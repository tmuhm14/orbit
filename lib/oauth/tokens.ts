import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * OAuth secrets (ADR 008): authorization codes, access tokens and refresh
 * tokens are a marker plus 32 random bytes in base64url (256 bits). The
 * database stores only HMAC-SHA256(ORBIT_API_KEY_PEPPER, value) as hex, the
 * same keyed fingerprint as Orbit API keys (ADR 007). Logs carry
 * tokenLabel() only: the marker and six characters, never the value.
 */

export const ACCESS_MARKER = "orbit_at_";
export const REFRESH_MARKER = "orbit_rt_";
export const CODE_MARKER = "orbit_ac_";
const SECRET_PATTERN = /^orbit_(at|rt|ac)_[A-Za-z0-9_-]{43}$/;

export type SecretKind = "access" | "refresh" | "code";
const MARKERS: Record<SecretKind, string> = { access: ACCESS_MARKER, refresh: REFRESH_MARKER, code: CODE_MARKER };

export function newSecret(kind: SecretKind, random: (size: number) => Buffer = randomBytes) {
  return `${MARKERS[kind]}${random(32).toString("base64url")}`;
}

/** True when the value has the shape of an Orbit secret of that kind. */
export const isSecret = (value: unknown, kind: SecretKind): value is string =>
  typeof value === "string" && value.startsWith(MARKERS[kind]) && SECRET_PATTERN.test(value);

export const looksLikeAccessToken = (value: string) => value.startsWith(ACCESS_MARKER);

export function hashSecret(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value, "utf8").digest("hex");
}

/** PKCE S256: BASE64URL(SHA256(ASCII(code_verifier))) (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Keyed fingerprint of the caller's IP for the registration rate limit; never the address. */
export const ipFingerprint = (ip: string, pepper: string) => hashSecret(`oauth-register-ip:${ip}`, pepper);

/** The loggable form of a presented token. */
export function tokenLabel(value: string) {
  const match = /^(orbit_(?:at|rt|ac)_)([A-Za-z0-9_-]{6})/.exec(value);
  return match ? `${match[1]}${match[2]}…` : "(malformed)";
}
