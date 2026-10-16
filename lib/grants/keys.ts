import "server-only";
import { createHmac, randomBytes } from "node:crypto";

/**
 * Orbit API keys (ADR 007): orbit_sk_<prefix>_<secret>.
 * - prefix: 12 lowercase hex characters (48 random bits). Stored, shown in
 *   Settings and safe to log. It only finds the row; it grants nothing.
 * - secret: 32 random bytes, base64url (43 characters, 256 bits).
 * The database stores HMAC-SHA256(pepper, whole key) as hex. With a 256-bit
 * random secret a slow hash adds nothing; the pepper means a leaked table
 * can't be used to test guesses offline.
 */

export const API_KEY_MARKER = "orbit_sk_";
const KEY_PATTERN = /^orbit_sk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export type ParsedKey = { prefix: string; key: string };

/** True for anything shaped like an Orbit key, valid or not. */
export const looksLikeApiKey = (token: string) => token.startsWith(API_KEY_MARKER);

export function parseApiKey(token: string): ParsedKey | null {
  const match = KEY_PATTERN.exec(token);
  return match ? { prefix: match[1], key: token } : null;
}

export function hashApiKey(key: string, pepper: string): string {
  return createHmac("sha256", pepper).update(key, "utf8").digest("hex");
}

/** A new key. Show `key` once; store only `prefix` and `hash`. */
export function generateApiKey(pepper: string, random: (size: number) => Buffer = randomBytes) {
  const prefix = random(6).toString("hex");
  const key = `${API_KEY_MARKER}${prefix}_${random(32).toString("base64url")}`;
  return { key, prefix, hash: hashApiKey(key, pepper) };
}

/** The loggable form of a presented key: its prefix, or a fixed placeholder. */
export function keyLabel(token: string) {
  const match = /^orbit_sk_([0-9a-f]{12})_/.exec(token);
  return match ? `orbit_sk_${match[1]}` : "orbit_sk_(malformed)";
}
