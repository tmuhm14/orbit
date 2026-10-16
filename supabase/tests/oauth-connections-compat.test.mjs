import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { as, createDb, migrate, migrationFiles, skip } from "./harness.mjs";

// ADR 008's migration is applied to production before the code that uses it.
// Proof that it changes nothing for the deployed app, scoped to this one
// migration (every earlier migration is in both databases):
// 1. Catalog: every function, trigger, policy, table (grants, RLS), column,
//    column grant, constraint and index that existed before is the same
//    afterwards, except the documented additions to agent_clients: the
//    auth_kind column (default 'api_key'), its not-null constraint, its select
//    grant and two checks.
//    Everything else added is on the four new tables or is a new function.
// 2. Behavior: the A-05 key paths (create, verify, grants, revoke, audit,
//    purge), the note, workspace and assignment paths, and owner reads of
//    every existing table give the same results and rows before and after.
const MIGRATION = "20261021000000_oauth_connections.sql";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const PEPPER = "synthetic-pepper-synthetic-pepper-0123";
const NEW_TABLES = ["oauth_authorization_codes", "oauth_clients", "oauth_connections", "oauth_tokens"];
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
// The documented additions to agent_clients.
const isAddition = (key, row) => String(row.t).replace(/^public\./, "") === "agent_clients" && (
  ((key === "columns" || key === "columnGrants") && row.column_name === "auth_kind") ||
  (key === "constraints" && ["agent_clients_auth_kind_check", "agent_clients_auth_kind_not_null", "agent_clients_oauth_no_key_check"]
    .includes(row.conname)));

test("catalog: nothing existing changes; only the documented additions", { skip }, async () => {
  assert.ok(migrationFiles().includes(MIGRATION));
  const before = await catalog(await database(MIGRATION));
  const after = await catalog(await database(next()));
  assert.ok(before.functions.some((f) => f.k.startsWith("verify_agent_key(")), "before includes A-05");
  for (const key of ["triggers", "policies", "tables", "columns", "columnGrants", "constraints", "indexes"]) {
    assert.deepEqual(after[key].filter((r) => !onNewTable(r) && !isAddition(key, r)), before[key], key);
    assert.equal(before[key].some(onNewTable), false, `${key}: nothing pre-existing on the new tables`);
  }
  assert.deepEqual(after.columns.filter((r) => isAddition("columns", r)).map((c) => [c.column_name, c.data_type, c.is_nullable, c.column_default]),
    [["auth_kind", "text", "NO", "'api_key'::text"]]);
  assert.deepEqual(after.columnGrants.filter((r) => isAddition("columnGrants", r) && r.grantee !== "postgres")
    .map((g) => [g.grantee, g.privilege_type]),
    [["authenticated", "SELECT"], ["service_role", "SELECT"]]);
  assert.deepEqual(after.triggers, before.triggers, "no triggers added");
  assert.deepEqual(after.tables.filter(onNewTable).map((t) => [t.t, t.relrowsecurity]),
    NEW_TABLES.map((t) => [t, true]), "the new tables have RLS on");
  const added = after.functions.filter((f) => !before.functions.some((b) => b.k === f.k));
  assert.deepEqual(added.map((f) => f.k), [
    "create_oauth_authorization(p_client_id text, p_redirect_uri text, p_code_hash text, p_code_challenge text, p_resource text, p_scope text, p_grants jsonb)",
    "disconnect_oauth_connection(p_id uuid)",
    "exchange_oauth_code(p_code_hash text, p_client_id text, p_redirect_uri text, p_verifier_challenge text, p_resource text, p_access_hash text, p_refresh_hash text)",
    "get_oauth_client(p_client_id text)",
    "list_oauth_connections()",
    "oauth_agent_grants(p_agent_client_id uuid)",
    "oauth_client_json(p_client oauth_clients)",
    "oauth_issue_tokens(p_family uuid, p_oauth_client_id uuid, p_agent_client_id uuid, p_user_id uuid, p_resource text, p_scope text, p_access_hash text, p_refresh_hash text)",
    "oauth_revoke_family(p_family uuid, p_reason text)",
    "purge_oauth_records()",
    "refresh_oauth_token(p_refresh_hash text, p_client_id text, p_resource text, p_access_hash text, p_new_refresh_hash text)",
    "register_oauth_client(p_client_name text, p_redirect_uris text[], p_client_uri text, p_logo_uri text, p_ip_hash text)",
    "revoke_oauth_token(p_token_hash text, p_client_id text)",
    "verify_oauth_token(p_token_hash text, p_resource text)",
  ]);
  assert.deepEqual(after.functions.filter((f) => !added.includes(f)), before.functions, "existing functions unchanged");
  for (const f of added) assert.deepEqual(f.proconfig, ['search_path=""'], `${f.k} pins its search_path`);
});

