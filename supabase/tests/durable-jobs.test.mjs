import { test, before } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, skip } from "./harness.mjs";
import { adminDouble } from "./admin-double.mjs";
import { loadTs } from "../../tests/load-ts.mjs";
import { createRegistry, runJob, runWorker } from "../../lib/runtime/worker.ts";

// A-04: the durable-jobs functions (migration 20261020000000_durable_jobs.sql)
// against PGlite, directly and through the Postgres adapter
// (lib/runtime/postgres.ts) driven by the worker loop. Time is moved by
// rewriting lease_expires_at / run_at, since now() is the database's clock.
const U = "aaaaaaaa-0000-4000-8000-000000000001";
let db;
let admin;
let queue;

before(async () => {
  if (skip) return;
  db = await createDb();
  await migrate(db);
  await db.exec(`alter role service_role bypassrls; insert into auth.users values ('${U}');`);
  admin = adminDouble(db);
  queue = loadTs(new URL("../../lib/runtime/postgres.ts", import.meta.url)).postgresJobQueue(admin);
});

const svc = async (text, params = []) => (await admin.sql(text, params))[0]?.r;
const row = async (id) => (await db.query("select * from public.jobs where id = $1", [id])).rows[0];
const expire = (id) => db.query("update public.jobs set lease_expires_at = now() - interval '1 second' where id = $1", [id]);
const ready = (id) => db.query("update public.jobs set run_at = now() - interval '1 second' where id = $1", [id]);
let n = 0;
const key = () => `test:${++n}`;
const enqueue = (patch = {}) => queue.enqueue({ kind: "test.echo", idempotencyKey: key(), payload: { id: U }, ...patch });
const claimOne = async (jobId, workerId = "w1") => (await queue.claim({ workerId, leaseSeconds: 60, batchSize: 1, jobId }))[0];
const lease = (d) => ({ jobId: d.id, leaseToken: d.leaseToken });

test("idempotent enqueue: the same kind and key return the existing job, unchanged", { skip }, async () => {
  const k = key();
  const a = await queue.enqueue({ kind: "test.echo", idempotencyKey: k, payload: { id: U, n: 1 } });
  const b = await queue.enqueue({ kind: "test.echo", idempotencyKey: k, payload: { id: U, n: 2 }, maxAttempts: 9 });
  const c = await queue.enqueue({ kind: "test.other", idempotencyKey: k, payload: {} });
  assert.deepEqual([a.created, b.created, c.created], [true, false, true]);
  assert.equal(a.jobId, b.jobId);
  assert.notEqual(a.jobId, c.jobId);
  const r = await row(a.jobId);
  assert.deepEqual([r.payload, r.max_attempts, r.status, r.attempts], [{ id: U, n: 1 }, 5, "queued", 0]);
  // Still the same job after it finished.
  const d = await claimOne(a.jobId);
  await queue.complete(lease(d));
  assert.deepEqual(await queue.enqueue({ kind: "test.echo", idempotencyKey: k, payload: {} }),
    { jobId: a.jobId, created: false, status: "completed" });
});

test("payloads are ids only: nested values, long strings and bad kinds are refused", { skip }, async () => {
  const refused = async (args) => assert.deepEqual(await svc(
    "select public.enqueue_job($1, $2, $3::jsonb) r", args), { status: "invalid_payload" });
  await refused(["test.echo", key(), JSON.stringify({ note: { body: "content" } })]);
  await refused(["test.echo", key(), JSON.stringify({ ids: ["a", "b"] })]);
  await refused(["test.echo", key(), JSON.stringify({ text: "x".repeat(101) })]);
  await refused(["test.echo", key(), JSON.stringify(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])))]);
  await refused(["Test Echo", key(), "{}"]);
  await refused(["test.echo", "", "{}"]);
  assert.deepEqual(await svc("select public.enqueue_job('test.echo', $1, '{}', null, 30) r", [key()]), { status: "invalid_payload" });
  assert.deepEqual(await svc("select public.enqueue_job('test.echo', $1, '{}', null, null, 100, 10) r", [key()]), { status: "invalid_payload" });
  await assert.rejects(() => queue.enqueue({ kind: "test.echo", idempotencyKey: key(), payload: { a: { b: 1 } } }), /refused/);
});

