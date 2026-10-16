// The durable-jobs port (ADR 005 §3, ADR 006). Application code depends only
// on these types; the Postgres adapter (postgres.ts) is the one
// implementation today, and moving to another runtime means implementing
// JobQueue elsewhere (docs/runtime/migrating-durable-jobs.md).
//
// Delivery is at-least-once: a handler may run more than once for the same
// job (an expired lease, a crash before complete). Handlers make their
// effects idempotent or reconcile them; the owning record in Postgres (an
// assignment, a reminder) stays the source of truth.

/** Ids only: a flat object of short scalars. Never content, secrets or raw payloads. */
export type JobPayload = Readonly<Record<string, string | number | boolean | null>>;

export type JobStatus = "queued" | "running" | "completed" | "dead" | "canceled";

/** Exponential backoff for failed deliveries and expired leases, with equal jitter. */
export type BackoffPolicy = { baseSeconds: number; maxSeconds: number };

export type EnqueueJob = {
  /** Dotted identifier registered in the worker's registry, e.g. "assignment.run". */
  kind: string;
  payload: JobPayload;
  /** Unique per kind: enqueueing the same key again returns the existing job unchanged. */
  idempotencyKey: string;
  runAt?: Date;
  maxAttempts?: number;
  backoff?: BackoffPolicy;
};

export type EnqueueResult = {
  jobId: string;
  /** false when a job with the same kind and key already existed (any status). */
  created: boolean;
  status: JobStatus;
};

/** A persisted step of a multi-step job (ADR 005 §2): intent before an effect, result after. */
export type JobStep = { status: "started" | "succeeded"; result: JobPayload | null };

/** One delivery: the job and the lease that fences every later call for it. */
export type ClaimedJob = {
  id: string;
  kind: string;
  payload: JobPayload;
  /** 1 for the first delivery; counts claims, minus releases. */
  attempt: number;
  maxAttempts: number;
  /** A credential: never logged or returned to browsers. */
  leaseToken: string;
  leaseExpiresAt: string;
  steps: Readonly<Record<string, JobStep>>;
};

export type JobLease = { jobId: string; leaseToken: string };

export type ClaimOptions = {
  /** Identifies the worker invocation (no content), for operations. */
  workerId: string;
  leaseSeconds: number;
  batchSize: number;
  /** Only these kinds (the registry's); all kinds when omitted. */
  kinds?: readonly string[];
  /** Only this job (the in-request fast path). */
  jobId?: string;
};

export type FailResult = { status: "retrying"; runAt: string } | { status: "dead" } | { status: "lease_lost" };

export type CancelTarget = { jobId: string } | { kind: string; idempotencyKey: string };

export type CancelResult =
  | { status: "canceled"; jobId: string }
  | { status: "already_finished"; jobId: string; jobStatus: JobStatus }
  | { status: "not_found" };

export interface JobQueue {
  /** Idempotent per (kind, idempotencyKey). */
  enqueue(job: EnqueueJob): Promise<EnqueueResult>;
  /** Ready jobs with a lease; concurrent claims never return the same job. Each claim is an attempt. */
  claim(options: ClaimOptions): Promise<ClaimedJob[]>;
  /** Extends a live lease; lease_lost after expiry, cancel or re-delivery. */
  heartbeat(lease: JobLease, leaseSeconds?: number): Promise<"ok" | "lease_lost">;
  complete(lease: JobLease): Promise<"completed" | "lease_lost">;
  /** Backoff and retry while attempts remain and `retryable`; otherwise dead. `code` is normalized. */
  fail(lease: JobLease, code: string, options?: { retryable?: boolean }): Promise<FailResult>;
  /** Back to the queue without using up an attempt (busy, near the deadline). */
  release(lease: JobLease, delaySeconds?: number): Promise<"released" | "lease_lost">;
  /** Queued or running jobs only; a running delivery loses its lease at once. */
  cancel(target: CancelTarget): Promise<CancelResult>;
  /** Expired leases → back to the queue with backoff, or dead at max attempts. */
  reap(): Promise<{ requeued: number; dead: number }>;
  /** Records a step of the leased job (survives retries). */
  saveStep(lease: JobLease, name: string, step: JobStep): Promise<"saved" | "lease_lost">;
  /** Retention: drops long-finished jobs. Returns the count. */
  purge(): Promise<number>;
}

/** What a handler asks the worker to do with the delivery. */
export type JobResult =
  | { type: "complete" }
  /** Retry with backoff (counts the attempt), or dead when `retryable` is false or none remain. */
  | { type: "fail"; code: string; retryable?: boolean }
  /** Run again later without counting this delivery. */
  | { type: "release"; delaySeconds?: number };

export type JobContext = {
  job: ClaimedJob;
  /** Aborted when the lease is lost (cancel, expiry). Writes must stop. */
  signal: AbortSignal;
  /** Epoch ms by which the handler must have returned. */
  deadlineAt: number;
  now: () => number;
  /** Persists a step under this delivery's lease; false when the lease is lost. */
  saveStep: (name: string, step: JobStep) => Promise<boolean>;
};

export type JobHandler = {
  kind: string;
  run(context: JobContext): Promise<JobResult>;
  /** The least time a delivery needs; the worker doesn't claim with less left. */
  minRunMs: number;
};
