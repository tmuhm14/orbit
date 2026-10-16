import { createAdminClient } from "@/lib/supabase/admin";
import { ConfigError, apiKeyPepper } from "@/lib/grants/config";
import { requestEndpoints } from "@/lib/oauth/config";
import { oauthError, oauthJson, preflight, readJson } from "@/lib/oauth/http";
import { ipFingerprint } from "@/lib/oauth/tokens";
import { parseClientMetadata } from "@/lib/oauth/validation";

/**
 * RFC 7591 dynamic client registration (ADR 008), for public clients only.
 * Registering grants nothing: an app can do something only after a user
 * consents to it. Rate limited per IP (10 an hour) and overall (500 an hour);
 * the IP is stored as a keyed fingerprint, never as an address.
 */
export const runtime = "nodejs";

/** The caller's address as Vercel reports it; the fingerprint is all that is kept. */
function callerIp(request: Request) {
  return request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

export async function POST(request: Request) {
  if (!requestEndpoints(request)) return oauthError("invalid_request", "OAuth requires HTTPS");
  const body = await readJson(request, 16_384);
  const parsed = parseClientMetadata(body);
  if (!parsed.ok) return oauthError(parsed.error, parsed.description);
  let pepper: string;
  try {
    pepper = apiKeyPepper();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "API key configuration invalid");
    return oauthError("temporarily_unavailable", "Registration is not configured on this server", 503);
  }
  const admin = createAdminClient();
  if (!admin) return oauthError("temporarily_unavailable", "Registration is not configured on this server", 503);
  const { value } = parsed;
  const { data, error } = await admin.rpc("register_oauth_client", {
    p_client_name: value.clientName, p_redirect_uris: value.redirectUris,
    p_client_uri: value.clientUri, p_logo_uri: value.logoUri, p_ip_hash: ipFingerprint(callerIp(request), pepper),
  });
  if (error) return oauthError("temporarily_unavailable", "Could not register the client", 503);
  const result = data as { status?: string; client?: { clientId: string; clientName: string | null; createdAt: string } };
  if (result?.status === "rate_limited")
    return oauthError("too_many_requests", "Too many registrations. Try again later.", 429, { "Retry-After": "3600" });
  if (result?.status !== "registered" || !result.client) return oauthError("invalid_client_metadata", "The client metadata was refused");
  const client = result.client;
  console.info(JSON.stringify({ event: "oauth.client_registered", client: client.clientId }));
  return oauthJson({
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
    ...(client.clientName ? { client_name: client.clientName } : {}),
    redirect_uris: value.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(value.clientUri ? { client_uri: value.clientUri } : {}),
    ...(value.logoUri ? { logo_uri: value.logoUri } : {}),
  }, 201);
}

export function OPTIONS() {
  return preflight();
}
