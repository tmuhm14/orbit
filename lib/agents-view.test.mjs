import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_PAGE,
  HOME_POLL_MS,
  LIST_MAX,
  PAGE_POLL_MS,
  acceptedArtifactId,
  availabilityCopy,
  history,
  historyStates,
  homeAgentSummary,
  homePollDelay,
  inProgress,
  mergeAssignment,
  needsYou,
  nextHistoryLimit,
  pagePollDelay,
  parseAvailability,
  rowTimes,
  safeArtifactDoc,
  saveDocumentBody,
  sourceProject,
} from "./agents-view.ts";
import { createNote } from "./notes.ts";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

const assignment = (id, state, patch = {}) => ({
  id,
  workspaceId: "w1",
  sourceNoteId: "n1",
  requestedOutcome: "Draft a reply",
  executorKind: "builtin",
  capabilities: [],
  state,
  revision: 1,
  currentAttemptId: null,
  maxAttempts: 3,
  errorCode: null,
  createdAt: ago(600),
  updatedAt: ago(60),
  stateChangedAt: ago(60),
  finishedAt: null,
  ...patch,
});
const ids = (list) => list.map((a) => a.id);

test("needs you puts questions first, then whatever has waited longest", () => {
  const list = [
    assignment("review-new", "needs_review", { stateChangedAt: ago(10) }),
    assignment("review-old", "needs_review", { stateChangedAt: ago(500) }),
    assignment("question-new", "needs_input", { stateChangedAt: ago(5) }),
    assignment("question-old", "needs_input", { stateChangedAt: ago(50) }),
    assignment("running", "running"),
    assignment("done", "completed"),
  ];
  assert.deepEqual(ids(needsYou(list)), ["question-old", "question-new", "review-old", "review-new"]);
});

test("in progress lists running work, then the queue oldest first", () => {
  const list = [
    assignment("q-new", "queued", { stateChangedAt: ago(1) }),
    assignment("q-old", "queued", { stateChangedAt: ago(100) }),
    assignment("run", "running", { stateChangedAt: ago(2) }),
    assignment("review", "needs_review"),
  ];
  assert.deepEqual(ids(inProgress(list)), ["run", "q-old", "q-new"]);
});

test("history is newest first and filters by state", () => {
  const list = [
    assignment("c-old", "completed", { finishedAt: ago(900) }),
    assignment("f", "failed", { finishedAt: null, stateChangedAt: ago(100) }),
    assignment("x", "canceled", { finishedAt: ago(10) }),
    assignment("run", "running"),
  ];
  assert.deepEqual(ids(history(list)), ["x", "f", "c-old"]);
  assert.deepEqual(ids(history(list, "failed")), ["f"]);
  assert.deepEqual(ids(history(list, "completed")), ["c-old"]);
  assert.deepEqual(historyStates("all"), ["completed", "failed", "canceled"]);
  assert.deepEqual(historyStates("canceled"), ["canceled"]);
});

test("show more grows the history limit up to the route's cap", () => {
  assert.equal(nextHistoryLimit(HISTORY_PAGE), HISTORY_PAGE * 2);
  assert.equal(nextHistoryLimit(90), LIST_MAX);
  assert.equal(nextHistoryLimit(LIST_MAX), null);
});

test("mergeAssignment replaces by id unless the copy is older, and adds new ones", () => {
  const list = [assignment("a", "running", { revision: 3 }), assignment("b", "queued")];
  assert.equal(mergeAssignment(list, assignment("a", "queued", { revision: 2 })), list);
  const merged = mergeAssignment(list, assignment("a", "needs_review", { revision: 4 }));
  assert.equal(merged[0].state, "needs_review");
  assert.equal(list[0].state, "running");
  assert.deepEqual(ids(mergeAssignment(list, assignment("c", "queued"))), ["c", "a", "b"]);
});

test("row times come from real fields", () => {
  assert.equal(rowTimes(assignment("a", "queued", { stateChangedAt: ago(600) }), NOW), "Delegated 10 min ago");
  assert.equal(rowTimes(assignment("a", "needs_review"), NOW), "Delegated 10 min ago · submitted 1 min ago");
  assert.equal(
    rowTimes(assignment("a", "completed", { finishedAt: ago(3 * 3600) }), NOW),
    "Delegated 10 min ago · finished 3 h ago",
  );
});

test("the page polls only while work is moving and visible, backing off after failures", () => {
  const moving = [assignment("a", "running")];
  const waiting = [assignment("a", "needs_review"), assignment("b", "completed")];
  assert.equal(pagePollDelay(moving), PAGE_POLL_MS);
  assert.equal(pagePollDelay([assignment("a", "queued")]), PAGE_POLL_MS);
  assert.equal(pagePollDelay(moving, { hidden: true }), null);
  assert.equal(pagePollDelay(waiting), null);
  assert.equal(pagePollDelay([]), null);
  assert.equal(pagePollDelay(moving, { failures: 2 }), PAGE_POLL_MS * 4);
  assert.equal(pagePollDelay(moving, { failures: 10 }), 30_000);
  assert.equal(homePollDelay(), HOME_POLL_MS);
  assert.equal(homePollDelay({ hidden: true }), null);
});

