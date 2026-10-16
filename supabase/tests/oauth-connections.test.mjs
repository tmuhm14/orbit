import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { as, createDb, migrate, skip } from "./harness.mjs";

// ADR 008: OAuth clients, connections, codes and tokens. Synthetic users,
// secrets and pepper only. Never a real database.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const PEPPER = "synthetic-pepper-synthetic-pepper-0123";
const RESOURCE = "https://orbit.test/api/mcp";
const REDIRECT = "https://app.test/callback";
const IP = "a".repeat(64);

const hash = (value) => createHmac("sha256", PEPPER).update(value).digest("hex");
const secret = (marker) => `${marker}${randomBytes(32).toString("base64url")}`;
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function setup() {
  const db = await createDb();
  await migrate(db);
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  const ws = async (who, enabled = true) => (await db.query(
    `insert into public.workspaces (user_id, name, agent_enabled) values ($1, 'W', $2) returning id`, [who, enabled])).rows[0].id;
  const user = async (who, sql, params = []) => (await as(db, "authenticated", who, sql, params))[0]?.r;
  const svc = async (sql, params = []) => (await as(db, "service_role", null, sql, params))[0]?.r;
  const register = (uris = [REDIRECT], ip = IP, name = "Test App") =>
    svc("select public.register_oauth_client($1, $2::text[], null, null, $3) r", [name, uris, ip]);
  const authorize = async (who, clientId, grants, { redirect = REDIRECT, scope = "orbit:read orbit:capture" } = {}) => {
    const code = secret("orbit_ac_");
    const p = pkce();
    const result = await user(who, "select public.create_oauth_authorization($1, $2, $3, $4, $5, $6, $7::jsonb) r",
      [clientId, redirect, hash(code), p.challenge, RESOURCE, scope, JSON.stringify(grants)]);
    return { code, ...p, result };
  };
  const exchange = (clientId, code, verifierChallenge, { redirect = REDIRECT, resource = null } = {}) => {
    const access = secret("orbit_at_");
    const refresh = secret("orbit_rt_");
    return svc("select public.exchange_oauth_code($1, $2, $3, $4, $5, $6, $7) r",
      [hash(code), clientId, redirect, verifierChallenge, resource, hash(access), hash(refresh)])
      .then((r) => ({ r, access, refresh }));
  };
  const refreshToken = (clientId, presented) => {
    const access = secret("orbit_at_");
    const refresh = secret("orbit_rt_");
    return svc("select public.refresh_oauth_token($1, $2, null, $3, $4) r", [hash(presented), clientId, hash(access), hash(refresh)])
      .then((r) => ({ r, access, refresh }));
  };
  const verify = (access, resource = RESOURCE) => svc("select public.verify_oauth_token($1, $2) r", [hash(access), resource]);
  return { db, ws, user, svc, register, authorize, exchange, refreshToken, verify };
}

test("registration validates redirect URIs and rate-limits per IP; nothing stores an address", { skip }, async () => {
  const { db, register } = await setup();
  const ok = await register(["https://claude.ai/api/mcp/auth_callback", "http://localhost:33418/callback"]);
  assert.equal(ok.status, "registered");
  assert.match(ok.client.clientId, /^orbit_ci_[0-9a-f]{32}$/);
  assert.equal(Object.hasOwn(ok.client, "registrationIpHash"), false);
  for (const bad of [["http://evil.test/cb"], ["https://a.test/cb#frag"], ["cursor://callback"], [], ["https://user@a.test/cb"]])
    assert.equal((await register(bad)).status, "invalid_payload", JSON.stringify(bad));
  for (let i = 0; i < 9; i++) assert.equal((await register()).status, "registered");
  assert.equal((await register()).status, "rate_limited", "11th from one IP within the hour");
  assert.equal((await register([REDIRECT], "b".repeat(64))).status, "registered", "another IP is unaffected");
  const columns = (await db.query("select column_name from information_schema.columns where table_name = 'oauth_clients'")).rows
    .map((r) => r.column_name);
  assert.ok(!columns.some((c) => c === "ip" || c === "ip_address"));
});

