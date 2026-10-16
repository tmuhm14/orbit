import type { ClaimedJob, JobHandler, JobQueue, JobResult } from "./types";

// The worker loop (ADR 006): reap expired leases, run maintenance, then claim
// batches and run their handlers with job heartbeats, until the queue is
// empty or too little time is left before the deadline. Runtime-agnostic: it
// only uses JobQueue, so it runs the same against Postgres, the in-memory
// queue in tests, or a future adapter. Logs carry job ids, kinds, attempts,
// outcomes and normalized codes only.

/** Route maxDuration of the worker (seconds; Vercel Pro allows this without Fluid compute). */
export const WORKER_MAX_DURATION = 300;
/** Kept back from maxDuration so handlers return and results are written before the platform stops the function. */
export const WORKER_DEADLINE_MARGIN_MS = 30_000;
/** Job lease, extended by heartbeats while a handler runs. */
export const WORKER_LEASE_SECONDS = 60;
export const WORKER_HEARTBEAT_MS = 20_000;
/** Jobs claimed per round, run in parallel. */
export const WORKER_BATCH_SIZE = 5;
/** Rounds per invocation (a bound on re-claiming released work). */
export const WORKER_MAX_ROUNDS = 20;

export type JobOutcome = "completed" | "retrying" | "dead" | "released" | "lease_lost" | "error";

export type JobLogEntry = { jobId: string; kind: string; attempt: number; outcome: JobOutcome; code?: string };

export type RunOptions = {
  deadlineAt: number;
  now?: () => number;
  leaseSeconds?: number;
  heartbeatMs?: number;
  log?: (entry: JobLogEntry) => void;
};

const defaultLog = (entry: JobLogEntry) => console.info("job", entry);

/** The handlers by kind. Two handlers for one kind is a programming error. */
export function createRegistry(handlers: readonly JobHandler[]): ReadonlyMap<string, JobHandler> {
  const map = new Map<string, JobHandler>();
  for (const handler of handlers) {
    if (map.has(handler.kind)) throw new Error("duplicate job handler");
    map.set(handler.kind, handler);
  }
  return map;
}

/**
 * Runs one claimed delivery: heartbeats its lease, calls the handler with an
 * abort signal (aborted on lease_lost) and applies its result. Never throws.
 * A thrown handler is a retryable `handler_error`. If the lease is lost, the
 * result is dropped: whoever holds the job now decides.
 */
export async function runJob(
  queue: JobQueue,
  registry: ReadonlyMap<string, JobHandler>,
  job: ClaimedJob,
  options: RunOptions,
): Promise<JobOutcome> {
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLog;
  const lease = { jobId: job.id, leaseToken: job.leaseToken };
  const done = (outcome: JobOutcome, code?: string) => {
    log({ jobId: job.id, kind: job.kind, attempt: job.attempt, outcome, ...(code ? { code } : {}) });
    return outcome;
  };
  const apply = async (result: JobResult): Promise<JobOutcome> => {
    try {
      if (result.type === "complete")
        return done((await queue.complete(lease)) === "completed" ? "completed" : "lease_lost");
      if (result.type === "release")
        return done((await queue.release(lease, result.delaySeconds ?? 0)) === "released" ? "released" : "lease_lost");
      const failed = await queue.fail(lease, result.code, { retryable: result.retryable ?? true });
      return done(failed.status, result.code);
    } catch {
      // The lease expires and the reaper hands the job out again.
      return done("error");
    }
  };

  const handler = registry.get(job.kind);
  if (!handler) return apply({ type: "fail", code: "unknown_kind", retryable: false });
  if (options.deadlineAt - now() < handler.minRunMs) return apply({ type: "release", delaySeconds: 0 });

  const abort = new AbortController();
  let lost = false;
  let chain: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    chain = chain
      .then(async () => {
        if (lost) return;
        if ((await queue.heartbeat(lease, options.leaseSeconds ?? WORKER_LEASE_SECONDS)) === "lease_lost") {
          lost = true;
          abort.abort();
        }
      })
      // A failed heartbeat isn't fatal: the next may succeed; if none does,
      // the lease expires and the job is delivered again.
      .catch(() => undefined);
  }, options.heartbeatMs ?? WORKER_HEARTBEAT_MS);

  let result: JobResult;
  try {
    result = await handler.run({
      job,
      signal: abort.signal,
      deadlineAt: options.deadlineAt,
      now,
      saveStep: async (name, step) => {
        if (lost) return false;
        try {
          if ((await queue.saveStep(lease, name, step)) === "saved") return true;
        } catch {
          return false;
        }
        lost = true;
        abort.abort();
        return false;
      },
    });
  } catch {
    result = { type: "fail", code: "handler_error" };
  } finally {
    clearInterval(timer);
    await chain;
  }
  if (lost) return done("lease_lost");
  return apply(result);
}

