import { test } from "node:test";
import assert from "node:assert/strict";
import * as notesModule from "./notes.ts";
import { loadTs } from "../tests/load-ts.mjs";

const db = loadTs(new URL("./notes-db.ts", import.meta.url), { "./notes": notesModule });
const config = loadTs(new URL("./server-config.ts", import.meta.url));
const WS = "12345678-1234-1234-1234-123456789abc";
const row = (id, patch = {}) => ({
  id, workspace_id: WS, title: "Server title", content: { type: "doc" }, plain_text: "",
  bucket: "inbox", tags: [], source: "web", origin: null,
  created_at: "2026-10-13T00:00:00+00:00", updated_at: "2026-10-13T01:02:03.456789+00:00",
  completed_at: null, due_date: null, revision: 3, ...patch,
});

test("save items keep the precondition and never send server-owned columns", () => {
  const note = { ...notesModule.createNote("T", "inbox", WS), revision: 9 };
  const legacy = db.toSaveItem(note);
  assert.equal(Object.hasOwn(legacy, "expected_revision"), false);
  for (const column of ["user_id", "updated_at", "revision", "source", "origin", "triage_status"])
    assert.equal(Object.hasOwn(legacy, column), false, column);
  assert.equal(db.toSaveItem({ ...note, expectedRevision: null }).expected_revision, null);
  assert.equal(db.toSaveItem({ ...note, expectedRevision: 4 }).expected_revision, 4);
  assert.equal(db.hasExpectedRevision({ expectedRevision: null }), true);
  assert.equal(db.hasExpectedRevision({ expectedRevision: undefined }), false);
  for (const ok of [undefined, null, 1, 42]) assert.equal(db.isExpectedRevision(ok), true);
  for (const bad of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) assert.equal(db.isExpectedRevision(bad), false);
  assert.equal(db.parseExpectedRevision(null), undefined);
  assert.equal(db.parseExpectedRevision("7"), 7);
  for (const bad of ["0", "-1", "1e3", "abc", "01", "99999999999999999"])
    assert.equal(db.parseExpectedRevision(bad), "invalid", bad);
  assert.equal(db.fromRow(row("a")).revision, 3);
});

test("batch status precedence: conflict, then precondition, then invalid, else 200", () => {
  const saved = { id: "s", status: "saved", revision: 2, updatedAt: "2026-10-13T01:02:03.456789+00:00" };
  const conflict = { id: "c", status: "conflict", expectedRevision: 1, currentRevision: 3, current: row("c") };
  const precondition = { id: "p", status: "precondition_required" };
  const invalid = { id: "i", status: "invalid", code: "not_found" };
  const all = db.saveResponse([saved, invalid, precondition, conflict], { includeCurrent: true });
  assert.equal(all.status, 409);
  assert.equal(all.body.code, "revision_conflict");
  assert.equal(all.body.saved, 1, "saved items are still reported in a 409");
  assert.equal(all.body.results[0].updatedAt, "2026-10-13T01:02:03.456Z");
  assert.equal(all.body.results[3].current.title, "Server title");
  assert.equal(all.body.results[3].current.revision, 3);
  assert.doesNotMatch(all.body.error, /Server title/);
  assert.equal(db.saveResponse([saved, invalid, precondition], { includeCurrent: true }).status, 428);
  const unprocessable = db.saveResponse([saved, invalid], { includeCurrent: true });
  assert.deepEqual([unprocessable.status, unprocessable.body.code], [422, "not_found"]);
  assert.deepEqual(db.saveResponse([saved], { includeCurrent: true }), {
    status: 200,
    body: { saved: 1, results: [{ ...saved, updatedAt: "2026-10-13T01:02:03.456Z" }] },
  });
  const external = db.saveResponse([conflict], { includeCurrent: false });
  assert.equal(Object.hasOwn(external.body.results[0], "current"), false, "minimum necessary");
  assert.equal(db.saveResponse(null, { includeCurrent: true }), null);
});

