import type {
  ClaimedJob,
  JobPayload,
  JobQueue,
  JobStatus,
  JobStep,
} from "./types";

// An in-memory JobQueue with an injectable clock and random source, for unit
// tests of the worker and handlers (fake clocks). It mirrors the Postgres
// functions' rules (idempotent enqueue, leases and fencing, backoff with equal
// jitter, release, cancel, reap); the Postgres tests check the real thing.
// Not for production: nothing survives the process.

export type MemoryJob = {
  id: string;
  kind: string;
  payload: JobPayload;
  idempotencyKey: string;
  status: JobStatus;
  runAt: number;
  attempts: number;
  maxAttempts: number;
  backoff: { baseSeconds: number; maxSeconds: number };
  leasedBy: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  lastErrorCode: string | null;
  steps: Record<string, JobStep>;
};

export function backoffSeconds(attempts: number, base: number, max: number, random: number): number {
  const delay = Math.min(max, base * 2 ** Math.max(attempts - 1, 0));
  return delay / 2 + (random * delay) / 2;
}

export function memoryJobQueue(options: { now?: () => number; random?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const jobs = new Map<string, MemoryJob>();
  let ids = 0;
  const live = (lease: { jobId: string; leaseToken: string }) => {
    const job = jobs.get(lease.jobId);
    return job && job.status === "running" && job.leaseToken === lease.leaseToken && (job.leaseExpiresAt ?? 0) > now()
      ? job
      : null;
  };
  const unlease = (job: MemoryJob, status: JobStatus) => {
    job.status = status;
    job.leasedBy = null;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
  };
  const retryAt = (job: MemoryJob) =>
    now() + backoffSeconds(job.attempts, job.backoff.baseSeconds, job.backoff.maxSeconds, random()) * 1000;

  const queue: JobQueue & { jobs: Map<string, MemoryJob> } = {
    jobs,
    async enqueue(input) {
      const existing = [...jobs.values()].find((j) => j.kind === input.kind && j.idempotencyKey === input.idempotencyKey);
      if (existing) return { jobId: existing.id, created: false, status: existing.status };
      const id = `job-${++ids}`;
      jobs.set(id, {
        id,
        kind: input.kind,
        payload: { ...input.payload },
        idempotencyKey: input.idempotencyKey,
        status: "queued",
        runAt: input.runAt?.getTime() ?? now(),
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 5,
        backoff: input.backoff ?? { baseSeconds: 15, maxSeconds: 900 },
        leasedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        steps: {},
      });
      return { jobId: id, created: true, status: "queued" };
    },
    async claim(claim) {
      const ready = [...jobs.values()]
        .filter((j) => j.status === "queued" && j.runAt <= now())
        .filter((j) => !claim.kinds || claim.kinds.includes(j.kind))
        .filter((j) => !claim.jobId || j.id === claim.jobId)
        .sort((a, b) => a.runAt - b.runAt)
        .slice(0, claim.batchSize);
      return ready.map((job): ClaimedJob => {
        job.status = "running";
        job.attempts++;
        job.leasedBy = claim.workerId;
        job.leaseToken = `lease-${job.id}-${job.attempts}-${++ids}`;
        job.leaseExpiresAt = now() + claim.leaseSeconds * 1000;
        return {
          id: job.id,
          kind: job.kind,
          payload: job.payload,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          leaseToken: job.leaseToken,
          leaseExpiresAt: new Date(job.leaseExpiresAt).toISOString(),
          steps: structuredClone(job.steps),
        };
      });
    },
    async heartbeat(lease, leaseSeconds = 60) {
      const job = live(lease);
      if (!job) return "lease_lost";
      job.leaseExpiresAt = now() + leaseSeconds * 1000;
      return "ok";
    },
    async complete(lease) {
      const job = live(lease);
      if (!job) return "lease_lost";
      unlease(job, "completed");
      return "completed";
    },
    async fail(lease, code, options = {}) {
      const job = live(lease);
      if (!job) return { status: "lease_lost" };
      job.lastErrorCode = code;
      if ((options.retryable ?? true) && job.attempts < job.maxAttempts) {
        job.runAt = retryAt(job);
        unlease(job, "queued");
        return { status: "retrying", runAt: new Date(job.runAt).toISOString() };
      }
      unlease(job, "dead");
      return { status: "dead" };
    },
    async release(lease, delaySeconds = 0) {
      const job = live(lease);
      if (!job) return "lease_lost";
      job.attempts = Math.max(job.attempts - 1, 0);
      job.runAt = now() + delaySeconds * 1000;
      unlease(job, "queued");
      return "released";
    },
    async cancel(target) {
      const job =
        "jobId" in target
          ? jobs.get(target.jobId)
          : [...jobs.values()].find((j) => j.kind === target.kind && j.idempotencyKey === target.idempotencyKey);
      if (!job) return { status: "not_found" };
      if (job.status !== "queued" && job.status !== "running")
        return { status: "already_finished", jobId: job.id, jobStatus: job.status };
      unlease(job, "canceled");
      return { status: "canceled", jobId: job.id };
    },
    async reap() {
      let requeued = 0;
      let dead = 0;
      for (const job of jobs.values()) {
        if (job.status !== "running" || (job.leaseExpiresAt ?? Infinity) > now()) continue;
        job.lastErrorCode = "lease_expired";
        if (job.attempts < job.maxAttempts) {
          job.runAt = retryAt(job);
          unlease(job, "queued");
          requeued++;
        } else {
          unlease(job, "dead");
          dead++;
        }
      }
      return { requeued, dead };
    },
    async saveStep(lease, name, step) {
      const job = live(lease);
      if (!job) return "lease_lost";
      job.steps[name] = structuredClone(step);
      return "saved";
    },
    async purge() {
      return 0;
    },
  };
  return queue;
}
