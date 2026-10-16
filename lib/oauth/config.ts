import "server-only";
import { ConfigError } from "@/lib/grants/config";

/**
 * Where Orbit's authorization server and MCP resource live (ADR 008). The
 * issuer is this deployment's origin, so production and each Vercel preview
 * are separate issuers with separately bound tokens. ORBIT_OAUTH_ISSUER
 * (optional, an origin such as https://orbit.example.com) pins it, for
 * deployments behind a proxy that rewrites the host. Route code reads this
 * here, never process.env directly.
 */

type Env = Record<string, string | undefined>;

export type OAuthEndpoints = {
  issuer: string;
  /** The canonical MCP server URI (RFC 8707 audience), without a trailing slash. */
  resource: string;
  resourceMetadata: string;
  authorization: string;
  token: string;
  registration: string;
  revocation: string;
  documentation: string;
};

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function checkedOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.test(url.host))) return url.origin;
  return null;
}

/**
 * This request's issuer origin, or null when it isn't HTTPS (OAuth needs
 * TLS; plain HTTP is accepted only on localhost for development). Uses the
 * forwarded host and protocol like routeUser's same-origin check, falling
 * back to the request URL.
 */
export function oauthOrigin(headers: { get(name: string): string | null }, requestUrl?: string,
  env: Env = process.env): string | null {
  const pinned = env.ORBIT_OAUTH_ISSUER?.trim();
  if (pinned) {
    const origin = checkedOrigin(pinned);
    if (!origin || origin !== pinned.replace(/\/$/, ""))
      throw new ConfigError("ORBIT_OAUTH_ISSUER must be an https origin such as https://orbit.example.com");
    return origin;
  }
  const host = headers.get("x-forwarded-host")?.split(",")[0].trim() || headers.get("host")?.trim();
  if (host) {
    const forwarded = headers.get("x-forwarded-proto")?.split(",")[0].trim();
    const proto = forwarded || (requestUrl ? new URL(requestUrl).protocol.replace(":", "") : LOOPBACK.test(host) ? "http" : "https");
    return checkedOrigin(`${proto}://${host}`);
  }
  return requestUrl ? checkedOrigin(new URL(requestUrl).origin) : null;
}

export function oauthEndpoints(origin: string): OAuthEndpoints {
  return {
    issuer: origin,
    resource: `${origin}/api/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource`,
    authorization: `${origin}/oauth/authorize`,
    token: `${origin}/oauth/token`,
    registration: `${origin}/oauth/register`,
    revocation: `${origin}/oauth/revoke`,
    documentation: `${origin}/settings/agents/setup#connect-apps`,
  };
}

/**
 * Endpoints for a route handler's request; null when the origin isn't HTTPS
 * or ORBIT_OAUTH_ISSUER is malformed (logged by name, never by value).
 */
export function requestEndpoints(request: Request, env: Env = process.env): OAuthEndpoints | null {
  try {
    const origin = oauthOrigin(request.headers, request.url, env);
    return origin ? oauthEndpoints(origin) : null;
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "OAuth issuer configuration invalid");
    return null;
  }
}

/** Lifetimes, mirrored from the database functions that enforce them. */
export const ACCESS_TOKEN_SECONDS = 3600;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 3600;
export const AUTHORIZATION_CODE_SECONDS = 300;
