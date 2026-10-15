// Pure display logic for delegation (U-04): state labels and actions, poll
// timing, honest status lines, the timeline built from real events, the
// context picker's options and friendly copy for every error code. Nothing
// here logs or sends outcomes, questions, answers, results or item content.
import {
  ACTIVE_STATES,
  MAX_CONTEXT_ITEMS,
  OUTCOME_MAX,
  allowedTargets,
  userActions,
  type AssignmentState,
  type FailureCode,
} from "./assignments/transitions.ts";
import type {
  Assignment,
  AssignmentDetail,
  AssignmentEvent,
  AssignmentRouteErrorCode,
} from "./assignments/types.ts";
import { itemKind, type Note } from "./notes.ts";

export const STATE_LABELS: Record<AssignmentState, string> = {
  queued: "Queued",
  running: "Working",
  needs_input: "Needs input",
  needs_review: "Needs review",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

export const isActiveState = (state: AssignmentState) => ACTIVE_STATES.includes(state);

/** States where only the executor or system can move things along. */
const WORKING_STATES: readonly AssignmentState[] = ["queued", "running"];

export type ViewActions = {
  cancel: boolean;
  retry: boolean;
  answer: boolean;
  review: boolean;
};

/**
 * Which controls the detail shows, from the transitions mirror: an action
 * appears only when userActions() offers it and the table lets the user make
 * the move it implies. A result waiting for review is declined with Reject
 * (which records the decision), not Cancel.
 */
export function viewActions(state: AssignmentState): ViewActions {
  const actions = userActions(state);
  const targets = allowedTargets(state, "user");
  return {
    cancel: actions.includes("cancel") && targets.includes("canceled"),
    retry: actions.includes("retry") && targets.includes("queued"),
    answer: actions.includes("answer") && targets.includes("queued"),
    review:
      actions.includes("accept") &&
      actions.includes("request_changes") &&
      actions.includes("reject") &&
      targets.includes("completed"),
  };
}

export const DETAIL_POLL_MS = 2_000;
export const ITEM_POLL_MS = 15_000;
export const MAX_POLL_MS = 30_000;

/**
 * Delay before the detail reloads, or null to stop. Polls only while the
 * agent is the one moving (queued, running) and the page is visible, and
 * backs off after failed loads. Questions and results wait for the user.
 */
export function detailPollDelay(
  state: AssignmentState | null,
  { hidden = false, failures = 0 }: { hidden?: boolean; failures?: number } = {},
): number | null {
  if (hidden || state === null || !WORKING_STATES.includes(state)) return null;
  return Math.min(MAX_POLL_MS, DETAIL_POLL_MS * 2 ** Math.max(0, failures));
}

/** The editor's status chip refreshes slowly, and only while work is moving. */
export function itemPollDelay(
  state: AssignmentState | null,
  { hidden = false }: { hidden?: boolean } = {},
): number | null {
  if (hidden || state === null || !WORKING_STATES.includes(state)) return null;
  return ITEM_POLL_MS;
}

/** "just now", "12s ago", "3 min ago", "2 h ago", or a date. */
export function sinceLabel(iso: string | null | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

const latest = (values: (string | null | undefined)[]) =>
  values.filter((v): v is string => !!v && !Number.isNaN(Date.parse(v))).sort().at(-1) ?? null;

/** When anything real last happened: an event or the current attempt's heartbeat. */
export function lastUpdateAt(detail: Pick<AssignmentDetail, "assignment" | "attempts" | "events">) {
  const attempt = detail.attempts.find((a) => a.id === detail.assignment.currentAttemptId);
  return latest([
    detail.assignment.stateChangedAt,
    detail.events.at(-1)?.createdAt,
    attempt?.heartbeatAt,
  ]);
}

/** The newest progress text, only while running; executor-written, show as text. */
export function latestProgress(detail: Pick<AssignmentDetail, "assignment" | "events">): string | null {
  if (detail.assignment.state !== "running") return null;
  for (let i = detail.events.length - 1; i >= 0; i--) {
    const event = detail.events[i];
    if (event.type === "state_changed" && event.toState === "running") return null;
    if (event.type === "progress") return progressText(event);
  }
  return null;
}

const progressText = (event: AssignmentEvent) => {
  const text = event.payload.text;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 280) : null;
};

/**
 * Status for the detail header. `label` is what the live region announces
 * (it changes only when the state does); `since` is shown, not announced.
 */
export function statusLine(
  detail: Pick<AssignmentDetail, "assignment" | "attempts" | "events">,
  now: number,
): { label: string; since: string } {
  const { state } = detail.assignment;
  switch (state) {
    case "queued":
      return { label: "Queued", since: `waiting for the agent · since ${sinceLabel(detail.assignment.stateChangedAt, now)}` };
    case "running":
      return { label: "Working", since: `last update ${sinceLabel(lastUpdateAt(detail), now)}` };
    case "needs_input":
      return { label: "Waiting for your answer", since: `asked ${sinceLabel(detail.assignment.stateChangedAt, now)}` };
    case "needs_review":
      return { label: "Ready for your review", since: `submitted ${sinceLabel(detail.assignment.stateChangedAt, now)}` };
    default:
      return {
        label: STATE_LABELS[state],
        since: sinceLabel(detail.assignment.finishedAt ?? detail.assignment.stateChangedAt, now),
      };
  }
}

export const FAILURE_COPY: Record<FailureCode, string> = {
  provider_auth: "Your model provider didn’t accept the saved key. Check it in Settings, then retry.",
  provider_rate_limited: "Your model provider asked Orbit to slow down. Wait a little, then retry.",
  provider_unavailable: "Your model provider wasn’t reachable. Retry in a moment.",
  budget_exhausted: "The agent ran out of room for this one. Try a narrower outcome or less context.",
  timed_out: "The agent stopped checking in, so Orbit stopped waiting. Retry when you’re ready.",
  context_unavailable: "Some selected context couldn’t be read. Check the items still exist, then retry.",
  capability_revoked: "The agent no longer has permission for this. Check the agent switch and Settings.",
  executor_unavailable: "The agent is off for this space or has no model key. Turn it on and save a key, then retry.",
  internal: "Something went wrong on Orbit’s side. Retry, and it should pick up again.",
};

export function failureCopy(code: string | null | undefined): string {
  return code && code in FAILURE_COPY
    ? FAILURE_COPY[code as FailureCode]
    : "The agent couldn’t finish this one. Retry when you’re ready.";
}

/** What a friendly error message offers next. */
export type ErrorAction = "settings" | "existing" | "saved" | "refetch" | "reload" | "retry" | null;
export type ErrorCopy = { message: string; action: ErrorAction };
export type ViewErrorCode = AssignmentRouteErrorCode | "network_error" | "unexpected_response";

export const ERROR_COPY: Record<ViewErrorCode, ErrorCopy> = {
  agent_disabled: { message: "Turn on the agent and save a model key", action: "settings" },
  active_assignment_exists: { message: "This item is already delegated. Open the current assignment to follow it.", action: "existing" },
  invalid_context: { message: "One of the context items isn’t in this space any more, or is this item. Check the list and try again.", action: null },
  capability_denied: { message: "The agent isn’t allowed to do this here yet.", action: null },
  revision_conflict: { message: "This changed while you were looking. Here’s the latest.", action: "refetch" },
  invalid_transition: { message: "That isn’t possible any more. Here’s where things stand now.", action: "refetch" },
  invalid_payload: { message: "Orbit couldn’t read that request. Check the outcome isn’t empty or too long.", action: null },
  unauthenticated: { message: "Your session ended. Reload to sign in again.", action: "reload" },
  forbidden_origin: { message: "Orbit refused a request from outside this page. Reload and try again.", action: "reload" },
  not_found: { message: "Orbit couldn’t find this. If you just created the item, wait a moment for it to sync.", action: "refetch" },
  artifact_superseded: { message: "A newer result replaced this one. Here’s the latest.", action: "refetch" },
  payload_too_large: { message: "That’s too long to send. Shorten it and try again.", action: null },
  load_failed: { message: "Orbit couldn’t load this right now.", action: "retry" },
  save_failed: { message: "Orbit couldn’t save that right now. Try again.", action: "retry" },
  not_configured: { message: "Delegation isn’t set up on this server yet.", action: null },
  already_saved: { message: "This result is already saved as a document.", action: "saved" },
  invalid_project_link: { message: "That project isn’t available in this space any more. Pick another, or None.", action: null },
  project_cycle: { message: "That project can’t hold this document. Pick another, or None.", action: null },
  project_depth_exceeded: { message: "That project is nested too deeply to hold another item. Pick another, or None.", action: null },
  network_error: { message: "Orbit couldn’t be reached. Check your connection.", action: "retry" },
  unexpected_response: { message: "Orbit sent back something unexpected. Try again.", action: "retry" },
};

export function errorCopy(code: string | null | undefined): ErrorCopy {
  return code && code in ERROR_COPY
    ? ERROR_COPY[code as ViewErrorCode]
    : { message: "Something went wrong. Try again.", action: "retry" };
}

/** Error codes the detail recovers from by loading the latest copy. */
export const refetchOn = (code: string) => errorCopy(code).action === "refetch";

export type TimelineTone = "neutral" | "progress" | "question" | "answer" | "result" | "good" | "bad";
export type TimelineEntry = {
  id: string;
  at: string;
  tone: TimelineTone;
  /** Orbit-written. */
  title: string;
  /** Executor- or user-written text; render as plain text only. */
  text?: string;
  /** A note the entry links to (artifact_saved: the saved document). */
  noteId?: string;
};

const DECISION_LABELS = { accept: "You accepted the result", request_changes: "You asked for changes", reject: "You declined the result" } as const;

function stateTitle(event: AssignmentEvent): { title: string; tone: TimelineTone } {
  const { fromState: from, toState: to } = event;
  switch (to) {
    case "queued":
      if (from === null) return { title: "Delegated · queued", tone: "neutral" };
      if (from === "failed") return { title: "Retrying · back in the queue", tone: "neutral" };
      if (from === "running") return { title: "Back in the queue after the agent stopped", tone: "neutral" };
      return { title: "Back in the queue", tone: "neutral" };
    case "running":
      return { title: "The agent started working", tone: "progress" };
    case "needs_input":
      return { title: "Waiting for your answer", tone: "question" };
    case "needs_review":
      return { title: "Ready for your review", tone: "result" };
    case "completed":
      return { title: "Completed", tone: "good" };
    case "canceled":
      return { title: "Canceled", tone: "bad" };
    case "failed":
      return { title: "Failed", tone: "bad" };
    default:
      return { title: "Status changed", tone: "neutral" };
  }
}

const str = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * The timeline, oldest first, from recorded events only: state changes,
 * progress, questions and answers, results, decisions and detachments.
 * Nothing is inferred or invented between events.
 */
export function timelineEntries(
  detail: Pick<AssignmentDetail, "events" | "questions" | "reviews" | "artifacts">,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const event of detail.events) {
    const base = { id: event.id, at: event.createdAt };
    switch (event.type) {
      case "state_changed": {
        const { title, tone } = stateTitle(event);
        const code = str(event.payload.errorCode);
        entries.push({ ...base, title, tone, ...(event.toState === "failed" ? { text: failureCopy(code) } : {}) });
        break;
      }
      case "progress": {
        const text = progressText(event);
        if (text) entries.push({ ...base, tone: "progress", title: "Progress", text });
        break;
      }
      case "question_asked": {
        const question = detail.questions.find((q) => q.id === str(event.payload.questionId));
        entries.push({ ...base, tone: "question", title: "The agent asked", ...(question ? { text: question.prompt } : {}) });
        break;
      }
      case "question_answered": {
        const question = detail.questions.find((q) => q.id === str(event.payload.questionId));
        entries.push({ ...base, tone: "answer", title: "You answered", ...(question?.answer ? { text: question.answer } : {}) });
        break;
      }
      case "artifact_submitted": {
        const artifact = detail.artifacts.find((a) => a.id === str(event.payload.artifactId));
        entries.push({ ...base, tone: "result", title: "The agent submitted a result", ...(artifact?.title ? { text: artifact.title } : {}) });
        break;
      }
      case "review_decided": {
        const decision = str(event.payload.decision);
        const review = detail.reviews.find((r) => r.id === str(event.payload.reviewId));
        const title =
          decision && decision in DECISION_LABELS
            ? DECISION_LABELS[decision as keyof typeof DECISION_LABELS]
            : "You reviewed the result";
        entries.push({
          ...base,
          tone: decision === "accept" ? "good" : decision === "reject" ? "bad" : "answer",
          title,
          ...(review?.comment ? { text: review.comment } : {}),
        });
        break;
      }
      case "cancel_requested":
        entries.push({ ...base, tone: "bad", title: "You canceled this" });
        break;
      case "context_unavailable":
        entries.push({ ...base, tone: "bad", title: "A context item couldn’t be read" });
        break;
      case "artifact_saved": {
        const noteId = str(event.payload.noteId);
        entries.push({ ...base, tone: "good", title: "Saved as a document", ...(noteId ? { noteId } : {}) });
        break;
      }
      case "item_detached":
        entries.push({
          ...base,
          tone: "neutral",
          title:
            str(event.payload.role) === "source"
              ? "The source item moved to another space and was unlinked"
              : "A context item moved to another space and was unlinked",
        });
        break;
    }
  }
  return entries;
}

