# 006 — Durable jobs on Postgres, behind a runtime port

- **Status:** Accepted — decided by Tony, 2026-10-15
- **Date:** 2026-10-15
- **Ticket:** A-04 (durable worker/queue adapter, claim leases and persisted steps); unblocks D-04, A-06, I-05
- **Deciders:** Tony (Solutions Architect)
- **Related:** ADR 005 (runtime boundary: tiers, §2 semantics, §3 port, §4 criteria; resolves its open questions 1–3), ADR 003 (assignment leases, reaper, A-02 notes), `docs/api/assignments.md` ("Built-in executor"), `docs/runtime/migrating-durable-jobs.md`, plan Wave 3

## Context

Before A-04, the built-in preparation executor (A-02) ran in ADR 005's tier 2: `after()` in the route that queued the assignment (`app/api/assignments/**`, `maxDuration = 300`), plus two recovery paths for lost kickoffs. The client's `POST /api/assignments/kickoff` and every hourly scheduler tick (`app/api/scheduler/tick/[slot]`, 24 daily crons in `vercel.json`) started up to five assignments that had been `queued` for over 60 s (`recoverQueuedAssignments`). Expired assignment leases were reaped on reads (`reap_own_assignment_leases`) and once a day from tick slot 04 (`reap_assignment_leases`). This works, but a lost kickoff could wait up to an hour for the next tick. There were no retries with backoff, no idempotency keys, and nothing for D-04 (reminders at a time), A-06 (external-executor lease expiry) or I-05 (outbound effects that must not repeat) to build on.

ADR 005 left three questions open that block A-04: the Vercel plan's limits, whether Waltz Azure standards apply, and the runtime vendor.

Data handling: Orbit holds no PHI (decided by Tony, 2026-10-13). The rules still apply: job payloads, error codes and logs carry ids, kinds, counts and normalized codes only. They never carry note bodies, requested outcomes, model output, secrets or lease tokens (ADR 005 §5).

## Decision

### 1. Tony's decisions (2026-10-15)

1. **The production Vercel plan is Pro.** Per-minute cron schedules and functions longer than the tick's 300 s are available. Exact limits (cron count, maximum duration with or without Fluid compute) are checked against the project dashboard at deploy time (§6).
2. **The durable runtime is Postgres-backed (Supabase), with no new vendor.** Orbit's own `jobs` table, `FOR UPDATE SKIP LOCKED` claims and leases, driven by a Vercel cron worker. No pgmq or pg_cron dependency, so it runs wherever the migrations run, including PGlite in tests.
3. **Document how to migrate later** to Vercel Queues/Workflow, Inngest, Trigger.dev and Azure Service Bus: `docs/runtime/migrating-durable-jobs.md`. **Waltz Azure standards (Service Bus, Key Vault) do not apply to Orbit**; Service Bus is documented as one option among the others, not a requirement.

### 2. Semantics

ADR 005 §2 applies unchanged. Delivery is **at least once**, and effects are idempotent or reconciled; there is no exactly-once promise. Postgres is the source of truth both for business state and for the queue itself. Payloads hold ids only. Every write made for a delivery is fenced by its lease token.

### 3. Schema: `supabase/migrations/20261020000000_durable_jobs.sql` (additive only)

**`jobs`**

| Column | Notes |
| --- | --- |
| `id uuid` | primary key |
| `kind text` | dotted identifier (`assignment.run`), ≤ 64 characters |
| `payload jsonb` | flat object of at most 16 scalars, strings ≤ 100 characters, ≤ 2 KB. Ids only, enforced by `enqueue_job` |
| `idempotency_key text` | unique per kind (`jobs_kind_idempotency_key_key`) |
| `status text` | `queued`, `running`, `completed`, `dead`, `canceled` |
| `run_at timestamptz` | not delivered before this time (delay, backoff, release) |
| `attempts`, `max_attempts smallint` | deliveries so far (claims minus releases); 1–25, default 5 |
| `backoff_base_seconds`, `backoff_max_seconds int` | defaults 15 and 900 |
| `leased_by text`, `lease_token uuid`, `lease_expires_at timestamptz` | set exactly while `running` (check constraint) |
| `last_error_code text` | normalized identifier (`^[a-z][a-z0-9_]{0,39}$`), never a message |
| `created_at`, `updated_at`, `started_at`, `finished_at` | `finished_at` set exactly in final states |

Indexes: ready work (`run_at, created_at where status = 'queued'`), leases (`lease_expires_at where status = 'running'`), and retention (`finished_at`).

