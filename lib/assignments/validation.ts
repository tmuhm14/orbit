import {
  ANSWER_MAX,
  COMMENT_MAX,
  MAX_CONTEXT_ITEMS,
  OUTCOME_MAX,
  isAssignmentState,
  type AssignmentState,
} from "./transitions";
import type { ReviewDecision } from "./types";

// Request validation for the assignment routes. The database functions check
// the same limits again; these reject bad shapes before any call and keep the
// error a fixed `invalid_payload` that never echoes input.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAssignmentUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

type Parsed<T> = { ok: true; value: T } | { ok: false };
const fail = { ok: false } as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
/** Length in characters, matching Postgres char_length. */
const chars = (value: string) => [...value].length;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && chars(trimmed) <= max ? trimmed : null;
}

const expectedRevision = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;

export type CreateAssignmentRequest = {
  workspaceId: string;
  sourceNoteId: string;
  requestedOutcome: string;
  contextNoteIds: string[];
  executor: "builtin";
};

/**
 * `{ workspaceId, sourceNoteId, requestedOutcome, contextNoteIds?, executor? }`.
 * The source may be any item kind. Context is up to 20 distinct item ids the
 * user selected; executor is "builtin" (external agents arrive with A-05).
 */
export function parseCreateAssignment(body: unknown): Parsed<CreateAssignmentRequest> {
  if (!isObject(body)) return fail;
  if (!onlyKeys(body, ["workspaceId", "sourceNoteId", "requestedOutcome", "contextNoteIds", "executor"]))
    return fail;
  const { workspaceId, sourceNoteId, contextNoteIds = [], executor = "builtin" } = body;
  const requestedOutcome = text(body.requestedOutcome, OUTCOME_MAX);
  if (!isAssignmentUuid(workspaceId) || !isAssignmentUuid(sourceNoteId) || !requestedOutcome) return fail;
  if (executor !== "builtin") return fail;
  if (
    !Array.isArray(contextNoteIds) ||
    contextNoteIds.length > MAX_CONTEXT_ITEMS ||
    !contextNoteIds.every(isAssignmentUuid)
  )
    return fail;
  const lower = contextNoteIds.map((id) => id.toLowerCase());
  if (new Set(lower).size !== lower.length) return fail;
  return {
    ok: true,
    value: { workspaceId, sourceNoteId, requestedOutcome, contextNoteIds, executor },
  };
}

/** `{ expectedRevision }` for cancel and retry. */
export function parseRevisionOnly(body: unknown): Parsed<{ expectedRevision: number }> {
  if (!isObject(body) || !onlyKeys(body, ["expectedRevision"])) return fail;
  const revision = expectedRevision(body.expectedRevision);
  return revision ? { ok: true, value: { expectedRevision: revision } } : fail;
}

/** `{ expectedRevision, questionId, answer }`. */
export function parseAnswer(
  body: unknown,
): Parsed<{ expectedRevision: number; questionId: string; answer: string }> {
  if (!isObject(body) || !onlyKeys(body, ["expectedRevision", "questionId", "answer"])) return fail;
  const revision = expectedRevision(body.expectedRevision);
  const answer = text(body.answer, ANSWER_MAX);
  if (!revision || !isAssignmentUuid(body.questionId) || !answer) return fail;
  return { ok: true, value: { expectedRevision: revision, questionId: body.questionId, answer } };
}

const DECISIONS: ReviewDecision[] = ["accept", "request_changes", "reject"];

/** `{ expectedRevision, artifactId, decision, comment? }`; request_changes needs a comment. */
export function parseReview(body: unknown): Parsed<{
  expectedRevision: number;
  artifactId: string;
  decision: ReviewDecision;
  comment: string | null;
}> {
  if (!isObject(body) || !onlyKeys(body, ["expectedRevision", "artifactId", "decision", "comment"]))
    return fail;
  const revision = expectedRevision(body.expectedRevision);
  const decision = body.decision as ReviewDecision;
  if (!revision || !isAssignmentUuid(body.artifactId) || !DECISIONS.includes(decision)) return fail;
  let comment: string | null = null;
  if (body.comment !== undefined && body.comment !== null) {
    if (typeof body.comment !== "string" || chars(body.comment.trim()) > COMMENT_MAX) return fail;
    comment = body.comment.trim() || null;
  }
  if (decision === "request_changes" && !comment) return fail;
  return {
    ok: true,
    value: { expectedRevision: revision, artifactId: body.artifactId, decision, comment },
  };
}

/** `?workspaceId=<uuid>[&sourceNoteId=<uuid>][&state=queued,running][&limit=50]`. */
export function parseListQuery(query: URLSearchParams): Parsed<{
  workspaceId: string;
  sourceNoteId: string | null;
  states: AssignmentState[] | null;
  limit: number;
}> {
  const workspaceId = query.get("workspaceId");
  if (!isAssignmentUuid(workspaceId)) return fail;
  const sourceNoteId = query.get("sourceNoteId");
  if (sourceNoteId !== null && !isAssignmentUuid(sourceNoteId)) return fail;
  const stateParam = query.get("state");
  let states: AssignmentState[] | null = null;
  if (stateParam !== null) {
    const parts = stateParam.split(",");
    if (!parts.every(isAssignmentState)) return fail;
    states = [...new Set(parts)] as AssignmentState[];
  }
  const limitParam = query.get("limit");
  const limit = limitParam === null ? 50 : Number(limitParam);
  if (!/^\d+$/.test(limitParam ?? "50") || limit < 1 || limit > 100) return fail;
  return { ok: true, value: { workspaceId, sourceNoteId, states, limit } };
}

/** Longest title a saved document may get (the artifact title limit). */
export const DOCUMENT_TITLE_MAX = 200;

/**
 * `{ expectedRevision, artifactId, projectId?, title? }` for save-document.
 * projectId: absent (default project), null (none) or a uuid. title is
 * trimmed, 1–200 characters. Unknown fields are rejected.
 */
export function parseSaveDocument(body: unknown): Parsed<{
  expectedRevision: number;
  artifactId: string;
  projectId?: string | null;
  title?: string;
}> {
  if (!isObject(body) || !onlyKeys(body, ["expectedRevision", "artifactId", "projectId", "title"]))
    return fail;
  const revision = expectedRevision(body.expectedRevision);
  if (!revision || !isAssignmentUuid(body.artifactId)) return fail;
  const value: { expectedRevision: number; artifactId: string; projectId?: string | null; title?: string } = {
    expectedRevision: revision,
    artifactId: body.artifactId,
  };
  if (Object.hasOwn(body, "projectId")) {
    if (body.projectId !== null && !isAssignmentUuid(body.projectId)) return fail;
    value.projectId = body.projectId;
  }
  if (Object.hasOwn(body, "title")) {
    const title = text(body.title, DOCUMENT_TITLE_MAX);
    if (!title) return fail;
    value.title = title;
  }
  return { ok: true, value };
}
