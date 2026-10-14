import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Runs every migration against a disposable in-process Postgres (PGlite) and
// exercises the ADR 002 functions: revision trigger, save_notes, delete_note,
// the agent functions and undo_agent_action. PGlite is not a dependency; the
// suite is skipped unless it is installed locally:
//   npm install --no-save @electric-sql/pglite && npm test
// Never point this at a real project database. Concurrency is not covered:
// PGlite has a single connection, so row locks are not contended here.
const pglite = await import("@electric-sql/pglite").catch(() => null);
const skip = pglite ? false : "PGlite not installed (npm install --no-save @electric-sql/pglite)";
const MIGRATIONS = new URL("../migrations/", import.meta.url);

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
let db, WA, WB, RUN;

async function as(role, user, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ?? ""}', false); set role ${role};`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role;");
  }
}
const save = async (user, items, require = false) =>
  (await as("authenticated", user, "select public.save_notes($1::jsonb, $2) r", [JSON.stringify(items), require]))[0].r;
const del = async (user, id, rev, require = false) =>
  (await as("authenticated", user, "select public.delete_note($1, $2, $3) r", [id, rev, require]))[0].r;
const row = async (id) => (await db.query("select * from public.notes where id = $1", [id])).rows[0];
const note = (id, patch = {}) => ({
  id, workspace_id: WA, title: "t", content: { type: "doc" }, plain_text: "",
  bucket: "inbox", tags: [], created_at: "2026-10-13T00:00:00.000Z", completed_at: null, ...patch,
});
const apply = async (noteId, rev, after, runId = RUN) =>
  (await as("service_role", null, "select public.agent_apply_note_change($1, $2, $3, $4::jsonb, 'why') r",
    [runId, noteId, rev, JSON.stringify(after)]))[0].r;
const createByAgent = async (n) =>
  (await as("service_role", null, "select public.agent_create_note($1, $2::jsonb, 'r') r", [RUN, JSON.stringify(n)]))[0].r;
const undo = async (user, id) => (await as("authenticated", user, "select public.undo_agent_action($1) r", [id]))[0].r;
const count = async (sql) => (await db.query(sql)).rows[0].c;
const newRun = async (status = "running") => (await db.query(
  `insert into public.agent_runs (user_id, workspace_id, trigger, mode, provider, model, status)
   values ($1, $2, 'manual', 'organize', 'anthropic', 'm', $3) returning id`, [A, WA, status])).rows[0].id;

before(async () => {
  if (!pglite) return;
  db = new pglite.PGlite();
  // Minimal stand-ins for what Supabase provides.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort())
    await db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  const ws = async (user) =>
    (await db.query(`insert into public.workspaces (user_id, name) values ($1, 'W') returning id`, [user])).rows[0].id;
  WA = await ws(A);
  WB = await ws(B);
  RUN = await newRun();
});

test("save_notes: create-only, revision checks, legacy mode and enforce", { skip }, async () => {
  const N = "11111111-0000-4000-8000-000000000001";
  let r = await save(A, [{ ...note(N), expected_revision: null, revision: 99, source: "slack", user_id: B }]);
  assert.deepEqual([r[0].status, r[0].revision], ["saved", 1]);
  const created = await row(N);
  assert.deepEqual([created.user_id, created.source, Number(created.revision)], [A, "web", 1], "server-owned input ignored");
  r = await save(A, [{ ...note(N), expected_revision: null }]);
  assert.deepEqual([r[0].status, r[0].currentRevision, r[0].current.revision], ["conflict", 1, 1]);
  r = await save(A, [{ ...note(N, { title: "tab A" }), expected_revision: 1 }]);
  assert.deepEqual([r[0].status, r[0].revision], ["saved", 2]);
  r = await save(A, [{ ...note(N, { title: "tab B" }), expected_revision: 1 }]);
  assert.deepEqual([r[0].status, r[0].currentRevision, r[0].current.title], ["conflict", 2, "tab A"]);
  assert.equal((await row(N)).title, "tab A", "second writer did not overwrite");
  r = await save(A, [{ ...note(N, { title: "legacy" }) }]);
  assert.deepEqual([r[0].status, r[0].revision], ["saved", 3], "legacy write allowed when not enforced");
  r = await save(A, [{ ...note(N, { title: "refused" }) }], true);
  assert.equal(r[0].status, "precondition_required");
  await save(A, [{ ...note(N, { title: "legacy", due_date: "2026-12-01" }), expected_revision: 3 }]);
  r = await save(A, [{ ...note(N, { title: "legacy" }), expected_revision: 4 }]);
  assert.deepEqual([r[0].status, r[0].revision], ["saved", 4], "no-op keeps the revision");
  assert.equal((await row(N)).due_date.toISOString().slice(0, 10), "2026-12-01", "absent due_date kept");
  r = await save(A, [{ ...note("11111111-0000-4000-8000-0000000000ff"), expected_revision: 2 }]);
  assert.deepEqual([r[0].status, r[0].currentRevision, r[0].current], ["conflict", null, null], "deleted elsewhere");
});

