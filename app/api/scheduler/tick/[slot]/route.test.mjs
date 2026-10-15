import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "../../../../../tests/load-ts.mjs";

// The daily purge of agent action values (ADR 002 §5) and the assignment
// lease reaper (ADR 003 §2) each run from one fixed tick slot. Doubles only:
// no database or scheduled reports run here.
let rpcCalls;
let rpcResult;
let reapResult;
beforeEach(() => {
  rpcCalls = [];
  rpcResult = { data: 2, error: null };
  reapResult = { data: { timedOut: 1, unavailable: 0 }, error: null };
  process.env.CRON_SECRET = "synthetic-secret";
});

const admin = {
  rpc: async (name) => (rpcCalls.push(name), name === "reap_assignment_leases" ? reapResult : rpcResult),
  from: () => {
    const q = { select: () => q, eq: () => q, returns: async () => ({ data: [], error: null }) };
    return q;
  },
};
// Recovery of queued built-in assignments (A-02) runs after the response.
let afterCallbacks = [];
let recoveries = [];
let recoverResult = async () => ({ started: 0 });
const route = loadTs(new URL("./route.ts", import.meta.url), {
  "next/server": { after: (callback) => afterCallbacks.push(callback) },
  "@/lib/assignments/executor-server": {
    recoverQueuedAssignments: async (client, options) => (recoveries.push([client, options]), recoverResult()),
    routeDeadline: (startedAt) => startedAt + 270_000,
  },
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

test("reaps assignment leases once a day, from slot 04 only", async () => {
  const bodies = [];
  for (let hour = 0; hour < 24; hour++) bodies.push((await tick(String(hour).padStart(2, "0"))).body);
  assert.deepEqual(rpcCalls.filter((n) => n === "reap_assignment_leases"), ["reap_assignment_leases"]);
  assert.deepEqual(bodies[4], { completed: 0, failed: 0, reaped: { timedOut: 1, unavailable: 0 } });
  assert.ok(bodies.every((b, hour) => hour === 4 || b.reaped === undefined));
});

test("a failed reap does not stop the tick and logs no detail", async () => {
  reapResult = { data: null, error: { message: "boom" } };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.deepEqual(await tick("04"), { status: 200, body: { completed: 0, failed: 0, reaped: null } });
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, [["assignment lease reap failed"]]);
});

test("every tick starts recovery of queued built-in assignments after the response", async () => {
  afterCallbacks = [];
  recoveries = [];
  const before = Date.now();
  assert.equal((await tick("07")).status, 200);
  assert.equal(recoveries.length, 0, "nothing runs before the response");
  for (const callback of afterCallbacks.splice(0)) await callback();
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0][0], admin);
  assert.ok(recoveries[0][1].deadlineAt >= before + 270_000);
  // A failing sweep logs a fixed line only; unauthorized ticks schedule nothing.
  recoverResult = async () => { throw new Error("boom: secret"); };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await tick("08");
    for (const callback of afterCallbacks.splice(0)) await callback();
  } finally {
    console.error = original;
    recoverResult = async () => ({ started: 0 });
  }
  assert.deepEqual(errors, [["assignment recovery failed"]]);
  await tick("08", "wrong");
  assert.equal(afterCallbacks.length, 0);
});
