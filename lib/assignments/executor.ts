import {
  ProviderError,
  type AgentMessage,
  type ModelProvider,
  type ProviderId,
  type ToolCall,
} from "@/lib/agent/providers";
import {
  ASSIGNMENT_HEARTBEAT_SECONDS,
  ASSIGNMENT_LEASE_SECONDS,
  type AssignmentState,
  type FailureCode,
} from "./transitions";
import {
  ASK_TOOL,
  RESULT_MARKDOWN_MAX,
  RESULT_TITLE_MAX,
  SUBMIT_TOOL,
  executorMessages,
  executorTools,
  promptNonce,
  type IntentEntry,
  type PromptItem,
} from "./executor-prompt";
import { markdownToDoc, type TiptapDoc } from "./markdown";

// The built-in preparation executor (A-02; ADR 003 §7, ADR 005 tier 2). One
// call runs one attempt of one queued built-in assignment:
//   claim (lease) → load the source and selected context → model turns with
//   heartbeats → submit an artifact, ask one question, or fail with a
//   normalized code.
// The executor has no write access to items and no tools beyond
// submit_result and ask_question; every write is an executor RPC fenced by
// the lease token, so a cancel, expiry or newer attempt stops it (lease_lost)
// and nothing more is written.
// I/O goes through ExecutorStore and the provider factory, so this module has
// no Supabase or Next.js dependency. It never logs or stores content: logs and
// progress carry ids, counts, fixed phrases and codes only.

/** Most model calls per attempt. */
export const EXECUTOR_MAX_TURNS = 4;
/** Most output tokens per model call. */
export const EXECUTOR_MAX_OUTPUT_TOKENS_PER_TURN = 4_096;
/** Most output tokens per attempt, summed over the turns the provider reports. */
export const EXECUTOR_MAX_OUTPUT_TOKENS = 12_000;
/**
 * Wall-clock budget per attempt. The kickoff routes allow 300 s
 * (maxDuration); this leaves a minute for the claim, loads and final write.
 */
export const EXECUTOR_WALL_CLOCK_MS = 240_000;
/** A model turn isn't started with less time than this left. */
export const EXECUTOR_MIN_TURN_MS = 15_000;
/** An attempt isn't claimed with less of the caller's time left than this. */
export const EXECUTOR_MIN_START_MS = 60_000;
/** Questions an assignment may ask over all its attempts. */
export const EXECUTOR_MAX_QUESTIONS = 2;
/** Longest question accepted from the model (the database allows 2000). */
export const EXECUTOR_QUESTION_MAX = 500;
/** Most ids an artifact can cite (the source plus 20 context items). */
export const EXECUTOR_MAX_CITED = 21;

export type ExecutorAssignment = {
  id: string;
  userId: string;
  workspaceId: string;
  state: AssignmentState;
  executorKind: "builtin" | "external";
  sourceNoteId: string | null;
  requestedOutcome: string;
};

export type ExecutorSettings = { provider: ProviderId; model: string; apiKey: string | null };

export type ExecutorLease = { attemptId: string; leaseToken: string };

/** What the executor reads for one attempt (minimum necessary). */
export type ExecutorMaterial = {
  /** Source item first (when it still exists), then context in selection order. */
  items: PromptItem[];
  /** Context rows the user selected, including deleted ones. */
  selectedCount: number;
  /** Outcome, then answers and change requests, oldest first. */
  intent: IntentEntry[];
  /** The latest artifact, when changes were requested after it. */
  previousResult: { title: string; text: string } | null;
  /** Questions asked so far on this assignment. */
  questionCount: number;
};

export type ArtifactInput = {
  kind: "draft" | "summary";
  title: string;
  content: TiptapDoc;
  plain_text: string;
  source_note_ids: string[];
};

export type ClaimStatus =
  | { status: "claimed"; lease: ExecutorLease }
  | { status: "not_queued" | "executor_busy" | "agent_disabled" | "not_found" };

/**
 * Database access for the executor. Each method maps to one query or one
 * executor RPC (ADR 003 §5) and throws only on transport errors.
 */
