import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import { as, createDb, migrate, migrationFiles, skip } from "./harness.mjs";

// The workflow run history migration is applied to production before the code
// that uses it. 1. Catalog: it only adds the two new tables (and their
// constraints, indexes and policies); everything that existed before is the
// same afterwards. 2. Behavior: owners see only their own runs; links stay in
// the run's space; history outlives a deleted workflow; finished runs keep
// their invariants.
const MIGRATION = "20261023000000_workflow_runs.sql";
const NEW_TABLES = ["workflow_runs", "workflow_run_items"];
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const next = () => migrationFiles().find((f) => f > MIGRATION);

async function database(until) {
  const db = await createDb();
  await migrate(db, { until });
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  return db;
}

async function catalog(db) {
  const rows = async (sql) => (await db.query(sql)).rows;
  return {
    functions: await rows(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' k, pg_get_functiondef(p.oid) d
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' order by 1`),
    triggers: await rows(`select tgrelid::regclass::text t, tgname, pg_get_triggerdef(oid) d from pg_trigger where not tgisinternal order by 1, 2`),
    policies: await rows(`select tablename t, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`),
    tables: await rows(`select relname t, relacl::text acl, relrowsecurity from pg_class c
      join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and relkind = 'r' order by 1`),
    columns: await rows(`select table_name t, column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'public' order by 1, 2`),
    constraints: await rows(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d
      from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await rows(`select tablename t, indexname, indexdef from pg_indexes where schemaname = 'public' order by 2`),
  };
}

const onNewTable = (row) => NEW_TABLES.includes(String(row.t).replace(/^public\./, ""));

test("catalog: nothing existing changes; only the two new tables are added", { skip }, async () => {
  assert.ok(migrationFiles().includes(MIGRATION));
  const before = await catalog(await database(MIGRATION));
  const after = await catalog(await database(next()));
  for (const key of Object.keys(before)) {
    assert.deepEqual(after[key].filter((r) => !onNewTable(r)), before[key], key);
    assert.equal(before[key].some(onNewTable), false, `${key}: nothing pre-existing on the new tables`);
  }
  assert.deepEqual(after.tables.filter(onNewTable).map((t) => [t.t, t.relrowsecurity]),
    [["workflow_run_items", true], ["workflow_runs", true]]);
});

async function seeded() {
  const db = await database(next());
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const ws = async (who) => (await q(`insert into public.workspaces (user_id, name) values ($1, 'W') returning id`, [who]))[0].id;
  const wf = async (who, workspace) =>
    (await q(`insert into public.workflows (user_id, workspace_id, name) values ($1, $2, 'Digest') returning id`, [who, workspace]))[0].id;
  const note = async (who, workspace) => {
    const id = uuid();
    await q(`insert into public.notes (id, user_id, workspace_id, title, content, plain_text) values ($1, $2, $3, 't', '{}'::jsonb, '')`,
      [id, who, workspace]);
    return id;
  };
  const W1 = await ws(A);
  const W2 = await ws(A);
  const WB = await ws(B);
  return { db, q, W1, W2, WB, F1: await wf(A, W1), FB: await wf(B, WB), N1: await note(A, W1), N2: await note(A, W2), NB: await note(B, WB) };
}

const insertRun = (workspace, workflow, extra = "") => `insert into public.workflow_runs
  (workspace_id, workflow_id, workflow_name, workflow_revision, status, finished_at${extra ? ", error_code" : ""})
  values ('${workspace}', '${workflow}', 'Digest', 1, 'completed', now()${extra ? `, '${extra}'` : ""}) returning id`;

test("owners record and read only their own runs and links", { skip }, async () => {
  const { db, W1, WB, F1, FB, N1, NB } = await seeded();
  const [run] = await as(db, "authenticated", A, insertRun(W1, F1));
  await as(db, "authenticated", A, `insert into public.workflow_run_items (run_id, item_id, workspace_id, role)
    values ($1, $2, $3, 'source')`, [run.id, N1, W1]);
  const [runB] = await as(db, "authenticated", B, insertRun(WB, FB));

  assert.deepEqual((await as(db, "authenticated", A, "select id from public.workflow_runs")).map((r) => r.id), [run.id]);
  assert.deepEqual((await as(db, "authenticated", B, "select id from public.workflow_runs")).map((r) => r.id), [runB.id]);
  assert.equal((await as(db, "authenticated", B, "select * from public.workflow_run_items")).length, 0);
  assert.equal((await as(db, "anon", null, "select * from public.workflow_runs")).length, 0);
  // A can't write into B's space, or attach B's item.
  await assert.rejects(as(db, "authenticated", A, insertRun(WB, FB)));
  await assert.rejects(as(db, "authenticated", A, `insert into public.workflow_run_items (run_id, item_id, workspace_id, role)
    values ($1, $2, $3, 'source')`, [run.id, NB, W1]));
  // B can't change or delete A's run.
  assert.equal((await as(db, "authenticated", B, "update public.workflow_runs set status = 'failed' where id = $1 returning id", [run.id])).length, 0);
  assert.equal((await as(db, "authenticated", B, "delete from public.workflow_runs where id = $1 returning id", [run.id])).length, 0);
});

test("links stay in the run's space; deletes keep history sensible", { skip }, async () => {
  const { db, q, W1, W2, F1, N1, N2 } = await seeded();
  const [run] = await as(db, "authenticated", A, insertRun(W1, F1));
  // An item from another of A's spaces fails the composite key.
  await assert.rejects(q(`insert into public.workflow_run_items (run_id, item_id, workspace_id, user_id, role)
    values ($1, $2, $3, $4, 'source')`, [run.id, N2, W2, A]));
  await q(`insert into public.workflow_run_items (run_id, item_id, workspace_id, user_id, role)
    values ($1, $2, $3, $4, 'source')`, [run.id, N1, W1, A]);
  // Deleting the item drops the link, not the run.
  await q("delete from public.notes where id = $1", [N1]);
  assert.equal((await q("select * from public.workflow_run_items")).length, 0);
  // Deleting the workflow keeps the run with its name snapshot.
  await q("delete from public.workflows where id = $1", [F1]);
  assert.deepEqual(await q("select workflow_id, workflow_name from public.workflow_runs"), [{ workflow_id: null, workflow_name: "Digest" }]);
  // Deleting the workspace deletes its runs.
  await q("delete from public.workspaces where id = $1", [W1]);
  assert.equal((await q("select * from public.workflow_runs")).length, 0);
});

test("run invariants: final status iff finished, ordered times, bounded fields", { skip }, async () => {
  const { q, W1, F1 } = await seeded();
  const bad = [
    `insert into public.workflow_runs (workspace_id, user_id, workflow_name, workflow_revision, status) values ('${W1}', '${A}', 'D', 1, 'completed')`,
    `insert into public.workflow_runs (workspace_id, user_id, workflow_name, workflow_revision, status, finished_at) values ('${W1}', '${A}', 'D', 1, 'running', now())`,
    `insert into public.workflow_runs (workspace_id, user_id, workflow_name, workflow_revision, started_at, status, finished_at) values ('${W1}', '${A}', 'D', 1, now(), 'failed', now() - interval '1 minute')`,
    `insert into public.workflow_runs (workspace_id, user_id, workflow_name, workflow_revision) values ('${W1}', '${A}', ' ', 1)`,
    `insert into public.workflow_runs (workspace_id, user_id, workflow_name, workflow_revision, mode) values ('${W1}', '${A}', 'D', 1, 'prod')`,
    `insert into public.workflow_runs (workspace_id, user_id, workflow_name, workflow_revision, steps) values ('${W1}', '${A}', 'D', 1, '{}')`,
    `insert into public.workflow_runs (workspace_id, user_id, workflow_name, workflow_revision, error_code) values ('${W1}', '${A}', 'D', 1, 'Patient X failed')`,
  ];
  for (const sql of bad) await assert.rejects(q(sql), undefined, sql);
  const [running] = await q(`insert into public.workflow_runs (workspace_id, user_id, workflow_id, workflow_name, workflow_revision)
    values ($1, $2, $3, 'D', 1) returning status, mode, trigger, steps`, [W1, A, F1]);
  assert.deepEqual(running, { status: "running", mode: "test", trigger: "manual", steps: [] });
});