test("consent creates one connection per app and user, with grants, and a code bound to everything", { skip }, async () => {
  const { db, ws, user, register, authorize } = await setup();
  const W1 = await ws(A);
  const W2 = await ws(A, false);
  const WB = await ws(B);
  const { client } = await register();
  const first = await authorize(A, client.clientId, [{ workspaceId: W1, capability: "workspace.read" },
    { workspaceId: W2, capability: "item.write" }]);
  assert.equal(first.result.status, "created");
  const id = first.result.connectionId;
  const agent = (await db.query("select auth_kind, key_hash, name from public.agent_clients where id = $1", [id])).rows[0];
  assert.deepEqual(agent, { auth_kind: "oauth", key_hash: "0".repeat(64), name: "Test App" });
  const again = await authorize(A, client.clientId, [{ workspaceId: W1, capability: "item.write" }]);
  assert.equal(again.result.connectionId, id, "reconnecting reuses the active connection");
  const grants = (await db.query(`select workspace_id, capability, revoked_at is null active, revoke_reason from public.capability_grants
    where principal_id = $1 order by granted_at, capability`, [id])).rows;
  assert.deepEqual(grants.filter((g) => g.active).map((g) => [g.workspace_id, g.capability]), [[W1, "item.write"]]);
  assert.ok(grants.filter((g) => !g.active).every((g) => g.revoke_reason === "user"), "consent replaces the grants");
  const code = (await db.query("select * from public.oauth_authorization_codes where code_hash = $1", [hash(again.code)])).rows[0];
  assert.equal(code.redirect_uri, REDIRECT);
  assert.equal(code.code_challenge, again.challenge);
  assert.equal(code.resource, RESOURCE);
  assert.equal(code.user_id, A);
  assert.ok(code.expires_at - Date.now() <= 300_000 && code.expires_at - Date.now() > 290_000, "five minutes");
  // Refusals: another user's workspace, an unregistered redirect URI, no grants, bad shapes.
  assert.equal((await authorize(A, client.clientId, [{ workspaceId: WB, capability: "workspace.read" }])).result.status, "not_found");
  assert.equal((await authorize(A, client.clientId, [{ workspaceId: W1, capability: "workspace.read" }],
    { redirect: "https://app.test/other" })).result.status, "not_found");
  assert.equal((await authorize(A, "orbit_ci_" + "0".repeat(32), [{ workspaceId: W1, capability: "workspace.read" }])).result.status, "not_found");
  assert.equal((await authorize(A, client.clientId, [])).result.status, "invalid_payload");
  assert.equal((await authorize(A, client.clientId, [{ workspaceId: W1, capability: "workspace.read" }], { scope: "admin" })).result.status,
    "invalid_payload");
  await assert.rejects(authorize(null, client.clientId, [{ workspaceId: W1, capability: "workspace.read" }]), /Not signed in/);
  // B consenting to the same app gets its own connection.
  const forB = await authorize(B, client.clientId, [{ workspaceId: WB, capability: "workspace.read" }]);
  assert.notEqual(forB.result.connectionId, id);
  assert.equal((await user(A, "select public.list_oauth_connections() r")).length, 1);
});