**`job_steps`** holds the persisted steps of multi-step jobs: `(job_id, name)` primary key, `status` (`started` means intent recorded before an external effect, `succeeded` means the result was recorded after it), an ids-only `result`, the `attempt` that wrote it, and timestamps. Rows cascade with their job. A retry that finds `started` must reconcile the effect with the provider before repeating it (ADR 005 §2, plan I-05). `assignment.run` doesn't need steps; they exist for D-04 and I-05.

**Functions.** All are `security definer`, `search_path = ''`, and **executable by `service_role` only** (revoked from `public`, `anon`, `authenticated`):

| Function | Behavior |
| --- | --- |
| `enqueue_job(kind, key, payload, run_at?, max_attempts?, backoff_base?, backoff_max?)` | `insert … on conflict (kind, idempotency_key) do nothing`. Returns `created` or `exists` with `{ jobId, jobStatus, runAt }` (the existing job is returned unchanged, whatever its status), or `invalid_payload` |
| `claim_jobs(worker, lease_seconds 15–900, batch_size 1–25, kinds?, job_id?)` | `FOR UPDATE SKIP LOCKED` over ready jobs, oldest `run_at` first. Sets `running`, `attempts + 1` and a fresh `lease_token`. Returns `[{ id, kind, payload, attempt, maxAttempts, leaseToken, leaseExpiresAt, steps }]` |
| `heartbeat_job(id, token, lease_seconds?)` | Extends a live lease. `lease_lost` after expiry, cancel or re-delivery |
| `complete_job(id, token)` | → `completed` (or `lease_lost`) |
| `fail_job(id, token, code, retryable = true)` | Retryable with attempts left → `queued` at `now() + backoff`; otherwise `dead`. Backoff is `min(max, base · 2^(attempts−1))` with equal jitter (between half and all of it) |
| `release_job(id, token, delay_seconds 0–3600)` | Back to `queued` without using an attempt (busy, near the deadline) |
| `cancel_job(job_id? \| kind + key)` | Queued or running → `canceled`; a running delivery loses its lease at once. Results: `canceled`, `already_finished`, `not_found` |
| `reap_jobs()` | Expired leases (up to 500, `SKIP LOCKED`) → `queued` with backoff and `last_error_code = 'lease_expired'`, or `dead` at max attempts. Returns `{ requeued, dead }` |
| `save_job_step(id, token, name, status, result?)` | Upsert of a step, fenced by the lease |
| `purge_jobs()` | Deletes `completed`/`canceled` jobs after 7 days and `dead` jobs after 30 (up to 1000 per call) |

The internal helpers `job_lease`, `job_payload_valid` and `job_backoff_seconds` are revoked from every role.

**Access.** RLS is on for both tables, with no policies. `anon` and `authenticated` have no table privileges. `service_role` has `select` (for reconciliation and operations) and writes only through the functions. Owners can't read their own jobs: jobs carry no user-facing state, because the owning record (the assignment) is what the UI shows (ADR 005 §6), so there's nothing to show and nothing to leak.

**Compatibility.** The migration creates new objects only. `supabase/tests/durable-jobs-compat.test.mjs` proves this before and after on PGlite. The catalog check shows that every pre-existing function, trigger, policy, table, column, grant, constraint, index and type is byte-for-byte identical. The behavior check shows that the assignment and note paths give the same results, rows and events. It is applied to production **before** this code merges; old code never calls it.

### 4. The port: `lib/runtime/`

| File | Role |
| --- | --- |
| `types.ts` | The `JobQueue` interface and job, lease, handler and result types |
| `postgres.ts` | `postgresJobQueue(admin)`: one RPC per operation, fixed error messages (server-only) |
| `memory.ts` | In-memory `JobQueue` with an injectable clock and random source, for unit tests |
| `worker.ts` | `runWorker`, `runJob`, `runJobNow`, `createRegistry` (runtime-agnostic) |
| `jobs.ts` | The application's registry (`jobHandlers`) and worker maintenance (`jobMaintenance`) (server-only) |

```ts
interface JobQueue {
  enqueue(job: { kind; payload /* ids only */; idempotencyKey; runAt?; maxAttempts?; backoff? }): Promise<{ jobId; created; status }>;
  claim(o: { workerId; leaseSeconds; batchSize; kinds?; jobId? }): Promise<ClaimedJob[]>;
  heartbeat(lease, leaseSeconds?): Promise<"ok" | "lease_lost">;
  complete(lease): Promise<"completed" | "lease_lost">;
  fail(lease, code, { retryable? }): Promise<{ status: "retrying"; runAt } | { status: "dead" } | { status: "lease_lost" }>;
  release(lease, delaySeconds?): Promise<"released" | "lease_lost">;
  cancel({ jobId } | { kind, idempotencyKey }): Promise<…>;
  reap(): Promise<{ requeued; dead }>;
  saveStep(lease, name, { status, result }): Promise<"saved" | "lease_lost">;
  purge(): Promise<number>;
}
type JobHandler = { kind; minRunMs; run(ctx: { job; signal; deadlineAt; now; saveStep }): Promise<JobResult> };
type JobResult = { type: "complete" } | { type: "fail"; code; retryable? } | { type: "release"; delaySeconds? };
```