test("concurrent workers: two claims never return the same job (SKIP LOCKED); batch size and run_at hold", { skip }, async () => {
  await db.query("update public.jobs set status = 'canceled', finished_at = now(), lease_token = null, lease_expires_at = null, leased_by = null where status in ('queued', 'running')");
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await enqueue()).jobId);
  const later = await enqueue({ runAt: new Date(Date.now() + 3_600_000) });
  // PGlite has a single connection, so two workers are simulated by two
  // claim calls in flight at once; Postgres serializes them on the row locks
  // and SKIP LOCKED makes the second pass over rows the first holds.
  const [first, second] = await Promise.all([
    queue.claim({ workerId: "w1", leaseSeconds: 60, batchSize: 3 }),
    queue.claim({ workerId: "w2", leaseSeconds: 60, batchSize: 3 }),
  ]);
  const claimed = [...first, ...second].map((d) => d.id);
  assert.deepEqual([first.length, second.length], [3, 2]);
  assert.equal(new Set(claimed).size, 5, "no job is delivered twice");
  assert.deepEqual(new Set(claimed), new Set(ids));
  assert.ok(!claimed.includes(later.jobId), "not before run_at");
  assert.deepEqual(await queue.claim({ workerId: "w3", leaseSeconds: 60, batchSize: 10 }), []);
  assert.match((await db.query("select pg_get_functiondef('public.claim_jobs'::regproc) d")).rows[0].d, /for update skip locked/);
  const r = await row(first[0].id);
  assert.deepEqual([r.status, r.attempts, r.leased_by], ["running", 1, "w1"]);
  assert.equal(first[0].attempt, 1);
  assert.deepEqual(first[0].steps, {});
  // Invalid arguments claim nothing.
  for (const args of [["", 60, 1], ["w", 5, 1], ["w", 60, 0], ["w", 60, 26]])
    assert.deepEqual(await svc("select public.claim_jobs($1, $2, $3) r", args), []);
  // Kinds filter.
  const other = await queue.enqueue({ kind: "test.other", idempotencyKey: key(), payload: {} });
  assert.deepEqual(await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 5, kinds: ["test.echo"] }), []);
  assert.equal((await queue.claim({ workerId: "w", leaseSeconds: 60, batchSize: 5, kinds: ["test.other"] }))[0].id, other.jobId);
});

test("heartbeat and every write are fenced by the lease token; expiry loses the lease before the reaper runs", { skip }, async () => {
  const { jobId } = await enqueue();
  const d = await claimOne(jobId);
  assert.equal(await queue.heartbeat(lease(d), 120), "ok");
  assert.ok(new Date((await row(jobId)).lease_expires_at) > new Date(Date.now() + 100_000));
  const wrong = { jobId, leaseToken: U };
  assert.equal(await queue.heartbeat(wrong), "lease_lost");
  assert.equal(await queue.complete(wrong), "lease_lost");
  assert.deepEqual(await queue.fail(wrong, "boom"), { status: "lease_lost" });
  assert.equal(await queue.release(wrong), "lease_lost");
  assert.equal(await queue.saveStep(wrong, "s", { status: "started", result: null }), "lease_lost");
  assert.deepEqual(await svc("select public.heartbeat_job($1, $2, 5) r", [jobId, d.leaseToken]), { status: "invalid_payload" });
  await expire(jobId);
  assert.equal(await queue.heartbeat(lease(d)), "lease_lost");
  assert.equal(await queue.complete(lease(d)), "lease_lost");
  assert.equal((await row(jobId)).status, "running", "until the reaper sees it");
  await queue.cancel({ jobId });
});

