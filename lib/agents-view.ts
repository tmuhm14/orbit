// Pure display logic for the Agents page, Home's agent line, delegate
// availability, saving an accepted result as a document (U-05) and the
// read-only result preview. Nothing here logs or sends outcomes, results or
// item content.
import type { AssignmentState } from "./assignments/transitions.ts";
import type {
  Assignment,
  AssignmentUnavailableReason,
  SaveDocumentInput,
} from "./assignments/types.ts";
import { itemKind, type Note } from "./notes.ts";
import { sinceLabel } from "./assignment-view.ts";

// --- Agents page groups ------------------------------------------------------

export const NEEDS_YOU_STATES: readonly AssignmentState[] = ["needs_input", "needs_review"];
export const IN_PROGRESS_STATES: readonly AssignmentState[] = ["queued", "running"];
export const HISTORY_STATES: readonly AssignmentState[] = ["completed", "failed", "canceled"];
/** Everything that isn't history: what the page and Home load in one request. */
export const OPEN_STATES: readonly AssignmentState[] = [...NEEDS_YOU_STATES, ...IN_PROGRESS_STATES];

export type HistoryFilter = "all" | "completed" | "failed" | "canceled";
export const HISTORY_FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
  { id: "canceled", label: "Canceled" },
];
export const historyStates = (filter: HistoryFilter): AssignmentState[] =>
  filter === "all" ? [...HISTORY_STATES] : [filter];

export const HISTORY_PAGE = 20;
/** The list route's own limit. */
export const LIST_MAX = 100;
/** The next history limit for "Show more", or null at the route's cap. */
export const nextHistoryLimit = (limit: number) => (limit >= LIST_MAX ? null : Math.min(LIST_MAX, limit + HISTORY_PAGE));

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(at) ? 0 : at;
};
const byTime = (pick: (a: Assignment) => string | null | undefined, newestFirst: boolean) =>
  (a: Assignment, b: Assignment) =>
    (newestFirst ? time(pick(b)) - time(pick(a)) : time(pick(a)) - time(pick(b))) || a.id.localeCompare(b.id);

/**
 * "Needs you", most urgent first: questions before reviews (a question blocks
 * the agent; a review only waits for you), then whatever has waited longest.
 */
export function needsYou<T extends Assignment>(list: T[]): T[] {
  const oldest = byTime((a) => a.stateChangedAt, false);
  return list
    .filter((a) => NEEDS_YOU_STATES.includes(a.state))
    .sort((a, b) => Number(a.state !== "needs_input") - Number(b.state !== "needs_input") || oldest(a, b));
}

/** "In progress": working first, then the queue in the order it will run (oldest first). */
export function inProgress<T extends Assignment>(list: T[]): T[] {
  const oldest = byTime((a) => a.stateChangedAt, false);
  return list
    .filter((a) => IN_PROGRESS_STATES.includes(a.state))
    .sort((a, b) => Number(a.state !== "running") - Number(b.state !== "running") || oldest(a, b));
}

/** "History": finished work, newest first, optionally one state only. */
export function history<T extends Assignment>(list: T[], filter: HistoryFilter = "all"): T[] {
  const states = historyStates(filter);
  return list
    .filter((a) => states.includes(a.state))
    .sort(byTime((a) => a.finishedAt ?? a.stateChangedAt, true));
}

/**
 * Merges a fresher copy (from the detail dialog) into a list: replaces the
 * same id when the revision is at least as new, otherwise leaves the list.
 */
export function mergeAssignment<T extends Assignment>(list: T[], next: T): T[] {
  const index = list.findIndex((a) => a.id === next.id);
  if (index === -1) return [next, ...list];
  if (list[index].revision > next.revision) return list;
  const copy = [...list];
  copy[index] = next;
  return copy;
}

/** Relative times for a row: "Delegated 3 min ago · Answered just now" style, from real fields only. */
export function rowTimes(a: Assignment, now: number): string {
  const delegated = `Delegated ${sinceLabel(a.createdAt, now)}`;
  const changed = sinceLabel(a.finishedAt ?? a.stateChangedAt, now);
  const verb: Record<AssignmentState, string> = {
    queued: "queued",
    running: "started",
    needs_input: "asked",
    needs_review: "submitted",
    completed: "finished",
    failed: "stopped",
    canceled: "canceled",
  };
  if (!changed || a.stateChangedAt === a.createdAt) return delegated;
  return `${delegated} · ${verb[a.state]} ${changed}`;
}