async function scenario(until) {
  const db = await database(until);
  const names = new Map();
  const norm = (value) => JSON.parse(JSON.stringify(value, (k, v) => {
    if (["created_at", "updated_at", "state_changed_at", "finished_at", "lease_expires_at", "heartbeat_at", "leaseExpiresAt",
      "asked_at", "answered_at", "closed_at", "decided_at", "started_at", "superseded_at", "updatedAt", "createdAt",
      "granted_at", "grantedAt", "revoked_at", "revokedAt", "last_used_at", "lastUsedAt", "occurred_at"].includes(k))
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

  const ws = async (who, label, enabled) => {
    const [row] = await as(db, "authenticated", who,
      "insert into public.workspaces (user_id, name, agent_enabled) values ($1, $2, $3) returning id", [who, label, enabled]);
    return name(row.id, "W");
  };
  const W1 = await ws(A, "Personal", true);
  const W2 = await ws(A, "Work", false);
  const WB = await ws(B, "B", true);
  for (const who of [A, B])
    await db.query(`insert into public.agent_settings (user_id, provider, model, api_key_ciphertext, key_hint)
      values ($1, 'anthropic', 'm', 'x', 'abcd')`, [who]);

  // A-05 API keys, exactly as the deployed Settings routes and /api/v1 use them.
  let k = 0;
  const key = () => {
    const prefix = String(++k).padStart(12, "0");
    const full = `orbit_sk_${prefix}_${"S".repeat(43)}`;
    return { prefix, hash: createHmac("sha256", PEPPER).update(full).digest("hex") };
  };
  const k1 = key();
  const created = await user(A, "select public.create_agent_client($1, $2, $3, $4::jsonb) r", ["Grok bot", k1.prefix, k1.hash,
    JSON.stringify([{ workspaceId: W1, capability: "workspace.read" }, { workspaceId: W1, capability: "item.write" }])]);
  name(created.client.id, "C");
  push("key-create", created);
  push("key-create-cross-user", await user(A, "select public.create_agent_client($1, $2, $3, $4::jsonb) r", ["x", key().prefix,
    "f".repeat(64), JSON.stringify([{ workspaceId: WB, capability: "workspace.read" }])]));
  push("key-verify", await svc("select public.verify_agent_key($1, $2) r", [k1.prefix, k1.hash]));
  push("key-verify-wrong", await svc("select public.verify_agent_key($1, $2) r", [k1.prefix, "0".repeat(64)]));
  push("key-grants", await user(A, "select public.set_agent_client_grants($1, $2::jsonb) r", [created.client.id,
    JSON.stringify([{ workspaceId: W2, capability: "item.write" }])]));
  push("key-verify-after-grants", await svc("select public.verify_agent_key($1, $2) r", [k1.prefix, k1.hash]));
  await attempt("audit", () => svc("select public.record_access_event($1, 'agent_client', $2, 'item.read', $3, null, 'allowed', null) r",
    [A, created.client.id, W1]));
  await attempt("audit-user-token", () => svc("select public.record_access_event($1, 'user_token', null, 'workspace.list', null, null, 'allowed', null) r", [A]));
  push("key-revoke", await user(A, "select public.revoke_agent_client($1) r", [created.client.id]));
  push("key-verify-revoked", await svc("select public.verify_agent_key($1, $2) r", [k1.prefix, k1.hash]));
  push("purge-audit", await svc("select public.purge_access_audit_events() r"));
  // The deployed GET /api/agent-clients and access-log reads.
  push("list-keys", await as(db, "authenticated", A, `select id, name, key_prefix, created_at, last_used_at, revoked_at
    from public.agent_clients where user_id = $1 order by created_at desc`, [A]));
  push("list-grants", await as(db, "authenticated", A, `select principal_id, workspace_id, capability, constraints, granted_at
    from public.capability_grants where user_id = $1 and revoked_at is null`, [A]));
  push("list-audit", await as(db, "authenticated", A, `select principal_type, principal_id, operation, workspace_id, outcome, code
    from public.access_audit_events where user_id = $1 order by id`, [A]));
  await attempt("key-hash-read", () => as(db, "authenticated", A, "select key_hash from public.agent_clients"));
  for (let i = 0; i < 25; i++) {
    const r = await user(B, "select public.create_agent_client($1, $2, $3, '[]'::jsonb) r", [`b${i}`, key().prefix, "e".repeat(64)]);
    if (i === 24) push("key-limit-last", r.status);
  }
  push("key-limit", (await user(B, "select public.create_agent_client('over', $1, $2, '[]'::jsonb) r", [key().prefix, "e".repeat(64)])).status);

  // Notes and assignments, as in A-05's compatibility test.
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
  await note(W2, A, { kind: "note" });
  await note(WB, B);
  push("save-conflict", await save(A, [row(N1, W1, { title: "u", expected_revision: 7 })]));
  await attempt("capture-insert", () => as(db, "authenticated", A, `insert into public.notes (id, user_id, workspace_id, title,
    content, plain_text, bucket, tags) values ('77777777-0000-4000-8000-0000000000ff', $1, $2, 'c', '{}'::jsonb, 'x', 'inbox', '{}')
    returning revision, kind, source`, [A, W1]));
  const assignment = await user(A, "select public.create_assignment($1, $2, 'Outcome', '{}'::uuid[], 'builtin', null) r", [W1, N1]);
  name(assignment.assignment?.id, "A");
  push("assignment-create", assignment);
  push("purge-agent-actions", await svc("select public.purge_agent_action_values() r"));

  // Owner reads of every pre-existing table, for both users.
  const tables = (await db.query(`select relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and relkind = 'r' and relname <> all ($1) order by 1`, [NEW_TABLES])).rows.map((r) => r.relname);
  for (const table of tables) for (const who of [A, B])
    await attempt(`read-${table}-${who === A ? "A" : "B"}`, async () =>
      (await as(db, "authenticated", who, `select count(*)::int n from public.${table}`))[0]);
  await attempt("delete-workspace", () => as(db, "authenticated", A, "delete from public.workspaces where id = $1 returning id", [W2]));
  await db.query("delete from auth.users where id = $1", [B]);
  const snapshot = async (table, drop = []) => norm((await db.query(`select to_jsonb(t) - 'id' - 'created_at' - 'updated_at'
    - 'inbox_token' ${drop.map((c) => `- '${c}'`).join(" ")} j from public.${table} t order by 1`)).rows.map((r) => r.j));
  const after = {};
  for (const table of ["workspaces", "notes", "assignments", "capability_grants", "access_audit_events"]) after[table] = await snapshot(table);
  // agent_clients rows, without the new column (it is the default for all of them).
  after.agent_clients = await snapshot("agent_clients", ["auth_kind"]);
  return { out, tables, after, db };
}

test("behavior: API key, note, workspace and assignment paths give the same results before and after", { skip }, async () => {
  const before = await scenario(MIGRATION);
  const after = await scenario(next());
  assert.ok(before.out.length > 40);
  const result = (label) => before.out.find(([l]) => l === label)[1];
  assert.equal(result("key-create").status, "created");
  assert.equal(result("key-verify").status, "ok");
  assert.equal(result("key-verify-revoked").status, "revoked");
  assert.equal(result("key-limit"), "limit_reached");
  assert.ok(result("key-hash-read").error, "key hashes stay unreadable");
  assert.deepEqual(after.tables, before.tables);
  assert.deepEqual(after.out, before.out);
  assert.deepEqual(after.after, before.after);
  // Every existing agent_clients row reads as an API key.
  const kinds = (await after.db.query("select distinct auth_kind from public.agent_clients")).rows;
  assert.deepEqual(kinds, [{ auth_kind: "api_key" }]);
});
