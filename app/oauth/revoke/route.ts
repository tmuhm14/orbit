import { createAdminClient } from "@/lib/supabase/admin";
import { ConfigError, apiKeyPepper } from "@/lib/grants/config";
import { requestEndpoints } from "@/lib/oauth/config";
import { CORS_HEADERS, oauthError, preflight, readFields } from "@/lib/oauth/http";
import { hashSecret, isSecret } from "@/lib/oauth/tokens";

/**
 * RFC 7009 token revocation (ADR 008). A refresh token revokes its whole
 * family; an access token only itself. The answer is 200 whether or not the
 * token was known, so it reveals nothing.
 */
export const runtime = "nodejs";

const ok = () => new Response(null, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (!requestEndpoints(request)) return oauthError("invalid_request", "OAuth requires HTTPS");
  const fields = await readFields(request);
  if (!fields || !fields.token) return oauthError("invalid_request", "Send the token to revoke");
  const clientId = fields.client_id ?? "";
  if (!isSecret(fields.token, "access") && !isSecret(fields.token, "refresh")) return ok();
  let pepper: string;
  try {
    pepper = apiKeyPepper();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "API key configuration invalid");
    return oauthError("temporarily_unavailable", "Revocation is not configured on this server", 503);
  }
  const admin = createAdminClient();
  if (!admin) return oauthError("temporarily_unavailable", "Revocation is not configured on this server", 503);
  const { error } = await admin.rpc("revoke_oauth_token", { p_token_hash: hashSecret(fields.token, pepper), p_client_id: clientId });
  if (error) return oauthError("temporarily_unavailable", "Could not revoke the token", 503);
  return ok();
}

export function OPTIONS() {
  return preflight();
}
