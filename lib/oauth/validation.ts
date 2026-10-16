// OAuth 2.1 input rules for Orbit's authorization server (ADR 008). Pure: no
// Next, no database, no secrets, so every rule is unit tested in node.

/**
 * Scopes Orbit issues. They cap what a token can do; the per-space grants the
 * user ticks on the consent page decide where. A token needs both.
 */
export const SCOPES = ["orbit:read", "orbit:capture"] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_CAPABILITY = { "orbit:read": "workspace.read", "orbit:capture": "item.write" } as const;
export const DEFAULT_SCOPE = SCOPES.join(" ");

/**
 * The requested scopes in canonical order. Unknown scopes (offline_access,
 * openid, ...) are ignored. A missing or empty scope means both. Returns null
 * when scopes were requested but none of them is Orbit's (invalid_scope).
 */
export function parseScope(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !value.trim()) return DEFAULT_SCOPE;
  const requested = new Set(value.trim().split(/\s+/));
  const known = SCOPES.filter((s) => requested.has(s));
  return known.length ? known.join(" ") : null;
}

/** The capabilities a token's scope allows. */
export function scopeCapabilities(scope: string): string[] {
  const granted = new Set(scope.split(" "));
  return SCOPES.filter((s) => granted.has(s)).map((s) => SCOPE_CAPABILITY[s]);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// The same shape the database checks (register_oauth_client).
const REDIRECT_SHAPE = /^(https:\/\/[^/?#@\s]+|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?)([/?][^#\s]*)?$/;

/**
 * Null when the redirect URI may be registered: HTTPS, or HTTP on a loopback
 * host for apps running on the user's machine. No fragment, no user info, no
 * custom schemes. Stored exactly as given; authorize compares exactly.
 */
export function redirectUriProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 2000) return "must be a URL up to 2000 characters";
  if (!REDIRECT_SHAPE.test(value)) return "must be an https URL (or http://localhost for apps on your computer), without a fragment";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be a valid URL";
  }
  if (url.username || url.password || url.hash) return "must not contain user info or a fragment";
  if (url.protocol === "https:") return url.hostname ? null : "must name a host";
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  return "must use https";
}

export const isLoopbackRedirect = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
};

/** "claude.ai" or "localhost:33418": what the consent page shows prominently. */
export function redirectHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

/** An optional https URL (client_uri, logo_uri); anything else is dropped. */
function httpsUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

// Control characters, zero-width and bidi formatting characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Display names: printable, single-spaced, at most 100 characters. */
function displayName(value: unknown) {
  if (typeof value !== "string") return null;
  // Control and formatting characters (bidi overrides included) are removed.
  const clean = value.replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, 100).trim();
  return clean || null;
}

export type ClientMetadata = {
  clientName: string | null;
  redirectUris: string[];
  clientUri: string | null;
  logoUri: string | null;
};
export type MetadataResult =
  | { ok: true; value: ClientMetadata }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

const metadataError = (error: "invalid_redirect_uri" | "invalid_client_metadata", description: string) =>
  ({ ok: false, error, description }) as const;

/**
 * RFC 7591 registration metadata for a public client. Orbit registers every
 * client with token_endpoint_auth_method "none", grant types
 * authorization_code and refresh_token, and response type code. Requests for
 * anything else are refused; a requested client authentication method is
 * replaced with "none" (RFC 7591 §3.2.1 lets the server replace values).
 */
export function parseClientMetadata(body: unknown): MetadataResult {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return metadataError("invalid_client_metadata", "Send the client metadata as a JSON object");
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5)
    return metadataError("invalid_redirect_uri", "Provide 1 to 5 redirect_uris");
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return metadataError("invalid_redirect_uri", `Each redirect URI ${problem}`);
  }
  const grantTypes = b.grant_types ?? ["authorization_code"];
  if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code") ||
    grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token"))
    return metadataError("invalid_client_metadata", "grant_types must be authorization_code, optionally with refresh_token");
  const responseTypes = b.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || responseTypes.length < 1 || responseTypes.some((r) => r !== "code"))
    return metadataError("invalid_client_metadata", "response_types must be [\"code\"]");
  return {
    ok: true,
    value: {
      clientName: displayName(b.client_name),
      redirectUris: [...new Set(uris as string[])],
      clientUri: httpsUrl(b.client_uri),
      logoUri: httpsUrl(b.logo_uri),
    },
  };
}

/**
 * A safe post-login destination: a relative path on this origin only. Absolute
 * URLs, scheme-relative "//host", backslashes and control characters are
 * refused (null), which sends the user to "/".
 */
export function safeNext(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 4000) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  const base = "https://orbit.invalid";
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.origin !== base) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * RFC 8707 resource comparison. Scheme and host compare case-insensitively
 * (URL parsing lowercases them) and a trailing slash is ignored; a fragment
 * makes the value invalid.
 */
export function sameResource(value: string, expected: string) {
  const canonical = (v: string) => {
    try {
      const url = new URL(v);
      if (url.hash || url.username || url.password) return null;
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    } catch {
      return null;
    }
  };
  const a = canonical(value);
  return a !== null && a === canonical(expected);
}

export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

const quote = (value: string) => `"${value.replace(/["\\]/g, "")}"`;

/**
 * The RFC 6750 / RFC 9728 challenge on /api/mcp. Without credentials it has
 * no error (RFC 6750 §3.1); with a bad token it adds error="invalid_token".
 */
export function wwwAuthenticate(resourceMetadata: string, options: { error?: string; description?: string } = {}) {
  const parts = [
    ...(options.error ? [`error=${quote(options.error)}`] : []),
    ...(options.description ? [`error_description=${quote(options.description)}`] : []),
    `resource_metadata=${quote(resourceMetadata)}`,
    `scope=${quote(DEFAULT_SCOPE)}`,
  ];
  return `Bearer ${parts.join(", ")}`;
}
