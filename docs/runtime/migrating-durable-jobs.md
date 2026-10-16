# Migrating durable jobs off Postgres

Orbit's durable jobs run on Postgres today (ADR 006): the `jobs` table, service-role functions, and a Vercel cron worker (`/api/jobs/worker`). This guide explains how to move them to another runtime later. It covers Vercel Queues/Workflow, Inngest, Trigger.dev and Azure Service Bus, and the job port stays the same. No move is planned. Vendor capabilities and limits below are as generally documented and **must be re-checked against current vendor docs at cutover time**.

Waltz Azure standards don't apply to Orbit (decided by Tony, 2026-10-15). Service Bus is listed as an option, not a requirement.

## What stays the same in every runtime

- **Postgres is the source of truth for business state.** Assignments, their attempts and leases (`claim_assignment`, `heartbeat_assignment`, the `lease_lost` fencing), reminders and outbound actions stay in Orbit's tables. A runtime only delivers work and wakes workers (ADR 005 §2).
- **Handlers don't change.** A `JobHandler` (`lib/runtime/types.ts`) gets `{ job, signal, deadlineAt, now, saveStep }` and returns `complete`, `fail` or `release`. A vendor adapter calls the same handler from the vendor's callback or consumer.
- **Payloads are ids only.** For example, `{ assignmentId, revision }`. Vendors never see note bodies, requested outcomes, model output, secrets or lease tokens.
- **Idempotency keys keep their format.** For example, `assignment:<id>:<revision>`, `reminder:<id>:<fire_at>`, `outbound:<action_id>`.
- **Reconciliation keeps running.** `reconcileAssignmentJobs` re-enqueues from Postgres, so a vendor that loses a message loses no work.

## Operation mapping

