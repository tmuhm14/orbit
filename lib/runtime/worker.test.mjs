import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffSeconds, memoryJobQueue } from "./memory.ts";
import { createRegistry, runJob, runJobNow, runWorker } from "./worker.ts";

// The worker loop and the JobQueue contract against the in-memory queue,
// with a fake clock (time only moves when a test moves it) and a fixed
// random source for the jitter. The Postgres functions are tested against
// PGlite in supabase/tests/durable-jobs.test.mjs.

function setup({ random = () => 0.5 } = {}) {
  let t = Date.UTC(2026, 9, 20, 12, 0, 0);
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const queue = memoryJobQueue({ now: clock.now, random });
  const logs = [];
  const log = (entry) => logs.push(entry);
  return { clock, queue, logs, log };
}
const handler = (kind, run, minRunMs = 0) => ({ kind, minRunMs, run });
const job = (kind = "test.echo", key = "k1", payload = { id: "11111111-1111-4111-8111-111111111111" }) =>
  ({ kind, idempotencyKey: key, payload });

test("enqueue is idempotent per kind and key; the first payload wins", async () => {
  const { queue } = setup();
  const a = await queue.enqueue(job());
  const b = await queue.enqueue({ ...job(), payload: { id: "other" } });
  const c = await queue.enqueue(job("test.other"));
  assert.deepEqual([a.created, b.created, c.created], [true, false, true]);
  assert.equal(b.jobId, a.jobId);
  assert.notEqual(c.jobId, a.jobId);
  assert.deepEqual(queue.jobs.get(a.jobId).payload, { id: "11111111-1111-4111-8111-111111111111" });
});

test("concurrent claims never return the same job; batch size and run_at are respected", async () => {
  const { queue, clock } = setup();
  for (let i = 0; i < 5; i++) await queue.enqueue(job("test.echo", `k${i}`));
  await queue.enqueue({ ...job("test.echo", "later"), runAt: new Date(clock.now() + 60_000) });
  const [first, second] = await Promise.all([
    queue.claim({ workerId: "w1", leaseSeconds: 60, batchSize: 3 }),
    queue.claim({ workerId: "w2", leaseSeconds: 60, batchSize: 3 }),
  ]);
  assert.equal(first.length + second.length, 5);
  assert.equal(new Set([...first, ...second].map((j) => j.id)).size, 5);
  assert.deepEqual(await queue.claim({ workerId: "w3", leaseSeconds: 60, batchSize: 3 }), [], "later job not ready");
  clock.advance(60_000);
  assert.equal((await queue.claim({ workerId: "w3", leaseSeconds: 60, batchSize: 3 })).length, 1);
});

test("restart mid-job: the lease expires, the reaper re-queues with backoff, and the next claim is attempt 2", async () => {
  const { queue, clock } = setup();
  const { jobId } = await queue.enqueue(job());
  const [delivery] = await queue.claim({ workerId: "w1", leaseSeconds: 60, batchSize: 1 });
  assert.equal(delivery.attempt, 1);
  // The process dies: no heartbeat, no complete.
  clock.advance(59_000);
  assert.deepEqual(await queue.reap(), { requeued: 0, dead: 0 }, "lease still live");
  clock.advance(1_000);
  assert.deepEqual(await queue.reap(), { requeued: 1, dead: 0 });
  assert.equal(queue.jobs.get(jobId).lastErrorCode, "lease_expired");
  // Backoff after attempt 1 with base 15 s and random 0.5: 7.5 + 3.75 s.
  assert.equal(queue.jobs.get(jobId).runAt - clock.now(), 11_250);
  assert.deepEqual(await queue.claim({ workerId: "w2", leaseSeconds: 60, batchSize: 1 }), []);
  clock.advance(11_250);
  const [again] = await queue.claim({ workerId: "w2", leaseSeconds: 60, batchSize: 1 });
  assert.equal(again.attempt, 2);
  // The old delivery is fenced out.
  const old = { jobId, leaseToken: delivery.leaseToken };
  assert.equal(await queue.heartbeat(old), "lease_lost");
  assert.equal(await queue.complete(old), "lease_lost");
  assert.equal(await queue.complete({ jobId, leaseToken: again.leaseToken }), "completed");
});

