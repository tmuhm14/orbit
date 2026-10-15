import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DRAFTS_KEY,
  ITEM_ERROR_CODES,
  LINK_ERROR_CODES,
  LINK_ERROR_MESSAGES,
  applySaveResults,
  createNote,
  deleteWithUnlink,
  draftPlan,
  hasUnsavedChanges,
  noteDrafts,
  restoreDrafts,
  revertUnlink,
  sameEdits,
  settleIdenticalConflicts,
  withRestored,
} from "./notes.ts";
import { announceAuthChange } from "./session.ts";

// Pure helpers behind useNotes() (there is no React test harness): draft
// restoration under StrictMode's double effects, unsaved edits kept when a
// reload is required or the page is left, the assignment_active code, and
// the local move of a deleted project's items.
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

const USER = "alice";
const at = (n) => `2026-10-13T00:00:0${n}.000Z`;
const note = (title, patch = {}) => ({ ...createNote(title, "inbox", "ws"), ...patch });
const synced = (...notes) => new Map(notes.map((n) => [n.id, { revision: n.revision ?? null, updatedAt: n.updatedAt }]));

/** Applies a draftPlan to storage the way useNotes' syncDrafts() does. */
function apply(plan) {
  for (const d of plan.conflictDrafts) noteDrafts.save(USER, { local: d.local, baseRevision: d.baseRevision, savedAt: at(9) });
  for (const d of plan.unsaved) noteDrafts.save(USER, { local: d.local, baseRevision: d.baseRevision, savedAt: at(9), unsaved: true });
  for (const id of plan.remove) noteDrafts.remove(USER, id);
  return plan;
}
const stored = (id) => JSON.parse(store.get(`${DRAFTS_KEY}:${USER}:${id}`) ?? "null");

// --- assignment_active ------------------------------------------------------------

test("assignment_active is an item error with a message, and saves hold it like link codes", () => {
  assert.ok(ITEM_ERROR_CODES.includes("assignment_active"));
  assert.ok(!LINK_ERROR_CODES.includes("assignment_active"), "the agent's link refusals are unchanged");
  for (const code of ITEM_ERROR_CODES) assert.equal(typeof LINK_ERROR_MESSAGES[code], "string", code);
  assert.match(LINK_ERROR_MESSAGES.assignment_active, /assignment/);
  const moved = { ...note("Moved", { workspaceId: "other" }), expectedRevision: 2 };
  const out = applySaveResults(new Map(), [moved], [{ id: moved.id, status: "invalid", code: "assignment_active" }]);
  assert.deepEqual([out.failed, out.rejected], [false, [{ id: moved.id, code: "assignment_active", updatedAt: moved.updatedAt }]]);
});

// --- Fix 2: StrictMode restoration --------------------------------------------------

test("restoring a conflicted draft survives StrictMode's double effects", () => {
  const server = note("Server copy", { revision: 3, updatedAt: at(1) });
  const draft = { ...server, title: "My edit", revision: 2, updatedAt: at(5) };
  noteDrafts.save(USER, { local: draft, baseRevision: 2, savedAt: at(6) });
  const initial = [server];
  const known = synced(server);
  let conflicts = new Map();
  let restoring = new Map();
  let unsavedStored = new Set();
  const notesEffect = (list) => {
    const plan = apply(draftPlan({ notes: list, synced: known, conflicts, unsavedStored, restoring, persistUnsaved: false }));
    restoring = plan.restoring;
    unsavedStored = plan.stored;
    return plan;
  };
  const mountEffect = () => {
    const result = restoreDrafts(initial, noteDrafts.load(USER));
    restoring = new Map([...restoring, ...result.apply.map((n) => [n.id, n.updatedAt])]);
    conflicts = new Map([...conflicts, ...result.conflicts.map((c) => [c.id, c])]);
    return (list) => withRestored(list, result.apply);
  };
  // Mount, StrictMode cleanup, mount again: both effects run twice with the
  // first render's (server) list.
  notesEffect(initial);
  const first = mountEffect();
  const rerun = notesEffect(initial);
  assert.deepEqual(rerun.conflictDrafts, [], "the server copy is not written over the draft");
  assert.equal(stored(draft.id).local.title, "My edit");
  const second = mountEffect();
  // Both queued updaters run on the next render.
  const rendered = second(first(initial));
  assert.equal(rendered.length, 1, "restored once");
  assert.equal(rendered[0].title, "My edit");
  assert.equal(conflicts.size, 1);
  assert.deepEqual(conflicts.get(draft.id), { id: draft.id, baseRevision: 2, currentRevision: 3, server, detectedAt: at(6) });
  // The render that shows the draft writes it again (as production does) and settles.
  const shown = notesEffect(rendered);
  assert.deepEqual(shown.conflictDrafts.map((d) => d.local.title), ["My edit"]);
  assert.equal(restoring.size, 0);
  assert.equal(stored(draft.id).local.title, "My edit");
  assert.equal(stored(draft.id).unsaved, undefined);
});

