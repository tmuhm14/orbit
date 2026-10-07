import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Model API keys are encrypted before they reach the database, so a leaked
// row or backup does not expose them. Format: v1.<iv>.<tag>.<ciphertext>,
// each base64url, AES-256-GCM.

/** Parses AGENT_ENCRYPTION_KEY: 32 bytes as base64 (openssl rand -base64 32) or hex. */
export function parseEncryptionKey(value: string | undefined): Buffer | null {
  if (!value) return null;
  const trimmed = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  return key.length === 32 ? key : null;
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    data.toString("base64url"),
  ].join(".");
}

/** Returns null if the value was tampered with or encrypted under another key. */
export function decryptSecret(sealed: string, key: Buffer): string | null {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export const keyHint = (apiKey: string) => apiKey.trim().slice(-4);