test("an expired lease is lost even before the reaper runs", async () => {
  const { queue, clock } = setup();
  await queue.enqueue(job());
  const [d] = await queue.claim({ workerId: "w1", leaseSeconds: 60, batchSize: 1 });
  const lease = { jobId: d.id, leaseToken: d.leaseToken };
  clock.advance(30_000);
  assert.equal(await queue.heartbeat(lease, 60), "ok");
  clock.advance(59_000);
  assert.equal(await queue.heartbeat(lease, 60), "ok", "the heartbeat extended it");
  clock.advance(60_000);
  assert.equal(await queue.heartbeat(lease, 60), "lease_lost");
  assert.deepEqual(await queue.fail(lease, "boom"), { status: "lease_lost" });
});

test("retry with exponential backoff and jitter, capped, then dead at max attempts", async () => {
  assert.equal(backoffSeconds(1, 15, 900, 0), 7.5);
  assert.equal(backoffSeconds(1, 15, 900, 1), 15);
  assert.equal(backoffSeconds(3, 15, 900, 1), 60);
  assert.equal(backoffSeconds(10, 15, 900, 1), 900, "capped");
  assert.equal(backoffSeconds(10, 15, 900, 0), 450, "equal jitter keeps half");
  const { queue, clock } = setup({ random: () => 1 });
  const { jobId } = await queue.enqueue({ ...job(), maxAttempts: 3, backoff: { baseSeconds: 10, maxSeconds: 25 } });
  const delays = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const [d] = await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 1 });
    assert.equal(d.attempt, attempt);
    const r = await queue.fail({ jobId, leaseToken: d.leaseToken }, "provider_unavailable");
    if (attempt < 3) {
      assert.equal(r.status, "retrying");
      delays.push(Date.parse(r.runAt) - clock.now());
      clock.advance(delays.at(-1));
    } else assert.deepEqual(r, { status: "dead" });
  }
  assert.deepEqual(delays, [10_000, 20_000]);
  assert.equal(queue.jobs.get(jobId).status, "dead");
  assert.equal(queue.jobs.get(jobId).lastErrorCode, "provider_unavailable");
  assert.deepEqual(await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 1 }), [], "dead jobs never run");
  // A lease that expires on the last attempt is dead too.
  const second = await queue.enqueue({ ...job("test.echo", "k2"), maxAttempts: 1 });
  await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 1 });
  clock.advance(61_000);
  assert.deepEqual(await queue.reap(), { requeued: 0, dead: 1 });
  assert.equal(queue.jobs.get(second.jobId).status, "dead");
});

test("release hands a delivery back without using an attempt", async () => {
  const { queue, clock } = setup();
  const { jobId } = await queue.enqueue({ ...job(), maxAttempts: 1 });
  for (let i = 0; i < 3; i++) {
    const [d] = await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 1 });
    assert.equal(d.attempt, 1);
    assert.equal(await queue.release({ jobId, leaseToken: d.leaseToken }, 30), "released");
    clock.advance(30_000);
  }
  assert.equal(queue.jobs.get(jobId).status, "queued");
});