test("code exchange checks PKCE, client, redirect URI, expiry and single use; replay revokes the family", { skip }, async () => {
  const { db, ws, register, authorize, exchange, verify } = await setup();
  const W = await ws(A);
  const { client } = await register();
  const other = (await register()).client;
  const grants = [{ workspaceId: W, capability: "workspace.read" }];

  const wrongVerifier = await authorize(A, client.clientId, grants);
  assert.equal((await exchange(client.clientId, wrongVerifier.code, pkce().challenge)).r.status, "invalid_grant");
  assert.equal((await exchange(client.clientId, wrongVerifier.code, wrongVerifier.challenge)).r.status, "invalid_grant",
    "a failed attempt burns the code");
  const wrongClient = await authorize(A, client.clientId, grants);
  assert.equal((await exchange(other.clientId, wrongClient.code, wrongClient.challenge)).r.status, "invalid_grant");
  const wrongRedirect = await authorize(A, client.clientId, grants);
  assert.equal((await exchange(client.clientId, wrongRedirect.code, wrongRedirect.challenge, { redirect: "https://app.test/x" })).r.status,
    "invalid_grant");
  const wrongResource = await authorize(A, client.clientId, grants);
  assert.equal((await exchange(client.clientId, wrongResource.code, wrongResource.challenge, { resource: "https://evil.test/mcp" })).r.status,
    "invalid_target");
  const expired = await authorize(A, client.clientId, grants);
  await db.query("update public.oauth_authorization_codes set expires_at = now() - interval '1 second' where code_hash = $1", [hash(expired.code)]);
  assert.equal((await exchange(client.clientId, expired.code, expired.challenge)).r.status, "invalid_grant");
  assert.equal((await exchange(client.clientId, secret("orbit_ac_"), pkce().challenge)).r.status, "invalid_grant", "unknown code");

  const good = await authorize(A, client.clientId, grants);
  const issued = await exchange(client.clientId, good.code, good.challenge, { resource: RESOURCE });
  assert.deepEqual(issued.r, { status: "issued", expiresIn: 3600, refreshExpiresIn: 2592000, scope: "orbit:read orbit:capture", resource: RESOURCE });
  const ok = await verify(issued.access);
  assert.equal(ok.status, "ok");
  assert.equal(ok.userId, A);
  assert.deepEqual(ok.grants.map((g) => [g.workspaceId, g.capability, g.agentEnabled]), [[W, "workspace.read", true]]);
  assert.equal(await verify(issued.access, "https://other.test/api/mcp"), null, "audience-bound");
  assert.equal(await verify(issued.refresh), null, "a refresh token is not an access token");
  // Replaying the used code revokes what it issued.
  assert.equal((await exchange(client.clientId, good.code, good.challenge)).r.status, "invalid_grant");
  assert.equal(await verify(issued.access), null);
  const reasons = (await db.query("select distinct revoke_reason from public.oauth_tokens where token_hash = any($1)",
    [[hash(issued.access), hash(issued.refresh)]])).rows;
  assert.deepEqual(reasons, [{ revoke_reason: "reuse_detected" }]);
  // Nothing in the database contains a code or token.
  const dump = JSON.stringify((await db.query(`select to_jsonb(t) j from public.oauth_tokens t
    union all select to_jsonb(c) from public.oauth_authorization_codes c`)).rows);
  for (const value of [good.code, issued.access, issued.refresh, good.verifier]) assert.equal(dump.includes(value), false);
});

