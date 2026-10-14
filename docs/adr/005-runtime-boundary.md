# 005 — Runtime boundary: in-request, bounded background, and durable execution

- **Status:** Proposed — awaiting Tony's approval
- **Date:** 2026-10-13
- **Ticket:** O-01 (the "runtime ADR" that gates A-04; affects A-02, D-04, I-05)
- **Deciders:** Tony (Solutions Architect)
- **Related:** ADR 003 (attempts/leases), ADR 004 (re-check grants per step); plan Wave 3 "Runtime choice is open"

## Context

All work runs inside Next.js route handlers on Vercel functions today:

| Work | Where | Limits and behavior |
| --- | --- | --- |
| Note CRUD, workspace settings, v1 API | `app/api/notes/*`, `app/api/workspaces/*`, `app/api/v1/*` | Short request/response |
| Slack capture | `app/api/slack/interact/route.ts` | Slack needs a 200 within 3 s; the ephemeral reply and auto-triage run in `after()`; `maxDuration = 120` |
| Email capture | `app/api/email/inbound/route.ts` | Resend retries on non-2xx; triage runs in `after()`; `maxDuration = 120` |
| Organizing agent run | `POST /api/agent/runs` → `after(() => executeRun(...))` | `maxDuration = 300`; up to 16 model calls at 60 s timeout each (`lib/agent/providers.ts`), which can exceed 300 s; a cut-off run stays `running` until `GET /api/agent/runs` marks it failed after `RUN_TIMEOUT_MS` (6 min) |
| Nightly debriefs | 24 hourly crons in `vercel.json` → `app/api/scheduler/tick/[slot]/route.ts` (`CRON_SECRET`) | `maxDuration = 300`; loops over **all** enabled tasks sequentially in one invocation; claims each run with the unique index `scheduled_task_runs_once_per_day`, so a failed scheduled run also blocks a retry that day |
| Manual debrief | `POST /api/scheduled-tasks/[id]/run` | Inline, up to 300 s |

Per the Next.js 16 docs bundled in `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`, `after()` runs only up to the route's `maxDuration`, using the platform's `waitUntil`. It gives no retry, persistence or recovery after process loss.

What's coming needs more than that: assignments that wait for answers and resume (ADR 003), leases and heartbeats for external executors (A-06), reminders and recurring instances with DST correctness (D-04), and outbound messages that must never be sent twice or lost silently (I-05).

## Decision

### 1. Three tiers

| Tier | Use for | Must not be used for | Mechanism |
| --- | --- | --- | --- |
| **1 · In-request** | Auth and grant checks; validation; item reads/writes with revisions (ADR 002); assignment creation, transitions, answers, reviews (ADR 003); capture ingest with dedupe; enqueueing work; webhook acknowledgement | Model calls, third-party fetches that can exceed a few seconds | Route handlers |
| **2 · Bounded background** | Work that (a) has **no external side effects**, (b) is designed to finish well within `maxDuration`, (c) persists its state before and after, and (d) can be safely marked failed and re-run by the user | Anything with an external side effect, anything that waits for a human, automatic retries | `after()` plus a persisted record with a lease and a reaper (on reads and on the scheduler tick) |
| **3 · Durable execution** | External side effects (I-05); resume after `needs_input`; automatic retries with backoff; reminders and recurring instances (D-04); connector syncs; external-executor leases (A-06); scheduled-report fan-out once one tick can't finish all tasks | — | Queue/worker adapter (§3), vendor open (§4) |

Placement of current and planned work:

| Work | Tier now | Tier target | Moves when |
| --- | --- | --- | --- |
| Slack/email capture ingest | 1 | 1 | — |
| Auto-triage after capture, organizing runs | 2 | 2 (3 if retries are wanted) | Optional |
| Built-in preparation executor (A-02) | 2 | 3 | A-04. Qualifies for tier 2 because it writes only Orbit artifacts, is fenced by its lease (ADR 003), and fails visibly. |
| Nightly debriefs | cron + inline | 3 fan-out (one job per task) | When tick duration approaches `maxDuration`, or retry-on-failure is wanted |
| Reminder dispatch, recurring tasks (D-04) | — | 3 | D-04 depends on A-04 |
| External executor claim/progress/submit (A-06) | — | 1 for calls; 3 for lease expiry and retries | A-06 |
| Outbound Slack/email/Teams (I-05) | — | 3, only | I-05 |

### 2. Semantics the durable tier must provide

- **At-least-once delivery with idempotent or reconciled effects.** No exactly-once promise. Every job has an idempotency key (for example `assignment:<id>:attempt:<n>`, `reminder:<id>:<fire_at>`, `outbound:<action_id>`).
- **Postgres is the source of truth.** Assignment state, attempts, leases and outbound-action state live in Orbit's tables (ADR 003). The runtime only *delivers work* and *wakes workers*. Losing the vendor's state loses no business state; a reconciliation sweep can re-enqueue from Postgres.
- **Leased claims and fencing.** A worker acts only while holding a valid `lease_token`; every write checks it (ADR 003 `lease_lost`). Heartbeats extend leases; expiry hands the work to retry or failure.
- **Persisted steps.** Multi-step jobs record completed steps so a retry resumes rather than repeats. Steps with external effects record "intent" before the call and "result" after; an ambiguous outcome (timeout after send) is **reconciled** with the provider before any retry (plan I-05).
- **Cancellation** is a state change in Postgres checked at each step, plus lease revocation; workers never rely on the queue to stop them.
- **Retries** with capped exponential backoff and a maximum attempt count stored with the work (`assignments.max_attempts`). Poison jobs end in `failed` with a normalized code, never in a silent dead-letter.
- **Recovery after process loss** is the default path: an expired lease is detected by the reaper and handled per the transition table.
- **Grant re-checks per step** (ADR 004) and **no PHI in job payloads** (§5).

