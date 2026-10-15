import "server-only";
import { json } from "@/lib/supabase/route-auth";
import type {
  Assignment,
  AssignmentArtifact,
  AssignmentAttempt,
  AssignmentContextItem,
  AssignmentRouteErrorCode,
  AssignmentEvent,
  AssignmentQuestion,
  AssignmentReview,
} from "./types";

// Row mapping and the error contract for /api/assignments. Messages are fixed
// and never contain outcomes, questions, answers, comments, artifact bodies or
// item content; nothing here logs.

export const ASSIGNMENT_COLUMNS =
  "id,workspace_id,source_note_id,requested_outcome,executor_kind,capabilities,state,revision," +
  "current_attempt_id,max_attempts,error_code,created_at,updated_at,state_changed_at,finished_at";
export const CONTEXT_COLUMNS = "note_id,position,revision_at_selection,content_role";
/** Never lease_token: authenticated has no select grant on it. */
export const ATTEMPT_COLUMNS =
  "id,attempt_number,status,lease_expires_at,heartbeat_at,provider,model,error_code,started_at,finished_at";
export const EVENT_COLUMNS = "id,attempt_id,type,actor,from_state,to_state,payload,created_at";
export const QUESTION_COLUMNS = "id,attempt_id,prompt,answer,asked_at,answered_at,closed_at";
export const ARTIFACT_COLUMNS =
  "id,attempt_id,kind,title,content,plain_text,source_note_ids,saved_note_id,superseded_at,created_at";
export const REVIEW_COLUMNS = "id,artifact_id,decision,comment,decided_at";

/** Most events and artifacts a detail response carries. */
export const DETAIL_EVENT_LIMIT = 500;
export const DETAIL_ARTIFACT_LIMIT = 20;
/** Largest request body the mutating routes read. */
export const MAX_BODY_BYTES = 32 * 1024;

type Row = Record<string, unknown>;
const str = (value: unknown) => value as string;
const opt = (value: unknown) => (value ?? null) as string | null;
const iso = (value: unknown) => new Date(value as string).toISOString();
const optIso = (value: unknown) => (value == null ? null : iso(value));

export function fromAssignmentRow(row: Row): Assignment {
  return {
    id: str(row.id),
    workspaceId: str(row.workspace_id),
    sourceNoteId: opt(row.source_note_id),
    requestedOutcome: str(row.requested_outcome),
    executorKind: row.executor_kind as Assignment["executorKind"],
    capabilities: (row.capabilities as string[]) ?? [],
    state: row.state as Assignment["state"],
    revision: Number(row.revision),
    currentAttemptId: opt(row.current_attempt_id),
    maxAttempts: Number(row.max_attempts),
    errorCode: (row.error_code ?? null) as Assignment["errorCode"],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    stateChangedAt: iso(row.state_changed_at),
    finishedAt: optIso(row.finished_at),
  };
}

export const fromContextRow = (row: Row): AssignmentContextItem => ({
  noteId: opt(row.note_id),
  position: Number(row.position),
  revisionAtSelection: Number(row.revision_at_selection),
  contentRole: "untrusted_data",
});

export const fromAttemptRow = (row: Row): AssignmentAttempt => ({
  id: str(row.id),
  attemptNumber: Number(row.attempt_number),
  status: row.status as AssignmentAttempt["status"],
  leaseExpiresAt: iso(row.lease_expires_at),
  heartbeatAt: iso(row.heartbeat_at),
  provider: opt(row.provider),
  model: opt(row.model),
  errorCode: opt(row.error_code),
  startedAt: iso(row.started_at),
  finishedAt: optIso(row.finished_at),
});

export const fromEventRow = (row: Row): AssignmentEvent => ({
  id: String(row.id),
  attemptId: opt(row.attempt_id),
  type: row.type as AssignmentEvent["type"],
  actor: row.actor as AssignmentEvent["actor"],
  fromState: (row.from_state ?? null) as AssignmentEvent["fromState"],
  toState: (row.to_state ?? null) as AssignmentEvent["toState"],
  payload: (row.payload as Record<string, unknown>) ?? {},
  createdAt: iso(row.created_at),
});

export const fromQuestionRow = (row: Row): AssignmentQuestion => ({
  id: str(row.id),
  attemptId: str(row.attempt_id),
  prompt: str(row.prompt),
  answer: opt(row.answer),
  askedAt: iso(row.asked_at),
  answeredAt: optIso(row.answered_at),
  closedAt: optIso(row.closed_at),
});

