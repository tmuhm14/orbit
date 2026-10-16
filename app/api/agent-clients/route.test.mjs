import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { loadTs } from "../../../tests/load-ts.mjs";

// Settings → Agents & API keys routes, with the real cookie-session helper
// (same-origin check included) over a Supabase double. Synthetic values only.
const PEPPER = "synthetic-pepper-synthetic-pepper-0123";
const USER = "11111111-1111-4111-8111-111111111111";
const W1 = "12345678-1234-4234-8234-123456789abc";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";

let state;
let logs;
const original = { warn: console.warn, error: console.error, info: console.info, log: console.log };
beforeEach(() => {
  process.env.ORBIT_API_KEY_PEPPER = PEPPER;
  state = { signedIn: true, rpc: [], selects: [], rpcResult: null, rpcQueue: [], fail: false, rows: {} };
  logs = [];
  for (const level of Object.keys(original)) console[level] = (...args) => logs.push(args.map(String).join(" "));
});
afterEach(() => Object.assign(console, original));

const supabase = {
  auth: { getUser: async () => ({ data: { user: state.signedIn ? { id: USER } : null } }) },
  rpc: async (name, args) => {
    state.rpc.push([name, args]);
    if (state.fail) return { data: null, error: { message: "boom" } };
    return { data: state.rpcQueue.length ? state.rpcQueue.shift() : state.rpcResult, error: null };
  },
  from: (table) => {
    const calls = [];
    state.selects.push([table, calls]);
    const result = () => state.fail ? { data: null, error: {} } : { data: state.rows[table] ?? [], error: null };
    const q = {
      select: (...a) => (calls.push(["select", ...a]), q),
      eq: (...a) => (calls.push(["eq", ...a]), q),
      is: (...a) => (calls.push(["is", ...a]), q),
      order: (...a) => (calls.push(["order", ...a]), q),
      limit: async (...a) => (calls.push(["limit", ...a]), result()),
      then: (resolve) => resolve(result()),
    };
    return q;
  },
};
const routeAuth = loadTs(new URL("../../../lib/supabase/route-auth.ts", import.meta.url), {
  "./server": { createClient: async () => supabase },
  "./config": { authConfig: () => ({ url: "http://supabase.test", key: "publishable" }) },
});
const grants = loadTs(new URL("../../../lib/grants/server.ts", import.meta.url));
const imports = {
  "@/lib/supabase/route-auth": routeAuth,
  "@/lib/grants/config": loadTs(new URL("../../../lib/grants/config.ts", import.meta.url)),
  "@/lib/grants/keys": loadTs(new URL("../../../lib/grants/keys.ts", import.meta.url), { "node:crypto": crypto }),
  "@/lib/grants/validation": loadTs(new URL("../../../lib/grants/validation.ts", import.meta.url), { "@/lib/grants/server": grants }),
};
imports["@/lib/grants/clients"] = loadTs(new URL("../../../lib/grants/clients.ts", import.meta.url), imports);
const list = loadTs(new URL("./route.ts", import.meta.url), imports);
const grantRoute = loadTs(new URL("./[id]/grants/route.ts", import.meta.url), imports);
const revoke = loadTs(new URL("./[id]/revoke/route.ts", import.meta.url), imports);
const accessLog = loadTs(new URL("./access-log/route.ts", import.meta.url), imports);

