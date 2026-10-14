import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DRAFTS_KEY,
  ITEM_KINDS,
  applySaveResults,
  createNote,
  exportDocument,
  isNote,
  itemKind,
  mergeServerNotes,
  noteDrafts,
  pendingWrites,
  projectAncestors,
  projectChildren,
  projectDescendants,
  projectLinkError,
  projectsIn,
} from "./notes.ts";
import { AUTH_CHANGED_KEY, announceAuthChange } from "./session.ts";

// localStorage stand-in with key enumeration, as browsers provide.
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
beforeEach(() => store.clear());

const at = (n) => `2026-10-13T00:00:0${n}.000Z`;
const note = (title, patch = {}) => ({ ...createNote(title), ...patch });

test("pending writes carry the synced revision, create-only for new notes, and skip conflicts", () => {
  const saved = note("Saved", { updatedAt: at(2) });
  const fresh = note("New");
  const conflicted = note("Conflicted", { updatedAt: at(3) });
  const synced = new Map([
    [saved.id, { revision: 4, updatedAt: at(1) }],
    [conflicted.id, { revision: 2, updatedAt: at(1) }],
    ["deleted-here", { revision: 7, updatedAt: at(1) }],
    ["deleted-conflicted", { revision: 1, updatedAt: at(1) }],
  ]);
  const { changed, deleted } = pendingWrites(
    [saved, fresh, conflicted],
    synced,
    new Set([conflicted.id, "deleted-conflicted"]),
  );
  assert.deepEqual(
    changed.map((n) => [n.title, n.expectedRevision]),
    [["Saved", 4], ["New", null]],
  );
  assert.deepEqual(deleted, [{ id: "deleted-here", expectedRevision: 7 }]);
});

test("save results record revisions, keep later edits dirty, and surface conflicts", () => {
  const a = note("A", { updatedAt: at(1), expectedRevision: 1 });
  const b = note("B", { updatedAt: at(1), expectedRevision: 3 });
  const c = note("C", { expectedRevision: null });
  const d = note("D", { expectedRevision: 1 });
  const server = note("B (theirs)", { id: b.id, revision: 4 });
  const synced = new Map([[a.id, { revision: 1, updatedAt: at(0) }]]);
  const out = applySaveResults(synced, [a, b, c, d], [
    { id: a.id, status: "saved", revision: 2, updatedAt: at(9) },
    { id: b.id, status: "conflict", expectedRevision: 3, currentRevision: 4, current: server },
    { id: c.id, status: "conflict", expectedRevision: null, currentRevision: 1 },
    { id: d.id, status: "precondition_required" },
  ]);
  // The local updatedAt is kept, so the server's own timestamp does not look like an edit.
  assert.deepEqual(out.synced.get(a.id), { revision: 2, updatedAt: at(1) });
  assert.deepEqual(out.conflicts, [
    { id: b.id, baseRevision: 3, currentRevision: 4, server },
    { id: c.id, baseRevision: null, currentRevision: 1, server: null },
  ]);
  assert.equal(out.failed, true, "precondition_required is retried, not dropped");
  assert.deepEqual(synced.get(a.id), { revision: 1, updatedAt: at(0) }, "input not mutated");
  assert.equal(applySaveResults(synced, [a], []).failed, true, "missing results count as failures");
});