/** What the row's button says the next step is. */
export const ROW_ACTION: Partial<Record<AssignmentState, string>> = {
  needs_input: "Answer",
  needs_review: "Review",
};

/** The page polls only while work is moving and the tab is visible. */
export const PAGE_POLL_MS = 5_000;
export function pagePollDelay(
  list: Assignment[],
  { hidden = false, failures = 0 }: { hidden?: boolean; failures?: number } = {},
): number | null {
  if (hidden || !list.some((a) => IN_PROGRESS_STATES.includes(a.state))) return null;
  return Math.min(30_000, PAGE_POLL_MS * 2 ** Math.max(0, failures));
}

/** Home checks gently while visible: new work can arrive from any device. */
export const HOME_POLL_MS = 30_000;
export const homePollDelay = ({ hidden = false }: { hidden?: boolean } = {}) => (hidden ? null : HOME_POLL_MS);

// --- Home summary -------------------------------------------------------------

export type HomeAgentSummary = {
  /** "1 needs your review · 2 in progress" */
  text: string;
  needsYou: number;
  inProgress: number;
  /** Open this assignment directly when exactly one needs you; otherwise the page. */
  assignmentId: string | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Home's agent line from real assignments in the workspace, or null to hide
 * the line (nothing open). Failed and finished work never shows here.
 */
export function homeAgentSummary(list: Assignment[]): HomeAgentSummary | null {
  const questions = list.filter((a) => a.state === "needs_input");
  const reviews = list.filter((a) => a.state === "needs_review");
  const moving = list.filter((a) => IN_PROGRESS_STATES.includes(a.state));
  if (!questions.length && !reviews.length && !moving.length) return null;
  const parts = [
    questions.length && plural(questions.length, "question for you", "questions for you"),
    reviews.length && `${reviews.length} ${reviews.length === 1 ? "needs" : "need"} your review`,
    moving.length && `${moving.length} in progress`,
  ].filter(Boolean);
  const waiting = needsYou(list);
  return {
    text: parts.join(" · "),
    needsYou: waiting.length,
    inProgress: moving.length,
    assignmentId: waiting.length === 1 ? waiting[0].id : null,
  };
}

// --- Availability -------------------------------------------------------------

export type AvailabilityReason = AssignmentUnavailableReason;
/** AssignmentAvailability, read defensively: an unknown reason is kept as "unavailable". */
export type Availability = { available: boolean; reason?: AvailabilityReason };

export const AVAILABILITY_COPY: Record<AvailabilityReason, { message: string; agent: boolean; settings: boolean }> = {
  agent_disabled: { message: "Turn on the agent for this space to delegate.", agent: true, settings: false },
  no_key: { message: "Turn on the agent by saving a model key in Settings.", agent: false, settings: true },
  key_unreadable: { message: "Orbit can’t read your saved model key. Save it again in Settings to delegate.", agent: false, settings: true },
};

/** Friendly copy for an unavailable agent, or null when delegation can go ahead (or isn't known yet). */
export function availabilityCopy(value: Availability | null) {
  if (!value || value.available) return null;
  return value.reason && value.reason in AVAILABILITY_COPY
    ? AVAILABILITY_COPY[value.reason]
    : { message: "Turn on the agent and save a model key to delegate.", agent: true, settings: true };
}

/** Parses the availability body defensively; anything unexpected reads as unknown (null). */
export function parseAvailability(body: unknown): Availability | null {
  if (!body || typeof body !== "object") return null;
  const { available, reason } = body as { available?: unknown; reason?: unknown };
  if (typeof available !== "boolean") return null;
  if (available) return { available: true };
  return typeof reason === "string" && reason in AVAILABILITY_COPY
    ? { available: false, reason: reason as AvailabilityReason }
    : { available: false };
}

// --- Save as document ----------------------------------------------------------

export const DOCUMENT_TITLE_MAX = 200;

/** Where the source item would put the document: its project, or itself when it is a project. */
export function sourceProject(notes: Note[], sourceNoteId: string | null): { id: string | null; title: string | null } {
  const source = sourceNoteId ? notes.find((n) => n.id === sourceNoteId) : undefined;
  if (!source) return { id: null, title: null };
  const id = itemKind(source) === "project" ? source.id : (source.projectId ?? null);
  if (!id) return { id: null, title: null };
  const project = notes.find((n) => n.id === id);
  return { id, title: project ? project.title.trim() || "Untitled project" : "A project that isn’t loaded" };
}

/** "Same as source" (the server picks), or an explicit project or none. */
export type ProjectChoice = { mode: "source" } | { mode: "pick"; projectId: string | null };

export type SaveDocumentBody = SaveDocumentInput;

/**
 * The save-document request. "Same as source" omits projectId so the server
 * applies its default; a pick sends the id, and None sends null. A title the
 * same as the result's is omitted too.
 */
export function saveDocumentBody(
  { expectedRevision, artifactId, artifactTitle, title, choice }: {
    expectedRevision: number;
    artifactId: string;
    artifactTitle: string;
    title: string;
    choice: ProjectChoice;
  },
): SaveDocumentBody {
  const trimmed = title.trim().slice(0, DOCUMENT_TITLE_MAX);
  return {
    expectedRevision,
    artifactId,
    ...(choice.mode === "pick" ? { projectId: choice.projectId } : {}),
    ...(trimmed && trimmed !== artifactTitle.trim() ? { title: trimmed } : {}),
  };
}

/** The result that was accepted (and so can be saved), from the reviews. */
export function acceptedArtifactId(reviews: { artifactId: string; decision: string }[]): string | null {
  return [...reviews].reverse().find((r) => r.decision === "accept")?.artifactId ?? null;
}

// --- Read-only result preview -------------------------------------------------

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: { type: string }[] };