test("worker: completes, retries a thrown handler, kills unknown kinds, and logs ids and codes only", async () => {
  const { queue, clock, logs, log } = setup();
  const seen = [];
  const handlers = [
    handler("test.echo", async ({ job: j }) => (seen.push(j.payload.id), { type: "complete" })),
    handler("test.throws", async () => { throw new Error("secret content in an error"); }),
  ];
  await queue.enqueue(job("test.echo", "a"));
  await queue.enqueue(job("test.throws", "b"));
  await queue.enqueue(job("test.unknown", "c"));
  const summary = await runWorker({ queue, handlers, workerId: "cron:1", deadlineAt: clock.now() + 270_000, now: clock.now, log });
  assert.deepEqual(summary, { reaped: { requeued: 0, dead: 0 }, maintenance: {}, claimed: 2, rounds: 1,
    outcomes: { completed: 1, retrying: 1 }, stopped: "empty" });
  assert.deepEqual(seen, ["11111111-1111-4111-8111-111111111111"]);
  const thrown = [...queue.jobs.values()].find((j) => j.kind === "test.throws");
  assert.deepEqual([thrown.status, thrown.lastErrorCode], ["queued", "handler_error"]);
  // The worker only claims registered kinds; a delivery of an unknown kind (fast path) is dead.
  const unknown = [...queue.jobs.values()].find((j) => j.kind === "test.unknown");
  assert.equal(unknown.status, "queued");
  assert.equal(await runJobNow(queue, [...handlers, handler("test.unknown", async () => ({ type: "complete" }))], unknown.id,
    { deadlineAt: clock.now() + 1000, now: clock.now, workerId: "k", log }), "completed");
  await queue.enqueue(job("test.gone", "d"));
  const [d] = await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 1, kinds: ["test.gone"] });
  assert.equal(await runJob(queue, createRegistry(handlers), d, { deadlineAt: clock.now() + 1000, now: clock.now, log }), "dead");
  assert.equal(queue.jobs.get(d.id).lastErrorCode, "unknown_kind");
  const text = JSON.stringify(logs);
  assert.ok(!text.includes("secret") && !text.includes("lease-"), "no error text or lease tokens in logs");
  assert.deepEqual(Object.keys(logs[0]).sort(), ["attempt", "jobId", "kind", "outcome"]);
});

test("duplicate delivery: a zombie whose lease was re-delivered can't complete, and its result is dropped", async () => {
  const { queue, clock, log } = setup();
  const { jobId } = await queue.enqueue(job());
  const effects = [];
  let release;
  const blocked = new Promise((resolve) => (release = resolve));
  const registry = createRegistry([handler("test.echo", async ({ job: j }) => {
    effects.push(j.attempt);
    if (j.attempt === 1) await blocked;
    return { type: "complete" };
  })]);
  const [first] = await queue.claim({ workerId: "w1", leaseSeconds: 60, batchSize: 1 });
  // Heartbeats can't reach the database (fake clock jumps past the lease).
  const zombie = runJob(queue, registry, first, { deadlineAt: clock.now() + 600_000, now: clock.now, log, heartbeatMs: 60_000 });
  clock.advance(61_000);
  await queue.reap();
  clock.advance(60_000);
  const [second] = await queue.claim({ workerId: "w2", leaseSeconds: 60, batchSize: 1 });
  assert.equal(await runJob(queue, registry, second, { deadlineAt: clock.now() + 600_000, now: clock.now, log }), "completed");
  release();
  assert.equal(await zombie, "lease_lost");
  assert.deepEqual(effects, [1, 2], "the handler ran twice: handlers must be idempotent (assignment.run is)");
  assert.equal(queue.jobs.get(jobId).status, "completed");
});

test("cancellation: a canceled running job loses its lease, the handler's signal aborts, and nothing is written", async () => {
  const { queue, clock, log } = setup();
  const { jobId } = await queue.enqueue(job());
  let aborted = false;
  let started;
  const running = new Promise((resolve) => (started = resolve));
  const registry = createRegistry([handler("test.echo", async ({ signal }) => {
    started();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    aborted = signal.aborted;
    return { type: "complete" };
  })]);
  const [d] = await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 1 });
  const outcome = runJob(queue, registry, d, { deadlineAt: clock.now() + 270_000, now: clock.now, log, heartbeatMs: 5 });
  await running;
  assert.deepEqual(await queue.cancel({ jobId }), { status: "canceled", jobId });
  assert.equal(await outcome, "lease_lost");
  assert.equal(aborted, true);
  assert.equal(queue.jobs.get(jobId).status, "canceled");
  assert.deepEqual(await queue.cancel({ kind: "test.echo", idempotencyKey: "k1" }),
    { status: "already_finished", jobId, jobStatus: "canceled" });
  assert.deepEqual(await queue.cancel({ jobId: "missing" }), { status: "not_found" });
  // A queued job is canceled before it ever runs.
  const queued = await queue.enqueue(job("test.echo", "k2"));
  await queue.cancel({ kind: "test.echo", idempotencyKey: "k2" });
  assert.deepEqual(await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 5 }), []);
  assert.equal(queue.jobs.get(queued.jobId).status, "canceled");
});

