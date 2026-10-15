import { test, before } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, skip } from "./harness.mjs";

// D-03: follow-up fields on items (ADR 001 §4) against PGlite, and proof that
// the migration is backward compatible: the payloads today's deployed code
// sends (D-01 and D-02, no follow-up fields) give the same results on a
// database without D-03 and on one with every migration.
const D03 = "20261016000000_note_followups_and_reminders.sql";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
let n = 0;
const uuid = () => `eeeeeeee-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const FOLLOWUP_KEYS = ["waiting_on", "waiting_for", "next_check_on"];

/** Helpers bound to one database. */
function api(db) {
  const self = {
    db,
    save: async (user, items, require = false) =>
      (await as(db, "authenticated", user, "select public.save_notes($1::jsonb, $2) r", [JSON.stringify(items), require]))[0].r,
    del: async (user, id, rev, unlink) =>
      unlink === undefined
        ? (await as(db, "authenticated", user, "select public.delete_note($1, $2, false) r", [id, rev]))[0].r
        : (await as(db, "authenticated", user, "select public.delete_note($1, $2, false, $3) r", [id, rev, unlink]))[0].r,
    row: async (id) => {
      const row = (await db.query("select * from public.notes where id = $1", [id])).rows[0];
      // Calendar dates as strings, the way PostgREST returns them.
      if (row?.next_check_on instanceof Date) row.next_check_on = row.next_check_on.toISOString().slice(0, 10);
      return row;
    },
    rev: async (id) => Number((await self.row(id)).revision),
    note: (id, ws, patch = {}) => ({
      id, workspace_id: ws, title: "t", content: { type: "doc" }, plain_text: "",
      bucket: "inbox", tags: [], created_at: "2026-10-13T00:00:00.000Z", completed_at: null, ...patch,
    }),
    workspace: async (user) =>
      (await db.query(`insert into public.workspaces (user_id, name) values ($1, 'W') returning id`, [user])).rows[0].id,
    run: async (user, ws, status = "running") => (await db.query(
      `insert into public.agent_runs (user_id, workspace_id, trigger, mode, provider, model, status)
       values ($1, $2, 'manual', 'organize', 'anthropic', 'm', $3) returning id`, [user, ws, status])).rows[0].id,
    apply: async (run, noteId, rev, after) =>
      (await as(db, "service_role", null, "select public.agent_apply_note_change($1, $2, $3, $4::jsonb, 'why') r",
        [run, noteId, rev, JSON.stringify(after)]))[0].r,
    createByAgent: async (run, note) =>
      (await as(db, "service_role", null, "select public.agent_create_note($1, $2::jsonb, 'r') r", [run, JSON.stringify(note)]))[0].r,
    undo: async (user, id) => (await as(db, "authenticated", user, "select public.undo_agent_action($1) r", [id]))[0].r,
    action: async (id) => (await db.query("select * from public.agent_actions where id = $1", [id])).rows[0],
  };
  return self;
}

let t, WA, WA2;
before(async () => {
  if (skip) return;
  const db = await createDb();
  await migrate(db);
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  t = api(db);
  WA = await t.workspace(A);
  WA2 = await t.workspace(A);
});

// --- Backward compatibility --------------------------------------------------------

/**
 * Every write path, with payloads exactly as the deployed D-02 code sends
 * them (no follow-up fields), on a database at `until` (exclusive) or with
 * everything. Returns normalized results, the final rows and audit rows.
 */
async function legacyScenario(until) {
  const db = await createDb();
  await migrate(db, { until });
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  const x = api(db);
  const ws = await x.workspace(A);
  const ws2 = await x.workspace(A);
  const run = await x.run(A, ws);
  const ids = Array.from({ length: 8 }, (_, i) => `22222222-0000-4000-8000-00000000000${i + 1}`);
  const [N, M, P, C, Q, S, K, Z] = ids;
  const known = new Set(ids);
  const out = [];
  const push = (label, value) => out.push([label, JSON.parse(JSON.stringify(value, (k, v) =>
    ["updatedAt", "updated_at", "created_at", "actionId", "undone", "workspace_id"].includes(k)
      || (k === "id" && typeof v === "string" && !known.has(v)) ? "*" : v))]);
  // D-01 saves and deletes.
  push("create", await x.save(A, [{ ...x.note(N, ws), expected_revision: null }]));
  push("dup", await x.save(A, [{ ...x.note(N, ws), expected_revision: null }]));
  push("update", await x.save(A, [{ ...x.note(N, ws, { title: "a", due_date: "2026-12-01" }), expected_revision: 1 }]));
  push("stale", await x.save(A, [{ ...x.note(N, ws, { title: "b" }), expected_revision: 1 }]));
  push("legacy", await x.save(A, [x.note(N, ws, { title: "c" }), { ...x.note(M, ws), expected_revision: null }]));
  push("enforce", await x.save(A, [x.note(N, ws, { title: "d" })], true));
  push("bad", await x.save(A, [{ ...x.note(Z, ws, { bucket: "nope" }), expected_revision: null }]));
  push("other", await x.save(B, [{ ...x.note(N, ws), expected_revision: 3 }]));
  // D-02 kinds and links.
  push("project", await x.save(A, [{ ...x.note(P, ws, { kind: "project", bucket: "projects" }), expected_revision: null }]));
  push("child", await x.save(A, [{ ...x.note(C, ws, { kind: "task", project_id: P }), expected_revision: null }]));
  push("kind-keep", await x.save(A, [{ ...x.note(C, ws, { title: "renamed" }), expected_revision: 1 }]));
  push("sub", await x.save(A, [{ ...x.note(S, ws, { kind: "project", project_id: P }), expected_revision: null }]));
  push("cycle", await x.save(A, [{ ...x.note(P, ws, { kind: "project", project_id: S }), expected_revision: 1 }]));
  push("not-project", await x.save(A, [{ ...x.note(Q, ws, { project_id: C }), expected_revision: null }]));
  push("move-linked", await x.save(A, [{ ...x.note(C, ws2), expected_revision: 2 }]));
  push("unkind", await x.save(A, [{ ...x.note(P, ws, { kind: "task" }), expected_revision: 1 }]));
  // Agent changes, audit and undo.
  const applied = await x.apply(run, N, 3, { bucket: "next", tags: ["x"] });
  push("apply", applied);
  push("apply-conflict", await x.apply(run, N, 1, { bucket: "someday" }));
  push("apply-unchanged", await x.apply(run, N, 4, { bucket: "next" }));
  await assert.rejects(x.apply(run, N, 4, { bucket: "bogus" }));
  push("kind-refused", await x.apply(run, N, 4, { kind: "task" }));
  await x.save(A, [{ ...x.note(K, ws), expected_revision: null }]);
  await db.query("update public.notes set triage_status = 'pending' where id = $1", [K]);
  const triaged = await x.apply(run, K, 1, { kind: "task", project_id: P, triage_status: "done" });
  push("triage", triaged);
  push("link-cycle", await x.apply(run, P, 1, { project_id: S }));
  const created = await x.createByAgent(run, { title: "made", content: { type: "doc" }, plain_text: "b", bucket: "next", tags: ["agent"] });
  push("agent-create", created);
  const createdProject = await x.createByAgent(run, { title: "p", content: { type: "doc" }, bucket: "projects", tags: [], kind: "project" });
  push("agent-create-project", createdProject);
  push("agent-create-linked", await x.createByAgent(run, { title: "c", content: { type: "doc" }, bucket: "next", tags: [], project_id: P }));
  push("undo", await x.undo(A, applied.actionId));
  push("undo-again", await x.undo(A, applied.actionId));
  push("undo-create", await x.undo(A, created.actionId));
  push("undo-triage", await x.undo(A, triaged.actionId));
  push("undo-project", await x.undo(A, createdProject.actionId));
  // Direct writes (W10) still bump the revision.
  await as(db, "authenticated", A, "update public.notes set title = 'direct' where id = $1", [M]);
  await as(db, "authenticated", A, "update public.notes set triage_status = 'done' where id = $1", [M]);
  // Deletes.
  push("delete-linked", await x.del(A, P, 1, false));
  push("delete-unlink", await x.del(A, P, 1, true));
  push("delete-stale", await x.del(A, M, 9));
  push("delete", await x.del(A, M, 2));
  push("delete-missing", await x.del(A, M, 2));
  const rows = (await db.query(`select id, title, bucket, tags, revision, due_date, completed_at, triage_status,
    source, kind, project_id, workspace_id = $1 as in_ws from public.notes
    where id = any($2) order by id`, [ws, ids])).rows;
  const others = (await db.query(`select title, bucket, kind, revision from public.notes
    where not (id = any($1)) order by title`, [ids])).rows;
  const actions = (await db.query(`select kind, before, after, revision_before, revision_after,
    undone_at is not null as undone from public.agent_actions order by kind, after::text, before::text`)).rows;
  return { out, rows, others, actions, db };
}

test("legacy rows are unchanged by the migration and read with no follow-up", { skip }, async () => {
  const db = await createDb();
  await migrate(db, { until: D03 });
  await db.exec(`insert into auth.users values ('${A}');`);
  const x = api(db);
  const ws = await x.workspace(A);
  const N = uuid();
  await x.save(A, [{ ...x.note(N, ws, { bucket: "waiting", kind: "followup", title: "Legacy" }), expected_revision: null }]);
  await x.save(A, [{ ...x.note(N, ws, { bucket: "waiting", title: "Legacy 2" }), expected_revision: 1 }]);
  const before = (await db.query("select * from public.notes where id = $1", [N])).rows[0];
  await migrate(db, { from: D03 });
  const after = (await db.query("select * from public.notes where id = $1", [N])).rows[0];
  assert.deepEqual(FOLLOWUP_KEYS.map((k) => after[k]), [null, null, null]);
  for (const key of FOLLOWUP_KEYS) delete after[key];
  assert.deepEqual(after, before, "revision, updated_at and every other column unchanged");
});

test("D-01 and D-02 payloads behave exactly the same after the D-03 migration", { skip }, async () => {
  const old = await legacyScenario(D03);
  const now = await legacyScenario();
  // Conflict copies gain the three follow-up keys, all null (additive; older
  // readers ignore unknown keys). Everything else is identical.
  let copies = 0;
  for (const [, value] of now.out)
    for (const item of [value].flat())
      if (item?.current) {
        copies++;
        assert.deepEqual(FOLLOWUP_KEYS.map((k) => item.current[k]), [null, null, null]);
        for (const key of FOLLOWUP_KEYS) delete item.current[key];
      }
  assert.ok(copies >= 4, "conflict copies were compared");
  assert.deepEqual(now.out, old.out);
  assert.deepEqual(now.rows, old.rows);
  assert.deepEqual(now.others, old.others);
  assert.deepEqual(now.actions, old.actions, "audit rows carry no new keys for legacy payloads");
  const followups = (await now.db.query(`select count(*)::int c from public.notes
    where waiting_on is not null or waiting_for is not null or next_check_on is not null`)).rows[0].c;
  assert.equal(followups, 0);
  // Signatures are unchanged.
  const signatures = async (db) => (await db.query(`select proname, pg_get_function_identity_arguments(oid) a,
    pg_get_function_result(oid) r, prosecdef from pg_proc
    where proname in ('save_notes', 'delete_note', 'note_json', 'agent_restorable', 'note_fields_differ',
      'agent_apply_note_change', 'agent_create_note', 'undo_agent_action', 'notes_manage_revision')
    order by 1, 2`)).rows;
  assert.deepEqual(await signatures(now.db), await signatures(old.db));
});

// --- Persistence and validation ------------------------------------------------------

test("follow-up fields: saved when sent, kept when absent, cleared with null, revisioned", { skip }, async () => {
  const N = uuid();
  let [r] = await t.save(A, [{ ...t.note(N, WA, { kind: "task", bucket: "waiting",
    waiting_on: "Dana", waiting_for: "Signed contract", next_check_on: "2026-10-20" }), expected_revision: null }]);
  assert.deepEqual([r.status, r.revision], ["saved", 1]);
  let row = await t.row(N);
  assert.deepEqual([row.waiting_on, row.waiting_for, row.next_check_on], ["Dana", "Signed contract", "2026-10-20"]);
  [r] = await t.save(A, [{ ...t.note(N, WA, { title: "renamed", bucket: "waiting" }), expected_revision: 1 }]);
  row = await t.row(N);
  assert.deepEqual([r.revision, row.waiting_on, row.next_check_on], [2, "Dana", "2026-10-20"], "absent keeps them");
  [r] = await t.save(A, [{ ...t.note(N, WA, { title: "renamed", bucket: "waiting", waiting_on: "Dana" }), expected_revision: 2 }]);
  assert.equal(r.revision, 2, "the same value does not bump the revision");
  [r] = await t.save(A, [{ ...t.note(N, WA, { title: "renamed", bucket: "waiting", next_check_on: "2026-10-21" }), expected_revision: 2 }]);
  assert.equal(r.revision, 3, "a new check date bumps the revision");
  [r] = await t.save(A, [{ ...t.note(N, WA, { title: "renamed", bucket: "waiting", waiting_for: "Invoice" }), expected_revision: 3 }]);
  assert.equal(r.revision, 4);
  [r] = await t.save(A, [{ ...t.note(N, WA, { title: "renamed", kind: "document", bucket: "reference" }), expected_revision: 4 }]);
  row = await t.row(N);
  assert.deepEqual([row.kind, row.waiting_on, row.waiting_for], ["document", "Dana", "Invoice"], "a kind change keeps them");
  [r] = await t.save(A, [{ ...t.note(N, WA, { title: "renamed", waiting_on: null, waiting_for: null, next_check_on: null }), expected_revision: 5 }]);
  row = await t.row(N);
  assert.deepEqual([r.revision, row.waiting_on, row.waiting_for, row.next_check_on], [6, null, null, null]);
  // Any kind may carry them, including a plain note in the inbox.
  const M = uuid();
  [r] = await t.save(A, [{ ...t.note(M, WA, { waiting_on: "Lee" }), expected_revision: null }]);
  assert.deepEqual([r.status, (await t.row(M)).kind], ["saved", "note"]);
  // Direct writes (W10) bump the revision too.
  await as(t.db, "authenticated", A, "update public.notes set next_check_on = '2027-01-02' where id = $1", [M]);
  assert.equal(await t.rev(M), 2);
});

test("follow-up fields: limits, control characters and dates are enforced per item", { skip }, async () => {
  const ok = uuid();
  const cases = [
    { waiting_on: "x".repeat(201) },
    { waiting_for: "x".repeat(2001) },
    { waiting_on: "line\nbreak" },
    { waiting_for: "tab\there" },
    { waiting_on: "nel\u0085" },
    { waiting_on: "" },
    { next_check_on: "2026-02-30" },
    { next_check_on: "soon" },
  ];
  const items = cases.map((patch) => ({ ...t.note(uuid(), WA, patch), expected_revision: null }));
  const results = await t.save(A, [{ ...t.note(ok, WA, { waiting_on: "é".repeat(200), waiting_for: "y".repeat(2000) }), expected_revision: null }, ...items]);
  assert.equal(results[0].status, "saved", "limits count characters, at the limit is fine");
  assert.deepEqual(results.slice(1).map((r) => [r.status, r.code]), cases.map(() => ["invalid", "invalid_note"]));
  assert.equal((await t.db.query("select count(*)::int c from public.notes where id = any($1)", [items.map((i) => i.id)])).rows[0].c, 0);
  await assert.rejects(as(t.db, "authenticated", A, "update public.notes set waiting_on = $1 where id = $2", ["a\u0007", ok]),
    /notes_waiting_on_check/, "direct writes hit the same rules");
  await assert.rejects(as(t.db, "authenticated", A, "update public.notes set next_check_on = '10000-01-01' where id = $1", [ok]));
});

test("conflict copies and the checking index include follow-ups", { skip }, async () => {
  const N = uuid();
  await t.save(A, [{ ...t.note(N, WA, { waiting_on: "Sam", next_check_on: "2026-11-02" }), expected_revision: null }]);
  const [r] = await t.save(A, [{ ...t.note(N, WA), expected_revision: 7 }]);
  assert.equal(r.status, "conflict");
  assert.deepEqual([r.current.waiting_on, r.current.waiting_for, r.current.next_check_on], ["Sam", null, "2026-11-02"]);
  const index = (await t.db.query(`select indexdef from pg_indexes where indexname = 'notes_next_check_idx'`)).rows[0].indexdef;
  assert.match(index, /\(user_id, next_check_on\) WHERE \(\(next_check_on IS NOT NULL\) AND \(completed_at IS NULL\)\)/);
  // Moving a note to another workspace keeps its follow-up.
  const [moved] = await t.save(A, [{ ...t.note(N, WA2), expected_revision: 1 }]);
  assert.equal(moved.status, "saved");
  assert.equal((await t.row(N)).waiting_on, "Sam");
});

// --- Agent ------------------------------------------------------------------------

test("agent: follow-up changes are audited atomically and undone safely", { skip }, async () => {
  const run = await t.run(A, WA);
  const N = uuid();
  await t.save(A, [{ ...t.note(N, WA, { kind: "task", next_check_on: "2026-10-20" }), expected_revision: null }]);
  const r = await t.apply(run, N, 1, { waiting_on: "Dana", waiting_for: "Quote", next_check_on: "2026-10-27", bucket: "waiting" });
  assert.deepEqual([r.status, r.revision], ["applied", 2]);
  let action = await t.action(r.actionId);
  assert.deepEqual(action.before, { bucket: "inbox", waiting_on: null, waiting_for: null, next_check_on: "2026-10-20" });
  assert.deepEqual(action.after, { bucket: "waiting", waiting_on: "Dana", waiting_for: "Quote", next_check_on: "2026-10-27" });
  assert.deepEqual([Number(action.revision_before), Number(action.revision_after)], [1, 2]);
  // Allowed on any existing note (unlike kind), and an unchanged value is no change.
  assert.equal((await t.apply(run, N, 2, { waiting_on: "Dana" })).status, "unchanged");
  // A refused value writes neither the note nor the audit row.
  await assert.rejects(t.apply(run, N, 2, { waiting_on: "x".repeat(201) }));
  assert.equal(await t.rev(N), 2);
  // Undo, untouched since: everything comes back.
  assert.equal((await t.undo(A, r.actionId)).status, "undone");
  let row = await t.row(N);
  assert.deepEqual([row.bucket, row.waiting_on, row.waiting_for, row.next_check_on], ["inbox", null, null, "2026-10-20"]);
  // Undo after the user changed a follow-up field the agent set: a conflict.
  const second = await t.apply(run, N, 3, { waiting_on: "Kim", next_check_on: "2026-11-01" });
  await t.save(A, [{ ...t.note(N, WA, { kind: "task", waiting_on: "Kim R." }), expected_revision: 4 }]);
  assert.deepEqual(await t.undo(A, second.actionId), { status: "undo_conflict", fields: ["waiting_on"] });
  assert.equal((await t.row(N)).waiting_on, "Kim R.", "nothing written");
  // Undo after an unrelated edit: only the agent's columns are restored.
  const third = await t.apply(run, N, 5, { waiting_for: "Slides" });
  await t.save(A, [{ ...t.note(N, WA, { kind: "task", title: "edited" }), expected_revision: 6 }]);
  assert.equal((await t.undo(A, third.actionId)).status, "undone");
  row = await t.row(N);
  assert.deepEqual([row.title, row.waiting_for, row.waiting_on], ["edited", null, "Kim R."]);
  action = await t.action(third.actionId);
  assert.ok(action.undone_at && action.undone_by === A);
});

test("agent: created notes carry follow-ups in the audit only when given", { skip }, async () => {
  const run = await t.run(A, WA);
  const made = await t.createByAgent(run, { title: "Chase", content: { type: "doc" }, bucket: "waiting", tags: [],
    kind: "followup", waiting_on: "Ops", next_check_on: "2026-10-30" });
  assert.equal(made.status, "created");
  const row = await t.row(made.id);
  assert.deepEqual([row.waiting_on, row.waiting_for, row.next_check_on], ["Ops", null, "2026-10-30"]);
  const action = await t.action(made.actionId);
  assert.deepEqual([action.after.waiting_on, action.after.next_check_on, Object.hasOwn(action.after, "waiting_for")],
    ["Ops", "2026-10-30", false]);
  assert.equal((await t.undo(A, made.actionId)).status, "undone");
  assert.equal(await t.row(made.id), undefined);
  // Another workspace's run never sees the note.
  const other = await t.run(A, WA2);
  const N = uuid();
  await t.save(A, [{ ...t.note(N, WA), expected_revision: null }]);
  assert.deepEqual(await t.apply(other, N, 1, { waiting_on: "x" }), { status: "not_found" });
});
