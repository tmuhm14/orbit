import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "../../../../../tests/load-ts.mjs";

// The daily purge of agent action values (ADR 002 §5) runs from one fixed
// tick slot. Assignment lease reaping and recovery moved to the durable-jobs
// worker (A-04). Doubles only: no database or scheduled reports run here.
let rpcCalls;
let rpcResult;
beforeEach(() => {
  rpcCalls = [];
  rpcResult = { data: 2, error: null };
  process.env.CRON_SECRET = "synthetic-secret";
});

const admin = {
  rpc: async (name) => (rpcCalls.push(name), rpcResult),
  from: () => {
    const q = { select: () => q, eq: () => q, returns: async () => ({ data: [], error: null }) };
    return q;
  },
};
const route = loadTs(new URL("./route.ts", import.meta.url), {
  "@/lib/supabase/admin": { createAdminClient: () => admin },
  "@/lib/scheduled/schedule": { dueReportDate: () => null },
  "@/lib/scheduled/server": { runScheduledTask: async () => null },
});
const tick = async (slot, secret = "synthetic-secret") => {
  const response = await route.GET(
    new Request(`http://localhost/api/scheduler/tick/${slot}`, { headers: { authorization: `Bearer ${secret}` } }),
    { params: Promise.resolve({ slot }) });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
};

test("purges agent action values once a day, from slot 03 only", async () => {
  for (let hour = 0; hour < 24; hour++) await tick(String(hour).padStart(2, "0"));
  assert.deepEqual(rpcCalls.filter((n) => n === "purge_agent_action_values"), ["purge_agent_action_values"]);
  const again = await tick("03");
  assert.deepEqual(again, { status: 200, body: { completed: 0, failed: 0, purged: 2 } });
  assert.equal((await tick("04")).body.purged, undefined);
});

test("a failed purge does not stop the tick, and unauthorized ticks do nothing", async () => {
  rpcResult = { data: null, error: { message: "boom" } };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.deepEqual(await tick("03"), { status: 200, body: { completed: 0, failed: 0, purged: null } });
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, [["agent action purge failed"]]);
  rpcCalls = [];
  assert.equal((await tick("03", "wrong")).status, 401);
  assert.deepEqual(rpcCalls, []);
});

test("no tick reaps or recovers assignments any more (the jobs worker does, every minute)", async () => {
  const bodies = [];
  for (let hour = 0; hour < 24; hour++) bodies.push((await tick(String(hour).padStart(2, "0"))).body);
  assert.deepEqual(rpcCalls.filter((n) => n !== "purge_agent_action_values"), []);
  assert.ok(bodies.every((b) => !("reaped" in b)));
});