/** The question waiting for an answer, if any. */
export function openQuestion(detail: Pick<AssignmentDetail, "assignment" | "questions">) {
  if (detail.assignment.state !== "needs_input") return null;
  return [...detail.questions].reverse().find((q) => q.answer === null && q.closedAt === null) ?? null;
}

/** The one result that can be reviewed (newest, not superseded). */
export function reviewableArtifact(detail: Pick<AssignmentDetail, "assignment" | "artifacts">) {
  if (detail.assignment.state !== "needs_review") return null;
  return detail.artifacts.find((a) => a.supersededAt === null) ?? null;
}

/** The item's assignment to show: its active one, else its newest. Lists are newest first. */
export function currentAssignmentFor(assignments: Assignment[], noteId: string): Assignment | null {
  const mine = assignments.filter((a) => a.sourceNoteId === noteId);
  return mine.find((a) => isActiveState(a.state)) ?? mine[0] ?? null;
}

export const itemTitle = (note: Pick<Note, "title"> | undefined) =>
  note ? note.title.trim() || "Untitled thought" : "An item that isn’t loaded";

/** Trimmed outcome and whether it can be sent. */
export function outcomeStatus(value: string) {
  const trimmed = value.trim();
  return {
    length: trimmed.length,
    valid: trimmed.length > 0 && trimmed.length <= OUTCOME_MAX,
    tooLong: trimmed.length > OUTCOME_MAX,
  };
}

export const CONTEXT_RESULTS_MAX = 50;

/**
 * Items the context picker offers: same workspace, not the source, matching
 * the query in the title or text, open items first, then most recently edited.
 */
export function contextOptions(notes: Note[], source: Pick<Note, "id" | "workspaceId">, query: string) {
  const q = query.trim().toLowerCase();
  return notes
    .filter((n) => n.workspaceId === source.workspaceId && n.id !== source.id)
    .filter((n) => !q || n.title.toLowerCase().includes(q) || n.plainText.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(!!a.completedAt) - Number(!!b.completedAt) || b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, CONTEXT_RESULTS_MAX)
    .map((n) => ({ id: n.id, title: itemTitle(n), kind: itemKind(n), done: !!n.completedAt }));
}

/** Adds or removes one id; refuses to add past the limit. */
export function toggleContext(selected: string[], id: string, max = MAX_CONTEXT_ITEMS) {
  if (selected.includes(id)) return { selected: selected.filter((x) => x !== id), refused: false };
  if (selected.length >= max) return { selected, refused: true };
  return { selected: [...selected, id], refused: false };
}
