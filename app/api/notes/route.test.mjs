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
        // Link rules are the database's (see note-projects.test.mjs); the
        // double knows just enough to return a per-item code.
        const parent = values.project_id && rows.get(values.project_id);
        if (values.project_id && (parent?.kind !== "project" || parent.workspace_id !== values.workspace_id))
          return { id: item.id, status: "invalid", code: "invalid_project_link" };
        const revision = existing ? existing.revision + 1 : 1;
        const saved = { ...existing, ...values, user_id: USER, revision, source: "web", origin: null,
          updated_at: new Date().toISOString(), due_date: values.due_date ?? existing?.due_date ?? null,
          kind: values.kind ?? existing?.kind ?? "note",
          project_id: Object.hasOwn(values, "project_id") ? values.project_id : existing?.project_id ?? null };
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
    const children = [...rows.values()].filter((r) => r.project_id === args.p_id);
    if (children.length && !args.p_unlink_children)
      return { error: null, data: { status: "project_has_linked_items", count: children.length,
        currentRevision: existing.revision, current: current(existing) } };
    for (const child of children) Object.assign(child, { project_id: existing.project_id ?? null, revision: child.revision + 1 });
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

test("kind and project links: saved when valid, per-item 422 codes when not", async () => {
  const project = { ...newNote("Launch"), kind: "project" };
  const task = { ...newNote("Draft plan"), kind: "task", projectId: project.id };
  const saved = await put([{ ...project, expectedRevision: null }, { ...task, expectedRevision: null }]);
  assert.equal(saved.status, 200);
  assert.deepEqual([rows.get(task.id).kind, rows.get(task.id).project_id], ["task", project.id]);
  const sent = calls.at(-1)[1].p_notes;
  assert.deepEqual([sent[1].kind, sent[1].project_id], ["task", project.id]);
  // A legacy client never sends kind or projectId; the item keeps both.
  const { kind: _k, projectId: _p, ...legacy } = { ...task, title: "Old tab" };
  await put([{ ...legacy, expectedRevision: 1 }]);
  const legacyItem = calls.at(-1)[1].p_notes[0];
  assert.equal(Object.hasOwn(legacyItem, "kind") || Object.hasOwn(legacyItem, "project_id"), false);
  assert.deepEqual([rows.get(task.id).kind, rows.get(task.id).project_id], ["task", project.id]);
  const plain = newNote("Not a project");
  await put([{ ...plain, expectedRevision: null }]);
  const bad = await put([{ ...newNote("Child"), projectId: plain.id, expectedRevision: null }, { ...newNote("Fine"), expectedRevision: null }]);
  assert.deepEqual([bad.status, bad.body.code, bad.body.saved], [422, "invalid_project_link", 1]);
  assert.deepEqual(bad.body.results[0], { id: bad.body.results[0].id, status: "invalid", code: "invalid_project_link" });
  assert.doesNotMatch(bad.body.error, /Child|Not a project/);
  for (const invalid of [{ kind: "epic" }, { projectId: "not-a-uuid" }, { projectId: 7 }]) {
    const response = await put([{ ...newNote("x"), ...invalid, expectedRevision: null }]);
    assert.deepEqual([response.status, response.body.code], [400, "invalid_payload"]);
  }
});

test("deleting a project with linked items needs unlinkChildren", async () => {
  const parent = { ...newNote("Area"), kind: "project" };
  const project = { ...newNote("Launch"), kind: "project", projectId: parent.id };
  const child = { ...newNote("Draft"), projectId: project.id };
  await put([{ ...parent, expectedRevision: null }, { ...project, expectedRevision: null }, { ...child, expectedRevision: null }]);
  const refused = await del(project.id, 1);
  assert.deepEqual([refused.status, refused.body.code, refused.body.count, refused.body.currentRevision],
    [409, "project_has_linked_items", 1, 1]);
  assert.equal(refused.body.current.id, project.id);
  assert.equal(calls.at(-1)[1].p_unlink_children, false);
  assert.ok(rows.has(project.id));
  const response = await noteRoute.DELETE(
    new Request(`http://localhost/api/notes/${project.id}?expectedRevision=1&unlinkChildren=true`, { method: "DELETE" }),
    { params: Promise.resolve({ id: project.id }) });
  assert.equal(response.status, 200);
  assert.equal(calls.at(-1)[1].p_unlink_children, true);
  assert.equal(rows.get(child.id).project_id, parent.id, "moved up to the grandparent");
  const invalid = await noteRoute.DELETE(
    new Request(`http://localhost/api/notes/${parent.id}?unlinkChildren=yes`, { method: "DELETE" }),
    { params: Promise.resolve({ id: parent.id }) });
  assert.equal(invalid.status, 400);
});

test("GET returns kind and projectId; legacy rows read as notes", async () => {
  const selects = [];
  const base = { workspace_id: WS, content: { type: "doc" }, plain_text: "", tags: [], source: "web", origin: null,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", completed_at: null, due_date: null };
  const data = [
    { ...base, id: "11111111-1111-4111-8111-111111111111", title: "Old", bucket: "projects", revision: 1 },
    { ...base, id: "22222222-2222-4222-8222-222222222222", title: "New", bucket: "next", revision: 2, kind: "task",
      project_id: "33333333-3333-4333-8333-333333333333" },
  ];
  const query = { select: (c) => (selects.push(c), query), order: () => query, returns: async () => ({ error: null, data }) };
  const listAuth = { user: { id: USER }, supabase: { from: () => query } };
  const route = loadTs(new URL("./route.ts", import.meta.url),
    { ...imports, "@/lib/supabase/route-auth": { routeUser: async () => listAuth, json } });
  const { notes } = await (await route.GET(new Request("http://localhost/api/notes"))).json();
  assert.match(selects[0], /,kind,project_id,waiting_on,waiting_for,next_check_on$/);
  assert.deepEqual(notes.map((n) => [n.kind, n.projectId]), [["note", null], ["task", "33333333-3333-4333-8333-333333333333"]]);
});

test("PUT saves follow-up fields trimmed, keeps them when absent, and rejects bad values", async () => {
  const note = { ...newNote("Waiting"), kind: "task", waitingOn: "  Dana ", waitingFor: "Signed quote", nextCheckOn: "2026-10-20" };
  const saved = await put([{ ...note, expectedRevision: null }]);
  assert.equal(saved.status, 200);
  const item = calls.at(-1)[1].p_notes[0];
  assert.deepEqual([item.waiting_on, item.waiting_for, item.next_check_on], ["Dana", "Signed quote", "2026-10-20"]);
  // An older client that never sends them leaves them unchanged.
  const { waitingOn: _o, waitingFor: _f, nextCheckOn: _c, ...old } = { ...note, title: "Renamed" };
  assert.equal((await put([{ ...old, expectedRevision: 1 }])).status, 200);
  const legacyItem = calls.at(-1)[1].p_notes[0];
  assert.equal(["waiting_on", "waiting_for", "next_check_on"].some((k) => Object.hasOwn(legacyItem, k)), false);
  assert.equal(rows.get(note.id).waiting_on, "Dana");
  const before = calls.length;
  for (const bad of [{ waitingOn: "x".repeat(201) }, { waitingFor: "a\nb" }, { nextCheckOn: "2026-02-30" }]) {
    const response = await put([{ ...note, ...bad, expectedRevision: 2 }]);
    assert.deepEqual([response.status, response.body.code], [400, "invalid_payload"], JSON.stringify(bad));
    assert.doesNotMatch(JSON.stringify(response.body), /xxxx|Dana/);
  }
  assert.equal(calls.length, before, "nothing written for an invalid batch");
});
