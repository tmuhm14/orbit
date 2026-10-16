import { routeUser } from "@/lib/supabase/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ConfigError, apiKeyPepper } from "@/lib/grants/config";
import { requestEndpoints } from "@/lib/oauth/config";
import { readForm } from "@/lib/oauth/http";
import { checkAuthorize, consentGrants, readAuthorizeParams, redirectWith } from "@/lib/oauth/authorize";
import { authorizePath, registeredClient } from "@/lib/oauth/consent";
import { hashSecret, newSecret } from "@/lib/oauth/tokens";

/**
 * POST /oauth/authorize/decision: Allow or Deny from the consent page (ADR
 * 008). A same-origin form post from a signed-in session only. Every
 * parameter is checked again, because the form's hidden fields come back
 * from the browser. Deny sends error=access_denied to the verified redirect
 * URI; Allow saves the grants and a single-use code (its HMAC only) bound to
 * the app, redirect URI, PKCE challenge, user, resource and scope.
 */
export const runtime = "nodejs";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(status: number, message: string) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Orbit</title>` +
    `<body style="font-family:system-ui;background:#101115;color:#edecf2;padding:48px"><p>${escape(message)}</p><p><a style="color:#b09aeb" href="/">Back to Orbit</a></p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });
}

const seeOther = (location: string) =>
  new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const endpoints = requestEndpoints(request);
  if (!endpoints) return page(400, "App connections need HTTPS.");
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return (auth.error?.status ?? 401) === 401
    ? page(401, "You were signed out. Start the connection again from the app.")
    : page(auth.error?.status ?? 403, "That request can’t be accepted.");
  const form = await readForm(request);
  if (!form) return page(413, "That request is too large.");
  const admin = createAdminClient();
  if (!admin) return page(503, "This Orbit server isn’t set up for app connections yet.");
  const params = readAuthorizeParams(form);
  let client: ReturnType<typeof registeredClient> = null;
  if (params?.client_id) {
    const { data, error } = await admin.rpc("get_oauth_client", { p_client_id: params.client_id });
    if (error) return page(503, "Orbit couldn’t look up this app. Try again.");
    client = registeredClient(data);
  }
  const check = checkAuthorize(params, client, endpoints);
  if (check.kind === "invalid") return page(400, check.message);
  if (check.kind === "redirect") return seeOther(check.url);
  const back = (values: Record<string, string>) =>
    seeOther(redirectWith(check.redirectUri, { ...values, state: check.params.state, iss: endpoints.issuer }));
  if (form.get("decision") !== "allow") {
    console.info(JSON.stringify({ event: "oauth.denied", client: check.client.clientId }));
    return back({ error: "access_denied", error_description: "The user denied access" });
  }
  const grants = consentGrants(form.getAll("grant"), check.scope);
  if (!grants.length) return seeOther(`${authorizePath(check.params)}&notice=choose`);
  let pepper: string;
  try {
    pepper = apiKeyPepper();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "API key configuration invalid");
    return page(503, "This Orbit server isn’t set up for app connections yet.");
  }
  const code = newSecret("code");
  const { data, error } = await auth.supabase.rpc("create_oauth_authorization", {
    p_client_id: check.client.clientId, p_redirect_uri: check.redirectUri, p_code_hash: hashSecret(code, pepper),
    p_code_challenge: check.params.code_challenge, p_resource: check.resource, p_scope: check.scope, p_grants: grants,
  });
  if (error) return page(500, "Orbit couldn’t save the connection. Try again.");
  const status = (data as { status?: string } | null)?.status;
  if (status === "created") {
    console.info(JSON.stringify({ event: "oauth.authorized", client: check.client.clientId }));
    return back({ code });
  }
  if (status === "invalid_payload") return seeOther(`${authorizePath(check.params)}&notice=choose`);
  if (status === "limit_reached") return page(409, "You have 25 connected apps. Disconnect one in Settings → Agents & API keys first.");
  return page(400, "One of those spaces wasn’t found. Start the connection again from the app.");
}
