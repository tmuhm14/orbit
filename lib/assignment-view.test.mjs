import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_COPY,
  FAILURE_COPY,
  STATE_LABELS,
  contextOptions,
  currentAssignmentFor,
  detailPollDelay,
  errorCopy,
  failureCopy,
  itemPollDelay,
  lastUpdateAt,
  latestProgress,
  openQuestion,
  outcomeStatus,
  refetchOn,
  reviewableArtifact,
  sinceLabel,
  statusLine,
  timelineEntries,
  toggleContext,
  viewActions,
} from "./assignment-view.ts";
import { ASSIGNMENT_STATES, FAILURE_CODES, MAX_CONTEXT_ITEMS, OUTCOME_MAX } from "./assignments/transitions.ts";
import { createNote } from "./notes.ts";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

const assignment = (patch = {}) => ({
  id: "a1",
  workspaceId: "w1",
  sourceNoteId: "n1",
  requestedOutcome: "Draft a reply",
  executorKind: "builtin",
  capabilities: [],
  state: "queued",
  revision: 1,
  currentAttemptId: null,
  maxAttempts: 1,
  errorCode: null,
  createdAt: ago(600),
  updatedAt: ago(600),
  stateChangedAt: ago(600),
  finishedAt: null,
  ...patch,
});
const event = (id, type, patch = {}) => ({
  id,
  attemptId: null,
  type,
  actor: "system",
  fromState: null,
  toState: null,
  payload: {},
  createdAt: ago(100),
  ...patch,
});
const detail = (patch = {}) => ({
  assignment: assignment(),
  context: [],
  attempts: [],
  events: [],
  questions: [],
  artifacts: [],
  reviews: [],
  ...patch,
});

test("every state has a label", () => {
  for (const state of ASSIGNMENT_STATES) assert.ok(STATE_LABELS[state]);
});

test("actions follow the transitions mirror", () => {
  assert.deepEqual(viewActions("queued"), { cancel: true, retry: false, answer: false, review: false });
  assert.deepEqual(viewActions("running"), { cancel: true, retry: false, answer: false, review: false });
  assert.deepEqual(viewActions("needs_input"), { cancel: true, retry: false, answer: true, review: false });
  // A result waiting for review is declined with Reject, not Cancel.
  assert.deepEqual(viewActions("needs_review"), { cancel: false, retry: false, answer: false, review: true });
  assert.deepEqual(viewActions("failed"), { cancel: false, retry: true, answer: false, review: false });
  for (const state of ["completed", "canceled"])
    assert.deepEqual(viewActions(state), { cancel: false, retry: false, answer: false, review: false });
});

test("the detail polls every 2s only while queued or running and visible, backing off on errors", () => {
  assert.equal(detailPollDelay("queued"), 2000);
  assert.equal(detailPollDelay("running"), 2000);
  for (const state of ["needs_input", "needs_review", "completed", "failed", "canceled"])
    assert.equal(detailPollDelay(state), null);
  assert.equal(detailPollDelay(null), null);
  assert.equal(detailPollDelay("running", { hidden: true }), null);
  assert.equal(detailPollDelay("running", { failures: 1 }), 4000);
  assert.equal(detailPollDelay("running", { failures: 2 }), 8000);
  assert.equal(detailPollDelay("running", { failures: 10 }), 30000);
});

test("the item chip refreshes slowly while work is moving", () => {
  assert.equal(itemPollDelay("running"), 15000);
  assert.equal(itemPollDelay("queued"), 15000);
  assert.equal(itemPollDelay("needs_input"), null);
  assert.equal(itemPollDelay("running", { hidden: true }), null);
  assert.equal(itemPollDelay(null), null);
});

test("relative times are honest and short", () => {
  assert.equal(sinceLabel(ago(2), NOW), "just now");
  assert.equal(sinceLabel(ago(12), NOW), "12s ago");
  assert.equal(sinceLabel(ago(180), NOW), "3 min ago");
  assert.equal(sinceLabel(ago(7200), NOW), "2 h ago");
  assert.equal(sinceLabel(null, NOW), "");
  assert.equal(sinceLabel("nonsense", NOW), "");
  // A clock slightly ahead never shows a negative time.
  assert.equal(sinceLabel(new Date(NOW + 3000).toISOString(), NOW), "just now");
});

