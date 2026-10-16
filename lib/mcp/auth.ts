import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ConfigError, apiKeyPepper } from "@/lib/grants/config";
import { hashApiKey, keyLabel, looksLikeApiKey, parseApiKey } from "@/lib/grants/keys";
import { grantsWithinScope, parseGrants } from "@/lib/grants/server";
import type { IntegrationAuth } from "@/lib/integrations/auth";
import type { OAuthEndpoints } from "@/lib/oauth/config";
import { oauthJson } from "@/lib/oauth/http";
import { hashSecret, isSecret, looksLikeAccessToken, tokenLabel } from "@/lib/oauth/tokens";
import { scopeCapabilities, wwwAuthenticate } from "@/lib/oauth/validation";

/**
 * Authentication for the hosted MCP endpoint (ADR 008). Bearer only, never
 * cookies, and only Orbit's own credentials (the MCP spec forbids accepting
 * other tokens):
 * - an Orbit API key (orbit_sk_...), verified like /api/v1 (ADR 007);
 * - an OAuth access token (orbit_at_...) issued by Orbit for this resource.
 * Both are verified against the database on every request, and come back
 * with the grants read now, so Settings changes apply to the next request.
 * Anything else is a 401 whose WWW-Authenticate header points clients at the
 * protected resource metadata, which starts OAuth discovery.
 */

export type McpAuth = IntegrationAuth & { credential: "api_key" | "oauth" };

function unauthorized(endpoints: OAuthEndpoints, error?: "invalid_token", description?: string) {
  return {
    error: oauthJson(
      { error: error ?? "unauthorized", error_description: description ?? "Connect to Orbit to use this server" },
      401,
      { "WWW-Authenticate": wwwAuthenticate(endpoints.resourceMetadata, error ? { error, description } : {}) },
    ),
  } as const;
}

const unavailable = (description: string) =>
  ({ error: oauthJson({ error: "temporarily_unavailable", error_description: description }, 503) }) as const;

function logRefusal(label: string, reason: string) {
  // The credential's prefix only; never a key, token or secret.
  console.warn(JSON.stringify({ event: "mcp_auth.refused", credential: label, reason }));
}

function pepper() {
  try {
    return apiKeyPepper();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "API key configuration invalid");
    return null;
  }
}

export async function mcpAuth(request: Request, endpoints: OAuthEndpoints): Promise<McpAuth | { error: Response }> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return unauthorized(endpoints);
  const token = match[1];
  const apiKey = looksLikeApiKey(token);
  if (!apiKey && !looksLikeAccessToken(token)) {
    logRefusal("(other)", "unsupported");
    return unauthorized(endpoints, "invalid_token", "Use an Orbit access token or API key");
  }
  const label = apiKey ? keyLabel(token) : tokenLabel(token);
  const parsedKey = apiKey ? parseApiKey(token) : null;
  if (apiKey ? !parsedKey : !isSecret(token, "access")) {
    logRefusal(label, "malformed");
    return unauthorized(endpoints, "invalid_token", "The credential is malformed");
  }
  const secret = pepper();
  if (!secret) return unavailable("Orbit credentials are not configured on this server");
  const admin = createAdminClient();
  if (!admin) return unavailable("Not configured");
  const { data, error } = parsedKey
    ? await admin.rpc("verify_agent_key", { p_key_prefix: parsedKey.prefix, p_key_hash: hashApiKey(parsedKey.key, secret) })
    : await admin.rpc("verify_oauth_token", { p_token_hash: hashSecret(token, secret), p_resource: endpoints.resource });
  if (error) return unavailable("Could not verify the credential");
  const result = data as { status?: string; userId?: string; clientId?: string; grants?: unknown; scope?: unknown } | null;
  if (!result || typeof result.userId !== "string" || typeof result.clientId !== "string") {
    logRefusal(label, "unknown");
    return unauthorized(endpoints, "invalid_token", "The credential is invalid or expired");
  }
  if (result.status !== "ok") {
    logRefusal(label, "revoked");
    return unauthorized(endpoints, "invalid_token", apiKey ? "This API key has been revoked" : "This connection was disconnected in Orbit");
  }
  const grants = parseGrants(result.grants);
  return {
    userId: result.userId,
    principal: {
      type: "agent_client", clientId: result.clientId, keyPrefix: parsedKey?.prefix ?? "", label,
      credential: apiKey ? "api_key" : "oauth",
      // A token's scope caps its grants; an API key has no scope.
      grants: apiKey ? grants : grantsWithinScope(grants, scopeCapabilities(typeof result.scope === "string" ? result.scope : "")),
    },
    db: admin,
    admin,
    headers: {},
    credential: apiKey ? "api_key" : "oauth",
  };
}