const request = (method, body, { origin = "http://orbit.test", path = "/api/agent-clients" } = {}) =>
  new Request(`http://orbit.test${path}`, {
    method, headers: { host: "orbit.test", ...(origin ? { origin } : {}) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const params = (id) => ({ params: Promise.resolve({ id }) });
const read = async (response) => ({ status: response.status, body: await response.json(), headers: response.headers });
const created = (grantsList = []) => ({ status: "created", client: { id: CLIENT, name: "Bot", keyPrefix: "x", grants: grantsList } });

test("mutations require a same-origin Origin header and a signed-in user, before any storage", async () => {
  const attempts = [
    () => list.POST(request("POST", { name: "Bot" }, { origin: null })),
    () => list.POST(request("POST", { name: "Bot" }, { origin: "https://evil.test" })),
    () => grantRoute.PUT(request("PUT", { grants: [] }, { origin: "https://evil.test" }), params(CLIENT)),
    () => revoke.POST(request("POST", undefined, { origin: null }), params(CLIENT)),
  ];
  for (const attempt of attempts) assert.equal((await attempt()).status, 403);
  assert.deepEqual(state.rpc, []);
  state.signedIn = false;
  assert.equal((await list.POST(request("POST", { name: "Bot" }))).status, 401);
  assert.equal((await list.GET(request("GET"))).status, 401);
  assert.equal((await accessLog.GET(request("GET", undefined, { path: "/api/agent-clients/access-log" }))).status, 401);
  assert.deepEqual(state.rpc, []);
  assert.deepEqual(state.selects, []);
});

test("create returns the full key once and sends only its prefix and HMAC to the database", async () => {
  state.rpcResult = created([{ workspaceId: W1, capability: "workspace.read" }]);
  const r = await read(await list.POST(request("POST", { name: " Grok bot ", grants: [{ workspaceId: W1, capability: "workspace.read" }] })));
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.match(r.body.apiKey, /^orbit_sk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(r.body.client, state.rpcResult.client);
  const [[name, args]] = state.rpc;
  assert.equal(name, "create_agent_client");
  assert.deepEqual(Object.keys(args).sort(), ["p_grants", "p_key_hash", "p_key_prefix", "p_name"]);
  assert.equal(args.p_name, "Grok bot");
  assert.equal(args.p_key_prefix, r.body.apiKey.slice(9, 21));
  assert.equal(args.p_key_hash, crypto.createHmac("sha256", PEPPER).update(r.body.apiKey).digest("hex"));
  assert.equal(JSON.stringify(args).includes(r.body.apiKey.slice(22)), false, "the secret never reaches the database");
  assert.equal(logs.some((l) => l.includes(r.body.apiKey.slice(22))), false);
  // A prefix collision retries once with a fresh key.
  state.rpc = [];
  state.rpcQueue = [{ status: "duplicate_prefix" }, created()];
  const retried = await read(await list.POST(request("POST", { name: "Bot" })));
  assert.equal(retried.status, 201);
  assert.equal(state.rpc.length, 2);
  assert.notEqual(state.rpc[0][1].p_key_prefix, state.rpc[1][1].p_key_prefix);
  assert.equal(retried.body.apiKey.slice(9, 21), state.rpc[1][1].p_key_prefix);
});

test("create validates input, maps refusals, and fails fast without the pepper", async () => {
  for (const body of ["{", { name: "" }, { name: "Bot", grants: [{ workspaceId: W1, capability: "external.write" }] }, { name: "Bot", key: "x" }])
    assert.equal((await list.POST(request("POST", body))).status, 400);
  assert.deepEqual(state.rpc, []);
  for (const [status, code] of [["not_found", 404], ["limit_reached", 409], ["invalid_payload", 400], ["weird", 500]]) {
    state.rpcResult = { status };
    const r = await read(await list.POST(request("POST", { name: "Bot" })));
    assert.equal(r.status, code, status);
    assert.equal(Object.hasOwn(r.body, "apiKey"), false, "no key on failure");
  }
  state.fail = true;
  assert.equal((await list.POST(request("POST", { name: "Bot" }))).status, 500);
  state.fail = false;
  delete process.env.ORBIT_API_KEY_PEPPER;
  state.rpc = [];
  const r = await read(await list.POST(request("POST", { name: "Bot" })));
  assert.equal(r.status, 503);
  assert.deepEqual(state.rpc, []);
  assert.ok(logs.some((l) => l.includes("ORBIT_API_KEY_PEPPER is not set")));
});

test("list returns clients and active grants and never selects the key hash", async () => {
  state.rows = {
    agent_clients: [{ id: CLIENT, name: "Bot", key_prefix: "0123456789ab", created_at: "c", last_used_at: null, revoked_at: null }],
    capability_grants: [
      { principal_id: CLIENT, workspace_id: W1, capability: "workspace.read", constraints: {}, granted_at: "g" },
      { principal_id: "other", workspace_id: W1, capability: "item.write", constraints: {}, granted_at: "g" }],
  };
  const r = await read(await list.GET(request("GET")));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.clients, [{ id: CLIENT, name: "Bot", keyPrefix: "0123456789ab", createdAt: "c", lastUsedAt: null,
    revokedAt: null, grants: [{ workspaceId: W1, capability: "workspace.read", constraints: {}, grantedAt: "g" }] }]);
  const clientSelect = state.selects.find(([t]) => t === "agent_clients")[1];
  assert.doesNotMatch(clientSelect.find((c) => c[0] === "select")[1], /hash/);
  assert.ok(clientSelect.some((c) => c[0] === "eq" && c[1] === "user_id" && c[2] === USER));
  assert.ok(state.selects.find(([t]) => t === "capability_grants")[1].some((c) => c[0] === "is" && c[1] === "revoked_at"));
  state.fail = true;
  assert.equal((await list.GET(request("GET"))).status, 500);
});

test("revoke and edit grants call the owner functions and map their results", async () => {
  state.rpcResult = { status: "revoked", client: { id: CLIENT, revokedAt: "now", grants: [] } };
  const revoked = await read(await revoke.POST(request("POST", undefined, { path: `/api/agent-clients/${CLIENT}/revoke` }), params(CLIENT)));
  assert.equal(revoked.status, 200);
  assert.deepEqual(state.rpc.at(-1), ["revoke_agent_client", { p_id: CLIENT }]);
  state.rpcResult = { status: "not_found" };
  assert.equal((await revoke.POST(request("POST"), params(CLIENT))).status, 404);
  assert.equal((await revoke.POST(request("POST"), params("not-a-uuid"))).status, 404);

  state.rpcResult = { status: "saved", client: { id: CLIENT, grants: [{ workspaceId: W1, capability: "item.write" }] } };
  const saved = await read(await grantRoute.PUT(request("PUT", { grants: [{ workspaceId: W1, capability: "item.write" }] }), params(CLIENT)));
  assert.equal(saved.status, 200);
  assert.deepEqual(state.rpc.at(-1), ["set_agent_client_grants", { p_id: CLIENT, p_grants: [{ workspaceId: W1, capability: "item.write" }] }]);
  const calls = state.rpc.length;
  for (const body of ["{", { grants: "x" }, { grants: [], name: "x" }, { grants: [{ workspaceId: W1, capability: "admin" }] }])
    assert.equal((await grantRoute.PUT(request("PUT", body), params(CLIENT))).status, 400);
  assert.equal(state.rpc.length, calls, "invalid input never reaches the database");
  state.rpcResult = { status: "client_revoked" };
  assert.equal((await grantRoute.PUT(request("PUT", { grants: [] }), params(CLIENT))).status, 409);
  state.fail = true;
  assert.equal((await grantRoute.PUT(request("PUT", { grants: [] }), params(CLIENT))).status, 500);
  assert.equal((await revoke.POST(request("POST"), params(CLIENT))).status, 500);
});

test("the access log returns the latest content-free events for the signed-in user", async () => {
  state.rows.access_audit_events = [{ id: 2, principal_type: "agent_client", principal_id: CLIENT, operation: "item.read",
    workspace_id: W1, resource_id: null, outcome: "allowed", code: null, occurred_at: "t" }];
  const path = "/api/agent-clients/access-log";
  const r = await read(await accessLog.GET(request("GET", undefined, { path: `${path}?limit=10` })));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.events, [{ id: 2, principalType: "agent_client", clientId: CLIENT, operation: "item.read",
    workspaceId: W1, resourceId: null, outcome: "allowed", code: null, occurredAt: "t" }]);
  const calls = state.selects.at(-1)[1];
  assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "user_id" && c[2] === USER));
  assert.ok(calls.some((c) => c[0] === "limit" && c[1] === 10));
  for (const limit of ["0", "201", "x"])
    assert.equal((await accessLog.GET(request("GET", undefined, { path: `${path}?limit=${limit}` }))).status, 400);
  state.fail = true;
  assert.equal((await accessLog.GET(request("GET", undefined, { path }))).status, 500);
});