test("refresh rotates; a reused refresh token revokes the family; expiry and revocation hold", { skip }, async () => {
  const { db, ws, svc, user, register, authorize, exchange, refreshToken, verify } = await setup();
  const W = await ws(A);
  const { client } = await register();
  const grants = [{ workspaceId: W, capability: "workspace.read" }];
  const consent = await authorize(A, client.clientId, grants);
  const first = await exchange(client.clientId, consent.code, consent.challenge);
  const second = await refreshToken(client.clientId, first.refresh);
  assert.equal(second.r.status, "issued");
  assert.equal((await verify(second.access)).status, "ok");
  assert.equal((await verify(first.access)).status, "ok", "the earlier access token lives until it expires");
  const third = await refreshToken(client.clientId, second.refresh);
  assert.equal(third.r.status, "issued");
  // Reusing an already-rotated refresh token: the whole family goes.
  assert.equal((await refreshToken(client.clientId, first.refresh)).r.status, "invalid_grant");
  for (const t of [first.access, second.access, third.access]) assert.equal(await verify(t), null);
  assert.equal((await refreshToken(client.clientId, third.refresh)).r.status, "invalid_grant");

  // Another app presenting this app's refresh token also revokes the family.
  const c2 = await authorize(A, client.clientId, grants);
  const fam = await exchange(client.clientId, c2.code, c2.challenge);
  const other = (await register()).client;
  assert.equal((await refreshToken(other.clientId, fam.refresh)).r.status, "invalid_grant");
  assert.equal(await verify(fam.access), null);

  // Expired tokens fail; an expired access token stops verifying.
  const c3 = await authorize(A, client.clientId, grants);
  const t3 = await exchange(client.clientId, c3.code, c3.challenge);
  await db.query("update public.oauth_tokens set expires_at = now() - interval '1 second' where token_hash = any($1)",
    [[hash(t3.access), hash(t3.refresh)]]);
  assert.equal(await verify(t3.access), null);
  assert.equal((await refreshToken(client.clientId, t3.refresh)).r.status, "invalid_grant");

  // RFC 7009: revoking a refresh token revokes its family; unknown tokens change nothing.
  const c4 = await authorize(A, client.clientId, grants);
  const t4 = await exchange(client.clientId, c4.code, c4.challenge);
  assert.equal((await svc("select public.revoke_oauth_token($1, $2) r", [hash(t4.refresh), other.clientId])).status, "not_found",
    "another app can't revoke it");
  assert.equal((await verify(t4.access)).status, "ok");
  assert.equal((await svc("select public.revoke_oauth_token($1, $2) r", [hash(t4.refresh), client.clientId])).status, "revoked");
  assert.equal(await verify(t4.access), null);
  const c5 = await authorize(A, client.clientId, grants);
  const t5 = await exchange(client.clientId, c5.code, c5.challenge);
  await svc("select public.revoke_oauth_token($1, $2) r", [hash(t5.access), client.clientId]);
  assert.equal(await verify(t5.access), null);
  assert.equal((await refreshToken(client.clientId, t5.refresh)).r.status, "issued", "revoking an access token leaves its refresh token");

  // Disconnect: every token of the connection stops; grants are revoked; repeat is harmless.
  const c6 = await authorize(A, client.clientId, grants);
  const t6 = await exchange(client.clientId, c6.code, c6.challenge);
  const id = c6.result.connectionId;
  assert.equal((await user(B, "select public.disconnect_oauth_connection($1) r", [id])).status, "not_found", "only the owner");
  assert.equal((await user(A, "select public.disconnect_oauth_connection($1) r", [id])).status, "revoked");
  assert.equal((await user(A, "select public.disconnect_oauth_connection($1) r", [id])).status, "revoked");
  assert.equal(await verify(t6.access), null);
  assert.equal((await refreshToken(client.clientId, t6.refresh)).r.status, "invalid_grant");
  assert.equal((await db.query("select count(*)::int n from public.capability_grants where principal_id = $1 and revoked_at is null", [id]))
    .rows[0].n, 0);
  const listed = await user(A, "select public.list_oauth_connections() r");
  assert.ok(listed[0].revokedAt);
  // A new consent after disconnecting creates a fresh connection.
  const c7 = await authorize(A, client.clientId, grants);
  assert.notEqual(c7.result.connectionId, id);
  // An access token issued before the connection was revoked by the A-05 route also stops.
  const t7 = await exchange(client.clientId, c7.code, c7.challenge);
  await user(A, "select public.revoke_agent_client($1) r", [c7.result.connectionId]);
  assert.deepEqual(await verify(t7.access), { status: "revoked", userId: A, clientId: c7.result.connectionId });
});

test("grants and the kill switch are read on every verification", { skip }, async () => {
  const { db, ws, user, register, authorize, exchange, verify } = await setup();
  const W = await ws(A);
  const { client } = await register();
  const consent = await authorize(A, client.clientId, [{ workspaceId: W, capability: "workspace.read" }]);
  const t = await exchange(client.clientId, consent.code, consent.challenge);
  assert.equal((await verify(t.access)).grants.length, 1);
  await user(A, "select public.set_agent_client_grants($1, $2::jsonb) r", [consent.result.connectionId,
    JSON.stringify([{ workspaceId: W, capability: "item.write" }])]);
  assert.deepEqual((await verify(t.access)).grants.map((g) => g.capability), ["item.write"]);
  await db.query("update public.workspaces set agent_enabled = false where id = $1", [W]);
  assert.equal((await verify(t.access)).grants[0].agentEnabled, false);
  const used = (await db.query("select last_used_at from public.agent_clients where id = $1", [consent.result.connectionId])).rows[0];
  assert.ok(used.last_used_at);
});