test("without StrictMode the plan writes conflict drafts exactly as before", () => {
  const local = note("Mine", { updatedAt: at(5) });
  const plan = draftPlan({ notes: [local], synced: new Map([[local.id, { revision: 1, updatedAt: at(1) }]]),
    conflicts: new Map([[local.id, { baseRevision: 1 }], ["gone", { baseRevision: 2 }]]),
    unsavedStored: new Set(), restoring: new Map(), persistUnsaved: false });
  assert.deepEqual(plan.conflictDrafts, [{ local, baseRevision: 1 }]);
  assert.deepEqual([plan.unsaved, plan.remove], [[], []], "unsaved edits are not written without a reason");
});

test("a deleted-elsewhere draft is appended once, however often it is restored", () => {
  const draft = note("Only here", { updatedAt: at(5) });
  noteDrafts.save(USER, { local: draft, baseRevision: 4, savedAt: at(6) });
  const result = restoreDrafts([], noteDrafts.load(USER));
  assert.deepEqual(result.conflicts.map((c) => [c.id, c.currentRevision, c.server]), [[draft.id, null, null]]);
  const list = withRestored(withRestored([], result.apply), result.apply);
  assert.deepEqual(list.map((n) => n.id), [draft.id]);
});

// --- Fix 3: unsaved edits when a reload is required ---------------------------------

test("unsaved edits are kept when a reload is required, and restored as edits", () => {
  const saved = note("Saved", { revision: 2, updatedAt: at(1) });
  const fresh = note("Never saved", { updatedAt: at(2) });
  const clean = note("Clean", { revision: 1, updatedAt: at(1) });
  const known = synced(saved, clean);
  const edited = { ...saved, title: "Edited", updatedAt: at(4) };
  const conflicted = note("Conflicted", { updatedAt: at(3) });
  const plan = apply(draftPlan({ notes: [edited, fresh, clean, conflicted], synced: known,
    conflicts: new Map([[conflicted.id, { baseRevision: 1 }]]), unsavedStored: new Set(),
    restoring: new Map(), persistUnsaved: true }));
  assert.deepEqual(plan.unsaved.map((d) => [d.local.title, d.baseRevision]).sort(), [["Edited", 2], ["Never saved", null]]);
  assert.ok(plan.unsaved.every((d) => !("expectedRevision" in d.local)));
  assert.deepEqual([...plan.stored].sort(), [edited.id, fresh.id].sort());
  assert.equal(stored(edited.id).unsaved, true);
  assert.equal(stored(conflicted.id).unsaved, undefined, "conflicts keep their own draft");
  assert.equal(stored(clean.id), null);

  // After the reload: the server still has revision 2 and no "Never saved".
  const result = restoreDrafts([saved, clean], noteDrafts.load(USER));
  assert.deepEqual(result.conflicts.map((c) => c.id), [conflicted.id]);
  assert.deepEqual(result.unsaved.sort(), [edited.id, fresh.id].sort());
  const list = withRestored([saved, clean], result.apply);
  assert.equal(list.find((n) => n.id === saved.id).title, "Edited");
  assert.ok(list.some((n) => n.id === fresh.id));
  // They are ordinary pending edits again: sent with the base revision.
  assert.ok(hasUnsavedChanges(list, known, new Set([conflicted.id])));
});