test("delete responses: 404 for a revisioned delete of a missing note, 200 for legacy", () => {
  const conflict = db.deleteResponse({ status: "conflict", currentRevision: 5, current: row("x") }, "x", { includeCurrent: true, legacy: false });
  assert.equal(conflict.status, 409);
  assert.deepEqual([conflict.body.code, conflict.body.currentRevision, conflict.body.current.id], ["revision_conflict", 5, "x"]);
  const external = db.deleteResponse({ status: "conflict", currentRevision: 5, current: row("x") }, "x", { includeCurrent: false, legacy: false });
  assert.equal(Object.hasOwn(external.body, "current"), false);
  assert.equal(db.deleteResponse({ status: "not_found" }, "x", { includeCurrent: true, legacy: false }).status, 404);
  assert.deepEqual(db.deleteResponse({ status: "not_found" }, "x", { includeCurrent: true, legacy: true }), { status: 200, body: { deleted: "x" } });
  assert.equal(db.deleteResponse({ status: "precondition_required" }, "x", { includeCurrent: true, legacy: true }).status, 428);
  assert.equal(db.deleteResponse(null, "x", { includeCurrent: true, legacy: true }), null);
});

test("enforcement is typed config, and the legacy-write metric carries no content", () => {
  assert.equal(config.notesRevisionEnforcement({}), "off");
  assert.equal(config.notesRevisionEnforcement({ NOTES_REVISION_ENFORCEMENT: " Warn " }), "warn");
  assert.equal(config.notesRevisionEnforcement({ NOTES_REVISION_ENFORCEMENT: "enforce" }), "enforce");
  assert.throws(() => config.notesRevisionEnforcement({ NOTES_REVISION_ENFORCEMENT: "on" }), /off, warn, or enforce/);
  assert.equal(config.notesMinClient({}), 1);
  assert.equal(config.notesMinClient({ NOTES_MIN_CLIENT: "2" }), 2);
  assert.throws(() => config.notesMinClient({ NOTES_MIN_CLIENT: "x" }));
  const lines = [];
  config.recordLegacyWrite({ writer: "W1", route: "PUT /api/notes", count: 3, outcome: "accepted" }, (l) => lines.push(l));
  config.recordLegacyWrite({ writer: "W1", route: "PUT /api/notes", count: 0, outcome: "accepted" }, (l) => lines.push(l));
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [
    { metric: "notes.legacy_write", writer: "W1", route: "PUT /api/notes", outcome: "accepted", count: 3 },
  ]);
});

test("kind and project_id: read with legacy defaults, written only when present", () => {
  const legacy = db.fromRow(row("11111111-1111-4111-8111-111111111111"));
  assert.deepEqual([legacy.kind, legacy.projectId], ["note", null], "rows selected without the columns");
  const P = "33333333-3333-4333-8333-333333333333";
  const linked = db.fromRow(row("11111111-1111-4111-8111-111111111111", { kind: "task", project_id: P }));
  assert.deepEqual([linked.kind, linked.projectId], ["task", P]);
  assert.match(db.NOTE_COLUMNS, /,kind,project_id,waiting_on,waiting_for,next_check_on$/);
  const { kind: _k, projectId: _p, ...old } = notesModule.createNote("T", "inbox", WS);
  const item = db.toSaveItem(old);
  assert.equal(Object.hasOwn(item, "kind") || Object.hasOwn(item, "project_id"), false, "absent means unchanged");
  const current = db.toSaveItem({ ...old, kind: "project", projectId: null });
  assert.deepEqual([current.kind, current.project_id], ["project", null]);
  assert.equal(db.isSavableNote(old), true);
  assert.equal(db.isSavableNote({ ...old, kind: "followup", projectId: P }), true);
  for (const bad of [{ kind: "epic" }, { kind: null }, { projectId: "nope" }, { projectId: 1 }])
    assert.equal(db.isSavableNote({ ...old, ...bad }), false, JSON.stringify(bad));
});