test("restart mid-job: an expired lease is re-queued with backoff and re-claimed as attempt 2; the old token is dead", { skip }, async () => {
  const { jobId } = await enqueue();
  const d1 = await claimOne(jobId);
  // The process is lost: nothing more happens until the lease expires.
  assert.deepEqual(await queue.reap(), { requeued: 0, dead: 0 });
  await expire(jobId);
  assert.deepEqual(await queue.reap(), { requeued: 1, dead: 0 });
  const r = await row(jobId);
  assert.deepEqual([r.status, r.last_error_code, r.lease_token, r.leased_by], ["queued", "lease_expired", null, null]);
  const delay = (new Date(r.run_at) - new Date(r.updated_at)) / 1000;
  assert.ok(delay >= 7.5 && delay <= 15, `backoff after attempt 1 is 7.5–15 s, got ${delay}`);
  assert.equal(await claimOne(jobId), undefined, "not before the backoff");
  await ready(jobId);
  const d2 = await claimOne(jobId, "w2");
  assert.equal(d2.attempt, 2);
  assert.notEqual(d2.leaseToken, d1.leaseToken);
  assert.equal(await queue.complete(lease(d1)), "lease_lost");
  assert.equal(await queue.complete(lease(d2)), "completed");
  const done = await row(jobId);
  assert.deepEqual([done.status, done.lease_token, !!done.finished_at], ["completed", null, true]);
});

test("retry with exponential backoff and jitter, then dead at max attempts with a normalized code", { skip }, async () => {
  const { jobId } = await enqueue({ maxAttempts: 3, backoff: { baseSeconds: 10, maxSeconds: 25 } });
  const delays = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const d = await claimOne(jobId);
    assert.equal(d.attempt, attempt);
    const r = await queue.fail(lease(d), "provider_unavailable");
    if (attempt < 3) {
      assert.equal(r.status, "retrying");
      const j = await row(jobId);
      delays.push((new Date(j.run_at) - new Date(j.updated_at)) / 1000);
      await ready(jobId);
    } else assert.deepEqual(r, { status: "dead" });
  }
  // Attempt 1: 10 s → 5–10; attempt 2: 20 s → 10–20 (cap 25 not reached).
  assert.ok(delays[0] >= 5 && delays[0] <= 10, String(delays[0]));
  assert.ok(delays[1] >= 10 && delays[1] <= 20, String(delays[1]));
  const dead = await row(jobId);
  assert.deepEqual([dead.status, dead.attempts, dead.last_error_code], ["dead", 3, "provider_unavailable"]);
  assert.equal(await claimOne(jobId), undefined, "dead jobs never run again");
  // The cap applies (equal jitter: between half and all of it).
  const [{ d }] = (await db.query("select public.job_backoff_seconds(10, 15, 60)::float8 d")).rows;
  assert.ok(d >= 30 && d <= 60);
  // Non-retryable failure is dead at once; codes are normalized identifiers.
  const other = await enqueue();
  const o = await claimOne(other.jobId);
  assert.deepEqual(await svc("select public.fail_job($1, $2, 'Not a code: content') r", [o.id, o.leaseToken]), { status: "invalid_payload" });
  assert.deepEqual(await queue.fail(lease(o), "invalid_payload", { retryable: false }), { status: "dead" });
  // An expired lease on the last attempt is dead too.
  const last = await enqueue({ maxAttempts: 1 });
  await claimOne(last.jobId);
  await expire(last.jobId);
  assert.deepEqual(await queue.reap(), { requeued: 0, dead: 1 });
  assert.deepEqual([(await row(last.jobId)).status, (await row(last.jobId)).last_error_code], ["dead", "lease_expired"]);
});