test("restored unsaved drafts: dropped when already saved, conflicts when changed elsewhere", () => {
  const base = note("Base", { revision: 2, updatedAt: at(1), content: { type: "doc", content: [{ type: "paragraph" }] } });
  const mine = { ...base, title: "Mine", updatedAt: at(4) };
  const gone = note("Deleted elsewhere", { updatedAt: at(4) });
  const created = note("Created by the last save", { updatedAt: at(4) });
  for (const [local, baseRevision] of [[mine, 2], [gone, 1], [created, null]])
    noteDrafts.save(USER, { local, baseRevision, savedAt: at(5), unsaved: true });
  const drafts = noteDrafts.load(USER);
  // The server copy already has the edit (saved before the reload), with
  // its own timestamps, revision and jsonb key order.
  const savedCopy = { ...mine, revision: 3, updatedAt: at(8), content: { content: [{ type: "paragraph" }], type: "doc" } };
  const createdCopy = { ...created, revision: 1, updatedAt: at(8) };
  const done = restoreDrafts([savedCopy, createdCopy], drafts);
  assert.deepEqual(done.drop.sort(), [mine.id, created.id].sort());
  assert.deepEqual(done.conflicts.map((c) => [c.id, c.currentRevision]), [[gone.id, null]]);
  // Changed elsewhere since: a conflict, as for any other draft.
  const theirs = { ...base, title: "Theirs", revision: 3, updatedAt: at(8) };
  const changed = restoreDrafts([theirs, createdCopy], drafts.filter((d) => d.local.id === mine.id));
  assert.deepEqual(changed.conflicts.map((c) => [c.id, c.baseRevision, c.currentRevision]), [[mine.id, 2, 3]]);
  assert.deepEqual(changed.unsaved, []);
  // The list could not be loaded: unsaved drafts stay in storage untouched.
  const offline = restoreDrafts([], drafts, { unsaved: false });
  assert.deepEqual([offline.apply, offline.conflicts, offline.drop], [[], [], []]);
});

test("stored unsaved drafts stay current until saved, then go", () => {
  const n = note("N", { revision: 2, updatedAt: at(1) });
  const edited = { ...n, title: "Edited", updatedAt: at(4) };
  let known = synced(n);
  let unsavedStored = new Set([n.id]);
  // Still unsaved, no reload required: the existing draft is kept current.
  const later = { ...edited, title: "Edited again", updatedAt: at(6) };
  let plan = apply(draftPlan({ notes: [later], synced: known, conflicts: new Map(), unsavedStored,
    restoring: new Map(), persistUnsaved: false }));
  assert.equal(stored(n.id).local.title, "Edited again");
  unsavedStored = plan.stored;
  // Saved: removed.
  known = new Map([[n.id, { revision: 3, updatedAt: later.updatedAt }]]);
  plan = apply(draftPlan({ notes: [later], synced: known, conflicts: new Map(), unsavedStored,
    restoring: new Map(), persistUnsaved: false }));
  assert.deepEqual([plan.remove, [...plan.stored]], [[n.id], []]);
  assert.equal(stored(n.id), null);
  // Deleted here: removed too. A pending restore is left alone.
  plan = draftPlan({ notes: [], synced: new Map(), conflicts: new Map(), unsavedStored: new Set(["x", "y"]),
    restoring: new Map([["y", at(1)]]), persistUnsaved: true });
  assert.deepEqual([plan.remove, [...plan.stored]], [["x"], ["y"]]);
});

test("unsaved drafts are account drafts: cleared on sign-out, read as conflicts by older code", () => {
  const n = note("N", { updatedAt: at(4) });
  noteDrafts.save(USER, { local: n, baseRevision: 1, savedAt: at(5), unsaved: true });
  assert.equal(noteDrafts.load(USER).length, 1);
  store.set(`${DRAFTS_KEY}:${USER}:bad`, JSON.stringify({ local: { ...n, id: "bad" }, baseRevision: 1, savedAt: at(5), unsaved: "yes" }));
  assert.equal(noteDrafts.load(USER).length, 1, "a malformed flag is not read");
  // Older code ignores the flag and keeps the draft as a conflict.
  const legacy = noteDrafts.load(USER).map(({ unsaved: _u, ...d }) => d);
  assert.equal(restoreDrafts([], legacy).conflicts.length, 1);
  announceAuthChange();
  assert.equal(noteDrafts.load(USER).length, 0);
});

