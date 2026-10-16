import "server-only";

/**
 * Typed configuration for external agent credentials (ADR 007). Route code
 * reads these settings here, never process.env directly.
 */

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

/**
 * ORBIT_API_KEY_PEPPER: the server-side HMAC key for Orbit API keys. At least
 * 32 characters (generate with `openssl rand -base64 32`). Required as soon as
 * a key is created or presented; there is no default, and changing it
 * invalidates every issued key. The message never includes the value.
 */
export function apiKeyPepper(env: Env = process.env): string {
  const value = env.ORBIT_API_KEY_PEPPER?.trim();
  if (!value) throw new ConfigError("ORBIT_API_KEY_PEPPER is not set; Orbit API keys are unavailable");
  if (value.length < 32) throw new ConfigError("ORBIT_API_KEY_PEPPER must be at least 32 characters");
  return value;
}

/** When Orbit API keys became available; the start of the user-token deprecation. */
export const USER_TOKEN_DEPRECATED_AT = "2026-10-20";
/** Proposed 30-day window (ADR 007, awaiting Tony's confirmation). */
const DEFAULT_USER_TOKEN_SUNSET = "2026-11-19";

/**
 * ORBIT_USER_TOKEN_SUNSET: the calendar date (YYYY-MM-DD, UTC) after which
 * Supabase user tokens are refused on /api/v1 with credential_type_unsupported.
 * Defaults to 30 days after API keys shipped. Set a later date to extend.
 */
export function userTokenSunset(env: Env = process.env): Date {
  const value = env.ORBIT_USER_TOKEN_SUNSET?.trim() || DEFAULT_USER_TOKEN_SUNSET;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new ConfigError("ORBIT_USER_TOKEN_SUNSET must be a date like 2026-11-19");
  return date;
}