test("release returns a delivery without using an attempt", { skip }, async () => {
  const { jobId } = await enqueue({ maxAttempts: 1 });
  for (let i = 0; i < 3; i++) {
    const d = await claimOne(jobId);
    assert.equal(d.attempt, 1);
    assert.equal(await queue.release(lease(d), i === 0 ? 30 : 0), "released");
    if (i === 0) {
      assert.equal(await claimOne(jobId), undefined, "delayed");
      await ready(jobId);
    }
  }
  assert.deepEqual([(await row(jobId)).status, (await row(jobId)).attempts], ["queued", 0]);
});

test("cancellation: queued jobs never run; a running delivery loses its lease at once", { skip }, async () => {
  const queued = await enqueue();
  const k = key();
  await queue.enqueue({ kind: "test.echo", idempotencyKey: k, payload: {} });
  assert.equal((await queue.cancel({ jobId: queued.jobId })).status, "canceled");
  assert.equal((await queue.cancel({ kind: "test.echo", idempotencyKey: k })).status, "canceled");
  assert.equal(await claimOne(queued.jobId), undefined);
  const running = await enqueue();
  const d = await claimOne(running.jobId);
  assert.deepEqual(await queue.cancel({ jobId: running.jobId }), { status: "canceled", jobId: running.jobId });
  assert.equal(await queue.heartbeat(lease(d)), "lease_lost");
  assert.equal(await queue.complete(lease(d)), "lease_lost");
  assert.deepEqual(await queue.cancel({ jobId: running.jobId }),
    { status: "already_finished", jobId: running.jobId, jobStatus: "canceled" });
  assert.deepEqual(await queue.cancel({ jobId: U }), { status: "not_found" });
  const r = await row(running.jobId);
  assert.deepEqual([r.status, r.lease_token, !!r.finished_at], ["canceled", null, true]);
});

test("persisted steps survive a retry, come back with the claim, and are fenced", { skip }, async () => {
  const { jobId } = await enqueue();
  const d1 = await claimOne(jobId);
  assert.equal(await queue.saveStep(lease(d1), "send", { status: "started", result: null }), "saved");
  await queue.fail(lease(d1), "timed_out_after_send");
  await ready(jobId);
  const d2 = await claimOne(jobId);
  assert.deepEqual(d2.steps, { send: { status: "started", result: null } });
  assert.equal(await queue.saveStep(lease(d2), "send", { status: "succeeded", result: { messageId: "m-1" } }), "saved");
  assert.deepEqual(await svc("select public.save_job_step($1, $2, 'send', 'succeeded', '{\"body\": {\"x\": 1}}') r",
    [jobId, d2.leaseToken]), { status: "invalid_payload" });
  assert.deepEqual((await db.query("select name, status, result, attempt from public.job_steps where job_id = $1", [jobId])).rows,
    [{ name: "send", status: "succeeded", result: { messageId: "m-1" }, attempt: 2 }]);
  assert.equal(await queue.saveStep(lease(d1), "other", { status: "started", result: null }), "lease_lost");
});

test("retention: purge drops long-finished jobs only", { skip }, async () => {
  const old = await enqueue();
  const d = await claimOne(old.jobId);
  await queue.complete(lease(d));
  const recent = await enqueue();
  await queue.complete(lease(await claimOne(recent.jobId)));
  const dead = await enqueue({ maxAttempts: 1 });
  await queue.fail(lease(await claimOne(dead.jobId)), "boom");
  await db.query("update public.jobs set finished_at = now() - interval '8 days' where id in ($1, $2)", [old.jobId, dead.jobId]);
  const before = Number((await db.query("select count(*) c from public.jobs")).rows[0].c);
  assert.equal(await queue.purge(), 1);
  assert.equal(await row(old.jobId), undefined);
  assert.ok(await row(recent.jobId));
  assert.ok(await row(dead.jobId), "dead jobs are kept 30 days");
  assert.equal(Number((await db.query("select count(*) c from public.jobs")).rows[0].c), before - 1);
});

