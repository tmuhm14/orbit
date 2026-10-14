import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as notesModule from "../../../lib/notes.ts";
import { loadTs } from "../../../tests/load-ts.mjs";

// Route handlers with in-memory doubles for auth and the save_notes /
// delete_note functions. The doubles follow the SQL contract in
// supabase/migrations/20261014000100_note_write_functions.sql, which is
// exercised against Postgres in supabase/tests/note-functions.test.mjs.
const db = loadTs(new URL("../../../lib/notes-db.ts", import.meta.url), { "./notes": notesModule });
const config = loadTs(new URL("../../../lib/server-config.ts", import.meta.url));
const WS = "12345678-1234-1234-1234-123456789abc";
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const json = (body, status = 200) => Response.json(body, { status });

let rows;
let calls;
let metrics;
beforeEach(() => {
  rows = new Map();
  calls = [];
  metrics = [];
  delete process.env.NOTES_REVISION_ENFORCEMENT;
});

function rpc(name, args) {
  calls.push([name, args]);
  const current = (r) => ({ ...r });
  if (name === "save_notes")
    return {
      error: null,
      data: args.p_notes.map((item) => {
        const existing = rows.get(item.id);
        const has = Object.hasOwn(item, "expected_revision");
        const expected = item.expected_revision ?? null;
        if (existing && existing.user_id !== USER) return { id: item.id, status: "invalid", code: "not_found" };
        if (!has && args.p_require_revision) return { id: item.id, status: "precondition_required" };
        if (has && ((expected === null && existing) || (expected !== null && (!existing || existing.revision !== expected))))
          return { id: item.id, status: "conflict", expectedRevision: expected,
            currentRevision: existing?.revision ?? null, current: existing ? current(existing) : null };
        const { expected_revision: _e, ...values } = item;
        const revision = existing ? existing.revision + 1 : 1;
        const saved = { ...existing, ...values, user_id: USER, revision, source: "web", origin: null,
          updated_at: new Date().toISOString(), due_date: values.due_date ?? existing?.due_date ?? null };
        rows.set(item.id, saved);
        return { id: item.id, status: "saved", revision, updatedAt: saved.updated_at };
      }),
    };
  if (name === "delete_note") {
    const existing = rows.get(args.p_id);
    if (args.p_expected_revision === null && args.p_require_revision) return { error: null, data: { status: "precondition_required" } };
    if (!existing) return { error: null, data: { status: "not_found" } };
    if (args.p_expected_revision !== null && existing.revision !== args.p_expected_revision)
      return { error: null, data: { status: "conflict", currentRevision: existing.revision, current: current(existing) } };
    rows.delete(args.p_id);
    return { error: null, data: { status: "deleted", id: args.p_id } };
  }
  throw new Error(`unexpected rpc ${name}`);
}

const auth = { user: { id: USER }, supabase: { rpc: async (n, a) => rpc(n, a) } };
const imports = {
  "@/lib/supabase/route-auth": { routeUser: async () => auth, json },
  "@/lib/notes-db": db,
  "@/lib/notes": notesModule,
  "@/lib/server-config": { ...config, recordLegacyWrite: (w) => metrics.push(w) },
};
const notesRoute = loadTs(new URL("./route.ts", import.meta.url), imports);
const noteRoute = loadTs(new URL("./[id]/route.ts", import.meta.url), imports);