test("the worker stops claiming before its deadline and leaves the rest queued", async () => {
  const { queue, clock, log } = setup();
  for (let i = 0; i < 6; i++) await queue.enqueue(job("test.slow", `k${i}`));
  const handlers = [handler("test.slow", async () => (clock.advance(100_000), { type: "complete" }), 90_000)];
  const deadlineAt = clock.now() + 270_000;
  const summary = await runWorker({ queue, handlers, workerId: "cron:2", deadlineAt, now: clock.now, log, batchSize: 1 });
  // 0 s: run (→100 s), 100 s: run (→200 s), 200 s: only 70 s left < 90 s → stop.
  assert.equal(summary.stopped, "deadline");
  assert.equal(summary.claimed, 2);
  assert.ok(clock.now() <= deadlineAt);
  assert.equal([...queue.jobs.values()].filter((j) => j.status === "queued").length, 4);
  // A delivery that arrives with too little time left is released, not attempted.
  const [d] = await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 1 });
  assert.equal(await runJob(queue, createRegistry(handlers), d, { deadlineAt: clock.now() + 1000, now: clock.now, log }), "released");
  assert.equal(queue.jobs.get(d.id).attempts, 0);
});

test("maintenance runs after the reap and before claims; failures are counted, not thrown", async () => {
  const { queue, clock, log } = setup();
  const order = [];
  const wrapped = { ...queue, reap: async () => (order.push("reap"), queue.reap()),
    claim: async (o) => (order.push("claim"), queue.claim(o)) };
  const summary = await runWorker({
    queue: wrapped, handlers: [handler("test.echo", async () => ({ type: "complete" }))], workerId: "w",
    deadlineAt: clock.now() + 270_000, now: clock.now, log,
    maintenance: [{ name: "ok", run: async () => order.push("ok") }, { name: "bad", run: async () => { throw new Error("x"); } }],
  });
  assert.deepEqual(order, ["reap", "ok", "claim"]);
  assert.deepEqual(summary.maintenance, { ok: "ok", bad: "failed" });
  const failing = { ...queue, reap: async () => { throw new Error("db down"); }, claim: async () => { throw new Error("db down"); } };
  const down = await runWorker({ queue: failing, handlers: [handler("test.echo", async () => ({ type: "complete" }))],
    workerId: "w", deadlineAt: clock.now() + 270_000, now: clock.now, log });
  assert.deepEqual([down.reaped, down.stopped], [null, "error"]);
  assert.throws(() => createRegistry([handler("a.b", null), handler("a.b", null)]), /duplicate/);
});

test("persisted steps survive a retry and are fenced by the lease", async () => {
  const { queue, clock, log } = setup();
  await queue.enqueue(job());
  const calls = [];
  const registry = createRegistry([handler("test.echo", async ({ job: j, saveStep }) => {
    calls.push({ attempt: j.attempt, steps: j.steps });
    if (!j.steps.send) {
      assert.equal(await saveStep("send", { status: "started", result: null }), true);
      throw new Error("timeout after send");
    }
    // The effect's outcome is unknown: reconcile, then record the result.
    await saveStep("send", { status: "succeeded", result: { messageId: "m-1" } });
    return { type: "complete" };
  })]);
  let [d] = await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 1 });
  assert.equal(await runJob(queue, registry, d, { deadlineAt: clock.now() + 270_000, now: clock.now, log }), "retrying");
  clock.advance(60_000);
  [d] = await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 1 });
  assert.equal(await runJob(queue, registry, d, { deadlineAt: clock.now() + 270_000, now: clock.now, log }), "completed");
  assert.deepEqual(calls.map((c) => [c.attempt, c.steps.send?.status ?? null]), [[1, null], [2, "started"]]);
  assert.equal(await queue.saveStep({ jobId: d.id, leaseToken: d.leaseToken }, "late", { status: "started", result: null }), "lease_lost");
});