test("merge detects edits made elsewhere before saving, and keeps the local draft", () => {
  const base = note("Base", { revision: 2, updatedAt: at(1) });
  const editedHere = { ...base, title: "Mine", updatedAt: at(5) };
  const theirs = { ...base, title: "Theirs", revision: 3, updatedAt: at(6) };
  const goneLocal = note("Edited, deleted elsewhere", { updatedAt: at(5) });
  const sameRev = note("Same revision", { revision: 1, updatedAt: at(1) });
  const synced = new Map([
    [base.id, { revision: 2, updatedAt: at(1) }],
    [goneLocal.id, { revision: 1, updatedAt: at(1) }],
    [sameRev.id, { revision: 1, updatedAt: at(1) }],
  ]);
  const serverSame = { ...sameRev, updatedAt: "2026-10-13T00:00:01.000Z" };
  const merged = mergeServerNotes([editedHere, goneLocal, sameRev], [theirs, serverSame], synced);
  assert.equal(merged.notes.find((n) => n.id === base.id).title, "Mine");
  assert.ok(merged.notes.includes(goneLocal), "edited note deleted elsewhere is kept");
  assert.ok(merged.notes.includes(sameRev), "same revision keeps the local object");
  assert.deepEqual(merged.conflicts, [
    { id: base.id, baseRevision: 2, currentRevision: 3, server: theirs },
    { id: goneLocal.id, baseRevision: 1, currentRevision: null, server: null },
  ]);
  // Not dirty and the server moved on: adopt the server copy.
  const clean = mergeServerNotes([base], [theirs], synced);
  assert.deepEqual(clean.notes, [theirs]);
  assert.deepEqual(clean.synced.get(base.id), { revision: 3, updatedAt: at(6) });
  assert.deepEqual(clean.conflicts, []);
  // Already-conflicted notes stay local and refresh their server copy.
  const kept = mergeServerNotes([base], [theirs], synced, new Set([base.id]));
  assert.deepEqual(kept.notes, [base]);
  assert.equal(kept.conflicts[0].server, theirs);
});

test("conflicted drafts persist per account and note, and are removed on resolve", () => {
  const local = note("Draft");
  noteDrafts.save("alice", { local, baseRevision: 2, savedAt: at(1) });
  assert.ok(store.has(`${DRAFTS_KEY}:alice:${local.id}`));
  assert.deepEqual(noteDrafts.load("alice"), [
    JSON.parse(JSON.stringify({ local, baseRevision: 2, savedAt: at(1) })),
  ]);
  assert.deepEqual(noteDrafts.load("bob"), []);
  store.set(`${DRAFTS_KEY}:alice:broken`, "{not json");
  assert.equal(noteDrafts.load("alice").length, 1, "unreadable drafts are skipped");
  assert.ok(store.has(`${DRAFTS_KEY}:alice:broken`), "and left in place");
  noteDrafts.remove("alice", local.id);
  assert.equal(noteDrafts.load("alice").length, 0);
});

test("drafts are cleared on sign-out, and other accounts' drafts when one signs in", () => {
  const mine = note("Mine");
  const theirs = note("Theirs");
  noteDrafts.save("alice", { local: mine, baseRevision: 1, savedAt: at(1) });
  noteDrafts.save("bob", { local: theirs, baseRevision: null, savedAt: at(1) });
  store.set("orbit.notes.v1:alice", "[]");
  // The workspace announces the signed-in account.
  announceAuthChange("alice");
  assert.equal(noteDrafts.load("alice").length, 1);
  assert.equal(noteDrafts.load("bob").length, 0);
  assert.ok(store.has(AUTH_CHANGED_KEY));
  // The sign-in page (shown after sign-out) announces no account.
  announceAuthChange();
  assert.equal(noteDrafts.load("alice").length, 0);
  assert.ok(store.has("orbit.notes.v1:alice"), "other browser data is untouched");
});

// --- Kinds and project links (ADR 001) ---------------------------------------

const WS2 = "22222222-2222-4222-8222-222222222222";
const item = (title, kind = "note", projectId = null, workspaceId = "ws") =>
  ({ ...createNote(title, "inbox", workspaceId), kind, projectId });

test("legacy notes without kind or projectId stay valid and read as notes", () => {
  const { kind: _k, projectId: _p, ...legacy } = createNote("Old");
  assert.equal(isNote(legacy), true);
  assert.equal(itemKind(legacy), "note");
  assert.equal(isNote({ ...legacy, kind: "task", projectId: null }), true);
  assert.equal(isNote({ ...legacy, kind: "epic" }), false);
  assert.equal(isNote({ ...legacy, projectId: 3 }), false);
  assert.deepEqual([createNote("New").kind, createNote("New").projectId], ["note", null]);
  assert.deepEqual(ITEM_KINDS, ["note", "task", "project", "document", "followup"]);
});

