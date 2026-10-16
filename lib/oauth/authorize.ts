import {
  PKCE_CHALLENGE, SCOPE_CAPABILITY, SCOPES, parseScope, redirectHost, sameResource, type Scope,
} from "@/lib/oauth/validation";

/**
 * The authorization request checks (OAuth 2.1 §4.1.1, RFC 7636, RFC 8707),
 * shared by the consent page (GET /oauth/authorize) and the decision route
 * (POST /oauth/authorize/decision), which re-checks everything it is sent.
 * Pure: the caller looks up the client.
 */

export const AUTHORIZE_PARAMS = [
  "client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "resource", "scope",
] as const;
export type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_PARAMS)[number], string>>;

export type RegisteredClient = {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  clientUri: string | null;
};

export type AuthorizeCheck =
  /** Unknown client or redirect URI: never redirect, show an error (OAuth 2.1 §4.1.2.1). */
  | { kind: "invalid"; message: string }
  /** A request error the client is told about at its verified redirect URI. */
  | { kind: "redirect"; url: string }
  | { kind: "ok"; client: RegisteredClient; params: AuthorizeParams; redirectUri: string; resource: string; scope: string };

/** Reads the parameters; null when any of them repeats (OAuth 2.1 §3.1). */
export function readAuthorizeParams(source: URLSearchParams): AuthorizeParams | null {
  const params: AuthorizeParams = {};
  for (const name of AUTHORIZE_PARAMS) {
    const values = source.getAll(name);
    if (values.length > 1) return null;
    if (values.length === 1) params[name] = values[0];
  }
  return params;
}

/** Appends query parameters to a registered redirect URI, keeping its own query. */
export function redirectWith(redirectUri: string, values: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

export function checkAuthorize(params: AuthorizeParams | null, client: RegisteredClient | null,
  endpoints: { issuer: string; resource: string }): AuthorizeCheck {
  if (!params) return { kind: "invalid", message: "The request repeats a parameter." };
  if (!params.client_id || !client || client.clientId !== params.client_id)
    return { kind: "invalid", message: "This app isn’t registered with Orbit. Start the connection again from the app." };
  const redirectUri = params.redirect_uri;
  if (!redirectUri || !client.redirectUris.includes(redirectUri))
    return { kind: "invalid", message: "This app sent a return address it didn’t register. Orbit won’t send you there." };
  const fail = (error: string, description: string) => ({
    kind: "redirect" as const,
    url: redirectWith(redirectUri, { error, error_description: description, state: params.state, iss: endpoints.issuer }),
  });
  if (params.state !== undefined && params.state.length > 2000) return fail("invalid_request", "state is too long");
  if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
  if (!params.code_challenge || params.code_challenge_method !== "S256" || !PKCE_CHALLENGE.test(params.code_challenge))
    return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256");
  if (params.resource !== undefined && !sameResource(params.resource, endpoints.resource))
    return fail("invalid_target", `resource must be ${endpoints.resource}`);
  const scope = parseScope(params.scope);
  if (!scope) return fail("invalid_scope", `Supported scopes: ${SCOPES.join(" ")}`);
  return { kind: "ok", client, params, redirectUri, resource: endpoints.resource, scope };
}

/** The capabilities the consent page offers for a scope, as Read / Capture columns. */
export function consentColumns(scope: string) {
  const granted = new Set(scope.split(" "));
  return SCOPES.filter((s) => granted.has(s)).map((s: Scope) => ({
    scope: s,
    capability: SCOPE_CAPABILITY[s],
    label: s === "orbit:read" ? "Read" : "Capture",
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ticked "workspaceId:capability" boxes, limited to the token's scope and
 * deduplicated. Ownership of each workspace is checked by the database.
 */
export function consentGrants(values: string[], scope: string) {
  const allowed = new Set<string>(consentColumns(scope).map((c) => c.capability));
  const seen = new Map<string, { workspaceId: string; capability: string }>();
  for (const value of values.slice(0, 300)) {
    const [workspaceId, capability, extra] = value.split(":");
    if (extra !== undefined || !workspaceId || !UUID.test(workspaceId) || !allowed.has(capability)) continue;
    seen.set(`${workspaceId.toLowerCase()}:${capability}`, { workspaceId: workspaceId.toLowerCase(), capability });
  }
  return [...seen.values()];
}

/** What the consent page shows about where the user is sent back to. */
export const consentRedirectHost = redirectHost;