const put = async (notes) => {
  const response = await notesRoute.PUT(new Request("http://localhost/api/notes", { method: "PUT", body: JSON.stringify({ notes }) }));
  return { status: response.status, body: await response.json(), headers: response.headers };
};
const del = async (id, expected) => {
  const query = expected === undefined ? "" : `?expectedRevision=${expected}`;
  const response = await noteRoute.DELETE(new Request(`http://localhost/api/notes/${id}${query}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
};
const newNote = (title) => notesModule.createNote(title, "inbox", WS);

test("two writers on the same revision: the second gets 409 with the server copy", async () => {
  const note = newNote("Shared");
  assert.equal((await put([{ ...note, expectedRevision: null }])).body.results[0].revision, 1);
  const tabA = { ...note, title: "From tab A", expectedRevision: 1 };
  const tabB = { ...note, title: "From tab B", expectedRevision: 1 };
  const first = await put([tabA]);
  assert.deepEqual([first.status, first.body.results[0].status, first.body.results[0].revision], [200, "saved", 2]);
  const other = newNote("Unrelated");
  const second = await put([tabB, { ...other, expectedRevision: null }]);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "revision_conflict");
  assert.equal(second.body.saved, 1, "the unrelated item in the batch was still saved");
  const conflict = second.body.results[0];
  assert.deepEqual([conflict.status, conflict.expectedRevision, conflict.currentRevision], ["conflict", 1, 2]);
  assert.equal(conflict.current.title, "From tab A");
  assert.doesNotMatch(second.body.error, /From tab/);
  assert.equal(rows.get(note.id).title, "From tab A", "nothing was overwritten");
  assert.equal(second.headers.get("X-Orbit-Min-Client"), "1");
});

test("create-only: an id that already exists is a conflict, never an overwrite", async () => {
  const note = newNote("Imported");
  await put([{ ...note, expectedRevision: null }]);
  const again = await put([{ ...note, title: "Imported again", expectedRevision: null }]);
  assert.equal(again.status, 409);
  assert.deepEqual([again.body.results[0].expectedRevision, again.body.results[0].currentRevision], [null, 1]);
  assert.equal(rows.get(note.id).title, "Imported");
  assert.deepEqual(metrics, [{ writer: "W1", route: "PUT /api/notes", count: 0, outcome: "accepted" },
    { writer: "W1", route: "PUT /api/notes", count: 0, outcome: "accepted" }]);
});

test("legacy writes succeed and are counted until enforce, then get 428", async () => {
  const note = newNote("Old tab");
  const legacy = await put([note]);
  assert.equal(legacy.status, 200);
  assert.equal(calls.at(-1)[1].p_require_revision, false);
  assert.deepEqual(metrics.at(-1), { writer: "W1", route: "PUT /api/notes", count: 1, outcome: "accepted" });
  process.env.NOTES_REVISION_ENFORCEMENT = "warn";
  assert.equal((await put([{ ...note, title: "Still old" }])).status, 200);
  process.env.NOTES_REVISION_ENFORCEMENT = "enforce";
  const refused = await put([{ ...note, title: "Refused" }]);
  assert.deepEqual([refused.status, refused.body.code, refused.body.results[0].status], [428, "precondition_required", "precondition_required"]);
  assert.equal(calls.at(-1)[1].p_require_revision, true);
  assert.deepEqual(metrics.at(-1), { writer: "W1", route: "PUT /api/notes", count: 1, outcome: "rejected" });
  assert.equal(rows.get(note.id).title, "Still old");
  // Metrics never include ids or content.
  assert.doesNotMatch(JSON.stringify(metrics), new RegExp(`${note.id}|Old tab|Refused`));
});

test("malformed batches are rejected before any write", async () => {
  const note = newNote("Bad");
  for (const notes of [[{ ...note, expectedRevision: 0 }], [{ ...note, expectedRevision: "1" }], [note, note], "x"]) {
    const response = await put(notes);
    assert.deepEqual([response.status, response.body.code], [400, "invalid_payload"]);
  }
  assert.equal(calls.length, 0);
  const empty = await put([]);
  assert.deepEqual(empty.body, { saved: 0, results: [] });
});

test("delete with a stale revision is refused and returns the server copy", async () => {
  const note = newNote("Keep me");
  await put([{ ...note, expectedRevision: null }]);
  await put([{ ...note, title: "Edited elsewhere", expectedRevision: 1 }]);
  const stale = await del(note.id, 1);
  assert.deepEqual([stale.status, stale.body.code, stale.body.currentRevision], [409, "revision_conflict", 2]);
  assert.equal(stale.body.current.title, "Edited elsewhere");
  assert.ok(rows.has(note.id));
  assert.deepEqual(await del(note.id, 2), { status: 200, body: { deleted: note.id } });
  assert.equal((await del(note.id, 2)).status, 404, "already deleted");
  assert.equal((await del(note.id)).status, 200, "legacy delete of a missing note stays 200");
  assert.equal((await del(note.id, "abc")).status, 400);
  process.env.NOTES_REVISION_ENFORCEMENT = "enforce";
  const legacy = await del(note.id);
  assert.deepEqual([legacy.status, legacy.body.code], [428, "precondition_required"]);
  assert.deepEqual(metrics.at(-1), { writer: "W2", route: "DELETE /api/notes/:id", count: 1, outcome: "rejected" });
});
