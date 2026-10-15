// Assignment lifecycle (ADR 003 §2), mirrored from
// supabase/migrations/20261017000000_assignments.sql for UI hints only. The
// database is authoritative: its trigger rejects any state change that is not
// in public.assignment_transitions, and supabase/tests/assignments.test.mjs
// checks that this table matches the seeded one.

export const ASSIGNMENT_STATES = [
  "queued",
  "running",
  "needs_input",
  "needs_review",
  "completed",
  "failed",
  "canceled",
] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

/** States that hold the one-active-assignment-per-item slot. */
export const ACTIVE_STATES: readonly AssignmentState[] = [
  "queued",
  "running",
  "needs_input",
  "needs_review",
];
/** No transition leaves these. `failed` is terminal unless the user retries. */
export const TERMINAL_STATES: readonly AssignmentState[] = ["completed", "canceled"];

export type AssignmentActor = "user" | "executor" | "system";

export type Transition = {
  code: string;
  from: AssignmentState;
  to: AssignmentState;
  actor: AssignmentActor;
};

export const TRANSITIONS: readonly Transition[] = [
  { code: "T1", from: "queued", to: "running", actor: "executor" },
  { code: "T2", from: "queued", to: "canceled", actor: "user" },
  { code: "T3", from: "running", to: "needs_input", actor: "executor" },
  { code: "T4", from: "running", to: "needs_review", actor: "executor" },
  { code: "T5", from: "running", to: "failed", actor: "executor" },
  { code: "T6", from: "running", to: "failed", actor: "system" },
  { code: "T7", from: "running", to: "queued", actor: "system" },
  { code: "T8", from: "running", to: "canceled", actor: "user" },
  { code: "T9", from: "needs_input", to: "queued", actor: "user" },
  { code: "T10", from: "needs_input", to: "canceled", actor: "user" },
  { code: "T11", from: "needs_review", to: "completed", actor: "user" },
  { code: "T12", from: "needs_review", to: "queued", actor: "user" },
  { code: "T13", from: "needs_review", to: "canceled", actor: "user" },
  { code: "T14", from: "failed", to: "queued", actor: "user" },
  { code: "T15", from: "queued", to: "failed", actor: "system" },
  { code: "T16", from: "needs_input", to: "failed", actor: "system" },
  { code: "T16", from: "needs_review", to: "failed", actor: "system" },
];

export const isAssignmentState = (value: unknown): value is AssignmentState =>
  typeof value === "string" && (ASSIGNMENT_STATES as readonly string[]).includes(value);

export const isTransitionAllowed = (
  from: AssignmentState,
  to: AssignmentState,
  actor: AssignmentActor,
) => TRANSITIONS.some((t) => t.from === from && t.to === to && t.actor === actor);

/** Target states `actor` may move an assignment to from `from`. */
export const allowedTargets = (from: AssignmentState, actor: AssignmentActor) =>
  [...new Set(TRANSITIONS.filter((t) => t.from === from && t.actor === actor).map((t) => t.to))];

/** What the owner can do next, for buttons. Each maps to one route. */
export type UserAction = "cancel" | "retry" | "answer" | "accept" | "request_changes" | "reject";
export function userActions(state: AssignmentState): UserAction[] {
  switch (state) {
    case "queued":
    case "running":
      return ["cancel"];
    case "needs_input":
      return ["answer", "cancel"];
    case "needs_review":
      return ["accept", "request_changes", "reject"];
    case "failed":
      return ["retry"];
    default:
      return [];
  }
}

// Interim built-in executor lease (ADR 003 open question 5, decided by Tony,
// 2026-10-14). Not exercised until A-02; the database default lease is the
// same 90 s.
export const ASSIGNMENT_LEASE_SECONDS = 90;
export const ASSIGNMENT_HEARTBEAT_SECONDS = 30;

// Limits, the same as the database checks.
export const MAX_CONTEXT_ITEMS = 20;
export const OUTCOME_MAX = 4000;
export const ANSWER_MAX = 4000;
export const COMMENT_MAX = 4000;
export const QUESTION_MAX = 2000;
export const PROGRESS_MAX = 280;

/** Normalized failure codes stored in error_code and shown to the user. */
export const FAILURE_CODES = [
  "provider_auth",
  "provider_rate_limited",
  "provider_unavailable",
  "budget_exhausted",
  "timed_out",
  "context_unavailable",
  "capability_revoked",
  "executor_unavailable",
  "internal",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