test("beforeunload warns for any unsaved change, not just conflicts", () => {
  const n = note("N", { revision: 1, updatedAt: at(1) });
  const known = synced(n);
  assert.equal(hasUnsavedChanges([n], known, new Set()), false);
  assert.equal(hasUnsavedChanges([{ ...n, updatedAt: at(2) }], known, new Set()), true, "edited");
  assert.equal(hasUnsavedChanges([n, note("New")], known, new Set()), true, "created");
  assert.equal(hasUnsavedChanges([], known, new Set()), true, "deleted");
  assert.equal(hasUnsavedChanges([n], known, new Set(["c"])), true, "conflicted");
  const refused = { ...n, updatedAt: at(3) };
  assert.equal(hasUnsavedChanges([refused], known, new Set(), new Map([[n.id, at(3)]])), false,
    "a refused change is not pending (it shows its own error)");
});

test("a conflict on a restored unsaved edit the server already has is settled", () => {
  const local = note("Mine", { revision: 2, updatedAt: at(4), completedAt: "2026-10-13T00:00:00Z" });
  const server = { ...local, revision: 3, updatedAt: at(8), completedAt: "2026-10-13T00:00:00.000Z" };
  const other = note("Other", { updatedAt: at(4) });
  const found = [
    { id: local.id, baseRevision: 2, currentRevision: 3, server },
    { id: other.id, baseRevision: 1, currentRevision: 2, server: { ...other, title: "Theirs" } },
  ];
  const out = settleIdenticalConflicts(found, [local, other], new Set([local.id, other.id]));
  assert.deepEqual(out.settled, [{ id: local.id, entry: { revision: 3, updatedAt: at(4) } }]);
  assert.deepEqual(out.conflicts.map((c) => c.id), [other.id]);
  assert.equal(settleIdenticalConflicts(found, [local, other], new Set()).conflicts.length, 2, "only for unsaved drafts");
  assert.equal(sameEdits(local, { ...server, tags: ["x"] }), false);
});

// --- Fix 4: items of a project deleted with unlinkChildren -------------------------

test("deleting a project with unlinkChildren moves its items up locally", () => {
  const top = note("Top", { kind: "project" });
  const project = note("Project", { kind: "project", projectId: top.id });
  const task = note("Task", { kind: "task", projectId: project.id, revision: 1 });
  const sub = note("Sub", { kind: "project", projectId: project.id, revision: 1 });
  const deep = note("Deep", { projectId: sub.id });
  const other = note("Other");
  const { notes, moved } = deleteWithUnlink([top, project, task, sub, deep, other], project.id);
  assert.deepEqual(notes.map((n) => [n.title, n.projectId ?? null]),
    [["Top", null], ["Task", top.id], ["Sub", top.id], ["Deep", sub.id], ["Other", null]]);
  assert.deepEqual(moved.map(({ id, to }) => ({ id, to })), [{ id: task.id, to: top.id }, { id: sub.id, to: top.id }]);
  assert.equal(notes.find((n) => n.id === task.id).updatedAt, task.updatedAt, "not marked as edited");
  assert.deepEqual(deleteWithUnlink(notes, project.id).notes, notes, "idempotent");
  // A root project's items end up in no project.
  const root = deleteWithUnlink([top, { ...project, projectId: null }, task], project.id);
  assert.equal(root.notes.find((n) => n.id === task.id).projectId, null);
});

test("a refused unlink delete puts back only items whose move was never sent", () => {
  const project = note("Project", { kind: "project", revision: 2, updatedAt: at(1) });
  const clean = note("Clean", { projectId: project.id, revision: 1, updatedAt: at(1) });
  const dirty = note("Dirty", { projectId: project.id, revision: 1, updatedAt: at(1) });
  const later = note("Edited later", { projectId: project.id, revision: 1, updatedAt: at(1) });
  const known = synced(project, clean, later);
  known.set(dirty.id, { revision: 1, updatedAt: at(0) }); // unsaved edits when deleted
  const { notes, moved } = deleteWithUnlink([project, clean, dirty, later], project.id, known);
  assert.deepEqual(moved.map((m) => [m.id, m.clean]), [[clean.id, true], [dirty.id, false], [later.id, true]]);
  // Dirty was saved with the new link; "Edited later" was changed again after the move.
  const after = notes.map((n) => (n.id === later.id ? { ...n, updatedAt: at(7) } : n));
  const restored = revertUnlink([project, ...after], project.id, moved);
  assert.deepEqual(restored.map((n) => [n.title, n.projectId ?? null]),
    [["Project", null], ["Clean", project.id], ["Dirty", null], ["Edited later", null]]);
});