test("save_notes: other accounts and bad items fail per item", { skip }, async () => {
  const N = "11111111-0000-4000-8000-000000000001";
  const r = await save(B, [
    { ...note(N, { workspace_id: WB }), expected_revision: 4 },
    { ...note("22222222-0000-4000-8000-000000000001"), expected_revision: null },
    { ...note("22222222-0000-4000-8000-000000000002", { workspace_id: WB, bucket: "nope" }), expected_revision: null },
    { ...note("22222222-0000-4000-8000-000000000003", { workspace_id: WB }), expected_revision: null },
  ]);
  assert.deepEqual(r.map((x) => `${x.status}:${x.code ?? ""}`),
    ["invalid:not_found", "invalid:invalid_note", "invalid:invalid_note", "saved:"]);
  assert.equal((await row(N)).user_id, A);
  await assert.rejects(as("anon", null, "select public.save_notes('[]'::jsonb, false)"));
});

test("delete_note: stale revision, enforce, ownership", { skip }, async () => {
  const N = "11111111-0000-4000-8000-000000000001";
  let r = await del(A, N, 1);
  assert.deepEqual([r.status, r.currentRevision, r.current.id], ["conflict", 4, N]);
  assert.equal((await del(A, N, null, true)).status, "precondition_required");
  assert.equal((await del(B, N, 4)).status, "not_found");
  assert.equal((await del(A, N, 4)).status, "deleted");
  assert.equal((await del(A, N, 4)).status, "not_found");
});

test("trigger: direct writes always move the revision; triage does not", { skip }, async () => {
  const N = "33333333-0000-4000-8000-000000000001";
  await as("authenticated", A, `insert into public.notes (id, workspace_id, title, content, revision, updated_at)
    values ($1, $2, 'x', '{"type":"doc"}', 50, '2000-01-01')`, [N, WA]);
  let n = await row(N);
  assert.equal(Number(n.revision), 1);
  assert.ok(n.updated_at.getFullYear() > 2000, "updated_at is server-managed");
  await as("authenticated", A, "update public.notes set title = 'y', revision = 1 where id = $1", [N]);
  n = await row(N);
  assert.equal(Number(n.revision), 2);
  const stamp = n.updated_at.getTime();
  await as("authenticated", A, "update public.notes set triage_status = 'done', updated_at = '2000-01-01' where id = $1", [N]);
  n = await row(N);
  assert.deepEqual([Number(n.revision), n.updated_at.getTime()], [2, stamp]);
});

test("agent functions: atomic change and audit, conflicts write nothing", { skip }, async () => {
  const N = "33333333-0000-4000-8000-000000000001";
  await assert.rejects(as("authenticated", A, "select public.agent_apply_note_change($1, $2, 2, '{}'::jsonb, '')", [RUN, N]),
    "service role only");
  let r = await apply(N, 1, { bucket: "next" });
  assert.deepEqual([r.status, r.currentRevision], ["conflict", 2]);
  assert.equal(await count("select count(*)::int c from public.agent_actions"), 0, "conflict writes no audit");
  r = await apply(N, 2, { bucket: "next", tags: ["a", "b"], user_id: B, revision: 1, title: "y" });
  assert.deepEqual([r.status, r.revision], ["applied", 3]);
  const action = (await db.query("select * from public.agent_actions where id = $1", [r.actionId])).rows[0];
  assert.deepEqual(action.before, { bucket: "inbox", tags: [] }, "before from the locked row; unchanged keys dropped");
  assert.deepEqual(action.after, { bucket: "next", tags: ["a", "b"] });
  assert.deepEqual([Number(action.revision_before), Number(action.revision_after)], [2, 3]);
  assert.equal((await row(N)).user_id, A);
  assert.equal((await apply(N, 3, { bucket: "next" })).status, "unchanged");
  await assert.rejects(apply(N, 3, { bucket: "bogus" }));
  assert.equal(await count("select count(*)::int c from public.agent_actions"), 1, "failed change leaves no audit");
  assert.equal((await apply("22222222-0000-4000-8000-000000000003", 1, { bucket: "next" })).status, "not_found",
    "scope comes from the run");
  assert.equal((await apply(N, 3, { bucket: "someday" }, await newRun("done"))).status, "run_not_active");
  const c = await createByAgent({ title: "made", content: { type: "doc" }, plain_text: "b", bucket: "next", tags: ["agent"], user_id: B, workspace_id: WB });
  const made = await row(c.id);
  assert.deepEqual([c.status, c.revision, made.user_id, made.workspace_id], ["created", 1, A, WA]);
  assert.equal(await count(`select count(*)::int c from public.agent_actions where note_id = '${c.id}' and kind = 'create'`), 1);
});