test("access: anon and authenticated can't read jobs or call any job function; RLS is on", { skip }, async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(() => as(db, role, U, "select * from public.jobs"), /permission denied/);
    await assert.rejects(() => as(db, role, U, "select * from public.job_steps"), /permission denied/);
    for (const call of ["public.enqueue_job('test.echo', 'x', '{}')", "public.claim_jobs('w', 60, 1)", "public.reap_jobs()",
      "public.purge_jobs()", `public.cancel_job('${U}')`, `public.complete_job('${U}', '${U}')`,
      `public.heartbeat_job('${U}', '${U}')`, `public.fail_job('${U}', '${U}', 'x')`, `public.release_job('${U}', '${U}')`,
      `public.save_job_step('${U}', '${U}', 's', 'started')`])
      await assert.rejects(() => as(db, role, U, `select ${call}`), /permission denied/, `${role} ${call}`);
  }
  const rls = (await db.query("select relname, relrowsecurity from pg_class where relname in ('jobs', 'job_steps') order by 1")).rows;
  assert.deepEqual(rls, [{ relname: "job_steps", relrowsecurity: true }, { relname: "jobs", relrowsecurity: true }]);
  assert.deepEqual((await db.query("select * from pg_policies where tablename in ('jobs', 'job_steps')")).rows, []);
  // Internal helpers aren't callable even by service_role.
  for (const call of [`public.job_lease('${U}', '${U}')`, "public.job_payload_valid('{}')", "public.job_backoff_seconds(1, 1, 1)"])
    await assert.rejects(() => as(db, "service_role", null, `select ${call}`), /permission denied/, call);
});

test("the worker loop over Postgres: reap, claim batches, heartbeat, complete, retry; logs carry no content", { skip }, async () => {
  await db.query("update public.jobs set status = 'canceled', finished_at = now(), lease_token = null, lease_expires_at = null, leased_by = null where status in ('queued', 'running')");
  const stale = await enqueue();
  await claimOne(stale.jobId, "crashed");
  await expire(stale.jobId);
  const ids = [(await enqueue()).jobId, (await enqueue()).jobId, (await enqueue({ kind: "test.flaky" })).jobId];
  const logs = [];
  const seen = [];
  const handlers = [
    { kind: "test.echo", minRunMs: 0, run: async ({ job }) => (seen.push(job.id), { type: "complete" }) },
    { kind: "test.flaky", minRunMs: 0, run: async () => { throw new Error("content that must not be logged"); } },
  ];
  const summary = await runWorker({ queue, handlers, workerId: "cron:test", deadlineAt: Date.now() + 270_000,
    batchSize: 2, heartbeatMs: 5, log: (e) => logs.push(e) });
  assert.deepEqual(summary.reaped, { requeued: 1, dead: 0 });
  assert.equal(summary.stopped, "empty");
  assert.deepEqual(summary.outcomes, { completed: 2, retrying: 1 });
  assert.deepEqual(seen.sort(), ids.slice(0, 2).sort());
  assert.equal((await row(ids[2])).last_error_code, "handler_error");
  assert.equal((await row(stale.jobId)).status, "queued", "re-queued with backoff, not run yet");
  assert.ok(!JSON.stringify(logs).includes("content") && !JSON.stringify(logs).includes(U));
  // A slow handler keeps its lease alive with heartbeats.
  const slow = await enqueue();
  const d = await claimOne(slow.jobId);
  const before = (await row(slow.jobId)).lease_expires_at;
  const registry = createRegistry([{ kind: "test.echo", minRunMs: 0,
    run: async () => (await new Promise((r) => setTimeout(r, 60)), { type: "complete" }) }]);
  assert.equal(await runJob(queue, registry, d, { deadlineAt: Date.now() + 270_000, heartbeatMs: 10, log: () => undefined }), "completed");
  assert.ok(admin.rpcLog.filter((name) => name === "heartbeat_job").length >= 2);
  assert.ok(before);
});