test("Home's agent line summarizes open work and hides when there is none", () => {
  assert.equal(homeAgentSummary([]), null);
  assert.equal(
    homeAgentSummary([assignment("a", "completed"), assignment("b", "failed"), assignment("c", "canceled")]),
    null,
  );
  const one = homeAgentSummary([
    assignment("r", "needs_review"),
    assignment("q1", "queued"),
    assignment("w", "running"),
    assignment("d", "completed"),
  ]);
  assert.deepEqual(one, { text: "1 needs your review · 2 in progress", needsYou: 1, inProgress: 2, assignmentId: "r" });
  const many = homeAgentSummary([
    assignment("r1", "needs_review"),
    assignment("r2", "needs_review"),
    assignment("q", "needs_input"),
  ]);
  assert.equal(many.text, "1 question for you · 2 need your review");
  assert.equal(many.assignmentId, null);
  const moving = homeAgentSummary([assignment("w", "running")]);
  assert.deepEqual(moving, { text: "1 in progress", needsYou: 0, inProgress: 1, assignmentId: null });
});

test("availability parses defensively and explains each reason", () => {
  assert.deepEqual(parseAvailability({ available: true }), { available: true });
  assert.deepEqual(parseAvailability({ available: false, reason: "no_key" }), { available: false, reason: "no_key" });
  assert.deepEqual(parseAvailability({ available: false, reason: "surprise" }), { available: false });
  assert.equal(parseAvailability(null), null);
  assert.equal(parseAvailability({ available: "yes" }), null);
  assert.equal(availabilityCopy(null), null);
  assert.equal(availabilityCopy({ available: true }), null);
  assert.equal(availabilityCopy({ available: false, reason: "agent_disabled" }).agent, true);
  assert.equal(availabilityCopy({ available: false, reason: "no_key" }).settings, true);
  assert.match(availabilityCopy({ available: false, reason: "no_key" }).message, /^Turn on the agent/);
  assert.equal(availabilityCopy({ available: false, reason: "key_unreadable" }).settings, true);
  const unknown = availabilityCopy({ available: false });
  assert.ok(unknown.agent && unknown.settings);
});

test("the source's project is the default: its project, itself for a project, or none", () => {
  const project = { ...createNote("Launch", "projects", "w1"), id: "p1", kind: "project" };
  const task = { ...createNote("Write copy", "next", "w1"), id: "t1", kind: "task", projectId: "p1" };
  const loose = { ...createNote("Loose", "inbox", "w1"), id: "l1" };
  const orphan = { ...createNote("Orphan", "inbox", "w1"), id: "o1", projectId: "gone" };
  const notes = [project, task, loose, orphan];
  assert.deepEqual(sourceProject(notes, "t1"), { id: "p1", title: "Launch" });
  assert.deepEqual(sourceProject(notes, "p1"), { id: "p1", title: "Launch" });
  assert.deepEqual(sourceProject(notes, "l1"), { id: null, title: null });
  assert.deepEqual(sourceProject(notes, null), { id: null, title: null });
  assert.deepEqual(sourceProject(notes, "missing"), { id: null, title: null });
  assert.equal(sourceProject(notes, "o1").id, "gone");
});

test("save body: same as source omits projectId, a pick sends it, None sends null", () => {
  const base = { expectedRevision: 7, artifactId: "art", artifactTitle: "Reply draft", title: "Reply draft" };
  assert.deepEqual(saveDocumentBody({ ...base, choice: { mode: "source" } }), { expectedRevision: 7, artifactId: "art" });
  assert.deepEqual(saveDocumentBody({ ...base, choice: { mode: "pick", projectId: "p1" } }), {
    expectedRevision: 7, artifactId: "art", projectId: "p1",
  });
  assert.deepEqual(saveDocumentBody({ ...base, choice: { mode: "pick", projectId: null } }), {
    expectedRevision: 7, artifactId: "art", projectId: null,
  });
  assert.deepEqual(saveDocumentBody({ ...base, title: "  Vendor reply ", choice: { mode: "source" } }), {
    expectedRevision: 7, artifactId: "art", title: "Vendor reply",
  });
  assert.equal(saveDocumentBody({ ...base, title: "   ", choice: { mode: "source" } }).title, undefined);
  assert.equal(saveDocumentBody({ ...base, title: "x".repeat(300), choice: { mode: "source" } }).title.length, 200);
});

test("the accepted artifact comes from the newest accept review", () => {
  assert.equal(acceptedArtifactId([]), null);
  assert.equal(
    acceptedArtifactId([
      { artifactId: "a1", decision: "request_changes" },
      { artifactId: "a2", decision: "accept" },
    ]),
    "a2",
  );
  assert.equal(acceptedArtifactId([{ artifactId: "a1", decision: "reject" }]), null);
});

test("safeArtifactDoc keeps the contract's schema and drops everything else", () => {
  assert.equal(safeArtifactDoc(null), null);
  assert.equal(safeArtifactDoc("hello"), null);
  assert.equal(safeArtifactDoc({ type: "paragraph" }), null);
  assert.equal(safeArtifactDoc({ type: "doc", content: [] }), null);
  const doc = safeArtifactDoc({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 9, id: "x" }, content: [{ type: "text", text: "Title" }] },
      {
        type: "paragraph",
        attrs: { style: "color:red" },
        content: [
          { type: "text", text: "Bold", marks: [{ type: "bold" }, { type: "link", attrs: { href: "javascript:alert(1)" } }] },
          { type: "image", attrs: { src: "https://x" } },
          { type: "text", text: "" },
        ],
      },
      { type: "html", content: [{ type: "text", text: "<script>" }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: "yes" }, content: [{ type: "paragraph" }] }] },
      { type: "bulletList", content: [] },
      { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] }] },
      { type: "horizontalRule", content: [{ type: "text", text: "no" }] },
      { type: "text", text: "stray" },
    ],
  });
  assert.deepEqual(doc, {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Title" }] },
      { type: "paragraph", content: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] }] },
      { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] }] },
      { type: "horizontalRule" },
    ],
  });
  const huge = { type: "doc", content: Array.from({ length: 6000 }, () => ({ type: "paragraph" })) };
  assert.equal(safeArtifactDoc(huge), null);
});