Application code imports only these types, `enqueue…` helpers and the worker. A vendor swap means implementing `JobQueue` (or, for push-based vendors, calling `runJob`'s handler contract from the vendor's callback) in one new adapter file (migration guide). This refines ADR 005 §3's sketch: the job lease lives in the port, next to the record-level lease (`claim_assignment`), which stays in Postgres for every vendor.

### 5. The worker: `GET /api/jobs/worker`

- **Auth:** `Authorization: Bearer $CRON_SECRET`, the same as the scheduler tick (401 otherwise, 503 without the service-role client).
- **Schedule:** `* * * * *` in `vercel.json`, added next to the 24 tick crons, which are **unchanged** (25 crons in total). Consolidating the ticks into the worker would mean moving the debrief loop into jobs (ADR 005: optional, triggered by measured duration), so it isn't "clearly safe" yet.
- **Limits:** `maxDuration = 300` (`WORKER_MAX_DURATION`). That is within Pro's limit with or without Fluid compute and equal to the existing routes'. Raising it to Pro's Fluid maximum is a one-line change once verified, but isn't needed: work is claimed per minute and invocations may overlap. The loop's deadline is start + 300 s − 30 s (`WORKER_DEADLINE_MARGIN_MS`).
- **Loop** (`runWorker`):
  1. `reap()`.
  2. Maintenance: `reap_assignment_leases`, `reconcileAssignmentJobs`, and `purge()` in minute 17 of each hour. Each task is counted, never thrown.
  3. Loop while time remains: claim up to 5 jobs (`WORKER_BATCH_SIZE`) of the kinds whose `minRunMs` fits in the remaining time, run them in parallel, apply each result. It stops on an empty queue, at the deadline, after 20 rounds, or on a claim error.