test("undo: restores only untouched values and never erases later edits", { skip }, async () => {
  const N = "44444444-0000-4000-8000-000000000001";
  await save(A, [{ ...note(N), expected_revision: null }]);
  let r = await apply(N, 1, { bucket: "next" });
  const first = r.actionId;
  assert.equal((await undo(B, first)).status, "not_found", "other accounts cannot undo");
  // A person edits an unrelated column: undo restores only the agent's column.
  await save(A, [{ ...note(N, { title: "human", bucket: "next" }), expected_revision: 2 }]);
  r = await undo(A, first);
  assert.deepEqual([r.status, r.revision], ["undone", 4]);
  let n = await row(N);
  assert.deepEqual([n.title, n.bucket], ["human", "inbox"]);
  assert.equal((await undo(A, first)).status, "already_undone");
  // A person edits the column the agent changed: refused, nothing written.
  r = await apply(N, 4, { title: "agent title", bucket: "someday" });
  await save(A, [{ ...note(N, { title: "human again", bucket: "someday" }), expected_revision: 5 }]);
  assert.deepEqual(await undo(A, r.actionId), { status: "undo_conflict", fields: ["title"] });
  n = await row(N);
  assert.deepEqual([n.title, n.bucket], ["human again", "someday"]);
  // Untouched since: everything restored.
  r = await apply(N, 6, { completed_at: new Date().toISOString() });
  assert.equal((await undo(A, r.actionId)).status, "undone");
  assert.equal((await row(N)).completed_at, null);
  // Update of a note deleted since.
  r = await apply(N, 8, { bucket: "next" });
  await del(A, N, 9);
  assert.equal((await undo(A, r.actionId)).status, "note_deleted");
});

test("undo of a created note: deletes only if untouched", { skip }, async () => {
  const untouched = await createByAgent({ title: "a", content: { type: "doc" }, bucket: "inbox", tags: [] });
  assert.equal((await undo(A, untouched.actionId)).status, "undone");
  assert.equal(await row(untouched.id), undefined);
  const edited = await createByAgent({ title: "b", content: { type: "doc" }, bucket: "inbox", tags: [] });
  await save(A, [{ ...note(edited.id, { title: "mine now" }), expected_revision: 1 }]);
  assert.equal((await undo(A, edited.actionId)).status, "edited_since_created");
  assert.ok(await row(edited.id), "never deleted silently");
  const gone = await createByAgent({ title: "c", content: { type: "doc" }, bucket: "inbox", tags: [] });
  await del(A, gone.id, 1);
  assert.deepEqual(await undo(A, gone.actionId), { status: "undone", undone: gone.actionId, alreadyDeleted: true });
});

test("undo window and retention: 90 days, then values are purged", { skip }, async () => {
  const N = "55555555-0000-4000-8000-000000000001";
  await save(A, [{ ...note(N), expected_revision: null }]);
  const { actionId } = await apply(N, 1, { title: "old agent" });
  await db.query("update public.agent_actions set created_at = now() - interval '91 days' where id = $1", [actionId]);
  assert.equal((await undo(A, actionId)).status, "undo_expired");
  assert.equal((await row(N)).title, "old agent", "nothing written");
  await db.query("update public.agent_actions set created_at = now() - interval '89 days' where id = $1", [actionId]);
  const purge = async () => (await as("service_role", null, "select public.purge_agent_action_values() n"))[0].n;
  assert.equal(await purge(), 0, "inside the window");
  await db.query("update public.agent_actions set created_at = now() - interval '91 days' where id = $1", [actionId]);
  assert.equal(await purge(), 1);
  await assert.rejects(as("authenticated", A, "select public.purge_agent_action_values()"));
  const purged = (await db.query("select * from public.agent_actions where id = $1", [actionId])).rows[0];
  assert.deepEqual([purged.before, purged.after, purged.reason, Number(purged.revision_after)], [null, null, "why", 2]);
});

test("undo of legacy actions (no revisions) compares values", { skip }, async () => {
  const N = "66666666-0000-4000-8000-000000000001";
  await save(A, [{ ...note(N, { bucket: "next", completed_at: "2026-10-01T10:00:00.000Z" }), expected_revision: null }]);
  const insert = (after) => db.query(`insert into public.agent_actions (run_id, user_id, note_id, kind, before, after)
    values ($1, $2, $3, 'update', '{"bucket":"inbox","completed_at":null}', $4::jsonb) returning id`, [RUN, A, N, after]);
  const stale = (await insert('{"bucket":"someday","completed_at":"2026-10-01T10:00:00+00:00"}')).rows[0].id;
  assert.deepEqual(await undo(A, stale), { status: "undo_conflict", fields: ["bucket"] });
  // Timestamps compare by value, not by text format.
  const legacy = (await insert('{"bucket":"next","completed_at":"2026-10-01T10:00:00+00:00"}')).rows[0].id;
  assert.equal((await undo(A, legacy)).status, "undone");
  const n = await row(N);
  assert.deepEqual([n.bucket, n.completed_at], ["inbox", null]);
});