export interface ExecutorStore {
  loadAssignment(id: string): Promise<ExecutorAssignment | null>;
  /** workspaces.agent_enabled, re-read at each step boundary (ADR 004 §3). */
  agentEnabled(assignment: ExecutorAssignment): Promise<boolean>;
  loadSettings(userId: string): Promise<ExecutorSettings | null>;
  loadMaterial(assignment: ExecutorAssignment): Promise<ExecutorMaterial>;
  claim(id: string, leaseSeconds: number): Promise<ClaimStatus>;
  heartbeat(lease: ExecutorLease, progress: string | null): Promise<"ok" | "lease_lost" | "invalid_payload">;
  ask(lease: ExecutorLease, prompt: string): Promise<"asked" | "lease_lost" | "invalid_payload">;
  submit(
    lease: ExecutorLease,
    artifact: ArtifactInput,
  ): Promise<"submitted" | "lease_lost" | "invalid_payload" | "invalid_context">;
  fail(lease: ExecutorLease, code: FailureCode): Promise<"saved" | "lease_lost" | "invalid_payload">;
  /** T15 for a queued assignment whose executor is unavailable. */
  failSystem(id: string, code: FailureCode): Promise<"saved" | "not_allowed">;
}

/** Content-free log record: ids, outcome and code only. */
export type ExecutorLogEntry = {
  assignmentId: string;
  attemptId?: string;
  outcome: ExecutionOutcome["outcome"];
  code?: FailureCode;
};

export type ExecutorDeps = {
  store: ExecutorStore;
  createProvider: (settings: ExecutorSettings & { apiKey: string }) => ModelProvider;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  heartbeatMs?: number;
  /** Schedules the per-turn deadline abort; returns a cancel function. */
  setTimer?: (callback: () => void, ms: number) => () => void;
  log?: (entry: ExecutorLogEntry) => void;
};

export type ExecutionOutcome =
  /** Artifact stored; the assignment is in needs_review. */
  | { outcome: "submitted" }
  /** Question stored; the assignment is in needs_input. */
  | { outcome: "asked" }
  /** Attempt failed with a normalized code (assignment failed). */
  | { outcome: "failed"; code: FailureCode }
  /** Failed before claiming: workspace switch off, no key or unreadable key (T15). */
  | { outcome: "unavailable"; code: "executor_unavailable" }
  /** Canceled, expired or superseded mid-run; nothing more was written. */
  | { outcome: "lease_lost" }
  /** Another built-in assignment is running in the workspace; still queued. */
  | { outcome: "busy" }
  /** Not a queued built-in assignment (already claimed, finished or missing). */
  | { outcome: "skipped" };

type Timestamp = string | Date;
const time = (value: Timestamp) => new Date(value).getTime();

export type MaterialRows = {
  assignment: Pick<ExecutorAssignment, "sourceNoteId" | "requestedOutcome">;
  /** assignment_context_items, any order. */
  context: { note_id: string | null; position: number }[];
  /** The source and context notes that still exist in the assignment's workspace. */
  notes: { id: string; title: string; plain_text: string; kind: string | null }[];
  questions: { prompt: string; answer: string | null; answered_at: Timestamp | null }[];
  reviews: { artifact_id: string; decision: string; comment: string | null; decided_at: Timestamp }[];
  /** The artifact previousArtifactId() named, if any. */
  previousArtifact: { title: string; plain_text: string } | null;
};

/** The artifact to revise: the one the latest review asked to change. */
export function previousArtifactId(reviews: MaterialRows["reviews"]): string | null {
  const latest = [...reviews].sort((a, b) => time(a.decided_at) - time(b.decided_at)).at(-1);
  return latest?.decision === "request_changes" ? latest.artifact_id : null;
}

/**
 * Builds the executor's material from rows. Intent is the requested outcome,
 * then answers and change-request comments oldest first (the same order as
 * assignmentIntent() in client.ts); item text is title and plain text only.
 */
