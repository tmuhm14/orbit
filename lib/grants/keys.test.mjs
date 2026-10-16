import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { loadTs } from "../../tests/load-ts.mjs";

// Key format, hashing, typed config and grant checks. Synthetic values only.
const keys = loadTs(new URL("./keys.ts", import.meta.url), { "node:crypto": crypto });
const config = loadTs(new URL("./config.ts", import.meta.url));
const grants = loadTs(new URL("./server.ts", import.meta.url));
const validation = loadTs(new URL("./validation.ts", import.meta.url), { "@/lib/grants/server": grants });
const PEPPER = "synthetic-pepper-synthetic-pepper-0123";

test("keys are orbit_sk_<12 hex>_<43 base64url>, unique, and hashed with HMAC-SHA256 under the pepper", () => {
  const a = keys.generateApiKey(PEPPER);
  const b = keys.generateApiKey(PEPPER);
  assert.match(a.key, /^orbit_sk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.prefix, b.prefix);
  assert.equal(a.key.slice(9, 21), a.prefix);
  assert.equal(a.hash, crypto.createHmac("sha256", PEPPER).update(a.key).digest("hex"));
  assert.notEqual(keys.hashApiKey(a.key, `${PEPPER}x`), a.hash, "the pepper is part of the hash");
  assert.equal(a.hash.includes(a.key.slice(22)), false);
  assert.deepEqual(keys.parseApiKey(a.key), { prefix: a.prefix, key: a.key });
  for (const bad of ["", "orbit_sk_", `orbit_sk_${a.prefix}`, `orbit_sk_${a.prefix.toUpperCase()}_${a.key.slice(22)}`,
    `${a.key}x`, `orbit_pk_${a.prefix}_${a.key.slice(22)}`, a.key.replace(/.$/, "!")])
    assert.equal(keys.parseApiKey(bad), null, bad);
  assert.equal(keys.looksLikeApiKey("orbit_sk_anything"), true);
  assert.equal(keys.looksLikeApiKey("eyJhbGciOi"), false);
  assert.equal(keys.keyLabel(a.key), `orbit_sk_${a.prefix}`);
  assert.equal(keys.keyLabel("orbit_sk_secret-looking-garbage"), "orbit_sk_(malformed)");
});

test("the pepper is required, long enough, and never echoed", () => {
  assert.equal(config.apiKeyPepper({ ORBIT_API_KEY_PEPPER: ` ${PEPPER} ` }), PEPPER);
  assert.throws(() => config.apiKeyPepper({}), /ORBIT_API_KEY_PEPPER is not set/);
  assert.throws(() => config.apiKeyPepper({ ORBIT_API_KEY_PEPPER: "short-secret-value" }),
    (error) => /at least 32/.test(error.message) && !error.message.includes("short-secret-value"));
});

test("the user-token sunset is off unless configured, and accepts only real dates", () => {
  assert.equal(config.USER_TOKEN_DEPRECATED_AT, "2026-10-20");
  assert.equal(config.userTokenSunset({}), null);
  assert.equal(config.userTokenSunset({ ORBIT_USER_TOKEN_SUNSET: " " }), null);
  assert.equal(config.userTokenSunset({ ORBIT_USER_TOKEN_SUNSET: "2027-01-31" }).toISOString(), "2027-01-31T00:00:00.000Z");
  for (const bad of ["2026-02-30", "tomorrow", "2026-1-1"])
    assert.throws(() => config.userTokenSunset({ ORBIT_USER_TOKEN_SUNSET: bad }), /ORBIT_USER_TOKEN_SUNSET/);
});

test("checkGrant: capability, workspace, item.write operation and kill switch", () => {
  const g = (workspaceId, capability, agentEnabled = true, operations) =>
    ({ workspaceId, capability, agentEnabled, constraints: operations ? { operations } : {} });
  const list = [g("w1", "workspace.read"), g("w1", "item.write", true, ["create"]), g("w2", "workspace.read", false)];
  assert.deepEqual(grants.checkGrant(list, "workspace.read", "w1"), { ok: true });
  assert.deepEqual(grants.checkGrant(list, "item.write", "w1", "create"), { ok: true });
  assert.deepEqual(grants.checkGrant(list, "item.write", "w1", "update"), { ok: false, code: "capability_denied" });
  assert.deepEqual(grants.checkGrant(list, "item.write", "w1"), { ok: false, code: "capability_denied" });
  assert.deepEqual(grants.checkGrant(list, "assignment.execute", "w1"), { ok: false, code: "capability_denied" });
  assert.deepEqual(grants.checkGrant(list, "workspace.read", "w3"), { ok: false, code: "capability_denied" });
  assert.deepEqual(grants.checkGrant(list, "workspace.read", "w2"), { ok: false, code: "agent_disabled" });
  assert.deepEqual([...grants.grantedWorkspaces(list)], [["w1", ["workspace.read", "item.write"]]]);
  // Unexpected verifier output is dropped, never widened.
  assert.deepEqual(grants.parseGrants([null, { workspaceId: "w1", capability: "admin", agentEnabled: true },
    { workspaceId: "w1", capability: "item.write", agentEnabled: "yes", constraints: { operations: ["create", 7] } }]),
  [{ workspaceId: "w1", capability: "item.write", agentEnabled: false, constraints: { operations: ["create"] } }]);
  assert.deepEqual(grants.parseGrants("nope"), []);
});

test("Settings input validation", () => {
  const W = "12345678-1234-4234-8234-123456789ABC";
  assert.deepEqual(validation.clientInput({ name: "  Bot ", grants: [{ workspaceId: W, capability: "workspace.read" },
    { workspaceId: W.toLowerCase(), capability: "workspace.read" }] }),
  { name: "Bot", grants: [{ workspaceId: W.toLowerCase(), capability: "workspace.read" }] });
  assert.deepEqual(validation.clientInput({ name: "Bot" }), { name: "Bot", grants: [] });
  for (const bad of [null, [], { name: "" }, { name: "x".repeat(101) }, { name: "Bot", extra: 1 },
    { name: "Bot", grants: [{ workspaceId: W, capability: "external.write" }] },
    { name: "Bot", grants: [{ workspaceId: "nope", capability: "workspace.read" }] },
    { name: "Bot", grants: [{ workspaceId: W, capability: "workspace.read", constraints: {} }] },
    { name: "Bot", grants: Array.from({ length: 301 }, () => ({ workspaceId: W, capability: "workspace.read" })) }])
    assert.equal(validation.clientInput(bad), null, JSON.stringify(bad)?.slice(0, 60));
});
