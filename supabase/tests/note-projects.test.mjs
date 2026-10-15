import { test, before } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, skip } from "./harness.mjs";

// D-02: kinds and project links (ADR 001 §2, §3, §3a) against PGlite, with
// every migration applied in order. Concurrency is not exercised: PGlite has
// one connection, so the per-workspace advisory lock that serializes
// concurrent re-parentings is checked by its presence (it is held inside the
// transaction), not by two racing transactions.
const D02 = "20261015000000_note_kinds_and_project_links.sql";
// The compatibility checks compare D-01 with D-02 exactly, so their D-02 side
// stops before D-03 (whose own checks are in note-followups.test.mjs).
const D03 = "20261016000000_note_followups_and_reminders.sql";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
let n = 0;
const uuid = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, "0")}`;

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
    row: async (id) => (await db.query("select * from public.notes where id = $1", [id])).rows[0],
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
  };
  return self;
}

let t, WA, WA2, WB;
/** Creates a project (optionally under a parent) as user A and returns its id. */
async function project(parent = null, ws = WA) {
  const id = uuid();
  const [r] = await t.save(A, [{ ...t.note(id, ws, { kind: "project", project_id: parent }), expected_revision: null }]);
  assert.equal(r.status, "saved", `project create: ${r.code ?? ""}`);
  return id;
}
/** Re-parents a note as user A at its current revision; returns the result. */
async function link(id, parent, patch = {}) {
  const row = await t.row(id);
  const [r] = await t.save(A, [{
    ...t.note(id, row.workspace_id, { kind: row.kind, title: row.title }), project_id: parent,
    ...patch, expected_revision: Number(row.revision),
  }]);
  return r;
}

before(async () => {
  if (skip) return;
  const db = await createDb();
  await migrate(db);
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  t = api(db);
  WA = await t.workspace(A);
  WA2 = await t.workspace(A);
  WB = await t.workspace(B);
});

// --- Legacy data and backward compatibility -----------------------------------

/**
 * The D-01 payloads, exactly as today's deployed code sends them (no kind or
 * project fields), on a database at `until` (exclusive) or with everything.
 * Returns results with ids and timestamps normalized, plus the final rows.
 */
async function legacyScenario(until) {
  const db = await createDb();
  await migrate(db, { until });
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  const x = api(db);
  const ws = await x.workspace(A);
  const run = await x.run(A, ws);
  const N = "11111111-0000-4000-8000-000000000001";
  const M = "11111111-0000-4000-8000-000000000002";
  const out = [];
  const push = (label, value) => out.push([label, JSON.parse(JSON.stringify(value, (k, v) =>
    k === "updatedAt" || k === "updated_at" || k === "created_at" || k === "actionId" || k === "undone"
      || k === "workspace_id" || (k === "id" && typeof v === "string" && v !== N && v !== M) ? "*" : v))]);
  push("create", await x.save(A, [{ ...x.note(N, ws), expected_revision: null }]));
  push("dup", await x.save(A, [{ ...x.note(N, ws), expected_revision: null }]));
  push("update", await x.save(A, [{ ...x.note(N, ws, { title: "a", due_date: "2026-12-01" }), expected_revision: 1 }]));
  push("stale", await x.save(A, [{ ...x.note(N, ws, { title: "b" }), expected_revision: 1 }]));
  push("legacy", await x.save(A, [x.note(N, ws, { title: "c" }), { ...x.note(M, ws), expected_revision: null }]));
  push("enforce", await x.save(A, [x.note(N, ws, { title: "d" })], true));
  push("bad", await x.save(A, [{ ...x.note(uuid(), ws, { bucket: "nope" }), expected_revision: null }]));
  push("other", await x.save(B, [{ ...x.note(N, ws), expected_revision: 3 }]));
  const applied = await x.apply(run, N, 3, { bucket: "next", tags: ["x"] });
  push("apply", applied);
  push("apply-conflict", await x.apply(run, N, 1, { bucket: "someday" }));
  push("apply-unchanged", await x.apply(run, N, 4, { bucket: "next" }));
  await assert.rejects(x.apply(run, N, 4, { bucket: "bogus" }));
  const created = await x.createByAgent(run, { title: "made", content: { type: "doc" }, plain_text: "b", bucket: "next", tags: ["agent"] });
  push("agent-create", created);
  push("undo", await x.undo(A, applied.actionId));
  push("undo-again", await x.undo(A, applied.actionId));
  push("undo-create", await x.undo(A, created.actionId));
  push("delete-stale", await x.del(A, M, 9));
  push("delete", await x.del(A, M, 1));
  push("delete-missing", await x.del(A, M, 1));
  const rows = (await db.query(`select id, title, bucket, tags, revision, due_date, completed_at, triage_status,
    source, workspace_id = $1 as in_ws from public.notes order by id`, [ws])).rows;
  const actions = (await db.query(`select kind, before, after, revision_before, revision_after,
    undone_at is not null as undone from public.agent_actions order by created_at, kind`)).rows;
  return { out, rows, actions, db };
}

test("legacy rows read as kind note with no project, and are otherwise unchanged", { skip }, async () => {
  const db = await createDb();
  await migrate(db, { until: D02 });
  await db.exec(`insert into auth.users values ('${A}');`);
  const x = api(db);
  const ws = await x.workspace(A);
  const N = uuid();
  await x.save(A, [{ ...x.note(N, ws, { bucket: "projects", title: "Legacy" }), expected_revision: null }]);
  await x.save(A, [{ ...x.note(N, ws, { bucket: "projects", title: "Legacy 2" }), expected_revision: 1 }]);
  const before = (await db.query("select * from public.notes where id = $1", [N])).rows[0];
  await migrate(db, { from: D02, until: D03 });
  const after = (await db.query("select * from public.notes where id = $1", [N])).rows[0];
  assert.deepEqual([after.kind, after.project_id], ["note", null], "a projects-bucket note is not reclassified");
  const { kind: _k, project_id: _p, ...rest } = after;
  assert.deepEqual(rest, before, "revision, updated_at and every other column unchanged");
});

test("D-01 payloads behave exactly the same after the D-02 migration", { skip }, async () => {
  const old = await legacyScenario(D02);
  const now = await legacyScenario(D03);
  // Conflict copies gain kind and project_id (additive; older readers ignore
  // unknown keys). Everything else is identical.
  const copies = [];
  for (const [, value] of now.out)
    for (const item of [value].flat())
      if (item?.current) {
        copies.push([item.current.kind, item.current.project_id]);
        delete item.current.kind;
        delete item.current.project_id;
      }
  assert.ok(copies.length >= 3);
  assert.ok(copies.every(([kind, projectId]) => kind === "note" && projectId === null));
  assert.deepEqual(now.out, old.out);
  assert.deepEqual(now.rows, old.rows);
  assert.deepEqual(now.actions, old.actions, "audit rows carry no new keys for legacy payloads");
  const kinds = (await now.db.query("select distinct kind, project_id from public.notes")).rows;
  assert.deepEqual(kinds, [{ kind: "note", project_id: null }]);
  // The D-01 three-argument delete is still there and still unconditional.
  const fns = (await now.db.query(`select pg_get_function_identity_arguments(oid) a from pg_proc
    where proname = 'delete_note' order by 1`)).rows.map((r) => r.a);
  assert.deepEqual(fns, [
    "p_id uuid, p_expected_revision bigint, p_require_revision boolean",
    "p_id uuid, p_expected_revision bigint, p_require_revision boolean, p_unlink_children boolean",
  ]);
});

// --- Kinds ----------------------------------------------------------------------

test("kind: saved when sent, kept when absent, validated", { skip }, async () => {
  const N = uuid();
  let [r] = await t.save(A, [{ ...t.note(N, WA, { kind: "task", bucket: "someday" }), expected_revision: null }]);
  assert.equal(r.status, "saved");
  assert.deepEqual([(await t.row(N)).kind, (await t.row(N)).bucket], ["task", "someday"], "kind independent of bucket");
  [r] = await t.save(A, [{ ...t.note(N, WA, { title: "renamed", bucket: "next" }), expected_revision: 1 }]);
  assert.deepEqual([r.status, (await t.row(N)).kind], ["saved", "task"], "absent kind leaves it unchanged");
  [r] = await t.save(A, [{ ...t.note(N, WA, { kind: "document" }), expected_revision: 2 }]);
  assert.deepEqual([r.revision, (await t.row(N)).kind], [3, "document"], "a kind change bumps the revision");
  [r] = await t.save(A, [{ ...t.note(N, WA, { kind: "epic" }), expected_revision: 3 }]);
  assert.deepEqual([r.status, r.code], ["invalid", "invalid_note"]);
  const M = uuid();
  await t.save(A, [{ ...t.note(M, WA), expected_revision: null }]);
  assert.equal((await t.row(M)).kind, "note", "default for new rows");
});

// --- Link validation ------------------------------------------------------------

test("links: self, non-project parent, other workspace and other user are refused", { skip }, async () => {
  const P = await project();
  const item = uuid();
  let [r] = await t.save(A, [{ ...t.note(item, WA, { project_id: P }), expected_revision: null }]);
  assert.equal(r.status, "saved");
  assert.equal((await t.row(item)).project_id, P);
  assert.equal((await link(P, P)).code, "invalid_project_link", "self-link");
  const other = uuid();
  [r] = await t.save(A, [{ ...t.note(other, WA, { project_id: item }), expected_revision: null }]);
  assert.deepEqual([r.status, r.code], ["invalid", "invalid_project_link"], "target is not a project");
  const elsewhere = await project(null, WA2);
  [r] = await t.save(A, [{ ...t.note(uuid(), WA, { project_id: elsewhere }), expected_revision: null }]);
  assert.equal(r.code, "invalid_project_link", "another workspace of the same user");
  const theirs = uuid();
  await t.save(B, [{ ...t.note(theirs, WB, { kind: "project" }), expected_revision: null }]);
  [r] = await t.save(A, [{ ...t.note(uuid(), WA, { project_id: theirs }), expected_revision: null }]);
  assert.equal(r.code, "invalid_project_link", "another user's project");
  [r] = await t.save(A, [{ ...t.note(uuid(), WA, { project_id: uuid() }), expected_revision: null }]);
  assert.equal(r.code, "invalid_project_link", "missing target");
  // Direct writes (W10) hit the same rules.
  await assert.rejects(as(t.db, "authenticated", A, "update public.notes set project_id = $1 where id = $2", [elsewhere, item]),
    /invalid_project_link/);
  await assert.rejects(as(t.db, "authenticated", A, "update public.notes set project_id = id where id = $1", [P]),
    /invalid_project_link|notes_project_not_self/);
});

test("a project with linked items cannot stop being a project", { skip }, async () => {
  const P = await project();
  const C = uuid();
  await t.save(A, [{ ...t.note(C, WA, { project_id: P }), expected_revision: null }]);
  const r = await link(P, null, { kind: "task" });
  assert.deepEqual([r.status, r.code], ["invalid", "project_has_linked_items"]);
  assert.equal((await t.row(P)).kind, "project");
  assert.equal((await link(C, null)).status, "saved");
  assert.equal((await link(P, null, { kind: "task" })).status, "saved", "allowed once nothing links to it");
});

test("cycles are refused: A→B→A and A→B→C→A", { skip }, async () => {
  const PA = await project();
  const PB = await project(PA);
  let r = await link(PA, PB);
  assert.deepEqual([r.status, r.code], ["invalid", "project_cycle"]);
  const PC = await project(PB);
  r = await link(PA, PC);
  assert.equal(r.code, "project_cycle");
  assert.equal((await t.row(PA)).project_id, null, "nothing written");
  await assert.rejects(as(t.db, "authenticated", A, "update public.notes set project_id = $1 where id = $2", [PC, PA]),
    /project_cycle/);
});

test("depth: five levels of projects, not six, also when moving a subtree", { skip }, async () => {
  const chain = [await project()];
  for (let i = 1; i < 5; i++) chain.push(await project(chain[i - 1]));
  const [r6] = await t.save(A, [{ ...t.note(uuid(), WA, { kind: "project", project_id: chain[4] }), expected_revision: null }]);
  assert.deepEqual([r6.status, r6.code], ["invalid", "project_depth_exceeded"]);
  const [item] = await t.save(A, [{ ...t.note(uuid(), WA, { project_id: chain[4] }), expected_revision: null }]);
  assert.equal(item.status, "saved", "non-project items attach at any level");
  // A root project with two levels of sub-projects (height 2 below it).
  const S = await project();
  const S1 = await project(S);
  await project(S1);
  assert.equal((await link(S, chain[2])).code, "project_depth_exceeded", "3 above + 1 + 2 below = 6");
  assert.equal((await link(S, chain[1])).status, "saved", "2 above + 1 + 2 below = 5");
  // Turning a linked note into a project counts it as a level.
  const N = uuid();
  await t.save(A, [{ ...t.note(N, WA, { project_id: chain[4] }), expected_revision: null }]);
  assert.equal((await link(N, chain[4], { kind: "project" })).code, "project_depth_exceeded");
});

test("re-parenting a project holds the per-workspace advisory lock", { skip }, async () => {
  const P = await project();
  const Q = await project();
  const fn = (await t.db.query("select pg_get_functiondef('public.notes_validate_project_link'::regproc) d")).rows[0].d;
  assert.match(fn, /pg_advisory_xact_lock\(hashtextextended\(new\.workspace_id::text, 0\)\)/);
  await t.db.exec("begin");
  try {
    await t.db.query("update public.notes set project_id = $1 where id = $2", [P, Q]);
    const locks = (await t.db.query("select count(*)::int c from pg_locks where locktype = 'advisory'")).rows[0].c;
    assert.equal(locks, 1, "lock held until the transaction ends");
  } finally {
    await t.db.exec("rollback");
  }
  // Ordinary item links do not take it.
  const C = uuid();
  await t.save(A, [{ ...t.note(C, WA), expected_revision: null }]);
  await t.db.exec("begin");
  try {
    await t.db.query("update public.notes set project_id = $1 where id = $2", [P, C]);
    assert.equal((await t.db.query("select count(*)::int c from pg_locks where locktype = 'advisory'")).rows[0].c, 0);
  } finally {
    await t.db.exec("rollback");
  }
});

// --- Moves and deletes ------------------------------------------------------------

test("linked items cannot move to another workspace until unlinked", { skip }, async () => {
  const P = await project();
  const C = uuid();
  await t.save(A, [{ ...t.note(C, WA, { project_id: P }), expected_revision: null }]);
  let [r] = await t.save(A, [{ ...t.note(C, WA2, { project_id: P }), expected_revision: 1 }]);
  assert.deepEqual([r.status, r.code], ["invalid", "linked_item_move"], "a linked child");
  [r] = await t.save(A, [{ ...t.note(C, WA2), expected_revision: 1 }]);
  assert.equal(r.code, "linked_item_move", "absent project_id keeps the link");
  [r] = await t.save(A, [{ ...t.note(P, WA2, { kind: "project" }), expected_revision: 1 }]);
  assert.equal(r.code, "linked_item_move", "a project with linked items");
  assert.equal((await t.row(P)).workspace_id, WA);
  await assert.rejects(as(t.db, "authenticated", A, "update public.notes set workspace_id = $1 where id = $2", [WA2, C]),
    /notes_project_fk/, "direct writes fail the composite key");
  [r] = await t.save(A, [{ ...t.note(C, WA2, { project_id: null }), expected_revision: 1 }]);
  assert.equal(r.status, "saved", "unlink and move in one save");
  [r] = await t.save(A, [{ ...t.note(P, WA2, { kind: "project" }), expected_revision: 1 }]);
  assert.equal(r.status, "saved", "an empty project moves");
});

test("delete: refused with children, unlinkChildren moves direct children up", { skip }, async () => {
  const G = await project();
  const P = await project(G);
  const C = uuid();
  await t.save(A, [{ ...t.note(C, WA, { project_id: P }), expected_revision: null }]);
  const SP = await project(P);
  const D = uuid();
  await t.save(A, [{ ...t.note(D, WA, { project_id: SP }), expected_revision: null }]);
  let r = await t.del(A, P, 1, false);
  assert.deepEqual([r.status, r.count, r.currentRevision, r.current.id], ["project_has_linked_items", 2, 1, P]);
  assert.ok(await t.row(P), "not deleted");
  r = await t.del(A, P, 1, true);
  assert.deepEqual([r.status, r.unlinked], ["deleted", 2]);
  assert.equal(await t.row(P), undefined);
  assert.deepEqual([(await t.row(C)).project_id, await t.rev(C)], [G, 2], "child moved up, revision bumped");
  assert.equal((await t.row(SP)).project_id, G, "sub-project moved up with its subtree");
  assert.deepEqual([(await t.row(D)).project_id, await t.rev(D)], [SP, 1], "deeper descendants unchanged");
  // A root project's children become unlinked.
  r = await t.del(A, G, 1, true);
  assert.equal(r.status, "deleted");
  assert.deepEqual([(await t.row(C)).project_id, (await t.row(SP)).project_id], [null, null]);
  // Stale revision still wins over the children check.
  const Q = await project();
  await t.save(A, [{ ...t.note(uuid(), WA, { project_id: Q }), expected_revision: null }]);
  assert.equal((await t.del(A, Q, 7, true)).status, "conflict");
  assert.equal((await t.del(B, Q, 1, true)).status, "not_found");
  // The D-01 delete is unconditional; the foreign key detaches children.
  const R = await project();
  const RC = uuid();
  await t.save(A, [{ ...t.note(RC, WA, { project_id: R }), expected_revision: null }]);
  assert.equal((await t.del(A, R, 1)).status, "deleted");
  assert.deepEqual([(await t.row(RC)).project_id, await t.rev(RC)], [null, 2]);
});

test("deleting a workspace or account with linked items still cascades", { skip }, async () => {
  const ws = await t.workspace(A);
  const P = await project(null, ws);
  const SP = await project(P, ws);
  await t.save(A, [{ ...t.note(uuid(), ws, { project_id: SP }), expected_revision: null }]);
  await t.db.query("delete from public.workspaces where id = $1", [ws]);
  assert.equal((await t.db.query("select count(*)::int c from public.notes where workspace_id = $1", [ws])).rows[0].c, 0);
});

// --- Tree reads ---------------------------------------------------------------------

test("project_descendants and project_ancestors respect ownership and depth", { skip }, async () => {
  const P = await project();
  const S = await project(P);
  const I = uuid();
  await t.save(A, [{ ...t.note(I, WA, { project_id: S }), expected_revision: null }]);
  const D = uuid();
  await t.save(A, [{ ...t.note(D, WA, { project_id: P }), expected_revision: null }]);
  const desc = await as(t.db, "authenticated", A, "select id, depth from public.project_descendants($1) order by depth, id", [P]);
  assert.deepEqual(desc.map((r) => [r.id, r.depth]), [[D, 1], [S, 1], [I, 2]].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])));
  const anc = await as(t.db, "authenticated", A, "select id, depth from public.project_ancestors($1) order by depth", [I]);
  assert.deepEqual(anc.map((r) => [r.id, r.depth]), [[S, 1], [P, 2]]);
  assert.deepEqual(await as(t.db, "authenticated", B, "select * from public.project_descendants($1)", [P]), [], "RLS applies");
  assert.deepEqual(await as(t.db, "authenticated", B, "select * from public.project_ancestors($1)", [I]), []);
  await assert.rejects(as(t.db, "anon", null, "select * from public.project_descendants($1)", [P]));
  const defs = (await t.db.query(`select proname, prosecdef from pg_proc
    where proname in ('project_descendants', 'project_ancestors', 'notes_validate_project_link') order by 1`)).rows;
  assert.ok(defs.every((d) => d.prosecdef === false), "security invoker");
});

// --- Agent ------------------------------------------------------------------------

test("agent: kind changes only on pending captures and its own new notes", { skip }, async () => {
  const run = await t.run(A, WA);
  const existing = uuid();
  await t.save(A, [{ ...t.note(existing, WA), expected_revision: null }]);
  assert.deepEqual(await t.apply(run, existing, 1, { kind: "task" }), { status: "kind_not_allowed" });
  assert.equal((await t.row(existing)).kind, "note");
  assert.equal(await t.rev(existing), 1, "nothing written");
  const capture = uuid();
  await t.save(A, [{ ...t.note(capture, WA), expected_revision: null }]);
  await t.db.query("update public.notes set triage_status = 'pending' where id = $1", [capture]);
  let r = await t.apply(run, capture, 1, { kind: "task", triage_status: "done" });
  assert.equal(r.status, "applied");
  r = await t.apply(run, capture, 2, { kind: "followup" });
  assert.equal(r.status, "applied", "still triaging it in the same run");
  const otherRun = await t.run(A, WA);
  assert.equal((await t.apply(otherRun, capture, 3, { kind: "document" })).status, "kind_not_allowed", "a later run");
  const made = await t.createByAgent(run, { title: "p", content: { type: "doc" }, bucket: "projects", tags: [], kind: "project" });
  assert.equal(made.status, "created");
  assert.equal((await t.row(made.id)).kind, "project");
  const child = await t.createByAgent(run, { title: "c", content: { type: "doc" }, bucket: "next", tags: [], project_id: made.id });
  assert.equal((await t.row(child.id)).project_id, made.id);
  assert.equal((await t.apply(run, child.id, 1, { kind: "task" })).status, "applied", "created in this run");
  const audit = (await t.db.query("select after from public.agent_actions where id = $1", [made.actionId])).rows[0].after;
  assert.deepEqual([audit.kind, Object.hasOwn(audit, "project_id")], ["project", false]);
  // project_id may be set on any note in the workspace.
  r = await t.apply(run, existing, 1, { project_id: made.id });
  assert.equal(r.status, "applied");
  const action = (await t.db.query("select before, after from public.agent_actions where id = $1", [r.actionId])).rows[0];
  assert.deepEqual([action.before, action.after], [{ project_id: null }, { project_id: made.id }]);
});

test("agent: links stay inside the run's workspace; rule failures are results", { skip }, async () => {
  const run = await t.run(A, WA);
  const N = uuid();
  await t.save(A, [{ ...t.note(N, WA), expected_revision: null }]);
  const elsewhere = await project(null, WA2);
  assert.deepEqual(await t.apply(run, N, 1, { project_id: elsewhere }), { status: "invalid", code: "invalid_project_link" });
  assert.deepEqual(await t.createByAgent(run, { title: "x", content: { type: "doc" }, bucket: "next", tags: [], project_id: elsewhere }),
    { status: "invalid", code: "invalid_project_link" });
  const PA = await project();
  const PB = await project(PA);
  assert.deepEqual(await t.apply(run, PA, 1, { project_id: PB }), { status: "invalid", code: "project_cycle" });
  assert.equal(await t.rev(N), 1);
  assert.equal((await t.db.query("select count(*)::int c from public.agent_actions where run_id = $1", [run])).rows[0].c, 0,
    "no audit without a change");
});

test("undo: a project_id restore that would form a cycle or exceed depth is a conflict", { skip }, async () => {
  const run = await t.run(A, WA);
  const PA = await project();
  const PB = await project(PA);
  // The agent moves B to the root; the user then puts A under B.
  const moved = await t.apply(run, PB, 1, { project_id: null });
  assert.equal(moved.status, "applied");
  assert.equal((await link(PA, PB)).status, "saved");
  const r = await t.undo(A, moved.actionId);
  assert.deepEqual(r, { status: "undo_conflict", fields: ["project_id"], reason: "project_cycle" });
  assert.equal((await t.row(PB)).project_id, null, "nothing written");
  assert.equal((await t.db.query("select undone_at from public.agent_actions where id = $1", [moved.actionId])).rows[0].undone_at, null);
  // Depth: the agent lifts T (with sub-project T1) out of Y to the root; Y
  // then moves under a chain of three, so restoring would make 4 + 1 + 1.
  const Y = await project();
  const T = await project(Y);
  await project(T);
  const lift = await t.apply(run, T, 1, { project_id: null });
  assert.equal(lift.status, "applied");
  const host = await project(await project(await project()));
  assert.equal((await link(Y, host)).status, "saved", "Y is now at depth 4");
  assert.deepEqual(await t.undo(A, lift.actionId),
    { status: "undo_conflict", fields: ["project_id"], reason: "project_depth_exceeded" });
  assert.equal((await t.row(T)).project_id, null);
});

test("undo of a created project that now has linked items is refused", { skip }, async () => {
  const run = await t.run(A, WA);
  const made = await t.createByAgent(run, { title: "p", content: { type: "doc" }, bucket: "projects", tags: [], kind: "project" });
  const C = uuid();
  await t.save(A, [{ ...t.note(C, WA, { project_id: made.id }), expected_revision: null }]);
  assert.equal(await t.rev(made.id), 1, "linking does not bump the project");
  assert.deepEqual(await t.undo(A, made.actionId), { status: "project_has_linked_items" });
  assert.ok(await t.row(made.id));
  await link(C, null);
  assert.equal((await t.undo(A, made.actionId)).status, "undone");
});

test("undo restores kind and project_id when nothing changed since", { skip }, async () => {
  const run = await t.run(A, WA);
  const P = await project();
  const N = uuid();
  await t.save(A, [{ ...t.note(N, WA), expected_revision: null }]);
  await t.db.query("update public.notes set triage_status = 'pending' where id = $1", [N]);
  const r = await t.apply(run, N, 1, { kind: "task", project_id: P, triage_status: "done" });
  assert.equal((await t.undo(A, r.actionId)).status, "undone");
  const row = await t.row(N);
  assert.deepEqual([row.kind, row.project_id, row.triage_status], ["note", null, "pending"]);
});