export function materialFromRows(rows: MaterialRows): ExecutorMaterial {
  const byId = new Map(rows.notes.map((note) => [note.id, note]));
  const item = (id: string, role: PromptItem["role"]): PromptItem | null => {
    const note = byId.get(id);
    return note
      ? { id, role, title: note.title ?? "", text: note.plain_text ?? "", kind: note.kind ?? "note" }
      : null;
  };
  const context = [...rows.context]
    .sort((a, b) => a.position - b.position)
    .map((row) => (row.note_id ? item(row.note_id, "context") : null));
  const source = rows.assignment.sourceNoteId ? item(rows.assignment.sourceNoteId, "source") : null;
  const timed = [
    ...rows.questions
      .filter((q) => q.answer !== null && q.answered_at !== null)
      .map((q) => ({
        at: time(q.answered_at!),
        entry: { kind: "answer", question: q.prompt, text: q.answer! } as IntentEntry,
      })),
    ...rows.reviews
      .filter((r) => r.decision === "request_changes" && r.comment)
      .map((r) => ({ at: time(r.decided_at), entry: { kind: "change_request", text: r.comment! } as IntentEntry })),
  ].sort((a, b) => a.at - b.at);
  return {
    items: [source, ...context].filter((x): x is PromptItem => x !== null),
    selectedCount: rows.context.length,
    intent: [{ kind: "outcome", text: rows.assignment.requestedOutcome }, ...timed.map((t) => t.entry)],
    previousResult: rows.previousArtifact
      ? { title: rows.previousArtifact.title, text: rows.previousArtifact.plain_text }
      : null,
    questionCount: rows.questions.length,
  };
}

/** Maps a provider failure to an ADR 003 §4 code. Never reads the message. */
export function normalizeProviderError(error: unknown): FailureCode {
  if (!(error instanceof ProviderError)) return "internal";
  if (error.status === 401 || error.status === 403) return "provider_auth";
  if (error.status === 429) return "provider_rate_limited";
  return "provider_unavailable";
}

/** Fixed progress phrases. Only counts are interpolated, never content. */
export const PROGRESS = {
  reading: (n: number) => `Reading ${n} item${n === 1 ? "" : "s"}`,
  unavailable: (n: number) => `${n} selected item${n === 1 ? " is" : "s are"} no longer available`,
  drafting: "Drafting",
  revising: "Revising the previous result",
  continuing: "Still working",
  submitting: "Submitting the result",
  asking: "Asking a question",
} as const;

type SubmitParse = { ok: true; artifact: ArtifactInput } | { ok: false; error: string };

/**
 * Validates submit_result input. Cited ids are limited to the items the
 * executor was given (the RPC enforces the same against the assignment).
 */
export function parseSubmit(input: Record<string, unknown>, allowedIds: ReadonlySet<string>): SubmitParse {
  const kind = input.kind;
  if (kind !== "draft" && kind !== "summary") return { ok: false, error: 'kind must be "draft" or "summary"' };
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return { ok: false, error: "title is required" };
  const markdown = typeof input.markdown === "string" ? input.markdown.trim() : "";
  if (!markdown) return { ok: false, error: "markdown is required" };
  if ([...markdown].length > RESULT_MARKDOWN_MAX)
    return { ok: false, error: `markdown must be at most ${RESULT_MARKDOWN_MAX} characters; shorten it` };
  const cited = Array.isArray(input.cited_ids) ? input.cited_ids : [];
  const ids = [...new Set(cited.filter((id): id is string => typeof id === "string" && allowedIds.has(id)))];
  return {
    ok: true,
    artifact: {
      kind,
      title: [...title].slice(0, RESULT_TITLE_MAX).join(""),
      content: markdownToDoc(markdown),
      plain_text: markdown,
      source_note_ids: ids.slice(0, EXECUTOR_MAX_CITED),
    },
  };
}

const defaultLog = (entry: ExecutorLogEntry) => {
  if (entry.outcome === "failed") console.error("assignment execution failed", entry);
};

function defaultSetTimer(callback: () => void, ms: number) {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
}