const BLOCKS = new Set([
  "paragraph", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem",
  "blockquote", "codeBlock", "horizontalRule",
]);
const MARKS = new Set(["bold", "italic", "code"]);
const INLINE_HOLDERS = new Set(["paragraph", "heading", "codeBlock"]);
const NEEDS_CONTENT = new Set(["bulletList", "orderedList", "taskList", "listItem", "taskItem", "blockquote"]);
const MAX_NODES = 5_000;

/**
 * The artifact's Tiptap document limited to the contract's schema
 * (docs/api/assignments.md): known nodes and marks only, attributes reduced
 * to heading level, list start and task checked, everything else dropped.
 * Returns null when the content isn't a usable document, so the caller can
 * fall back to plain text.
 */
export function safeArtifactDoc(content: unknown): { type: "doc"; content: Node[] } | null {
  if (!content || typeof content !== "object" || (content as Node).type !== "doc") return null;
  let count = 0;
  const clean = (node: unknown): Node | null => {
    if (++count > MAX_NODES || !node || typeof node !== "object") return null;
    const { type, attrs, content: children, text, marks } = node as Node;
    if (type === "text") {
      if (typeof text !== "string" || !text) return null;
      const kept = Array.isArray(marks)
        ? marks.filter((m) => m && MARKS.has(m.type)).map((m) => ({ type: m.type }))
        : [];
      return kept.length ? { type, text, marks: kept } : { type, text };
    }
    if (typeof type !== "string" || !BLOCKS.has(type)) return null;
    const out: Node = { type };
    if (type === "heading") {
      const level = Number(attrs?.level);
      out.attrs = { level: level >= 1 && level <= 3 ? Math.round(level) : 3 };
    } else if (type === "orderedList" && Number.isInteger(attrs?.start)) {
      out.attrs = { start: Math.max(0, attrs!.start as number) };
    } else if (type === "taskItem") {
      out.attrs = { checked: attrs?.checked === true };
    }
    if (Array.isArray(children) && type !== "horizontalRule") {
      // Text lives only in paragraphs, headings and code; containers hold blocks.
      const inline = INLINE_HOLDERS.has(type);
      const kept = children
        .map(clean)
        .filter((c): c is Node => c !== null && (c.type === "text") === inline);
      if (kept.length) out.content = kept;
    }
    if (NEEDS_CONTENT.has(type) && !out.content) return null;
    return out;
  };
  const children = Array.isArray((content as Node).content) ? (content as Node).content! : [];
  const blocks = children.map(clean).filter((c): c is Node => c !== null && c.type !== "text");
  if (count > MAX_NODES || !blocks.length) return null;
  return { type: "doc", content: blocks };
}
