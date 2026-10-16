import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { as, createDb, migrate, skip } from "./harness.mjs";

// A-05 (ADR 004, ADR 007): agent clients, capability grants, access audit.
// Synthetic users, keys and pepper only. Never a real database.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const PEPPER = "synthetic-pepper-synthetic-pepper-0123";

const newKey = () => {
  const prefix = randomBytes(6).toString("hex");
  const key = `orbit_sk_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, secret: key.slice(22), hash: createHmac("sha256", PEPPER).update(key).digest("hex") };
};

async function setup() {
  const db = await createDb();
  await migrate(db);
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  const ws = async (who, enabled = true) => (await db.query(
    `insert into public.workspaces (user_id, name, agent_enabled) values ($1, 'W', $2) returning id`, [who, enabled])).rows[0].id;
  const user = async (who, sql, params = []) => (await as(db, "authenticated", who, sql, params))[0]?.r;
  const svc = async (sql, params = []) => (await as(db, "service_role", null, sql, params))[0]?.r;
  const create = (who, name, k, grants) => user(who, "select public.create_agent_client($1, $2, $3, $4::jsonb) r",
    [name, k.prefix, k.hash, JSON.stringify(grants)]);
  const verify = (k) => svc("select public.verify_agent_key($1, $2) r", [k.prefix, k.hash]);
  return { db, ws, user, svc, create, verify };
}

test("creating a key stores only its prefix and HMAC, and verify returns the user, client and grants", { skip }, async () => {
  const { db, ws, create, verify } = await setup();
  const W1 = await ws(A);
  const W2 = await ws(A);
  const k = newKey();
  const created = await create(A, "  Grok bot ", k, [{ workspaceId: W1, capability: "workspace.read" },
    { workspaceId: W1, capability: "item.write" }, { workspaceId: W1, capability: "item.write" }]);
  assert.equal(created.status, "created");
  assert.equal(created.client.name, "Grok bot");
  assert.equal(created.client.keyPrefix, k.prefix);
  assert.equal(Object.hasOwn(created.client, "keyHash"), false);
  assert.deepEqual(created.client.grants.map((g) => [g.capability, g.constraints]),
    [["item.write", { operations: ["create"] }], ["workspace.read", {}]]);
  // Nothing in the database contains the key or its secret.
  const dump = JSON.stringify((await db.query(`select to_jsonb(c) j from public.agent_clients c
    union all select to_jsonb(g) from public.capability_grants g`)).rows);
  assert.equal(dump.includes(k.secret) || dump.includes(k.key), false);
  assert.ok(dump.includes(k.hash));

  const ok = await verify(k);
  assert.equal(ok.status, "ok");
  assert.equal(ok.userId, A);
  assert.equal(ok.clientId, created.client.id);
  assert.deepEqual(ok.grants.map((g) => [g.workspaceId, g.capability, g.agentEnabled]),
    [[W1, "item.write", true], [W1, "workspace.read", true]]);
  assert.ok(!ok.grants.some((g) => g.workspaceId === W2), "ungranted workspaces never appear");
  const used = (await db.query("select last_used_at from public.agent_clients where id = $1", [ok.clientId])).rows[0];
  assert.ok(used.last_used_at, "verification records last use");
});

test("verify refuses a wrong secret, a wrong prefix and a revoked key, immediately", { skip }, async () => {
  const { ws, user, svc, create, verify } = await setup();
  const W = await ws(A);
  const k = newKey();
  const { client } = await create(A, "Bot", k, [{ workspaceId: W, capability: "workspace.read" }]);
  const other = newKey();
  assert.equal(await verify({ prefix: k.prefix, hash: other.hash }), null, "wrong secret");
  assert.equal(await verify({ prefix: other.prefix, hash: k.hash }), null, "wrong prefix");
  assert.equal(await svc("select public.verify_agent_key(null, null) r"), null);
  assert.equal((await verify(k)).status, "ok");
  assert.equal((await user(A, "select public.revoke_agent_client($1) r", [client.id])).status, "revoked");
  const refused = await verify(k);
  assert.deepEqual(refused, { status: "revoked", userId: A, clientId: client.id });
  assert.equal(Object.hasOwn(refused, "grants"), false);
  // Revoking again is harmless; the grants were revoked with the client.
  const again = await user(A, "select public.revoke_agent_client($1) r", [client.id]);
  assert.equal(again.status, "revoked");
  assert.deepEqual(again.client.grants, []);
  assert.equal((await user(A, "select public.set_agent_client_grants($1, '[]'::jsonb) r", [client.id])).status, "client_revoked");
});

test("grants: replaced per workspace, kept as history, the kill switch is reported, and deletes cascade", { skip }, async () => {
  const { db, ws, user, create, verify } = await setup();
  const W1 = await ws(A);
  const W2 = await ws(A, false);
  const k = newKey();
  const { client } = await create(A, "Bot", k, [{ workspaceId: W1, capability: "workspace.read" }]);
  const before = (await db.query("select granted_at from public.capability_grants where principal_id = $1", [client.id])).rows[0];
  const saved = await user(A, "select public.set_agent_client_grants($1, $2::jsonb) r", [client.id, JSON.stringify([
    { workspaceId: W1, capability: "workspace.read" }, { workspaceId: W2, capability: "item.write" },
    { workspaceId: W2, capability: "assignment.execute" }])]);
  assert.equal(saved.status, "saved");
  assert.equal(saved.client.grants.length, 3);
  const kept = (await db.query(`select granted_at from public.capability_grants
    where principal_id = $1 and workspace_id = $2 and revoked_at is null`, [client.id, W1])).rows[0];
  assert.deepEqual(kept, before, "an unchanged grant keeps its row");
  assert.deepEqual((await verify(k)).grants.map((g) => [g.workspaceId === W1 ? "W1" : "W2", g.capability, g.agentEnabled]).sort(),
    [["W1", "workspace.read", true], ["W2", "assignment.execute", false], ["W2", "item.write", false]]);
  await user(A, "select public.set_agent_client_grants($1, $2::jsonb) r", [client.id,
    JSON.stringify([{ workspaceId: W2, capability: "item.write" }])]);
  const history = (await db.query(`select capability, revoke_reason from public.capability_grants
    where principal_id = $1 and revoked_at is not null order by capability`, [client.id])).rows;
  assert.deepEqual(history, [{ capability: "assignment.execute", revoke_reason: "user" }, { capability: "workspace.read", revoke_reason: "user" }]);
  // Kill switch read on each verification.
  await db.query("update public.workspaces set agent_enabled = true where id = $1", [W2]);
  assert.deepEqual((await verify(k)).grants.map((g) => g.agentEnabled), [true]);
  // Deleting the workspace removes its grants.
  await db.query("delete from public.workspaces where id = $1", [W2]);
  assert.deepEqual((await verify(k)).grants, []);
});

test("payload validation, ownership and the active key limit", { skip }, async () => {
  const { db, ws, user, create } = await setup();
  const WA = await ws(A);
  const WB = await ws(B);
  const bad = [[], "nope", [{ workspaceId: WA }], [{ workspaceId: WA, capability: "external.write" }],
    [{ workspaceId: "not-a-uuid", capability: "workspace.read" }], [{ workspaceId: WA, capability: "workspace.read", extra: 1 }]];
  for (const grants of bad.slice(1))
    assert.equal((await create(A, "Bot", newKey(), grants)).status, "invalid_payload", JSON.stringify(grants));
  assert.equal((await create(A, "Bot", newKey(), [])).status, "created", "a key may start with no grants");
  assert.equal((await create(A, " ", newKey(), [])).status, "invalid_payload");
  assert.equal((await create(A, "Bot", { prefix: "XYZ", hash: newKey().hash }, [])).status, "invalid_payload");
  assert.equal((await create(A, "Bot", { prefix: newKey().prefix, hash: "short" }, [])).status, "invalid_payload");
  assert.equal((await create(A, "Bot", newKey(), [{ workspaceId: WB, capability: "workspace.read" }])).status, "not_found",
    "another user's workspace can't be granted");
  const dup = newKey();
  await create(A, "Bot", dup, []);
  assert.equal((await create(B, "Bot", { prefix: dup.prefix, hash: newKey().hash }, [])).status, "duplicate_prefix");
  // Another user's client can't be revoked or regranted.
  const { client } = await create(A, "Mine", newKey(), [{ workspaceId: WA, capability: "workspace.read" }]);
  assert.equal((await user(B, "select public.revoke_agent_client($1) r", [client.id])).status, "not_found");
  assert.equal((await user(B, "select public.set_agent_client_grants($1, '[]'::jsonb) r", [client.id])).status, "not_found");
  assert.equal((await user(A, "select public.set_agent_client_grants($1, $2::jsonb) r", [client.id,
    JSON.stringify([{ workspaceId: WB, capability: "workspace.read" }])])).status, "not_found");
  await assert.rejects(user(null, "select public.create_agent_client('x', $1, $2, '[]'::jsonb) r", [newKey().prefix, newKey().hash]), /Not signed in/);
  const active = Number((await db.query("select count(*) n from public.agent_clients where user_id = $1", [A])).rows[0].n);
  for (let i = active; i < 25; i++) assert.equal((await create(A, `Bot ${i}`, newKey(), [])).status, "created");
  assert.equal((await create(A, "One too many", newKey(), [])).status, "limit_reached");
  // Table constraints: item.write is create-only; grants can't cross users.
  await assert.rejects(db.query(`insert into public.capability_grants (user_id, workspace_id, principal_id, capability, constraints)
    values ($1, $2, $3, 'item.write', '{"operations": ["create", "update"]}')`, [A, WA, client.id]), /v1_constraints_check/);
  await assert.rejects(db.query(`insert into public.capability_grants (user_id, workspace_id, principal_id, capability)
    values ($1, $2, $3, 'workspace.read')`, [B, WB, client.id]), /capability_grants_client_fk/);
});

test("RLS and privileges: owners read their own rows, nobody writes directly, the hash is unreadable", { skip }, async () => {
  const { db, ws, svc, create } = await setup();
  const W = await ws(A);
  const k = newKey();
  const { client } = await create(A, "Bot", k, [{ workspaceId: W, capability: "workspace.read" }]);
  await svc("select public.record_access_event($1, 'agent_client', $2, 'item.read', $3, null, 'allowed', null) r", [A, client.id, W]);
  const q = (role, who, sql, params = []) => as(db, role, who, sql, params);
  const visible = "select id, name, key_prefix, created_at, last_used_at, revoked_at from public.agent_clients";
  assert.equal((await q("authenticated", A, visible)).length, 1);
  assert.equal((await q("authenticated", B, visible)).length, 0);
  assert.equal((await q("authenticated", A, "select * from public.capability_grants")).length, 1);
  assert.equal((await q("authenticated", B, "select * from public.capability_grants")).length, 0);
  assert.equal((await q("authenticated", A, "select * from public.access_audit_events")).length, 1);
  assert.equal((await q("authenticated", B, "select * from public.access_audit_events")).length, 0);
  for (const role of ["authenticated", "service_role"])
    await assert.rejects(q(role, A, "select key_hash from public.agent_clients"), /permission denied/, `${role} can't read key_hash`);
  for (const sql of [
    `update public.agent_clients set revoked_at = null`,
    `insert into public.agent_clients (user_id, name, key_prefix, key_hash) values ('${A}', 'x', '${newKey().prefix}', '${"a".repeat(64)}')`,
    `delete from public.agent_clients`,
    `update public.capability_grants set revoked_at = null`,
    `insert into public.capability_grants (user_id, workspace_id, principal_id, capability) values ('${A}', '${W}', '${client.id}', 'item.write')`,
    `delete from public.capability_grants`,
    `insert into public.access_audit_events (user_id, principal_type, operation, outcome) values ('${A}', 'user_token', 'item.read', 'allowed')`,
    `update public.access_audit_events set outcome = 'denied'`,
    `delete from public.access_audit_events`,
  ]) for (const role of ["authenticated", "service_role", "anon"])
    await assert.rejects(q(role, A, sql), /permission denied/, `${role}: ${sql.slice(0, 40)}`);
  for (const table of ["agent_clients", "capability_grants", "access_audit_events"])
    await assert.rejects(q("anon", null, `select id from public.${table}`), /permission denied/);
  // Server functions are service-role only; owner functions are authenticated only.
  for (const sql of [
    `select public.verify_agent_key('${k.prefix}', '${k.hash}')`,
    `select public.record_access_event('${A}', 'user_token', null, 'item.read', null, null, 'allowed', null)`,
    `select public.purge_access_audit_events()`,
  ]) for (const role of ["authenticated", "anon"]) await assert.rejects(q(role, A, sql), /permission denied/);
  for (const sql of [`select public.revoke_agent_client('${client.id}')`, `select public.set_agent_client_grants('${client.id}', '[]')`,
    `select public.create_agent_client('x', '${newKey().prefix}', '${"a".repeat(64)}', '[]')`])
    for (const role of ["service_role", "anon"]) await assert.rejects(q(role, A, sql), /permission denied/);
  for (const sql of ["select public.agent_grant_pairs('[]')"])
    for (const role of ["authenticated", "service_role", "anon"]) await assert.rejects(q(role, A, sql), /permission denied/);
});