test("link errors are per-item 422 codes; project deletes need unlinkChildren", () => {
  for (const code of ["invalid_project_link", "project_cycle", "project_depth_exceeded", "linked_item_move", "project_has_linked_items"]) {
    const { status, body } = db.saveResponse([{ id: "a", status: "invalid", code }], { includeCurrent: true });
    assert.deepEqual([status, body.code, body.results[0].code], [422, code, code]);
  }
  assert.equal(db.saveResponse([{ id: "a", status: "invalid", code: "surprise" }], { includeCurrent: true }).body.code, "invalid_note");
  const id = "11111111-1111-4111-8111-111111111111";
  const raw = { status: "project_has_linked_items", count: 2, currentRevision: 4, current: row(id, { kind: "project" }) };
  const owner = db.deleteResponse(raw, id, { includeCurrent: true, legacy: false });
  assert.deepEqual([owner.status, owner.body.code, owner.body.count, owner.body.currentRevision, owner.body.current.kind],
    [409, "project_has_linked_items", 2, 4, "project"]);
  assert.doesNotMatch(owner.body.error, /Server title/);
  assert.equal(Object.hasOwn(db.deleteResponse(raw, id, { includeCurrent: false, legacy: false }).body, "current"), false);
  assert.deepEqual(["true", "false", null, ""].map(db.parseUnlinkChildren), [true, false, false, false]);
  assert.deepEqual(["1", "yes", "TRUE"].map(db.parseUnlinkChildren), ["invalid", "invalid", "invalid"]);
});

test("follow-ups: read with legacy defaults, written trimmed and only when present", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const legacy = db.fromRow(row(id));
  assert.deepEqual([legacy.waitingOn, legacy.waitingFor, legacy.nextCheckOn], [null, null, null], "rows selected without the columns");
  const read = db.fromRow(row(id, { waiting_on: "Dana", waiting_for: "Quote", next_check_on: "2026-10-20" }));
  assert.deepEqual([read.waitingOn, read.waitingFor, read.nextCheckOn], ["Dana", "Quote", "2026-10-20"]);
  const { waitingOn: _o, waitingFor: _f, nextCheckOn: _c, ...old } = notesModule.createNote("T", "inbox", WS);
  const item = db.toSaveItem(old);
  for (const key of ["waiting_on", "waiting_for", "next_check_on"])
    assert.equal(Object.hasOwn(item, key), false, `${key}: absent means unchanged`);
  const set = db.toSaveItem({ ...old, waitingOn: "  Dana ", waitingFor: "   ", nextCheckOn: "2026-10-20" });
  assert.deepEqual([set.waiting_on, set.waiting_for, set.next_check_on], ["Dana", null, "2026-10-20"], "trimmed; blank clears");
  const cleared = db.toSaveItem({ ...old, waitingOn: null, waitingFor: null, nextCheckOn: null });
  assert.deepEqual([cleared.waiting_on, cleared.waiting_for, cleared.next_check_on], [null, null, null]);
  // Round trip: what is written reads back the same.
  const back = db.fromRow({ ...row(id), ...set });
  assert.deepEqual([back.waitingOn, back.waitingFor, back.nextCheckOn], ["Dana", null, "2026-10-20"]);
  assert.equal(db.isSavableNote({ ...old, kind: "task", waitingOn: "Dana", waitingFor: "x".repeat(2000), nextCheckOn: "2026-10-20" }), true,
    "any kind, at the limits");
  for (const bad of [{ waitingOn: "a".repeat(201) }, { waitingFor: "b".repeat(2001) }, { waitingOn: "a\nb" },
    { waitingFor: "\u0000" }, { nextCheckOn: "2026-02-30" }, { nextCheckOn: "" }, { waitingOn: 5 }])
    assert.equal(db.isSavableNote({ ...old, ...bad }), false, JSON.stringify(bad));
  assert.match(db.NOTE_COLUMNS, /,waiting_on,waiting_for,next_check_on$/);
  // Conflict copies carry them to the owner's merge UI.
  const conflict = db.saveResponse([{ id, status: "conflict", expectedRevision: 1, currentRevision: 2,
    current: row(id, { waiting_on: "Dana", next_check_on: "2026-10-20" }) }], { includeCurrent: true });
  assert.deepEqual([conflict.body.results[0].current.waitingOn, conflict.body.results[0].current.nextCheckOn], ["Dana", "2026-10-20"]);
});