test("the last update is the newest real signal: state change, event or heartbeat", () => {
  const d = detail({
    assignment: assignment({ state: "running", currentAttemptId: "t1", stateChangedAt: ago(60) }),
    attempts: [{ id: "t1", heartbeatAt: ago(12) }, { id: "old", heartbeatAt: ago(1) }],
    events: [event("e1", "progress", { createdAt: ago(30), payload: { text: "Reading" } })],
  });
  assert.equal(lastUpdateAt(d), ago(12));
  assert.deepEqual(statusLine(d, NOW), { label: "Working", since: "last update 12s ago" });
  assert.equal(statusLine(detail(), NOW).label, "Queued");
  assert.equal(statusLine(detail({ assignment: assignment({ state: "failed", finishedAt: ago(5) }) }), NOW).since, "5s ago");
});

test("latest progress is shown only for the current run", () => {
  const running = assignment({ state: "running" });
  const events = [
    event("e1", "progress", { payload: { text: "  First pass  " } }),
    event("e2", "state_changed", { toState: "needs_input" }),
    event("e3", "state_changed", { toState: "running" }),
  ];
  assert.equal(latestProgress(detail({ assignment: running, events })), null);
  events.push(event("e4", "progress", { payload: { text: "x".repeat(400) } }));
  assert.equal(latestProgress(detail({ assignment: running, events })).length, 280);
  assert.equal(latestProgress(detail({ assignment: assignment({ state: "queued" }), events })), null);
  assert.equal(latestProgress(detail({ assignment: running, events: [event("e5", "progress", { payload: { text: 5 } })] })), null);
});

test("every route error code and failure code has friendly copy", () => {
  const codes = [
    "invalid_payload", "unauthenticated", "forbidden_origin", "not_found", "revision_conflict",
    "invalid_transition", "active_assignment_exists", "artifact_superseded", "invalid_context",
    "capability_denied", "agent_disabled", "payload_too_large", "load_failed", "save_failed",
    "not_configured", "network_error", "unexpected_response",
  ];
  assert.deepEqual(Object.keys(ERROR_COPY).sort(), [...codes].sort());
  for (const code of codes) assert.ok(errorCopy(code).message);
  assert.deepEqual(errorCopy("agent_disabled"), { message: "Turn on the agent and save a model key", action: "settings" });
  assert.equal(errorCopy("active_assignment_exists").action, "existing");
  assert.equal(errorCopy("unauthenticated").action, "reload");
  assert.equal(errorCopy("whatever").action, "retry");
  assert.ok(refetchOn("revision_conflict"));
  assert.ok(refetchOn("invalid_transition"));
  assert.ok(!refetchOn("agent_disabled"));
  assert.deepEqual(Object.keys(FAILURE_COPY).sort(), [...FAILURE_CODES].sort());
  assert.ok(failureCopy("timed_out").includes("stopped"));
  assert.ok(failureCopy(null));
  assert.ok(failureCopy("unknown_code"));
});

test("the timeline is built from recorded events only", () => {
  const d = detail({
    events: [
      event("e1", "state_changed", { toState: "queued" }),
      event("e2", "state_changed", { fromState: "queued", toState: "running" }),
      event("e3", "progress", { payload: { text: "Reading the vendor thread" } }),
      event("e4", "progress", { payload: {} }),
      event("e5", "question_asked", { payload: { questionId: "q1" } }),
      event("e6", "state_changed", { fromState: "running", toState: "needs_input" }),
      event("e7", "question_answered", { payload: { questionId: "q1" } }),
      event("e8", "artifact_submitted", { payload: { artifactId: "r1" } }),
      event("e9", "review_decided", { payload: { decision: "request_changes", reviewId: "v1" } }),
      event("e10", "state_changed", { fromState: "running", toState: "failed", payload: { errorCode: "timed_out" } }),
      event("e11", "state_changed", { fromState: "failed", toState: "queued" }),
      event("e12", "cancel_requested"),
      event("e13", "item_detached", { payload: { noteId: "n1", role: "source" } }),
      event("e14", "item_detached", { payload: { noteId: "n2", role: "context" } }),
      event("e15", "context_unavailable"),
    ],
    questions: [{ id: "q1", prompt: "Formal or casual?", answer: "Formal" }],
    artifacts: [{ id: "r1", title: "Reply draft" }],
    reviews: [{ id: "v1", comment: "Shorter" }],
  });
  const entries = timelineEntries(d);
  assert.deepEqual(
    entries.map((e) => [e.id, e.title, e.text]),
    [
      ["e1", "Delegated · queued", undefined],
      ["e2", "The agent started working", undefined],
      ["e3", "Progress", "Reading the vendor thread"],
      ["e5", "The agent asked", "Formal or casual?"],
      ["e6", "Waiting for your answer", undefined],
      ["e7", "You answered", "Formal"],
      ["e8", "The agent submitted a result", "Reply draft"],
      ["e9", "You asked for changes", "Shorter"],
      ["e10", "Failed", FAILURE_COPY.timed_out],
      ["e11", "Retrying · back in the queue", undefined],
      ["e12", "You canceled this", undefined],
      ["e13", "The source item moved to another space and was unlinked", undefined],
      ["e14", "A context item moved to another space and was unlinked", undefined],
      ["e15", "A context item couldn’t be read", undefined],
    ],
  );
  assert.deepEqual(timelineEntries(detail()), []);
});

