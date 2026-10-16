import { test } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, migrationFiles, skip } from "./harness.mjs";

// A-05's migration is applied to production before the code that uses it.
// Proof that it changes nothing for the deployed app:
// 1. Catalog: every function, trigger, policy, table (and its grants and RLS
//    flag), column, constraint and index that existed before is the same
//    afterwards. The only additions are the three new tables, their policies,
//    constraints, indexes and the nine new functions.
// 2. Behavior: the note, workspace, agent-action and assignment paths, and
//    owner reads of every existing table, give the same results and rows on a
//    database without the migration and on one with every migration.
const MIGRATION = "20261020000100_agent_api_keys.sql";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const NEW_TABLES = ["access_audit_events", "agent_clients", "capability_grants"];

async function database(until) {
  const db = await createDb();
  await migrate(db, { until });
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  return db;
}

async function catalog(db) {
  const rows = async (sql) => (await db.query(sql)).rows;
  return {
    functions: await rows(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' k,
        pg_get_functiondef(p.oid) d, p.prosecdef, p.proconfig, p.proacl::text acl
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' order by 1`),
    triggers: await rows(`select tgrelid::regclass::text t, tgname, pg_get_triggerdef(oid) d
      from pg_trigger where not tgisinternal order by 1, 2`),
    policies: await rows(`select tablename t, policyname, cmd, roles::text, qual, with_check
      from pg_policies where schemaname = 'public' order by 1, 2`),
    tables: await rows(`select relname t, relacl::text acl, relrowsecurity from pg_class c
      join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and relkind = 'r' order by 1`),
    columns: await rows(`select table_name t, column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'public' order by 1, 2`),
    columnGrants: await rows(`select table_name t, column_name, grantee, privilege_type
      from information_schema.column_privileges where table_schema = 'public' order by 1, 2, 3, 4`),
    constraints: await rows(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d
      from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await rows(`select tablename t, indexname, indexdef from pg_indexes where schemaname = 'public' order by 2`),
  };
}

const onNewTable = (row) => NEW_TABLES.includes(String(row.t).replace(/^public\./, ""));

test("catalog: nothing existing changes; only the new tables and functions are added", { skip }, async () => {
  const before = await catalog(await database(MIGRATION));
  // This migration only: later migrations are checked by their own tests.
  const after = await catalog(await database(migrationFiles().find((f) => f > MIGRATION)));
  assert.ok(before.functions.length > 40);
  for (const key of ["triggers", "policies", "tables", "columns", "columnGrants", "constraints", "indexes"]) {
    assert.deepEqual(after[key].filter((r) => !onNewTable(r)), before[key], key);
    assert.equal(before[key].some(onNewTable), false, `${key}: nothing pre-existing on the new tables`);
  }
  assert.deepEqual(after.triggers, before.triggers, "no triggers added");
  assert.deepEqual(after.tables.filter(onNewTable).map((t) => [t.t, t.relrowsecurity]),
    NEW_TABLES.map((t) => [t, true]), "the new tables have RLS on");
  const added = after.functions.filter((f) => !before.functions.some((b) => b.k === f.k));
  assert.deepEqual(added.map((f) => f.k), [
    "agent_client_json(p_client agent_clients)",
    "agent_grant_pairs(p_grants jsonb)",
    "create_agent_client(p_name text, p_key_prefix text, p_key_hash text, p_grants jsonb)",
    "purge_access_audit_events()",
    "record_access_event(p_user_id uuid, p_principal_type text, p_principal_id uuid, p_operation text, p_workspace_id uuid, p_resource_id uuid, p_outcome text, p_code text)",
    "revoke_agent_client(p_id uuid)",
    "set_agent_client_grants(p_id uuid, p_grants jsonb)",
    "verify_agent_key(p_key_prefix text, p_key_hash text)",
  ]);
  assert.deepEqual(after.functions.filter((f) => !added.includes(f)), before.functions);
  // Every new function pins its search_path.
  for (const f of added) assert.deepEqual(f.proconfig, ['search_path=""'], f.k);
});

async function scenario(until) {
  const db = await database(until);
  const names = new Map();
  const norm = (value) => JSON.parse(JSON.stringify(value, (k, v) => {
    if (["created_at", "updated_at", "state_changed_at", "finished_at", "lease_expires_at", "heartbeat_at", "leaseExpiresAt",
      "asked_at", "answered_at", "closed_at", "decided_at", "started_at", "superseded_at", "updatedAt", "createdAt"].includes(k))
      return v === null ? null : "*";
    if (typeof v === "string" && names.has(v)) return names.get(v);
    return v;
  }));
  const name = (id, label) => (id && !names.has(id) && names.set(id, `${label}${names.size}`), id);
  const user = async (who, sql, params = []) => (await as(db, "authenticated", who, sql, params))[0]?.r;
  const svc = async (sql, params = []) => (await as(db, "service_role", null, sql, params))[0]?.r;
  const out = [];
  const push = (label, value) => out.push([label, norm(value)]);
  const attempt = async (label, run) => {
    try { push(label, await run()); } catch (error) { push(label, { error: error.message }); }
  };

  // Workspaces through the owner's session, as the app does.
  const ws = async (who, label, enabled) => {
    const [row] = await as(db, "authenticated", who,
      "insert into public.workspaces (user_id, name, agent_enabled) values ($1, $2, $3) returning id", [who, label, enabled]);
    return name(row.id, "W");
  };
  const W1 = await ws(A, "Personal", true);
  const W2 = await ws(A, "Work", false);
  const WB = await ws(B, "B", true);
  await attempt("ws-cross-user", () => as(db, "authenticated", A, "update public.workspaces set name = 'x' where id = $1 returning id", [WB]));
  await attempt("ws-toggle", () => as(db, "authenticated", A, "update public.workspaces set agent_enabled = true where id = $1 returning agent_enabled", [W2]));
  await attempt("ws-toggle-back", () => as(db, "authenticated", A, "update public.workspaces set agent_enabled = false where id = $1 returning agent_enabled", [W2]));
  for (const who of [A, B])
    await db.query(`insert into public.agent_settings (user_id, provider, model, api_key_ciphertext, key_hint)
      values ($1, 'anthropic', 'm', 'x', 'abcd')`, [who]);

  // Notes: save, conflict, capture-style insert, delete.
  let n = 0;
  const save = (who, rows) => user(who, "select public.save_notes($1::jsonb, false) r", [JSON.stringify(rows)]);
  const row = (id, w, patch = {}) => ({ id, workspace_id: w, title: "t", content: { type: "doc" }, plain_text: "",
    bucket: "next", tags: [], kind: "task", project_id: null, created_at: "2026-10-13T00:00:00.000Z",
    completed_at: null, expected_revision: null, ...patch });
  const note = async (w, who = A, patch = {}) => {
    const id = name(`77777777-0000-4000-8000-${String(++n).padStart(12, "0")}`, "N");
    push(`save-${n}`, await save(who, [row(id, w, patch)]));
    return id;
  };
  const N1 = await note(W1);
  const N2 = await note(W2, A, { kind: "note" });
  await note(WB, B);
  push("save-conflict", await save(A, [row(N1, W1, { title: "u", expected_revision: 7 })]));
  push("save-update", await save(A, [row(N1, W1, { title: "u", expected_revision: 1 })]));
  push("save-other-user", await save(B, [row(N1, WB, { expected_revision: 2 })]));
  await attempt("capture-insert", () => as(db, "authenticated", A, `insert into public.notes (id, user_id, workspace_id, title,
    content, plain_text, bucket, tags) values ('77777777-0000-4000-8000-0000000000ff', $1, $2, 'c', '{}'::jsonb, 'x', 'inbox', '{}')
    returning revision, kind, source`, [A, W1]));
  await attempt("capture-cross-user", () => as(db, "authenticated", A, `insert into public.notes (id, user_id, workspace_id, title,
    content, plain_text, bucket, tags) values ('77777777-0000-4000-8000-0000000000fe', $1, $2, 'c', '{}'::jsonb, 'x', 'inbox', '{}')
    returning id`, [A, WB]));
  push("delete-note", await user(A, "select public.delete_note($1, null, false) r", [N2]));

  // Assignments: create, claim, submit, review; and a refusal.
  const created = await user(A, "select public.create_assignment($1, $2, 'Outcome', '{}'::uuid[], 'builtin', null) r", [W1, N1]);
  name(created.assignment?.id, "A");
  push("assignment-create", created);
  push("assignment-off", await user(A, "select public.create_assignment($1, $2, 'Outcome', '{}'::uuid[], 'builtin', null) r",
    [W2, await note(W2)]));
  push("assignment-external", await user(A, "select public.create_assignment($1, $2, 'Outcome', '{}'::uuid[], 'external', null) r",
    [W1, await note(W1)]));
  const lease = await svc("select public.claim_assignment($1, 90) r", [created.assignment.id]);
  name(lease.attemptId, "T"); name(lease.leaseToken, "L");
  push("claim", lease);
  const artifact = await svc("select public.submit_assignment_artifact($1, $2, $3::jsonb) r", [lease.attemptId, lease.leaseToken,
    JSON.stringify({ kind: "draft", title: "R", content: { type: "doc" }, plain_text: "md", source_note_ids: [] })]);
  name(artifact.artifactId, "R");
  push("submit", artifact);
  const rev = Number((await db.query("select revision from public.assignments where id = $1", [created.assignment.id])).rows[0].revision);
  const review = await user(A, "select public.review_assignment_artifact($1, $2, $3, 'accept', null) r",
    [created.assignment.id, rev, artifact.artifactId]);
  name(review.reviewId, "V");
  push("review", review);
  push("purge-agent-actions", await svc("select public.purge_agent_action_values() r"));
  push("reap", await svc("select public.reap_assignment_leases() r"));

  // Owner reads of every pre-existing table, for both users.
  const tables = (await db.query(`select relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and relkind = 'r' and relname <> all ($1) order by 1`, [NEW_TABLES])).rows.map((r) => r.relname);
  for (const table of tables) for (const who of [A, B])
    await attempt(`read-${table}-${who === A ? "A" : "B"}`, async () =>
      (await as(db, "authenticated", who, `select count(*)::int n from public.${table}`))[0]);
  // Deleting a workspace and a user still cascades as before.
  await attempt("delete-workspace", () => as(db, "authenticated", A, "delete from public.workspaces where id = $1 returning id", [W2]));
  await db.query("delete from auth.users where id = $1", [B]);
  const snapshot = async (table) => norm((await db.query(`select to_jsonb(t) - 'id' - 'created_at' - 'updated_at' - 'inbox_token' j
    from public.${table} t order by 1`)).rows.map((r) => r.j));
  const after = {};
  for (const table of ["workspaces", "notes", "assignments", "assignment_events"]) after[table] = await snapshot(table);
  return { out, tables, after };
}

test("behavior: note, workspace and assignment paths give the same results before and after", { skip }, async () => {
  const before = await scenario(MIGRATION);
  const after = await scenario();
  assert.ok(before.out.length > 30);
  const result = (label) => before.out.find(([l]) => l === label)[1];
  assert.equal(result("assignment-create").status, "created");
  assert.equal(result("review").assignment.state, "completed");
  assert.ok(result("capture-cross-user").error, "the composite workspace key still refuses another user's workspace");
  assert.deepEqual(after.tables, before.tables);
  assert.deepEqual(after.out, before.out);
  assert.deepEqual(after.after, before.after);
});