- **Per delivery** (`runJob`): a 60 s job lease with a heartbeat every 20 s. On `lease_lost` the handler's `AbortSignal` fires and its result is dropped. A thrown handler is a retryable `handler_error`. A kind not in the registry is dead with `unknown_kind`. A delivery with less than `minRunMs` left is released without using an attempt.
- **Response and logs:** counts only (`{ reaped, maintenance, claimed, rounds, outcomes, stopped }`). Each delivery logs `{ jobId, kind, attempt, outcome, code? }`.
- **Overlap:** safe by construction (SKIP LOCKED, leases, the assignment's own claim).

### 6. Built-in assignment execution on the queue

- **Enqueue (tier 1, in-request).** Creating, retrying, answering or requesting changes on a built-in assignment that ends `queued` enqueues `assignment.run` with payload `{ assignmentId, revision }` and idempotency key **`assignment:<id>:<revision>`**, before the route answers (`enqueueAssignmentRun`). Each queue cycle bumps the revision, so it gets its own job, and repeats of the same cycle collapse into one. The kickoff ping (`POST /api/assignments/kickoff`) enqueues the oldest queued assignment idempotently too.
- **Fast path.** `after()` then calls `kickoffAssignmentRun`, which claims *that* job (`claim_jobs(..., job_id)`) and runs it in-process, so latency is unchanged. If the worker already holds it or it's waiting for a retry, the fast path is a no-op. If the enqueue failed, the fast path runs the assignment directly, as before A-04, and reconciliation enqueues a job later that finds nothing to do.
- **Handler** (`assignmentRunHandler`, `minRunMs` = the executor's 240 s budget) calls the existing `runQueuedAssignment`. Assignment-level fencing (`claim_assignment` and its lease) is unchanged. Outcomes map to job results:

  | Outcome | Job result |
  | --- | --- |
  | `submitted`, `asked`, `failed`, `unavailable`, `lease_lost` | complete |
  | `busy` (another assignment is running in the workspace) | release for 30 s, without using an attempt |
  | `skipped`, assignment no longer queued at this revision | complete |
  | `skipped`, still queued, too little time left | release |
  | `skipped`, still queued, attempts left | `fail('executor_skipped')`: retry with backoff (15 s base, 300 s cap, 5 attempts) |
  | `skipped`, still queued, last attempt | `fail_assignment_system(executor_unavailable)`, then dead (ADR 005 §6: never queued forever) |
  | malformed payload | dead with `invalid_payload` |
- **Duplicate delivery** never duplicates model calls or artifacts. A second delivery (lease expiry, a crash before `complete_job`, the fast path racing the worker) finds the assignment no longer `queued`, so `executeAssignment` returns `skipped` before any model call, and the job completes.
- **Reconciliation** (`reconcileAssignmentJobs`, every worker run) checks the oldest 50 built-in assignments queued for over 60 s and enqueues their run (a no-op when it exists). It fails with `executor_unavailable` any assignment whose job for the current revision has ended (dead, completed or canceled) while the assignment still waits, after re-reading it. This also covers assignments that were queued before deploy.
- **Restart mid-attempt.** The job is re-delivered and completes as a no-op. The running attempt's 90 s assignment lease expires and the assignment reaper (now every minute) fails it with `timed_out` (T6). **T7 (automatic re-queue of the assignment) stays off**: `assignments.max_attempts` is still 1, and changing the reaper would change existing functions, which this additive migration doesn't. Enabling T7 is a follow-up migration.
- **Cancellation** stays a Postgres state change (ADR 005 §2). Canceling an assignment revokes its lease, so the executor's next heartbeat or write gets `lease_lost`, it stops, and the job completes. A queued job for a canceled assignment completes without a model call. `cancel_job` revokes the job lease and aborts the handler's signal. For `assignment.run`, the executor stops only on the assignment's own lease, so cancel the assignment, not the job. The cancel route doesn't cancel the job.
- **Tick route.** The per-tick `recoverQueuedAssignments` sweep is **removed**: it is redundant with the queue, the per-minute worker and reconciliation. `recoverQueuedAssignments` and `RECOVERY_BATCH` are deleted. The daily `reap_assignment_leases` in slot 04 is **removed** too: the worker runs it every minute. Reads still reap their own rows. The daily agent-action purge (slot 03) and the debriefs are unchanged.

## Consequences

- A lost kickoff now recovers within about a minute (the next worker run) instead of up to an hour. A timed-out attempt shows as failed within about a minute even if nobody reads it.
- D-04 (reminders: `run_at`, key `reminder:<id>:<fire_at>`), A-06 (lease expiry) and I-05 (steps with intent and result) build on this without new infrastructure.
- **Cost:** one function invocation per minute (about 43 200 a month), most finishing in well under a second on an empty queue. Each run makes a few small queries: the job reap, the assignment reap and one reconciliation select.
- **Operations:** inspect `public.jobs` with the service role: `status`, `attempts`, `last_error_code`, `run_at`. Dead jobs are kept 30 days.
- **Rollback:** reverting the code leaves the tables unused and harmless. Dropping them is a separate migration (nothing references them).
- **Tests:**
  - `lib/runtime/worker.test.mjs`: fake clock. Restart, expired lease, duplicate delivery, retry and backoff, dead, release, cancel, deadline stop, steps, logs.
  - `supabase/tests/durable-jobs.test.mjs`: PGlite. The SQL functions, grants and RLS, two concurrent claims, and the worker over Postgres.
  - `supabase/tests/durable-jobs-assignments.test.mjs`: end to end with the executor. One model call per cycle, duplicate delivery, restart mid-attempt, cancellation, busy, last attempt, reconciliation and the fast path.
  - `supabase/tests/durable-jobs-compat.test.mjs`: compatibility before and after.
  - `app/api/jobs/worker/route.test.mjs`: the worker route.
  - The updated route tests.
- **Unverified until deployed:** real Vercel cron cadence and overlap, the Pro duration limit, and the cron count limit.

## Alternatives considered

- **Supabase Queues (pgmq) and pg_cron.** Visibility timeouts instead of fenced leases, no per-kind idempotency key, extensions that PGlite tests can't load, and a second scheduler next to Vercel cron. Rejected for now; the port allows it later.
- **A vendor now** (Vercel Queues/Workflow, Inngest, Trigger.dev, Azure Service Bus). Tony chose no new vendor. Each one is mapped in the migration guide.
- **Keep tier 2 (`after()` plus the hourly sweep).** Recovery takes up to an hour, there are no retries, and nothing for D-04 or I-05. Rejected.
- **Consolidate the 24 tick crons into the worker.** It would move debriefs onto a per-minute schedule without the per-task fan-out ADR 005 calls for. Deferred.
- **Owner-readable jobs (RLS select for the owner).** There's no UI need, and it would mean a `user_id` column and a policy to keep correct. Rejected.

## Open questions

1. **Enable T7** (automatic re-queue of an assignment after lease expiry, `max_attempts > 1`)? *Decider: Tony. Needs a follow-up migration that changes `assignment_reap`.*
2. **Raise the worker's `maxDuration`** above 300 s once Pro's Fluid compute limit is verified? *Owner: Lead. Not blocking.*
