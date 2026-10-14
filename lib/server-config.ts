import "server-only";

/**
 * Typed server configuration and content-free metrics for note writes
 * (ADR 002 §7, §7a). Route code reads settings here, never process.env.
 */

export type RevisionEnforcement = "off" | "warn" | "enforce";
const ENFORCEMENT_MODES: readonly RevisionEnforcement[] = ["off", "warn", "enforce"];

type Env = Record<string, string | undefined>;

/**
 * NOTES_REVISION_ENFORCEMENT: "off" (default), "warn" or "enforce". In
 * enforce, writes without an expected revision are refused with 428. Any
 * other value is a deployment mistake and fails loudly.
 */
export function notesRevisionEnforcement(env: Env = process.env): RevisionEnforcement {
  const value = env.NOTES_REVISION_ENFORCEMENT?.trim().toLowerCase();
  if (!value) return "off";
  if ((ENFORCEMENT_MODES as readonly string[]).includes(value))
    return value as RevisionEnforcement;
  throw new Error("NOTES_REVISION_ENFORCEMENT must be off, warn, or enforce");
}

/**
 * NOTES_MIN_CLIENT: the oldest browser save protocol build the server
 * accepts, returned as X-Orbit-Min-Client so older tabs ask for a reload.
 */
export function notesMinClient(env: Env = process.env): number {
  const value = env.NOTES_MIN_CLIENT?.trim();
  if (!value) return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("NOTES_MIN_CLIENT must be a positive integer");
  return parsed;
}

export type LegacyWrite = {
  /** Writer from ADR 002's table, e.g. "W1". */
  writer: string;
  /** Method and route, e.g. "PUT /api/notes". */
  route: string;
  count: number;
  outcome: "accepted" | "rejected";
};

/**
 * Counts writes that did not state an expected revision. The phase C gate
 * reads this metric. Writer, route, outcome and count only: no user or note
 * ids, titles or content.
 */
export function recordLegacyWrite(
  write: LegacyWrite,
  emit: (line: string) => void = console.info,
) {
  if (!write.count) return;
  emit(
    JSON.stringify({
      metric: "notes.legacy_write",
      writer: write.writer,
      route: write.route,
      outcome: write.outcome,
      count: write.count,
    }),
  );
}