test("open questions and reviewable results depend on the state", () => {
  const questions = [
    { id: "q1", answer: "Yes", closedAt: null },
    { id: "q2", answer: null, closedAt: null },
  ];
  assert.equal(openQuestion(detail({ assignment: assignment({ state: "needs_input" }), questions })).id, "q2");
  assert.equal(openQuestion(detail({ assignment: assignment({ state: "running" }), questions })), null);
  const artifacts = [
    { id: "new", supersededAt: null },
    { id: "old", supersededAt: ago(10) },
  ];
  assert.equal(reviewableArtifact(detail({ assignment: assignment({ state: "needs_review" }), artifacts })).id, "new");
  assert.equal(reviewableArtifact(detail({ assignment: assignment({ state: "completed" }), artifacts })), null);
});

test("an item shows its active assignment, else its newest", () => {
  const list = [
    assignment({ id: "newest", state: "canceled" }),
    assignment({ id: "active", state: "running" }),
    assignment({ id: "other", sourceNoteId: "n2", state: "queued" }),
  ];
  assert.equal(currentAssignmentFor(list, "n1").id, "active");
  assert.equal(currentAssignmentFor(list.slice(0, 1), "n1").id, "newest");
  assert.equal(currentAssignmentFor(list, "n3"), null);
});

test("outcomes are trimmed and limited like the API", () => {
  assert.deepEqual(outcomeStatus("   "), { length: 0, valid: false, tooLong: false });
  assert.equal(outcomeStatus("  Draft it  ").length, 8);
  assert.equal(outcomeStatus("x".repeat(OUTCOME_MAX)).valid, true);
  assert.equal(outcomeStatus("x".repeat(OUTCOME_MAX + 1)).tooLong, true);
});

test("context options stay in the workspace, exclude the source and match the query", () => {
  const item = (title, patch = {}) => ({ ...createNote(title, "inbox", "w1"), ...patch });
  const source = item("Vendor reply");
  const notes = [
    source,
    item("Vendor contract", { updatedAt: ago(50) }),
    item("Old vendor call", { updatedAt: ago(10), completedAt: ago(5) }),
    item("Groceries", { plainText: "vendor of apples", updatedAt: ago(20) }),
    item("Vendor elsewhere", { workspaceId: "w2" }),
    item("   ", { updatedAt: ago(1) }),
  ];
  assert.deepEqual(
    contextOptions(notes, source, "vendor").map((o) => o.title),
    ["Groceries", "Vendor contract", "Old vendor call"],
  );
  const all = contextOptions(notes, source, "");
  assert.equal(all.length, 4);
  assert.equal(all[0].title, "Untitled thought");
  assert.ok(all.every((o) => o.id !== source.id));
});

test("context selection toggles and stops at the limit", () => {
  assert.deepEqual(toggleContext([], "a"), { selected: ["a"], refused: false });
  assert.deepEqual(toggleContext(["a", "b"], "a"), { selected: ["b"], refused: false });
  const full = Array.from({ length: MAX_CONTEXT_ITEMS }, (_, i) => `n${i}`);
  assert.deepEqual(toggleContext(full, "extra"), { selected: full, refused: true });
  assert.equal(toggleContext(full, "n3").selected.length, MAX_CONTEXT_ITEMS - 1);
});