test("owners read metadata only: no hashes, no other users' rows, no direct writes", { skip }, async () => {
  const { db, ws, register, authorize, exchange } = await setup();
  const W = await ws(A);
  const { client } = await register();
  const consent = await authorize(A, client.clientId, [{ workspaceId: W, capability: "workspace.read" }]);
  await exchange(client.clientId, consent.code, consent.challenge);
  for (const sql of ["select token_hash from public.oauth_tokens", "select * from public.oauth_tokens",
    "select code_hash from public.oauth_authorization_codes", "select registration_ip_hash from public.oauth_clients",
    "select key_hash from public.agent_clients"])
    await assert.rejects(as(db, "authenticated", A, sql), /permission denied/, sql);
  const mine = await as(db, "authenticated", A, "select id, kind, resource from public.oauth_tokens");
  assert.equal(mine.length, 2);
  assert.equal((await as(db, "authenticated", B, "select id from public.oauth_tokens")).length, 0);
  assert.equal((await as(db, "authenticated", A, "select client_name from public.oauth_clients"))[0].client_name, "Test App");
  assert.equal((await as(db, "authenticated", B, "select client_name from public.oauth_clients")).length, 0, "only apps you connected");
  assert.equal((await as(db, "authenticated", A, "select auth_kind from public.agent_clients"))[0].auth_kind, "oauth");
  for (const sql of ["update public.oauth_tokens set revoked_at = null", "delete from public.oauth_connections",
    "insert into public.oauth_clients (redirect_uris, registration_ip_hash) values ('{https://x.test}', repeat('a', 64))"])
    await assert.rejects(as(db, "authenticated", A, sql), /permission denied/, sql);
  // Server functions are not callable from a user session.
  await assert.rejects(as(db, "authenticated", A, "select public.verify_oauth_token('x', 'y')"), /permission denied/);
  await assert.rejects(as(db, "anon", null, "select public.register_oauth_client('n', '{https://x.test}', null, null, repeat('a', 64))"),
    /permission denied/);
  await assert.rejects(as(db, "service_role", null, "select public.create_oauth_authorization('a','b','c','d','e','f','[]'::jsonb)"),
    /permission denied/);
});

test("the purge removes expired codes and tokens and unconsented apps only", { skip }, async () => {
  const { db, ws, svc, register, authorize, exchange, verify } = await setup();
  const W = await ws(A);
  const { client } = await register();
  const stale = (await register()).client;
  const consent = await authorize(A, client.clientId, [{ workspaceId: W, capability: "workspace.read" }]);
  const t = await exchange(client.clientId, consent.code, consent.challenge);
  const old = await authorize(A, client.clientId, [{ workspaceId: W, capability: "workspace.read" }]);
  await db.query("update public.oauth_authorization_codes set expires_at = now() - interval '2 days' where code_hash = $1", [hash(old.code)]);
  await db.query("update public.oauth_clients set created_at = now() - interval '8 days'");
  assert.equal(await svc("select public.purge_oauth_records() r"), 2, "one stale code and one unconsented app");
  assert.equal((await db.query("select count(*)::int n from public.oauth_clients where id = $1", [stale.id])).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from public.oauth_clients where id = $1", [client.id])).rows[0].n, 1,
    "a consented app stays");
  assert.equal((await verify(t.access)).status, "ok");
  await db.query("update public.oauth_tokens set expires_at = now() - interval '2 days'");
  assert.equal(await svc("select public.purge_oauth_records() r"), 2);
  assert.equal(await svc("select public.purge_oauth_records() r"), 0, "repeating is harmless");
});