test("audit events are content-free, tied to the client's owner, and purged after 90 days", { skip }, async () => {
  const { db, ws, svc, create } = await setup();
  const W = await ws(A);
  const { client } = await create(A, "Bot", newKey(), [{ workspaceId: W, capability: "workspace.read" }]);
  await svc("select public.record_access_event($1, 'agent_client', $2, 'item.create', $3, $4, 'allowed', null) r", [A, client.id, W, W]);
  await svc("select public.record_access_event($1, 'agent_client', $2, 'item.read', $3, null, 'denied', 'capability_denied') r", [A, client.id, W]);
  await svc("select public.record_access_event($1, 'user_token', null, 'workspace.list', null, null, 'allowed', null) r", [A]);
  await assert.rejects(svc("select public.record_access_event($1, 'agent_client', $2, 'item.read', null, null, 'allowed', null) r",
    [B, client.id]), /unknown principal/, "a client can only be recorded for its owner");
  await assert.rejects(svc("select public.record_access_event($1, 'user_token', null, 'item.read', null, null, 'denied', null) r", [A]),
    /outcome_code_check/, "a denial needs a code");
  await assert.rejects(svc("select public.record_access_event($1, 'user_token', null, 'note.title', null, null, 'allowed', null) r", [A]),
    /operation_check/);
  const columns = (await db.query(`select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'access_audit_events' order by ordinal_position`)).rows.map((r) => r.column_name);
  assert.deepEqual(columns, ["id", "user_id", "principal_type", "principal_id", "operation", "workspace_id", "resource_id",
    "outcome", "code", "occurred_at"], "no column can hold content");
  await db.query("update public.access_audit_events set occurred_at = now() - interval '91 days' where operation = 'item.create'");
  await db.query("update public.access_audit_events set occurred_at = now() - interval '89 days' where operation = 'item.read'");
  assert.equal(await svc("select public.purge_access_audit_events() r"), 1);
  assert.equal(await svc("select public.purge_access_audit_events() r"), 0, "repeating is harmless");
  assert.deepEqual((await db.query("select operation from public.access_audit_events order by id")).rows.map((r) => r.operation),
    ["item.read", "workspace.list"]);
  // History outlives a deleted workspace; deleting the user removes it.
  await db.query("delete from public.workspaces where id = $1", [W]);
  assert.equal((await db.query("select count(*) n from public.access_audit_events")).rows[0].n, 2);
  await db.query("delete from auth.users where id = $1", [A]);
  for (const table of ["access_audit_events", "agent_clients", "capability_grants"])
    assert.equal((await db.query(`select count(*) n from public.${table}`)).rows[0].n, 0, table);
});