### 3. Adapter boundary (A-04)

Application code depends only on a small port in `lib/runtime/` (server-only), never on a vendor SDK outside the adapter file, following the repository's provider-adapter rule:

```ts
interface JobQueue {
  enqueue(job: { type: JobType; ref: string; idempotencyKey: string; runAt?: Date }): Promise<void>;
  // Workers are invoked by the adapter (HTTP callback, poller or consumer) with { type, ref, deliveryId }.
}
interface Lease {
  claim(ref: string, seconds: number): Promise<{ attemptId: string; leaseToken: string } | null>;
  heartbeat(attemptId: string, leaseToken: string): Promise<boolean>;
}
```

`ref` is an Orbit id (assignment, reminder, outbound action), never content. `Lease` is implemented on Postgres functions (ADR 003 `claim_assignment`, `heartbeat_assignment`) for every vendor. The first adapter can be a Postgres-backed poller driven by the existing Vercel cron; that is an implementation detail of A-04, not a vendor choice.

### 4. Vendor choice: open, with criteria

No workflow vendor is introduced as an incidental dependency. The choice is made in a follow-up ADR before A-04, scored against:

1. **Hosting fit.** Works with Vercel functions and the actual plan limits (`maxDuration`, cron frequency, concurrency), which must be verified; workers can run where Supabase is reachable.
2. **Delivery model.** At-least-once with visible retries, delay/scheduled delivery (reminders at `fire_at`), and cancellation or safe no-op on canceled work.
3. **Long-running and waiting work.** Supports steps beyond one function's duration and resume-after-human-input without holding a process.
4. **Data handling (HIPAA).** Payloads carry ids only. If any vendor would receive or log PHI, it must sign a BAA; prefer vendors that don't need it. Data residency and log retention are known.
5. **Observability without content.** Per-job status, attempts, latency and errors visible without logging bodies, model output, secrets or raw connector payloads.
6. **Cost.** Predictable at expected volume (jobs per user per day), with no paid tier required for development.
7. **Local development and tests.** Runs locally or has a faithful emulator; deterministic tests for restart, expired lease, duplicate delivery, retry and cancel (A-04 done criterion).
8. **Portability.** Low lock-in; the §3 port keeps a swap to one adapter file.
9. **Security.** Signed callbacks, secrets in the platform secret store, least-privilege credentials.
10. **Operational fit with Waltz standards.** The shared architecture standard names Azure Service Bus for cross-service async work; whether that applies to Orbit, which runs on Vercel and Supabase, needs a decision (open question 2).

Candidates to evaluate (no preference implied): a Postgres queue on Supabase (own `jobs` table with `for update skip locked`, or Supabase Queues/pgmq) with cron or `pg_cron` wake-ups; Vercel Queues/Workflow; Inngest; Trigger.dev; Temporal Cloud; Azure Service Bus with a worker.

### 5. PHI and logging

- Job payloads and vendor-visible metadata: ids, types, attempt numbers and normalized error codes only.
- Workers load content from Postgres at execution time under grant checks (ADR 004), so revocation and deletion apply to queued work.
- Logs follow `executeRun()`'s current rule: ids and error types, never messages that may quote content. Provider errors are normalized before they are stored (ADR 003 codes).

### 6. Error and status contract

The runtime has no user-facing API of its own. User-visible state is the owning record's state (assignment `failed` with `timed_out`, `budget_exhausted`, `executor_unavailable`, ...; reminder `status`; debrief run `failed`). Internal adapter failures surface as `executor_unavailable` on the affected record, never as a run that looks active forever.

## Consequences

- A-02 can ship on tier 2 without waiting for a vendor; its lease/fencing design already matches tier 3, so A-04 is a transport change, not a rewrite.
- Nothing with an external side effect can ship before A-04 (enforced by review against this ADR).
- Scheduled debriefs keep working unchanged; their move to per-task jobs is optional and triggered by measured tick duration.
- The existing organizing-run timeout (`RUN_TIMEOUT_MS` reaping on read) remains as is; it already follows the tier-2 rules except for leases, which are not needed while organizing runs are user-restartable.

## Alternatives considered

- **Use `after()` for everything.** No recovery after process loss, no retries, capped by `maxDuration`. Rejected beyond tier 2.
- **Pick a workflow vendor now.** The plan forbids an incidental vendor dependency before hosting limits and cost are verified. Rejected for now.
- **Vendor as source of truth for workflow state** (e.g. durable-function state only). Makes Orbit state depend on the vendor's storage and complicates PHI review. Rejected; Postgres stays authoritative.
- **Run a long-lived worker process immediately.** New hosting surface and operations before it's needed. Deferred to the vendor decision.

## Open questions

1. **Vercel plan limits** (max function duration, cron frequency and count, concurrency) for the production project. *Owner: Lead. Blocks: vendor decision, tick fan-out threshold.*
2. **Do Waltz Azure standards (Service Bus, Key Vault) apply to Orbit?** *Decider: Tony.*
3. **Runtime vendor** (follow-up ADR, using §4 criteria). *Decider: Tony. Blocks: A-04.*
4. **Retry policy for failed scheduled debriefs** (today's unique index blocks a same-day retry). *Decider: product.*
5. **Should organizing runs move to tier 3** for automatic retries, or stay user-restartable? *Decider: Tony.*
