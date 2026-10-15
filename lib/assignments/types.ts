import type { Note } from "@/lib/notes";
import type { AssignmentActor, AssignmentState, FailureCode } from "./transitions";

// API shapes for /api/assignments (docs/api/assignments.md). Shared by the
// routes and the browser client.

export type Assignment = {
  id: string;
  workspaceId: string;
  /** null after the source item was deleted. */
  sourceNoteId: string | null;
  /** User-authored; with answers and change requests, the only intent. */
  requestedOutcome: string;
  executorKind: "builtin" | "external";
  capabilities: string[];
  state: AssignmentState;
  revision: number;
  currentAttemptId: string | null;
  maxAttempts: number;
  errorCode: FailureCode | null;
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
  finishedAt: string | null;
};

/** A selected item. Its content is captured data, never instructions. */
export type AssignmentContextItem = {
  /** null after the item was deleted. */
  noteId: string | null;
  position: number;
  revisionAtSelection: number;
  contentRole: "untrusted_data";
};

export type AssignmentAttempt = {
  id: string;
  attemptNumber: number;
  status: "running" | "succeeded" | "waiting" | "failed" | "canceled" | "expired";
  leaseExpiresAt: string;
  heartbeatAt: string;
  provider: string | null;
  model: string | null;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type AssignmentEventType =
  | "state_changed"
  | "progress"
  | "question_asked"
  | "question_answered"
  | "artifact_submitted"
  | "review_decided"
  | "cancel_requested"
  | "context_unavailable"
  /** A finished assignment lost its link to an item that moved workspace. */
  | "item_detached"
  /** The accepted result was saved as a document item (payload { artifactId, noteId }). */
  | "artifact_saved";

export type AssignmentEvent = {
  id: string;
  attemptId: string | null;
  type: AssignmentEventType;
  actor: AssignmentActor;
  fromState: AssignmentState | null;
  toState: AssignmentState | null;
  /** Ids, codes and (for progress) short executor text; render as untrusted. */
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AssignmentQuestion = {
  id: string;
  attemptId: string;
  /** Executor-written; render as untrusted. */
  prompt: string;
  /** User-authored intent. */
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
  /** Set when the assignment ended with the question unanswered. */
  closedAt: string | null;
};

export type AssignmentArtifact = {
  id: string;
  attemptId: string;
  kind: "draft" | "summary";
  title: string;
  /** Tiptap document. Executor-written; render as untrusted. */
  content: unknown;
  plainText: string;
  sourceNoteIds: string[];
  savedNoteId: string | null;
  /** Only the artifact with supersededAt null can be reviewed. */
  supersededAt: string | null;
  createdAt: string;
};

export type ReviewDecision = "accept" | "request_changes" | "reject";

export type AssignmentReview = {
  id: string;
  artifactId: string;
  decision: ReviewDecision;
  /** User-authored intent (required for request_changes). */
  comment: string | null;
  decidedAt: string;
};

/**
 * One row of `GET /api/assignments`: the assignment plus the document item
 * saved from its accepted result (null when none was saved, or it was deleted).
 */
export type AssignmentListItem = Assignment & { savedNoteId: string | null };

export type AssignmentDetail = {
  assignment: Assignment;
  context: AssignmentContextItem[];
  attempts: AssignmentAttempt[];
  events: AssignmentEvent[];
  questions: AssignmentQuestion[];
  artifacts: AssignmentArtifact[];
  reviews: AssignmentReview[];
};

/** Every `code` an assignment route can return in an error body. */
export type AssignmentErrorCode =
  | "invalid_payload"
  | "unauthenticated"
  | "forbidden_origin"
  | "not_found"
  | "revision_conflict"
  | "invalid_transition"
  | "active_assignment_exists"
  | "artifact_superseded"
  | "invalid_context"
  | "capability_denied"
  | "agent_disabled"
  | "payload_too_large"
  | "load_failed"
  | "save_failed"
  | "not_configured";

/**
 * Codes only `POST /api/assignments/:id/save-document` returns (U-05). Kept
 * apart from AssignmentErrorCode so exhaustive maps over the older codes keep
 * compiling; AssignmentRouteErrorCode is every code.
 */
export type AssignmentDocumentErrorCode =
  /** This result already has a saved document (body noteId). */
  | "already_saved"
  /** The project link was refused. */
  | "invalid_project_link"
  | "project_cycle"
  | "project_depth_exceeded";

export type AssignmentRouteErrorCode = AssignmentErrorCode | AssignmentDocumentErrorCode;

export type AssignmentErrorBody = {
  error: string;
  code: AssignmentRouteErrorCode;
  /** revision_conflict */
  currentRevision?: number;
  state?: AssignmentState;
  /** invalid_transition */
  from?: AssignmentState;
  to?: AssignmentState;
  allowed?: AssignmentState[];
  /** active_assignment_exists */
  assignmentId?: string;
  /** already_saved: the document item saved earlier. */
  noteId?: string;
};

export type CreateAssignmentInput = {
  workspaceId: string;
  sourceNoteId: string;
  requestedOutcome: string;
  contextNoteIds?: string[];
  executor?: "builtin";
};

export type ListAssignmentsOptions = {
  states?: AssignmentState[];
  limit?: number;
  /** Only assignments delegated from this item. */
  sourceNoteId?: string;
};

/** Body of `POST /api/assignments/:id/save-document`. */
export type SaveDocumentInput = {
  /** The assignment's current revision. */
  expectedRevision: number;
  /** The accepted, current artifact. */
  artifactId: string;
  /**
   * Absent: the source item if it is a project, else its project, else none.
   * null: no project. A uuid: that project in the assignment's workspace.
   */
  projectId?: string | null;
  /** 1–200 characters after trimming; default the artifact title. */
  title?: string;
};

/** 201 from save-document. `note` has the same shape as `GET /api/notes` items. */
export type SaveDocumentResult = { note: Note; assignment: Assignment };

export type AssignmentUnavailableReason = "agent_disabled" | "no_key" | "key_unreadable";

/** `GET /api/assignments/availability`: whether the built-in executor can run. */
export type AssignmentAvailability =
  | { available: true }
  | { available: false; reason: AssignmentUnavailableReason };