| Port operation | Postgres (today) | Vercel Queues / Workflow | Inngest | Trigger.dev | Azure Service Bus |
| --- | --- | --- | --- | --- | --- |
| `enqueue(job)` | `enqueue_job` insert | Queues: publish a message to a topic. Workflow: start a workflow run | `inngest.send({ name: kind, data: payload, id })` | `tasks.trigger(kind, payload, { idempotencyKey })` | `sender.sendMessages({ body: payload, messageId: key, subject: kind })` |
| Idempotency per (kind, key) | Unique `(kind, idempotency_key)`, forever (until purge) | Check current support for a deduplication or idempotency key. If there's none or the window is short, keep a Postgres `jobs` row as the dedupe record | Event `id` dedupes within a window (about 24 h); function-level `idempotency` expression | `idempotencyKey` (with a TTL option) | Duplicate detection on `MessageId`, window up to 7 days (must be enabled on the queue) |
| `runAt` (delay) | `run_at` | Delayed delivery if supported. Workflow: `sleep` before the first step | `ts` on the event, or `step.sleepUntil` | `delay` / `delayUntil` option | `scheduledEnqueueTimeUtc` (scheduled messages) |
| `claim` + lease | `FOR UPDATE SKIP LOCKED` + `lease_token` | The platform invokes the consumer function. The visibility timeout is the lease | Push: Inngest calls `/api/inngest`; no claim | Push: the task runs on Trigger.dev's workers (or self-hosted) | `receiveMessages` in PeekLock mode; lock duration (up to 5 min) is the lease |
| `heartbeat` | `heartbeat_job` | Extend visibility, if supported. Otherwise keep each step short | Not needed: each `step.run` is its own request; keep steps under the function timeout | Not needed for duration (long runs supported); checkpoint with `wait`/subtasks | `renewMessageLock` (or the SDK's auto-lock renewal) |
| `complete` | `complete_job` | Acknowledge (return 2xx / ack) | Function returns | Task returns | `completeMessage` |
| `fail` (retry with backoff) | `fail_job`: exponential backoff with equal jitter | Platform retry policy (check whether it supports backoff); or nack and re-publish with a delay | Built-in retries (`retries: n`, exponential backoff); `RetryAfterError` for a specific delay; `NonRetriableError` → failed | `retry: { maxAttempts, factor, minTimeoutInMs, maxTimeoutInMs, randomize }`; `AbortTaskRunError` → no retry | `abandonMessage` redelivers **immediately** (no backoff). For backoff: complete, then re-send as a scheduled message with `attempt + 1` |
| `release` (no attempt used) | `release_job` | Re-publish with a delay | `step.sleep` then retry within the function, or send a new event | `wait.for` inside the run, or re-trigger with a delay | Complete, then re-send scheduled (keep the attempt count in an application property) |
| Max attempts → dead | `status = 'dead'` + `last_error_code` | Platform dead-letter or failed state, if any; mirror it into Postgres | Failed run + `onFailure` handler | Failed run (dashboard), `onFailure` hook | `MaxDeliveryCount` → dead-letter subqueue (`$DeadLetterQueue`) |
| `cancel` | `cancel_job` (revokes the lease) | Mark the Postgres record canceled; the consumer no-ops. Workflow: cancel the run if supported | `cancelOn` event match, or the REST API to cancel a run | `runs.cancel(runId)` | Scheduled: `cancelScheduledMessages(sequenceNumber)`. In flight: none, so the consumer checks Postgres state |
| `reap` | `reap_jobs` | Not needed (visibility timeout redelivers) | Not needed | Not needed | Not needed (lock expiry redelivers; counts toward `MaxDeliveryCount`) |
| `saveStep` | `job_steps` | Workflow: each `step` is persisted. Queues: keep `job_steps` in Postgres | `step.run` results are memoized | Subtasks / `idempotencyKey` per child; or keep `job_steps` | Keep `job_steps` in Postgres |
| Cron (the worker) | Vercel cron every minute → `/api/jobs/worker` | Vercel cron still drives reconciliation; delivery is push | Inngest cron triggers (`{ cron: "* * * * *" }`) | `schedules.task({ cron })` | No native cron: keep Vercel cron (or an Azure Functions timer trigger) for reconciliation and maintenance |
| Concurrency (one run per workspace) | `claim_assignment` returns `executor_busy` → release | Same (`executor_busy` → delay) | `concurrency: { key: "event.data.workspaceId", limit: 1 }` | Queue `concurrencyKey` | Sessions (`sessionId = workspaceId`) give ordered, one-at-a-time delivery per session |

**Lease versus visibility timeout.** A Postgres lease is *fenced*: a delivery whose lease expired can't complete or write a step. A visibility timeout or a lock only hides the message, and a slow consumer can still finish after redelivery. That's why fencing that matters stays on the record (`claim_assignment` / `lease_lost`) and is never left to the queue. Every runtime above is at-least-once. A handler must stay idempotent, and `assignment.run` already is.

## Writing an adapter

1. **Pull-based runtimes** (Service Bus receiver, Queues consumer, anything with receive/ack): implement `JobQueue` in `lib/runtime/<vendor>.ts`. The worker loop (`runWorker`) is unchanged; `claim` maps to receive, `heartbeat` to renewing the lock, `complete` to ack.
2. **Push-based runtimes** (Inngest, Trigger.dev, Workflow): implement `enqueue` (and `cancel`) in the adapter. Write a vendor entry point (`app/api/inngest/route.ts`, a Trigger.dev task file) that builds a `ClaimedJob`-shaped context and calls the registered handler (`lib/runtime/jobs.ts`). Map `JobResult` to the vendor's controls (`fail` + `retryable: false` → non-retriable error, `release` → sleep/delay). `claim`, `reap` and `purge` become no-ops; keep Postgres reconciliation as a cron.
3. Keep every SDK call inside the adapter file (the provider-adapter rule). Application code keeps importing `enqueueAssignmentRun`, handlers and types only.
4. Normalize vendor errors to codes before logging or storing; never log message bodies.

## Cutover plan

1. **Prepare.** Add the adapter behind a server config switch, for example `JOBS_RUNTIME=postgres|<vendor>|dual`, read in a typed config module. Default `postgres`. Add vendor secrets to the platform secret store. Deploy with the switch on `postgres`.
2. **Dual-write.** Set `dual`: `enqueue` writes the Postgres job **and** sends to the vendor, using the same idempotency key. The vendor's consumer runs in **shadow** mode: it calls handlers with a no-op wrapper that only records delivery latency, attempts and failures. Assignment fencing makes a real double run safe anyway, but shadow mode avoids double model cost. Compare delivery counts and latencies for at least a week.
3. **Switch new work.** Make the vendor authoritative for new jobs: its consumer runs handlers for real; Postgres rows are written as `canceled` with code `migrated` (kept for dedupe) or skipped. Keep the Postgres worker running to finish jobs already queued.
4. **Drain.** Wait until `select count(*) from jobs where status in ('queued', 'running')` is 0, including jobs waiting for backoff (up to `backoff_max_seconds`) and future `run_at` reminders. For reminders with far-future `run_at`, re-enqueue them on the vendor with their original key and `runAt`, then cancel the Postgres rows.
5. **Retire.** Remove the cron's claim loop (keep reconciliation and the assignment reaper on cron), then remove the Postgres adapter's use. Keep the tables for the retention window; drop them in a later migration if desired.
6. **Rollback** at any step: flip the switch back to `postgres`. Reconciliation re-enqueues any queued assignment whose job is missing, so a lost vendor message costs at most one reconciliation interval.

## What to watch

- **Cost.** Per-run or per-step pricing (Inngest, Trigger.dev), per-message and per-operation pricing (Service Bus, Vercel Queues), plus compute time for long model calls (Trigger.dev bills machine time; Vercel bills function duration either way). Today's baseline is about 43 200 cron invocations a month plus the work itself.
- **Limits.**
  - Function duration: Vercel Pro, 300 s today, more with Fluid compute.
  - Step and run duration: vendor step limits; each `assignment.run` attempt needs up to 240 s.
  - Payload size: ours are under 2 KB.
  - Delay maximums: reminders may need delays of days. Check each vendor's maximum delay and schedule horizon.
  - Retention of failed runs and dead letters.
  - Cron count and granularity.
- **Ordering.** None of these guarantees global FIFO. Service Bus sessions and concurrency keys give per-key serialization. Orbit relies on `claim_assignment`'s per-workspace check, not on queue order.
- **Idempotency windows.** Postgres dedupes for the job's lifetime (7–30 days). Inngest's event id window (about 24 h) and Service Bus's duplicate-detection window are shorter. Keep the Postgres row as the dedupe record if a key can repeat after the window.
- **Data handling.** Vendors store payloads and logs. Ids only, but confirm the region and log retention (ADR 005 §4 criteria 4–5).
- **Local development and tests.** The Inngest dev server and the Trigger.dev CLI run locally. Service Bus needs an emulator or a namespace. Keep `lib/runtime/memory.ts` and the handler tests runtime-agnostic.