export const fromArtifactRow = (row: Row): AssignmentArtifact => ({
  id: str(row.id),
  attemptId: str(row.attempt_id),
  kind: row.kind as AssignmentArtifact["kind"],
  title: str(row.title),
  content: row.content,
  plainText: str(row.plain_text ?? ""),
  sourceNoteIds: (row.source_note_ids as string[]) ?? [],
  savedNoteId: opt(row.saved_note_id),
  supersededAt: optIso(row.superseded_at),
  createdAt: iso(row.created_at),
});

export const fromReviewRow = (row: Row): AssignmentReview => ({
  id: str(row.id),
  artifactId: str(row.artifact_id),
  decision: row.decision as AssignmentReview["decision"],
  comment: opt(row.comment),
  decidedAt: iso(row.decided_at),
});

const MESSAGES: Record<AssignmentRouteErrorCode, [number, string]> = {
  invalid_payload: [400, "Invalid request"],
  unauthenticated: [401, "Signed out"],
  forbidden_origin: [403, "Forbidden"],
  not_found: [404, "Assignment or item not found"],
  revision_conflict: [409, "That assignment was changed elsewhere"],
  invalid_transition: [409, "That isn't possible in the assignment's current state"],
  active_assignment_exists: [409, "This item already has an active assignment"],
  artifact_superseded: [409, "A newer result is waiting for review"],
  invalid_context: [422, "Context must be items from the same workspace"],
  capability_denied: [403, "That executor or capability is not allowed"],
  agent_disabled: [403, "Turn on the agent and save a model key for this workspace first"],
  payload_too_large: [413, "Request too large"],
  load_failed: [500, "Could not load assignments"],
  save_failed: [500, "Could not save the assignment"],
  not_configured: [503, "Not configured"],
  already_saved: [409, "This result is already saved as a document"],
  invalid_project_link: [422, "That item can't be linked to this project."],
  project_cycle: [422, "A project can't be placed inside one of its own sub-projects."],
  project_depth_exceeded: [422, "Projects can be nested at most 5 levels deep."],
};

/** A `{ error, code }` response with the fixed message for `code`. */
export function assignmentError(code: AssignmentRouteErrorCode, extra: Record<string, unknown> = {}) {
  const [status, error] = MESSAGES[code];
  return json({ error, code, ...extra }, status);
}

/**
 * routeUser() answers 401/403/503 with `{ error }` only; re-issue them with
 * this API's codes. The 403 is the same-origin check on mutations.
 */
export function authFailure(response: Response | undefined) {
  if (response?.status === 403) return assignmentError("forbidden_origin");
  if (response?.status === 503) return assignmentError("not_configured");
  return assignmentError("unauthenticated");
}

/** Reads a JSON body of at most MAX_BODY_BYTES, or returns the error response. */
export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const length = Number(request.headers.get("content-length"));
  if (length > MAX_BODY_BYTES) return { ok: false, response: assignmentError("payload_too_large") };
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: assignmentError("invalid_payload") };
  }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES)
    return { ok: false, response: assignmentError("payload_too_large") };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: assignmentError("invalid_payload") };
  }
}

type RawResult = {
  status?: string;
  assignment?: Row;
  reviewId?: string;
  currentRevision?: number | string;
  state?: string;
  from?: string;
  to?: string;
  allowed?: string[];
  assignmentId?: string;
};

const PASSTHROUGH: Record<string, AssignmentRouteErrorCode> = {
  not_found: "not_found",
  invalid_payload: "invalid_payload",
  invalid_context: "invalid_context",
  capability_denied: "capability_denied",
  agent_disabled: "agent_disabled",
  artifact_superseded: "artifact_superseded",
};

/**
 * The response for a create_assignment / transition_assignment /
 * answer_assignment_question / review_assignment_artifact result, or null
 * for an unexpected result (the caller answers save_failed).
 */
export function assignmentResultResponse(raw: unknown): Response | null {
  const result = raw as RawResult | null;
  if (!result || typeof result !== "object" || typeof result.status !== "string") return null;
  switch (result.status) {
    case "created":
    case "saved": {
      if (!result.assignment) return null;
      const body: Record<string, unknown> = { assignment: fromAssignmentRow(result.assignment) };
      if (result.reviewId) body.reviewId = result.reviewId;
      return json(body, result.status === "created" ? 201 : 200);
    }
    case "conflict":
      return assignmentError("revision_conflict", {
        currentRevision: Number(result.currentRevision),
        state: result.state,
      });
    case "invalid_transition":
      return assignmentError("invalid_transition", {
        from: result.from,
        to: result.to,
        allowed: result.allowed ?? [],
      });
    case "active_assignment_exists":
      return assignmentError("active_assignment_exists", { assignmentId: result.assignmentId });
    default: {
      const code = PASSTHROUGH[result.status];
      return code ? assignmentError(code) : null;
    }
  }
}
