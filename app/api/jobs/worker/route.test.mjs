import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "../../../../tests/load-ts.mjs";
import * as workerModule from "../../../../lib/runtime/worker.ts";

// The worker route (A-04): CRON_SECRET auth like the scheduler tick, the
// deadline it gives the loop, and that it answers with counts only. The loop
// itself is tested in lib/runtime/worker.test.mjs and against PGlite in
// supabase/tests/durable-jobs*.test.mjs.
let runs, adminClient;
beforeEach(() => {
  runs = [];
  adminClient = { admin: true };
  process.env.CRON_SECRET = "synthetic-secret";
});
const route = loadTs(new URL("./route.ts", import.meta.url), {
  "@/lib/supabase/admin": { createAdminClient: () => adminClient },
  "@/lib/runtime/postgres": { postgresJobQueue: (admin) => ({ queueFor: admin }) },
  "@/lib/runtime/jobs": {
    jobHandlers: (admin) => [{ kind: "assignment.run", admin }],
    jobMaintenance: (admin, queue, at) => [{ name: "m", admin, queue, at }],
  },
  "@/lib/runtime/worker": {
    WORKER_DEADLINE_MARGIN_MS: workerModule.WORKER_DEADLINE_MARGIN_MS,
    workerId: (prefix) => `${prefix}:test`,
    runWorker: async (options) => (runs.push(options), { claimed: 0, rounds: 0, outcomes: {}, stopped: "empty",
      reaped: { requeued: 0, dead: 0 }, maintenance: { m: "ok" } }),
  },
});
const call = (secret = "synthetic-secret") =>
  route.GET(new Request("http://localhost/api/jobs/worker", { headers: secret ? { authorization: `Bearer ${secret}` } : {} }));

test("runs the worker with a deadline inside maxDuration and answers with counts only", async () => {
  assert.equal(route.maxDuration, 300);
  assert.equal(route.maxDuration, workerModule.WORKER_MAX_DURATION);
  assert.equal(route.runtime, "nodejs");
  const before = Date.now();
  const response = await call();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { claimed: 0, rounds: 0, outcomes: {}, stopped: "empty",
    reaped: { requeued: 0, dead: 0 }, maintenance: { m: "ok" } });
  assert.equal(runs.length, 1);
  const [options] = runs;
  assert.deepEqual(options.queue, { queueFor: adminClient });
  assert.deepEqual(options.handlers, [{ kind: "assignment.run", admin: adminClient }]);
  assert.equal(options.workerId, "cron:test");
  assert.ok(options.deadlineAt >= before + 270_000 && options.deadlineAt <= Date.now() + 270_000);
  assert.equal(options.maintenance[0].queue, options.queue);
});

test("unauthorized or unconfigured calls do nothing", async () => {
  for (const secret of [null, "wrong"]) assert.equal((await call(secret)).status, 401);
  delete process.env.CRON_SECRET;
  assert.equal((await call()).status, 401, "no secret configured: refuse everyone");
  process.env.CRON_SECRET = "synthetic-secret";
  adminClient = null;
  assert.equal((await call()).status, 503);
  assert.equal(runs.length, 0);
});
