import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CancelResult,
  ClaimedJob,
  FailResult,
  JobQueue,
  JobStatus,
} from "./types";

// The Postgres (Supabase) implementation of JobQueue: every operation is one
// service-role function from migration 20261020000000_durable_jobs.sql, so
// leases, SKIP LOCKED claims, backoff and fencing live in the database. Needs
// the admin (service role) client. Errors are thrown as fixed messages: never
// a database message, payload or lease token.

type Rpc = Record<string, unknown> & { status?: string };

export function postgresJobQueue(admin: SupabaseClient): JobQueue {
  async function rpc<T = Rpc>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await admin.rpc(name, args);
    if (error || data === null || data === undefined) throw new Error("job rpc failed");
    return data as T;
  }
  const leaseStatus = <T extends string>(result: Rpc, ok: T): T | "lease_lost" => {
    if (result.status === ok || result.status === "lease_lost") return result.status as T | "lease_lost";
    throw new Error("unexpected job rpc result");
  };
  return {
    async enqueue(job) {
      const result = await rpc("enqueue_job", {
        p_kind: job.kind,
        p_idempotency_key: job.idempotencyKey,
        p_payload: job.payload,
        p_run_at: job.runAt ? job.runAt.toISOString() : null,
        p_max_attempts: job.maxAttempts ?? null,
        p_backoff_base_seconds: job.backoff?.baseSeconds ?? null,
        p_backoff_max_seconds: job.backoff?.maxSeconds ?? null,
      });
      if ((result.status !== "created" && result.status !== "exists") || typeof result.jobId !== "string")
        throw new Error("job enqueue refused");
      return { jobId: result.jobId, created: result.status === "created", status: result.jobStatus as JobStatus };
    },
    async claim(options) {
      const rows = await rpc<unknown>("claim_jobs", {
        p_worker: options.workerId,
        p_lease_seconds: options.leaseSeconds,
        p_batch_size: options.batchSize,
        p_kinds: options.kinds ? [...options.kinds] : null,
        p_job_id: options.jobId ?? null,
      });
      if (!Array.isArray(rows)) throw new Error("unexpected job rpc result");
      return rows as ClaimedJob[];
    },
    async heartbeat(lease, leaseSeconds) {
      const result = await rpc("heartbeat_job", {
        p_job_id: lease.jobId,
        p_lease_token: lease.leaseToken,
        p_lease_seconds: leaseSeconds ?? null,
      });
      return leaseStatus(result, "ok");
    },
    async complete(lease) {
      const result = await rpc("complete_job", { p_job_id: lease.jobId, p_lease_token: lease.leaseToken });
      return leaseStatus(result, "completed");
    },
    async fail(lease, code, options = {}): Promise<FailResult> {
      const result = await rpc("fail_job", {
        p_job_id: lease.jobId,
        p_lease_token: lease.leaseToken,
        p_error_code: code,
        p_retryable: options.retryable ?? true,
      });
      if (result.status === "retrying") return { status: "retrying", runAt: String(result.runAt) };
      if (result.status === "dead" || result.status === "lease_lost") return { status: result.status };
      throw new Error("unexpected job rpc result");
    },
    async release(lease, delaySeconds = 0) {
      const result = await rpc("release_job", {
        p_job_id: lease.jobId,
        p_lease_token: lease.leaseToken,
        p_delay_seconds: Math.max(0, Math.min(3600, Math.round(delaySeconds))),
      });
      return leaseStatus(result, "released");
    },
    async cancel(target): Promise<CancelResult> {
      const result = await rpc(
        "cancel_job",
        "jobId" in target
          ? { p_job_id: target.jobId, p_kind: null, p_idempotency_key: null }
          : { p_job_id: null, p_kind: target.kind, p_idempotency_key: target.idempotencyKey },
      );
      if (result.status === "canceled") return { status: "canceled", jobId: String(result.jobId) };
      if (result.status === "already_finished")
        return { status: "already_finished", jobId: String(result.jobId), jobStatus: result.jobStatus as JobStatus };
      if (result.status === "not_found") return { status: "not_found" };
      throw new Error("unexpected job rpc result");
    },
    async reap() {
      const result = await rpc("reap_jobs", {});
      return { requeued: Number(result.requeued) || 0, dead: Number(result.dead) || 0 };
    },
    async saveStep(lease, name, step) {
      const result = await rpc("save_job_step", {
        p_job_id: lease.jobId,
        p_lease_token: lease.leaseToken,
        p_name: name,
        p_status: step.status,
        p_result: step.result,
      });
      return leaseStatus(result, "saved");
    },
    async purge() {
      return Number(await rpc<unknown>("purge_jobs", {})) || 0;
    },
  };
}