export type WorkerOptions = RunOptions & {
  queue: JobQueue;
  handlers: readonly JobHandler[];
  /** Content-free id of this invocation. */
  workerId: string;
  batchSize?: number;
  maxRounds?: number;
  /** Runs after the reap and before the first claim; failures are counted, not thrown. */
  maintenance?: readonly { name: string; run: () => Promise<unknown> }[];
};

export type WorkerSummary = {
  reaped: { requeued: number; dead: number } | null;
  maintenance: Record<string, "ok" | "failed">;
  claimed: number;
  rounds: number;
  outcomes: Partial<Record<JobOutcome, number>>;
  /** Why the loop ended: nothing ready, too little time left, round limit, or a claim error. */
  stopped: "empty" | "deadline" | "rounds" | "error";
};

/** One worker invocation. Never throws; returns counts only. */
export async function runWorker(options: WorkerOptions): Promise<WorkerSummary> {
  const now = options.now ?? Date.now;
  const registry = createRegistry(options.handlers);
  const summary: WorkerSummary = { reaped: null, maintenance: {}, claimed: 0, rounds: 0, outcomes: {}, stopped: "empty" };
  try {
    summary.reaped = await options.queue.reap();
  } catch {
    // Next invocation reaps again.
  }
  for (const task of options.maintenance ?? []) {
    try {
      await task.run();
      summary.maintenance[task.name] = "ok";
    } catch {
      summary.maintenance[task.name] = "failed";
    }
  }
  for (;;) {
    if (summary.rounds >= (options.maxRounds ?? WORKER_MAX_ROUNDS)) {
      summary.stopped = "rounds";
      break;
    }
    const remaining = options.deadlineAt - now();
    const kinds = options.handlers.filter((h) => h.minRunMs <= remaining).map((h) => h.kind);
    if (!kinds.length) {
      summary.stopped = "deadline";
      break;
    }
    let jobs: ClaimedJob[];
    try {
      jobs = await options.queue.claim({
        workerId: options.workerId,
        leaseSeconds: options.leaseSeconds ?? WORKER_LEASE_SECONDS,
        batchSize: options.batchSize ?? WORKER_BATCH_SIZE,
        kinds,
      });
    } catch {
      summary.stopped = "error";
      break;
    }
    if (!jobs.length) {
      summary.stopped = "empty";
      break;
    }
    summary.rounds++;
    summary.claimed += jobs.length;
    const outcomes = await Promise.all(jobs.map((job) => runJob(options.queue, registry, job, options)));
    for (const outcome of outcomes) summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
  }
  return summary;
}

/**
 * The in-request fast path: claims one specific job (if it is ready and no
 * one holds it) and runs it. A no-op otherwise; the worker picks it up.
 * Never throws.
 */
export async function runJobNow(
  queue: JobQueue,
  handlers: readonly JobHandler[],
  jobId: string,
  options: RunOptions & { workerId: string },
): Promise<JobOutcome | "not_claimed"> {
  const registry = createRegistry(handlers);
  let jobs: ClaimedJob[];
  try {
    jobs = await queue.claim({
      workerId: options.workerId,
      leaseSeconds: options.leaseSeconds ?? WORKER_LEASE_SECONDS,
      batchSize: 1,
      kinds: [...registry.keys()],
      jobId,
    });
  } catch {
    return "not_claimed";
  }
  if (!jobs[0]) return "not_claimed";
  return runJob(queue, registry, jobs[0], options);
}

/** A content-free id for one invocation, for leased_by. */
export const workerId = (prefix: string) => `${prefix}:${crypto.randomUUID().slice(0, 8)}`;
