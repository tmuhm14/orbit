/** The parts of the workspace page's server load that can fail. */
export type InitialLoadPart = "notes" | "workspaces";

// PostgREST and Postgres error codes, such as "PGRST301" or "42501".
const ERROR_CODE = /^[A-Z0-9]{1,12}$/;

/** A PostgREST error code safe to log, or "unknown"; never the message. */
export function errorCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : undefined;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "unknown";
}

/**
 * Logs which part of the initial page load failed and its error code. Part
 * and code only: no user ids, emails, workspace names or note content.
 */
export function recordInitialLoadFailure(
  part: InitialLoadPart,
  error: unknown,
  emit: (line: string) => void = console.error,
) {
  emit(
    JSON.stringify({ event: "initial_load_failed", part, code: errorCode(error) }),
  );
}
