import { test, before } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, skip } from "./harness.mjs";
import { adminDouble } from "./admin-double.mjs";
import * as providers from "../../lib/agent/providers.ts";
import * as transitions from "../../lib/assignments/transitions.ts";
import * as prompt from "../../lib/assignments/executor-prompt.ts";
import * as markdown from "../../lib/assignments/markdown.ts";
import * as worker from "../../lib/runtime/worker.ts";
import { loadTs } from "../../tests/load-ts.mjs";

// A-04: built-in assignment execution on the durable queue, end to end
// against PGlite: the real assignment and job functions, the real executor
// and Supabase store (executor-server.ts), the Postgres job adapter, the
// worker loop and its maintenance (lib/runtime/jobs.ts). The model is
// scripted; no provider is called and no key exists.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const SECRET_OUTCOME = "Draft a reply about invoice 4471";
const SECRET_NOTE = "Vendor Acme says the shipment of 300 widgets is late";
let n = 0;
const uuid = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, "0")}`;

let db;
let admin;
let server;
let jobs;
let queue;
let script = [];
let requests = [];
const provider = {
  async chat(request) {
    requests.push(request);
    const next = script.shift();
    if (!next) throw new Error("unexpected model call");
    return typeof next === "function" ? next(request) : next;
  },
  async listModels() { return []; },
};
const reset = (turns = []) => {
  script = turns;
  requests = [];
};

before(async () => {
  if (skip) return;
  db = await createDb();
  await migrate(db);
  await db.exec(`alter role service_role bypassrls; insert into auth.users values ('${A}');`);
  await db.query(`insert into public.agent_settings (user_id, provider, model, api_key_ciphertext, key_hint)
    values ($1, 'anthropic', 'claude-test', 'sealed', 'abcd')`, [A]);
  admin = adminDouble(db);
  const executor = loadTs(new URL("../../lib/assignments/executor.ts", import.meta.url), {
    "@/lib/agent/providers": providers, "./transitions": transitions, "./executor-prompt": prompt, "./markdown": markdown,
  });
  const postgres = loadTs(new URL("../../lib/runtime/postgres.ts", import.meta.url));
  server = loadTs(new URL("../../lib/assignments/executor-server.ts", import.meta.url), {
    "@/lib/supabase/admin": { createAdminClient: () => admin },
    "@/lib/agent/server": {
      loadAgentSettings: async () => ({ provider: "anthropic", model: "claude-test", keyHint: "abcd", autoTriage: false,
        apiKey: "sk-synthetic-not-a-key" }),
    },
    "@/lib/agent/providers": { createProvider: () => provider },
    "@/lib/runtime/postgres": postgres,
    "@/lib/runtime/worker": worker,
    "./executor": executor,
  });
  jobs = loadTs(new URL("../../lib/runtime/jobs.ts", import.meta.url), { "@/lib/assignments/executor-server": server });
  queue = postgres.postgresJobQueue(admin);
});

const q = async (text, params = []) => (await db.query(text, params)).rows;
const userRpc = async (text, params) => (await as(db, "authenticated", A, text, params))[0].r;
const submit = () => ({ text: "", calls: [{ id: "s", name: "submit_result", input: {
  kind: "draft", title: "Reply to the vendor", markdown: "## Reply\n\nThanks.", cited_ids: [] } }] });

async function workspace() {
  return (await q(`insert into public.workspaces (user_id, name, agent_enabled) values ($1, 'W', true) returning id`, [A]))[0].id;
}
async function delegate(ws) {
  ws ??= await workspace();
  const id = uuid();
  const [r] = await userRpc("select public.save_notes($1::jsonb, false) r", [JSON.stringify([{ id, workspace_id: ws,
    title: "Reply to Acme", content: { type: "doc" }, plain_text: SECRET_NOTE, bucket: "next", tags: [], kind: "task",
    created_at: "2026-10-13T00:00:00.000Z", completed_at: null, expected_revision: null }])]);
  assert.equal(r.status, "saved");
  const created = await userRpc("select public.create_assignment($1, $2, $3, '{}'::uuid[], 'builtin', null) r", [ws, id, SECRET_OUTCOME]);
  const queued = server.queuedBuiltinAssignment(created);
  assert.ok(queued);
  return { ...queued, ws };
}
const assignment = async (id) => (await q("select state, error_code, revision from public.assignments where id = $1", [id]))[0];
const artifacts = async (id) => (await q("select id from public.assignment_artifacts where assignment_id = $1", [id])).length;
const job = async (id) => (await q("select * from public.jobs where id = $1", [id]))[0];
const jobFor = async (a) => (await q("select * from public.jobs where kind = 'assignment.run' and idempotency_key = $1",
  [server.assignmentRunKey(a)]))[0];
const expireJob = (id) => q("update public.jobs set lease_expires_at = now() - interval '1 second' where id = $1", [id]);
const readyJobs = () => q("update public.jobs set run_at = now() - interval '1 second' where status = 'queued'");
/** Nothing left over from earlier tests competes for the worker. */
const quiesce = () => q(`update public.jobs set status = 'canceled', finished_at = now(), lease_token = null,
  lease_expires_at = null, leased_by = null where status in ('queued', 'running')`);
/**
 * The clock for the worker's maintenance schedule: now, except that a time
 * in the hourly purge minute is moved back to the end of the minute before
 * (at most 61 s), so the maintenance list is the same whenever the suite
 * runs. Reconciliation's grace cutoff only gets earlier, never later.
 */
const maintenanceAt = (t = Date.now()) => {
  const d = new Date(t);
  return d.getUTCMinutes() === jobs.PURGE_MINUTE
    ? new Date(t - (d.getUTCSeconds() + 1) * 1000 - d.getUTCMilliseconds())
    : d;
};
const runWorker = (options = {}) => worker.runWorker({
  queue, handlers: jobs.jobHandlers(admin), workerId: "cron:test", deadlineAt: Date.now() + 270_000,
  maintenance: jobs.jobMaintenance(admin, queue, maintenanceAt()), log: () => undefined, ...options,
});
async function captureConsole(fn) {
  const lines = [];
  const saved = { error: console.error, log: console.log, info: console.info, warn: console.warn };
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(args);
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

test("a queued assignment is enqueued once per revision and the worker runs it: one model call, one artifact", { skip }, async () => {
  await quiesce();
  const a = await delegate();
  const jobId = await server.enqueueAssignmentRun(a);
  assert.equal(await server.enqueueAssignmentRun(a), jobId, "idempotent: assignment:<id>:<revision>");
  const row = await job(jobId);
  assert.deepEqual([row.kind, row.idempotency_key, row.payload, row.max_attempts],
    ["assignment.run", `assignment:${a.id}:1`, { assignmentId: a.id, revision: 1 }, 5]);
  reset([submit()]);
  const { result: summary, lines } = await captureConsole(() => runWorker());
  assert.equal(summary.outcomes.completed, 1);
  assert.equal(summary.stopped, "empty");
  assert.deepEqual(summary.maintenance, { assignment_leases: "ok", assignment_jobs: "ok" });
  assert.equal((await assignment(a.id)).state, "needs_review");
  assert.deepEqual([requests.length, await artifacts(a.id)], [1, 1]);
  assert.deepEqual([(await job(jobId)).status, (await job(jobId)).attempts], ["completed", 1]);
  const text = JSON.stringify(lines);
  for (const secret of [SECRET_OUTCOME, SECRET_NOTE, "Acme", "sk-synthetic", row.lease_token ?? "no-token"])
    assert.ok(!text.includes(secret));
});

test("duplicate delivery: a job re-delivered after a crash before complete makes no second model call or artifact", { skip }, async () => {
  await quiesce();
  const a = await delegate();
  const jobId = await server.enqueueAssignmentRun(a);
  const [delivery] = await queue.claim({ workerId: "doomed", leaseSeconds: 60, batchSize: 1, jobId });
  reset([submit()]);
  // The handler runs, the assignment reaches needs_review, and the process
  // dies before complete_job.
  const handler = server.assignmentRunHandler(admin);
  assert.deepEqual(await handler.run({ job: delivery, signal: new AbortController().signal,
    deadlineAt: Date.now() + 270_000, now: Date.now, saveStep: async () => true }), { type: "complete" });
  await expireJob(jobId);
  await readyJobs();
  reset([]);
  const summary = await runWorker({ maintenance: [] });
  assert.deepEqual(summary.reaped, { requeued: 1, dead: 0 });
  await readyJobs();
  const again = await runWorker({ maintenance: [] });
  assert.equal(again.outcomes.completed, 1);
  assert.deepEqual([requests.length, await artifacts(a.id)], [0, 1], "the second delivery saw needs_review and stopped");
  assert.deepEqual([(await job(jobId)).status, (await job(jobId)).attempts], ["completed", 2]);
  // The fast path for a finished job, and for one another worker holds, is a no-op.
  assert.equal(await server.kickoffAssignmentRun(a, jobId, { deadlineAt: Date.now() + 270_000, admin }), "not_claimed");
});

test("restart mid-job: the attempt that was running times out (no T7 yet) and the re-delivered job completes without a model call", { skip }, async () => {
  await quiesce();
  const a = await delegate();
  const jobId = await server.enqueueAssignmentRun(a);
  await queue.claim({ workerId: "doomed", leaseSeconds: 60, batchSize: 1, jobId });
  // The process claimed the assignment, then was lost.
  const claim = await server.supabaseExecutorStore(admin).claim(a.id, 90);
  assert.equal(claim.status, "claimed");
  await expireJob(jobId);
  await q("update public.assignment_attempts set lease_expires_at = now() - interval '1 second' where id = $1", [claim.lease.attemptId]);
  reset([]);
  await runWorker();
  await readyJobs();
  const summary = await runWorker();
  assert.equal(summary.outcomes.completed, 1);
  assert.deepEqual(await assignment(a.id), { state: "failed", error_code: "timed_out", revision: 3 });
  assert.equal(requests.length, 0);
  assert.equal((await job(jobId)).status, "completed");
  // Retry by the user is a new revision, so a new job.
  const retried = await userRpc("select public.transition_assignment($1, 3, 'queued', null) r", [a.id]);
  const next = server.queuedBuiltinAssignment(retried);
  assert.deepEqual(next, { id: a.id, revision: 4 });
  assert.notEqual(await server.enqueueAssignmentRun(next), jobId);
});

test("cancellation: canceling the assignment and its job mid-run stops the handler via lease_lost; nothing is written", { skip }, async () => {
  await quiesce();
  const a = await delegate();
  const jobId = await server.enqueueAssignmentRun(a);
  reset([async () => {
    const rev = Number((await assignment(a.id)).revision);
    assert.equal((await userRpc("select public.transition_assignment($1, $2, 'canceled', null) r", [a.id, rev])).status, "saved");
    assert.equal((await queue.cancel({ kind: "assignment.run", idempotencyKey: server.assignmentRunKey(a) })).status, "canceled");
    await new Promise((resolve) => setTimeout(resolve, 30));
    return submit();
  }]);
  const summary = await runWorker({ heartbeatMs: 5, maintenance: [] });
  assert.deepEqual(summary.outcomes, { lease_lost: 1 });
  assert.deepEqual(await assignment(a.id), { state: "canceled", error_code: null, revision: 3 });
  assert.equal(await artifacts(a.id), 0, "the executor's submit was fenced");
  assert.equal((await job(jobId)).status, "canceled");
  // Canceling only the assignment is enough for a job that hasn't run: it completes as a no-op.
  const b = await delegate();
  const bJob = await server.enqueueAssignmentRun(b);
  await userRpc("select public.transition_assignment($1, 1, 'canceled', null) r", [b.id]);
  reset([]);
  assert.equal((await runWorker({ maintenance: [] })).outcomes.completed, 1);
  assert.equal((await job(bJob)).status, "completed");
  assert.equal(requests.length, 0);
});

test("a busy workspace releases the second run without using an attempt; the next pass runs it", { skip }, async () => {
  await quiesce();
  const ws = await workspace();
  const first = await delegate(ws);
  const second = await delegate(ws);
  const ids = [await server.enqueueAssignmentRun(first), await server.enqueueAssignmentRun(second)];
  reset([async () => (await new Promise((resolve) => setTimeout(resolve, 20)), submit())]);
  const summary = await runWorker({ maintenance: [] });
  assert.deepEqual(summary.outcomes, { completed: 1, released: 1 });
  const released = (await Promise.all(ids.map(job))).find((j) => j.status === "queued");
  assert.equal(released.attempts, 0);
  assert.ok(new Date(released.run_at) > new Date(Date.now() + 20_000), "after BUSY_RELEASE_SECONDS");
  await readyJobs();
  reset([submit()]);
  assert.equal((await runWorker({ maintenance: [] })).outcomes.completed, 1);
  assert.deepEqual([(await assignment(first.id)).state, (await assignment(second.id)).state], ["needs_review", "needs_review"]);
});

test("handler: skipped while still queued retries with backoff, and the last attempt fails the assignment visibly", { skip }, async () => {
  await quiesce();
  const a = await delegate();
  const jobId = await queue.enqueue({ kind: "assignment.run", idempotencyKey: server.assignmentRunKey(a),
    payload: { assignmentId: a.id, revision: a.revision }, maxAttempts: 2 }).then((r) => r.jobId);
  const skipped = server.assignmentRunHandler(admin, async () => ({ outcome: "skipped" }));
  const once = () => worker.runWorker({ queue, handlers: [skipped], workerId: "w", deadlineAt: Date.now() + 270_000, log: () => undefined });
  assert.deepEqual((await once()).outcomes, { retrying: 1 });
  assert.equal((await job(jobId)).last_error_code, "executor_skipped");
  assert.equal((await assignment(a.id)).state, "queued");
  await readyJobs();
  assert.deepEqual((await once()).outcomes, { dead: 1 });
  assert.deepEqual(await assignment(a.id), { state: "failed", error_code: "executor_unavailable", revision: 2 });
  // Malformed payloads are dead at once; a busy run is released.
  const bad = await queue.enqueue({ kind: "assignment.run", idempotencyKey: "assignment:bad", payload: { assignmentId: "x" } });
  assert.deepEqual((await once()).outcomes, { dead: 1 });
  assert.equal((await job(bad.jobId)).last_error_code, "invalid_payload");
  const b = await delegate();
  const bJob = await server.enqueueAssignmentRun(b);
  const busy = server.assignmentRunHandler(admin, async () => ({ outcome: "busy" }));
  assert.deepEqual((await worker.runWorker({ queue, handlers: [busy], workerId: "w", deadlineAt: Date.now() + 270_000,
    log: () => undefined })).outcomes, { released: 1 });
  assert.equal((await job(bJob)).attempts, 0);
  // The worker doesn't start an assignment run without the executor's full budget.
  await readyJobs();
  assert.equal((await worker.runWorker({ queue, handlers: [busy], workerId: "w", deadlineAt: Date.now() + 200_000,
    log: () => undefined })).stopped, "deadline");
  await queue.cancel({ jobId: bJob });
});

test("reconciliation: lost enqueues get a job after the grace period; work whose job ended fails visibly", { skip }, async () => {
  await quiesce();
  // Earlier tests leave nothing else queued for built-in execution.
  await q("update public.workspaces set agent_enabled = false where id in (select workspace_id from public.assignments where state = 'queued')");
  await as(db, "service_role", null, "select public.reap_assignment_leases() r");
  const lost = await delegate();
  const deadJob = await delegate();
  const finished = await delegate();
  const fresh = await delegate();
  // Age them past the grace period (the guard trigger is bypassed for this fixture only).
  await db.exec("set session_replication_role = replica");
  await q("update public.assignments set state_changed_at = now() - interval '5 minutes' where id = any($1)",
    [[lost.id, deadJob.id, finished.id]]);
  await db.exec("set session_replication_role = origin");
  for (const [a, status] of [[deadJob, "dead"], [finished, "completed"]]) {
    const id = await server.enqueueAssignmentRun(a);
    await q("update public.jobs set status = $2, finished_at = now() where id = $1", [id, status]);
  }
  const counts = await server.reconcileAssignmentJobs(admin, queue);
  assert.deepEqual(counts, { checked: 3, enqueued: 1, failed: 2 });
  assert.equal((await jobFor(lost)).status, "queued");
  assert.equal(await jobFor(fresh), undefined, "within the grace period the route's own enqueue is trusted");
  for (const a of [deadJob, finished])
    assert.deepEqual(await assignment(a.id), { state: "failed", error_code: "executor_unavailable", revision: 2 });
  // Repeating is a no-op; the worker then runs the reconciled one.
  assert.deepEqual(await server.reconcileAssignmentJobs(admin, queue), { checked: 1, enqueued: 0, failed: 0 });
  reset([submit()]);
  const summary = await runWorker();
  assert.equal(summary.outcomes.completed, 1);
  assert.equal((await assignment(lost.id)).state, "needs_review");
  assert.equal((await assignment(fresh.id)).state, "queued", "fresh has no job yet (its route would have enqueued one)");
  await userRpc("select public.transition_assignment($1, 1, 'canceled', null) r", [fresh.id]);
});

test("fast path: kickoff runs the enqueued job at once; without a job it runs the assignment directly", { skip }, async () => {
  await quiesce();
  const a = await delegate();
  const jobId = await server.enqueueAssignmentRun(a);
  reset([submit()]);
  assert.equal(await server.kickoffAssignmentRun(a, jobId, { deadlineAt: Date.now() + 270_000 }), "completed");
  assert.equal((await assignment(a.id)).state, "needs_review");
  assert.equal((await job(jobId)).status, "completed");
  const b = await delegate();
  reset([submit()]);
  assert.equal(await server.kickoffAssignmentRun(b, null, { deadlineAt: Date.now() + 270_000 }), "submitted");
  assert.equal((await assignment(b.id)).state, "needs_review");
  assert.equal(await server.kickoffAssignmentRun(b, null, { deadlineAt: Date.now() + 270_000, admin: null }), "not_configured");
  // Purge runs from the maintenance list in one minute of the hour only.
  const at = (minute) => jobs.jobMaintenance(admin, queue, new Date(Date.UTC(2026, 9, 20, 12, minute))).map((t) => t.name);
  assert.deepEqual(at(jobs.PURGE_MINUTE), ["assignment_leases", "assignment_jobs", "purge"]);
  assert.deepEqual(at(0), ["assignment_leases", "assignment_jobs"]);
  // The suite's maintenance clock never lands in the purge minute.
  const inPurgeMinute = Date.UTC(2026, 9, 20, 12, jobs.PURGE_MINUTE, 30, 500);
  assert.equal(maintenanceAt(inPurgeMinute).toISOString(), `2026-10-20T12:${String(jobs.PURGE_MINUTE - 1).padStart(2, "0")}:59.000Z`);
  assert.equal(maintenanceAt(Date.UTC(2026, 9, 20, 12, 5)).getTime(), Date.UTC(2026, 9, 20, 12, 5));
});
