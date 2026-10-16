import { createAdminClient } from "@/lib/supabase/admin";
import { ConfigError, apiKeyPepper } from "@/lib/grants/config";
import { requestEndpoints } from "@/lib/oauth/config";
import { oauthError, oauthJson, preflight, readFields } from "@/lib/oauth/http";
import { hashSecret, isSecret, newSecret, pkceChallenge, tokenLabel } from "@/lib/oauth/tokens";
import { PKCE_VERIFIER, sameResource } from "@/lib/oauth/validation";

/**
 * The token endpoint (OAuth 2.1 §3.2, ADR 008) for public clients:
 * - authorization_code: the code, the exact redirect_uri, the PKCE verifier
 *   and the client id must all match what the code was bound to. A code is
 *   single-use; replaying it revokes the tokens issued from it.
 * - refresh_token: rotates. The presented token is used up and a new pair is
 *   issued; presenting a used refresh token revokes the whole family.
 * Access tokens last 1 hour, refresh tokens 30 days from their issue.
 * Logs carry the client id, the grant type and a token label only.
 */
export const runtime = "nodejs";

function clientIdFrom(request: Request, fields: Record<string, string>) {
  if (fields.client_id) return fields.client_id;
  // A public client may still send HTTP Basic with an empty secret.
  const basic = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!basic) return null;
  const [id] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
  return id ? decodeURIComponent(id) : null;
}

function refused(client: string | null, grant: string, reason: string) {
  console.warn(JSON.stringify({ event: "oauth.token_refused", client, grant, reason }));
}

export async function POST(request: Request) {
  const endpoints = requestEndpoints(request);
  if (!endpoints) return oauthError("invalid_request", "OAuth requires HTTPS");
  const fields = await readFields(request);
  if (!fields) return oauthError("invalid_request", "Send a form-encoded body without repeated parameters");
  const grant = fields.grant_type ?? "";
  const clientId = clientIdFrom(request, fields);
  if (grant !== "authorization_code" && grant !== "refresh_token")
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  if (!clientId || !/^orbit_ci_[0-9a-f]{32}$/.test(clientId)) {
    refused(null, grant, "client");
    return oauthError("invalid_client", "Unknown client", 401);
  }
  // RFC 8707: the resource, when sent, must be this MCP server.
  if (fields.resource !== undefined && !sameResource(fields.resource, endpoints.resource)) {
    refused(clientId, grant, "resource");
    return oauthError("invalid_target", `resource must be ${endpoints.resource}`);
  }
  const resource = fields.resource !== undefined ? endpoints.resource : null;
  let pepper: string;
  try {
    pepper = apiKeyPepper();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "API key configuration invalid");
    return oauthError("temporarily_unavailable", "Tokens are not configured on this server", 503);
  }
  const admin = createAdminClient();
  if (!admin) return oauthError("temporarily_unavailable", "Tokens are not configured on this server", 503);

  const access = newSecret("access");
  const refresh = newSecret("refresh");
  let rpc: { data: unknown; error: unknown };
  if (grant === "authorization_code") {
    const { code, redirect_uri: redirectUri, code_verifier: verifier } = fields;
    if (!redirectUri || !verifier) return oauthError("invalid_request", "Send code, redirect_uri and code_verifier");
    if (!PKCE_VERIFIER.test(verifier)) {
      refused(clientId, grant, "verifier");
      return oauthError("invalid_grant", "The code_verifier is malformed");
    }
    if (!isSecret(code, "code")) {
      refused(clientId, grant, "malformed");
      return oauthError("invalid_grant", "The authorization code is invalid or expired");
    }
    rpc = await admin.rpc("exchange_oauth_code", {
      p_code_hash: hashSecret(code, pepper), p_client_id: clientId, p_redirect_uri: redirectUri,
      p_verifier_challenge: pkceChallenge(verifier), p_resource: resource,
      p_access_hash: hashSecret(access, pepper), p_refresh_hash: hashSecret(refresh, pepper),
    });
  } else {
    const presented = fields.refresh_token;
    if (!isSecret(presented, "refresh")) {
      refused(clientId, grant, "malformed");
      return oauthError("invalid_grant", "The refresh token is invalid or expired");
    }
    rpc = await admin.rpc("refresh_oauth_token", {
      p_refresh_hash: hashSecret(presented, pepper), p_client_id: clientId, p_resource: resource,
      p_access_hash: hashSecret(access, pepper), p_new_refresh_hash: hashSecret(refresh, pepper),
    });
  }
  if (rpc.error) return oauthError("temporarily_unavailable", "Could not issue tokens", 503);
  const result = rpc.data as { status?: string; reason?: string; expiresIn?: number; scope?: string } | null;
  if (result?.status !== "issued") {
    const status = result?.status ?? "invalid_grant";
    refused(clientId, grant, result?.reason ?? status);
    if (status === "invalid_target") return oauthError("invalid_target", "The token was issued for a different resource");
    if (status === "invalid_request") return oauthError("invalid_request", "The request is malformed");
    return oauthError("invalid_grant", grant === "authorization_code"
      ? "The authorization code is invalid, expired or already used, or the code_verifier or redirect_uri doesn't match"
      : "The refresh token is invalid, expired or already used");
  }
  console.info(JSON.stringify({ event: "oauth.token_issued", client: clientId, grant, token: tokenLabel(access) }));
  return oauthJson({
    access_token: access,
    token_type: "Bearer",
    expires_in: result.expiresIn ?? 3600,
    refresh_token: refresh,
    scope: result.scope,
  });
}

export function OPTIONS() {
  return preflight();
}