test("projectLinkError mirrors the database rules", () => {
  const a = item("A", "project");
  const b = item("B", "project", a.id);
  const c = item("C", "project", b.id);
  const task = item("T", "task", c.id);
  const other = item("Elsewhere", "project", null, WS2);
  const notes = [a, b, c, task, other];
  assert.equal(projectLinkError(notes, a.id, a.id), "invalid_project_link", "self");
  assert.equal(projectLinkError(notes, a.id, task.id), "invalid_project_link", "not a project");
  assert.equal(projectLinkError(notes, task.id, other.id), "invalid_project_link", "other workspace");
  assert.equal(projectLinkError(notes, a.id, b.id), "project_cycle", "A→B→A");
  assert.equal(projectLinkError(notes, a.id, c.id), "project_cycle", "A→B→C→A");
  assert.equal(projectLinkError(notes, c.id, null, "task"), "project_has_linked_items");
  assert.equal(projectLinkError(notes, task.id, a.id), null);
  const d = item("D", "project", c.id);
  const e = item("E", "project", d.id);
  const deep = [...notes, d, e];
  assert.equal(projectLinkError(deep, item("F").id, e.id, "project"), "project_depth_exceeded", "a sixth level");
  assert.equal(projectLinkError(deep, task.id, e.id), null, "items attach at any level");
  // Moving a project with its own sub-project counts the subtree.
  const s = item("S", "project");
  const s1 = item("S1", "project", s.id);
  assert.equal(projectLinkError([...deep, s, s1], s.id, d.id), "project_depth_exceeded", "4 above + 1 + 1 below");
  assert.equal(projectLinkError([...deep, s, s1], s.id, c.id), null, "3 above + 1 + 1 below");
  assert.deepEqual(projectAncestors(deep, task.id).map((n) => n.title), ["C", "B", "A"]);
  assert.deepEqual(projectDescendants(deep, a.id).map((d) => [d.note.title, d.depth]),
    [["B", 1], ["C", 2], ["T", 3], ["D", 3], ["E", 4]]);
  assert.deepEqual(projectsIn(deep, "ws").map((n) => n.title), ["A", "B", "C", "D", "E"]);
  assert.deepEqual(projectChildren(deep, c.id).map((n) => n.title), ["T", "D"]);
});

test("saves are ordered parents first and refused link changes are held", () => {
  const parent = item("P", "project");
  const child = item("C", "task", parent.id);
  const unlink = item("U", "task", null);
  const order = pendingWrites([child, parent, unlink], new Map()).changed.map((n) => n.title);
  assert.deepEqual(order, ["U", "P", "C"]);
  const sent = [{ ...child, expectedRevision: null }];
  const applied = applySaveResults(new Map(), sent, [{ id: child.id, status: "invalid", code: "project_cycle" }]);
  assert.deepEqual([applied.failed, applied.rejected], [false, [{ id: child.id, code: "project_cycle", updatedAt: child.updatedAt }]]);
  const held = new Map([[child.id, child.updatedAt]]);
  assert.deepEqual(pendingWrites([child], new Map(), new Set(), held).changed, [], "not resent unchanged");
  const edited = { ...child, updatedAt: at(9) };
  assert.equal(pendingWrites([edited], new Map(), new Set(), held).changed.length, 1, "resent after another edit");
  assert.equal(applySaveResults(new Map(), sent, [{ id: child.id, status: "invalid", code: "invalid_note" }]).failed, true);
});

test("export is version 2 and carries kind and projectId for every note", () => {
  const { kind: _k, projectId: _p, ...legacy } = createNote("Old");
  const parent = item("P", "project");
  const child = item("C", "task", parent.id);
  const doc = exportDocument([legacy, parent, child], "2026-10-14T00:00:00.000Z");
  assert.deepEqual([doc.version, doc.exportedAt], [2, "2026-10-14T00:00:00.000Z"]);
  assert.deepEqual(doc.notes.map((n) => [n.title, n.kind, n.projectId]),
    [["Old", "note", null], ["P", "project", null], ["C", "task", parent.id]]);
  assert.equal(Object.hasOwn(legacy, "kind"), false, "input is not changed");
});
