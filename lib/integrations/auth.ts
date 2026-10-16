import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authConfig } from "@/lib/supabase/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { ConfigError, USER_TOKEN_DEPRECATED_AT, apiKeyPepper, userTokenSunset } from "@/lib/grants/config";
import { hashApiKey, keyLabel, looksLikeApiKey, parseApiKey } from "@/lib/grants/keys";
import { checkGrant, parseGrants, type Capability, type Principal } from "@/lib/grants/server";
import { recordAccess, type AccessOperation } from "@/lib/grants/audit";

/**
 * /api/v1 authentication (ADR 007). Bearer only; never browser cookies.
 * - Orbit API keys (orbit_sk_...): verified against the database on every
 *   request; grants come back with the verification, so revocation and grant
 *   changes apply to the next call. Data access uses the server role, always
 *   filtered to the key's user and checked against its grants.
 * - Supabase user tokens: still accepted (deprecated) with a Deprecation
 *   header and a user_token audit row. Only if ORBIT_USER_TOKEN_SUNSET is set:
 *   a Sunset header, then refusal with credential_type_unsupported from that date.
 * Keys and tokens are never logged or echoed; logs carry the key prefix only.
 */

export const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });

const failure = (error: string, code: string, status: number, extra: Record<string, unknown> = {}) =>
  ({ error: reply({ error, code, ...extra }, status) }) as const;

export type IntegrationAuth = {
  userId: string;
  principal: Principal;
  /** Admin client for API keys (filtered by userId); the user-scoped client for user tokens. */
  db: SupabaseClient;
  /** For audit writes; null when the server role isn't configured (user tokens only). */
  admin: SupabaseClient | null;
  /** Response headers every reply must carry (deprecation notices). */
  headers: Record<string, string>;
};

const httpDate = (date: Date) => date.toUTCString();

function logRefusal(token: string, reason: string) {
  // Prefix only: never the secret, never the full key.
  console.warn(JSON.stringify({ event: "integration_auth.refused", key: keyLabel(token), reason }));
}

async function apiKeyAuth(token: string, operation: AccessOperation) {
  const parsed = parseApiKey(token);
  if (!parsed) {
    logRefusal(token, "malformed");
    return failure("Invalid API key", "invalid_credentials", 401);
  }
  let pepper: string;
  try {
    pepper = apiKeyPepper();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "API key configuration invalid");
    return failure("API keys are not configured on this server", "not_configured", 503);
  }
  const admin = createAdminClient();
  if (!admin) return failure("Not configured", "not_configured", 503);
  const { data, error } = await admin.rpc("verify_agent_key", {
    p_key_prefix: parsed.prefix, p_key_hash: hashApiKey(parsed.key, pepper),
  });
  if (error) return failure("Could not verify API key", "unavailable", 503);
  const result = data as { status?: string; userId?: string; clientId?: string; grants?: unknown } | null;
  if (!result || typeof result.userId !== "string" || typeof result.clientId !== "string") {
    logRefusal(token, "unknown");
    return failure("Invalid API key", "invalid_credentials", 401);
  }
  const principal: Principal = { type: "agent_client", clientId: result.clientId, keyPrefix: parsed.prefix,
    grants: result.status === "ok" ? parseGrants(result.grants) : [] };
  if (result.status !== "ok") {
    logRefusal(token, "revoked");
    await recordAccess(admin, { userId: result.userId, principal, operation, outcome: "denied", code: "client_revoked" });
    return failure("This API key has been revoked", "client_revoked", 401);
  }
  return { userId: result.userId, principal, db: admin, admin, headers: {} } satisfies IntegrationAuth;
}

async function userTokenAuth(token: string) {
  let sunset: Date | null;
  try {
    sunset = userTokenSunset();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "User token sunset invalid");
    return failure("Not configured", "not_configured", 503);
  }
  if (sunset && Date.now() >= sunset.getTime())
    return failure("Supabase user tokens are no longer accepted. Create an Orbit API key in Settings.",
      "credential_type_unsupported", 401);
  const config = authConfig();
  if (!config) return failure("Not configured", "not_configured", 503);
  const supabase = createClient(config.url, config.key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return failure("Invalid or expired access token", "invalid_credentials", 401);
  const headers: Record<string, string> = {
    // RFC 9745. Sunset (RFC 8594) only once a date is scheduled.
    Deprecation: `@${Math.floor(Date.parse(`${USER_TOKEN_DEPRECATED_AT}T00:00:00Z`) / 1000)}`,
    ...(sunset ? { Sunset: httpDate(sunset) } : {}),
  };
  return { userId: data.user.id, principal: { type: "user_token" }, db: supabase,
    admin: createAdminClient(), headers } satisfies IntegrationAuth;
}

/** Authenticates an /api/v1 request for one operation. */
export async function integrationAuth(request: Request, operation: AccessOperation):
  Promise<IntegrationAuth | { error: Response }> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return failure("An Orbit API key is required (Authorization: Bearer orbit_sk_...)", "invalid_credentials", 401);
  return looksLikeApiKey(match[1]) ? apiKeyAuth(match[1], operation) : userTokenAuth(match[1]);
}

/**
 * Authorizes one operation in one workspace and records the outcome.
 * API keys: the matching grant from this request's verification.
 * User tokens: today's policy (workspace.read + item.write {create}) behind
 * the workspace's agent_enabled switch, read now.
 * Returns null when allowed, or the denial response.
 */
export async function authorize(auth: IntegrationAuth, capability: Capability, workspaceId: string,
  operation: AccessOperation): Promise<Response | null> {
  let code: "capability_denied" | "agent_disabled" | null = null;
  if (auth.principal.type === "agent_client") {
    const decision = checkGrant(auth.principal.grants, capability, workspaceId,
      capability === "item.write" ? "create" : undefined);
    if (!decision.ok) code = decision.code;
  } else {
    if (capability === "assignment.execute") code = "capability_denied";
    else {
      const { data, error } = await auth.db.from("workspaces").select("id")
        .eq("id", workspaceId).eq("user_id", auth.userId).eq("agent_enabled", true).maybeSingle();
      if (error) return reply({ error: "Could not verify workspace access", code: "unavailable" }, 500, auth.headers);
      if (!data) code = "agent_disabled";
    }
  }
  if (code) {
    await recordAccess(auth.admin, { userId: auth.userId, principal: auth.principal, operation, workspaceId,
      outcome: "denied", code });
    // Generic messages; principal and code only (ADR 004 §5–6).
    if (auth.principal.type === "agent_client")
      console.warn(JSON.stringify({ event: "integration_auth.denied",
        key: auth.principal.label ?? `orbit_sk_${auth.principal.keyPrefix}`, capability, code }));
    return code === "agent_disabled"
      ? reply({ error: "Workspace unavailable or agent access disabled", code }, 403, auth.headers)
      : reply({ error: "This key does not have that capability in this workspace", code, capability }, 403, auth.headers);
  }
  return null;
}

/** Records an allowed operation (content-free). */
export const allowed = (auth: IntegrationAuth, operation: AccessOperation, workspaceId: string | null,
  resourceId: string | null = null) =>
  recordAccess(auth.admin, { userId: auth.userId, principal: auth.principal, operation, workspaceId, resourceId,
    outcome: "allowed" });
