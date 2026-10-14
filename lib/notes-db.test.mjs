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