function defaultRandomBytes(size: number) {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Runs one attempt of a queued built-in assignment. Never throws. Safe to
 * call more than once for the same assignment: only one caller wins the
 * claim; the others return `skipped` (or `busy`) without calling the model.
 * `deadlineAt` (epoch ms) caps the wall-clock budget when the caller has
 * already used part of its own maxDuration.
 */
export async function executeAssignment(
  deps: ExecutorDeps,
  assignmentId: string,
  options: { deadlineAt?: number } = {},
): Promise<ExecutionOutcome> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const done = (outcome: ExecutionOutcome, attemptId?: string): ExecutionOutcome => {
    log({
      assignmentId,
      ...(attemptId ? { attemptId } : {}),
      outcome: outcome.outcome,
      ...("code" in outcome ? { code: outcome.code } : {}),
    });
    return outcome;
  };

  // 1. Preflight, before any attempt exists.
  let assignment: ExecutorAssignment | null;
  let settings: ExecutorSettings | null;
  let enabled: boolean;
  try {
    assignment = await store.loadAssignment(assignmentId);
    if (!assignment || assignment.executorKind !== "builtin" || assignment.state !== "queued")
      return done({ outcome: "skipped" });
    [enabled, settings] = await Promise.all([
      store.agentEnabled(assignment),
      store.loadSettings(assignment.userId),
    ]);
  } catch {
    // Still queued; the recovery path picks it up again.
    return done({ outcome: "skipped" });
  }
  const unavailable = async () => {
    await store.failSystem(assignmentId, "executor_unavailable").catch(() => "not_allowed");
    return done({ outcome: "unavailable", code: "executor_unavailable" });
  };
  if (!enabled || !settings?.apiKey) return unavailable();
  const apiKey = settings.apiKey;
  // Too little of the caller's time left for a useful attempt: leave it
  // queued for the next kickoff or sweep rather than claim and fail it.
  if ((options.deadlineAt ?? Infinity) - now() < EXECUTOR_MIN_START_MS) return done({ outcome: "skipped" });

  // 2. Claim. claim_assignment allows one running attempt per assignment and
  // one running built-in assignment per workspace.
  let claim: ClaimStatus;
  try {
    claim = await store.claim(assignmentId, ASSIGNMENT_LEASE_SECONDS);
  } catch {
    return done({ outcome: "skipped" });
  }
  if (claim.status === "agent_disabled") return unavailable();
  if (claim.status === "executor_busy") return done({ outcome: "busy" });
  if (claim.status !== "claimed") return done({ outcome: "skipped" });
  const lease = claim.lease;
  const startedAt = now();
  const deadline = Math.min(startedAt + EXECUTOR_WALL_CLOCK_MS, options.deadlineAt ?? Infinity);

  // 3. Heartbeats every 30 s (and with each progress phrase). lease_lost
  // aborts the in-flight model call and stops the run.
  const abort = new AbortController();
  let lost = false;
  let chain: Promise<unknown> = Promise.resolve();
  const beat = (progress: string | null) => {
    const next = chain.then(async () => {
      if (lost) return;
      const result = await store.heartbeat(lease, progress);
      if (result === "lease_lost") {
        lost = true;
        abort.abort();
      }
    });
    chain = next.catch(() => undefined);
    return next;
  };
  const timer = setInterval(() => {
    // A failed heartbeat isn't fatal: the next one may succeed, and if none
    // does the lease expires and the reaper fails the attempt (timed_out).
    beat(null).catch(() => undefined);
  }, deps.heartbeatMs ?? ASSIGNMENT_HEARTBEAT_SECONDS * 1000);
  const stopBeats = async () => {
    clearInterval(timer);
    await chain;
  };
  const progress = async (text: string) => {
    await beat(text).catch(() => undefined);
    return !lost;
  };
  const finishFailed = async (code: FailureCode) => {
    await stopBeats();
    if (lost) return done({ outcome: "lease_lost" }, lease.attemptId);
    try {
      const result = await store.fail(lease, code);
      if (result === "lease_lost") return done({ outcome: "lease_lost" }, lease.attemptId);
    } catch {
      // The lease expires and the reaper records timed_out.
    }
    return done({ outcome: "failed", code }, lease.attemptId);
  };

  const leaseLost = async () => {
    await stopBeats();
    return done({ outcome: "lease_lost" }, lease.attemptId);
  };

  try {
    // 4. Load only the source and the selected context.
    const material = await store.loadMaterial(assignment);
    const contextLoaded = material.items.filter((item) => item.role === "context").length;
    const missing = Math.max(0, material.selectedCount - contextLoaded);
    if (!material.items.length) return await finishFailed("context_unavailable");
    if (!(await progress(PROGRESS.reading(material.items.length)))) return await leaseLost();
    if (missing && !(await progress(PROGRESS.unavailable(missing)))) return await leaseLost();

    const canAsk = material.questionCount < EXECUTOR_MAX_QUESTIONS;
    const { system, messages } = executorMessages({
      intent: material.intent,
      items: material.items,
      unavailableCount: missing,
      previousResult: material.previousResult,
      canAsk,
      nonce: promptNonce((deps.randomBytes ?? defaultRandomBytes)(12)),
    });
    const tools = executorTools(canAsk);
    const allowedIds = new Set(material.items.map((item) => item.id));
    const provider = deps.createProvider({ ...settings, apiKey });
    const conversation: AgentMessage[] = [...messages];
    let outputTokens = 0;

    // Returns the final outcome, or the error text the model gets back to
    // correct on its next turn.
    const handleCall = async (call: ToolCall): Promise<ExecutionOutcome | string> => {
      if (call.name === SUBMIT_TOOL) {
        const parsed = parseSubmit(call.input, allowedIds);
        if (!parsed.ok) return `Error: ${parsed.error}`;
        if (!(await progress(PROGRESS.submitting))) return leaseLost();
        await stopBeats();
        const submitted = await store.submit(lease, parsed.artifact);
        if (submitted === "submitted") return done({ outcome: "submitted" }, lease.attemptId);
        if (submitted === "lease_lost") return done({ outcome: "lease_lost" }, lease.attemptId);
        return finishFailed("internal");
      }
      if (call.name === ASK_TOOL && canAsk) {
        const question = typeof call.input.question === "string" ? call.input.question.trim() : "";
        if (!question || [...question].length > EXECUTOR_QUESTION_MAX)
          return `Error: question must be 1-${EXECUTOR_QUESTION_MAX} characters`;
        if (!(await progress(PROGRESS.asking))) return leaseLost();
        await stopBeats();
        const asked = await store.ask(lease, question);
        if (asked === "asked") return done({ outcome: "asked" }, lease.attemptId);
        if (asked === "lease_lost") return done({ outcome: "lease_lost" }, lease.attemptId);
        return finishFailed("internal");
      }
      return `Error: unknown tool. Use ${SUBMIT_TOOL}${canAsk ? ` or ${ASK_TOOL}` : ""}.`;
    };

    for (let turn = 1; turn <= EXECUTOR_MAX_TURNS; turn++) {
      if (lost) return await leaseLost();
      // Re-check the kill switch at each step boundary (ADR 004 §3).
      if (turn > 1 && !(await store.agentEnabled(assignment))) return await finishFailed("capability_revoked");
      const remaining = deadline - now();
      if (remaining < EXECUTOR_MIN_TURN_MS) return await finishFailed("budget_exhausted");
      const phrase =
        turn > 1 ? PROGRESS.continuing : material.previousResult ? PROGRESS.revising : PROGRESS.drafting;
      if (!(await progress(phrase))) return await leaseLost();

      const clearDeadline = (deps.setTimer ?? defaultSetTimer)(() => abort.abort(), remaining);
      let result;
      try {
        result = await provider.chat({
          system,
          messages: conversation,
          tools,
          maxTokens: Math.min(EXECUTOR_MAX_OUTPUT_TOKENS_PER_TURN, EXECUTOR_MAX_OUTPUT_TOKENS - outputTokens),
          signal: abort.signal,
        });
      } finally {
        clearDeadline();
      }
      if (lost) return await leaseLost();
      outputTokens += result.usage?.outputTokens ?? 0;

      const toolResults: { id: string; content: string }[] = [];
      for (const call of result.calls) {
        const handled = await handleCall(call);
        if (typeof handled !== "string") return handled;
        toolResults.push({ id: call.id, content: handled });
      }
      conversation.push({ role: "assistant", text: result.text, calls: result.calls });
      conversation.push(
        result.calls.length
          ? { role: "tool", results: toolResults }
          : { role: "user", text: `Finish by calling ${SUBMIT_TOOL}${canAsk ? ` (or ${ASK_TOOL})` : ""}.` },
      );
      if (outputTokens >= EXECUTOR_MAX_OUTPUT_TOKENS) return await finishFailed("budget_exhausted");
    }
    return await finishFailed("budget_exhausted");
  } catch (error) {
    if (lost) return leaseLost();
    // An abort at the deadline surfaces as a provider network error.
    if (now() >= deadline || abort.signal.aborted) return finishFailed("budget_exhausted");
    return finishFailed(normalizeProviderError(error));
  } finally {
    clearInterval(timer);
  }
}
