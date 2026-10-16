import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAgentSettings } from "@/lib/agent/server";
import { createProvider } from "@/lib/agent/providers";
import { postgresJobQueue } from "@/lib/runtime/postgres";
import { runJobNow, workerId } from "@/lib/runtime/worker";
import type { JobHandler, JobQueue, JobResult } from "@/lib/runtime/types";
import {
  EXECUTOR_MIN_START_MS,
  EXECUTOR_WALL_CLOCK_MS,
  executeAssignment,
  materialFromRows,
  previousArtifactId,
  type ClaimStatus,
  type ExecutionOutcome,
  type ExecutorAssignment,
  type ExecutorStore,
  type MaterialRows,
} from "./executor";

// Wires the built-in executor (executor.ts) to Supabase and to the durable
// job queue (ADR 005 tier 3, ADR 006; below): the admin (service role) client, because the
// executor RPCs are granted to service_role only and the run continues after
// the browser's request has been answered. Every read filters on the
// assignment's user and workspace; every write is an executor RPC fenced by
// the lease token. Nothing here logs content, keys, lease tokens or raw
// database errors.

/** Route maxDuration for the routes that start runs (seconds). */
export const EXECUTOR_ROUTE_MAX_DURATION = 300;
/** Queued work the reconciliation leaves alone this long, so the route's own enqueue lands first. */
export const RECOVERY_GRACE_MS = 60_000;
/** Most queued assignments one reconciliation pass checks, oldest first. */
export const RECONCILE_LIMIT = 50;
/** The durable job that runs one attempt of a queued built-in assignment (A-04, ADR 006). */
export const ASSIGNMENT_RUN_KIND = "assignment.run";
/** Deliveries of one assignment.run job before it is dead and the assignment fails with executor_unavailable. */
export const ASSIGNMENT_RUN_MAX_ATTEMPTS = 5;
export const ASSIGNMENT_RUN_BACKOFF = { baseSeconds: 15, maxSeconds: 300 };
/** Delay before re-delivering a run whose workspace already has a running assignment. */
export const BUSY_RELEASE_SECONDS = 30;
/** Margin kept back from maxDuration when a caller passes its start time. */
const DEADLINE_MARGIN_MS = 30_000;

type Admin = SupabaseClient;
type Rpc = { status?: string; attemptId?: string; leaseToken?: string };

async function rpc(admin: Admin, name: string, args: Record<string, unknown>): Promise<Rpc> {
  const { data, error } = await admin.rpc(name, args);
  if (error || !data || typeof data !== "object") throw new Error("executor rpc failed");
  return data as Rpc;
}

const status = <T extends string>(result: Rpc, allowed: readonly T[]): T => {
  if (allowed.includes(result.status as T)) return result.status as T;
  throw new Error("unexpected executor rpc result");
};

export function supabaseExecutorStore(admin: Admin): ExecutorStore {
  const rows = async <T>(query: PromiseLike<{ data: T | null; error: unknown }>) => {
    const { data, error } = await query;
    if (error || data === null) throw new Error("executor read failed");
    return data;
  };
  return {
    async loadAssignment(id) {
      const { data, error } = await admin
        .from("assignments")
        .select("id,user_id,workspace_id,state,executor_kind,source_note_id,requested_outcome")
        .eq("id", id)
        .maybeSingle<Record<string, string | null>>();
      if (error) throw new Error("executor read failed");
      if (!data) return null;
      return {
        id: data.id!,
        userId: data.user_id!,
        workspaceId: data.workspace_id!,
        state: data.state as ExecutorAssignment["state"],
        executorKind: data.executor_kind as ExecutorAssignment["executorKind"],
        sourceNoteId: data.source_note_id,
        requestedOutcome: data.requested_outcome!,
      };
    },
    async agentEnabled(assignment) {
      const { data, error } = await admin
        .from("workspaces")
        .select("agent_enabled")
        .eq("id", assignment.workspaceId)
        .eq("user_id", assignment.userId)
        .maybeSingle<{ agent_enabled: boolean }>();
      if (error) throw new Error("executor read failed");
      return !!data?.agent_enabled;
    },
    async loadSettings(userId) {
      const settings = await loadAgentSettings(admin, userId);
      return settings
        ? { provider: settings.provider, model: settings.model, apiKey: settings.apiKey }
        : null;
    },
    async loadMaterial(assignment) {
      const child = (table: string, columns: string) =>
        admin
          .from(table)
          .select(columns)
          .eq("assignment_id", assignment.id)
          .eq("user_id", assignment.userId);
      const [context, questions, reviews] = await Promise.all([
        rows(child("assignment_context_items", "note_id,position").returns<MaterialRows["context"]>()),
        rows(child("assignment_questions", "prompt,answer,answered_at").order("asked_at").returns<MaterialRows["questions"]>()),
        rows(
          child("assignment_reviews", "artifact_id,decision,comment,decided_at")
            .order("decided_at")
            .returns<MaterialRows["reviews"]>(),
        ),
      ]);
      const ids = [assignment.sourceNoteId, ...context.map((c) => c.note_id)].filter(
        (id): id is string => !!id,
      );
      // Minimum necessary: id, title, plain text and kind of the selected
      // items, in the assignment's workspace only.
      const notes = ids.length
        ? await rows(
            admin
              .from("notes")
              .select("id,title,plain_text,kind")
              .eq("user_id", assignment.userId)
              .eq("workspace_id", assignment.workspaceId)
              .in("id", ids)
              .returns<MaterialRows["notes"]>(),
          )
        : [];
      const previousId = previousArtifactId(reviews);
      const previousArtifact = previousId
        ? (
            await admin
              .from("assignment_artifacts")
              .select("title,plain_text")
              .eq("id", previousId)
              .eq("assignment_id", assignment.id)
              .eq("user_id", assignment.userId)
              .maybeSingle<{ title: string; plain_text: string }>()
          ).data ?? null
        : null;
      return materialFromRows({ assignment, context, notes, questions, reviews, previousArtifact });
    },
    async claim(id, leaseSeconds): Promise<ClaimStatus> {
      const result = await rpc(admin, "claim_assignment", { p_id: id, p_lease_seconds: leaseSeconds });
      if (result.status === "claimed" && result.attemptId && result.leaseToken)
        return { status: "claimed", lease: { attemptId: result.attemptId, leaseToken: result.leaseToken } };
      if (result.status === "invalid_transition") return { status: "not_queued" };
      return { status: status(result, ["executor_busy", "agent_disabled", "not_found"] as const) };
    },
    async heartbeat(lease, progress) {
      const result = await rpc(admin, "heartbeat_assignment", {
        p_attempt_id: lease.attemptId,
        p_lease_token: lease.leaseToken,
        p_progress: progress,
      });
      return status(result, ["ok", "lease_lost", "invalid_payload"] as const);
    },
    async ask(lease, prompt) {
      const result = await rpc(admin, "ask_assignment_question", {
        p_attempt_id: lease.attemptId,
        p_lease_token: lease.leaseToken,
        p_prompt: prompt,
      });
      return status(result, ["asked", "lease_lost", "invalid_payload"] as const);
    },
    async submit(lease, artifact) {
      const result = await rpc(admin, "submit_assignment_artifact", {
        p_attempt_id: lease.attemptId,
        p_lease_token: lease.leaseToken,
        p_artifact: artifact,
      });
      return status(result, ["submitted", "lease_lost", "invalid_payload", "invalid_context"] as const);
    },
    async fail(lease, code) {
      const result = await rpc(admin, "fail_assignment_attempt", {
        p_attempt_id: lease.attemptId,
        p_lease_token: lease.leaseToken,
        p_error_code: code,
      });
      return status(result, ["saved", "lease_lost", "invalid_payload"] as const);
    },
    async failSystem(id, code) {
      const result = await rpc(admin, "fail_assignment_system", { p_id: id, p_error_code: code });
      return result.status === "saved" ? "saved" : "not_allowed";
    },
  };
}

/** The wall-clock deadline for a run started by a route that began at `startedAt`. */
export const routeDeadline = (startedAt: number) =>
  startedAt + EXECUTOR_ROUTE_MAX_DURATION * 1000 - DEADLINE_MARGIN_MS;

/**
 * Runs one attempt of a queued built-in assignment with the admin client.
 * For `after()` in the routes that queue work. Never throws.
 */
export async function runQueuedAssignment(
  assignmentId: string,
  options: { deadlineAt?: number; admin?: Admin | null } = {},
): Promise<ExecutionOutcome> {
  const admin = options.admin === undefined ? createAdminClient() : options.admin;
  if (!admin) {
    console.error("assignment execution not configured", { assignmentId });
    return { outcome: "skipped" };
  }
  try {
    return await executeAssignment(
      {
        store: supabaseExecutorStore(admin),
        createProvider: (settings) => createProvider(settings.provider, settings.apiKey, settings.model),
      },
      assignmentId,
      { deadlineAt: options.deadlineAt },
    );
  } catch {
    console.error("assignment execution crashed", { assignmentId });
    return { outcome: "skipped" };
  }
}

// Durable execution (A-04, ADR 006). -----------------------------------------------
//
// The queue is the source of truth for recovery: every route that leaves a
// built-in assignment queued enqueues one `assignment.run` job, keyed by the
// assignment's id and revision, before it answers. after() then runs that
// same job at once (the fast path); if the process is lost, the worker cron
// delivers it again. Duplicate deliveries are harmless: claim_assignment lets
// one caller start an attempt and the assignment lease fences every write.

/** A queued built-in assignment at a revision; the revision makes each queue cycle its own job. */
export type QueuedAssignment = { id: string; revision: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const assignmentRunKey = (assignment: QueuedAssignment) =>
  `assignment:${assignment.id}:${assignment.revision}`;

const assignmentRunJob = (assignment: QueuedAssignment) => ({
  kind: ASSIGNMENT_RUN_KIND,
  payload: { assignmentId: assignment.id, revision: assignment.revision },
  idempotencyKey: assignmentRunKey(assignment),
  maxAttempts: ASSIGNMENT_RUN_MAX_ATTEMPTS,
  backoff: ASSIGNMENT_RUN_BACKOFF,
});

/**
 * The queued built-in assignment in a create / transition / answer / review
 * RPC result, or null. Routes enqueue a run for it.
 */
export function queuedBuiltinAssignment(raw: unknown): QueuedAssignment | null {
  const assignment = (raw as { status?: string; assignment?: Record<string, unknown> } | null)?.assignment;
  const ok = (raw as { status?: string } | null)?.status;
  if ((ok !== "created" && ok !== "saved") || !assignment) return null;
  const revision = Number(assignment.revision);
  return assignment.state === "queued" && assignment.executor_kind === "builtin" &&
    typeof assignment.id === "string" && Number.isSafeInteger(revision) && revision > 0
    ? { id: assignment.id, revision }
    : null;
}

/** Enqueues (idempotently) the run for this revision. Returns the job id, or null if the queue is unavailable. Never throws. */
export async function enqueueAssignmentRun(
  assignment: QueuedAssignment,
  options: { queue?: JobQueue | null } = {},
): Promise<string | null> {
  let queue = options.queue;
  if (queue === undefined) {
    const admin = createAdminClient();
    queue = admin ? postgresJobQueue(admin) : null;
  }
  if (!queue) return null;
  try {
    return (await queue.enqueue(assignmentRunJob(assignment))).jobId;
  } catch {
    // The worker's reconciliation enqueues it within a few minutes.
    console.error("assignment run enqueue failed", { assignmentId: assignment.id });
    return null;
  }
}

async function queuedAt(admin: Admin, assignment: QueuedAssignment): Promise<boolean> {
  const { data, error } = await admin
    .from("assignments")
    .select("state,revision,executor_kind")
    .eq("id", assignment.id)
    .maybeSingle<{ state: string; revision: number | string; executor_kind: string }>();
  if (error) throw new Error("assignment read failed");
  return !!data && data.state === "queued" && data.executor_kind === "builtin" &&
    Number(data.revision) === assignment.revision;
}

/**
 * The `assignment.run` handler: one attempt through runQueuedAssignment.
 * Finished outcomes (submitted, asked, failed, unavailable, lease_lost)
 * complete the job; a busy workspace releases it for later without using an
 * attempt; a run that was skipped while the assignment still waits at this
 * revision (a read error, too little time) is retried with backoff, and on
 * the last attempt fails the assignment visibly with executor_unavailable
 * (ADR 005 §6). Anything else (the assignment moved on) completes.
 */
export function assignmentRunHandler(
  admin: Admin,
  run: typeof runQueuedAssignment = runQueuedAssignment,
): JobHandler {
  return {
    kind: ASSIGNMENT_RUN_KIND,
    // Start only with the executor's full wall-clock budget left.
    minRunMs: EXECUTOR_WALL_CLOCK_MS,
    async run({ job, deadlineAt, now }): Promise<JobResult> {
      const id = job.payload.assignmentId;
      const revision = Number(job.payload.revision);
      if (typeof id !== "string" || !UUID.test(id) || !Number.isSafeInteger(revision) || revision < 1)
        return { type: "fail", code: "invalid_payload", retryable: false };
      const { outcome } = await run(id, { admin, deadlineAt });
      if (outcome === "busy") return { type: "release", delaySeconds: BUSY_RELEASE_SECONDS };
      if (outcome !== "skipped") return { type: "complete" };
      if (!(await queuedAt(admin, { id, revision }))) return { type: "complete" };
      if (deadlineAt - now() < EXECUTOR_MIN_START_MS) return { type: "release", delaySeconds: 0 };
      if (job.attempt < job.maxAttempts) return { type: "fail", code: "executor_skipped" };
      await supabaseExecutorStore(admin).failSystem(id, "executor_unavailable").catch(() => "not_allowed");
      return { type: "fail", code: "executor_skipped", retryable: false };
    },
  };
}

/**
 * after() in the queuing routes: runs the just-enqueued job now, so latency
 * stays low. If it can't be claimed (the worker already has it, or it waits
 * for a retry), this is a no-op. Without a job (the enqueue failed) it runs
 * the assignment directly, as before A-04, and the reconciliation's job later
 * finds nothing to do. Never throws; returns an outcome name only.
 */
export async function kickoffAssignmentRun(
  assignment: QueuedAssignment,
  jobId: string | null,
  options: { deadlineAt: number; admin?: Admin | null },
): Promise<string> {
  const admin = options.admin === undefined ? createAdminClient() : options.admin;
  if (!admin) return "not_configured";
  if (!jobId) return (await runQueuedAssignment(assignment.id, { admin, deadlineAt: options.deadlineAt })).outcome;
  return runJobNow(postgresJobQueue(admin), [assignmentRunHandler(admin)], jobId, {
    deadlineAt: options.deadlineAt,
    workerId: workerId("kickoff"),
  });
}

/**
 * Reconciliation from Postgres (ADR 005 §2), run by the worker before it
 * claims: every built-in assignment queued for longer than `graceMs` gets its
 * run enqueued (a no-op when the job exists). One whose job for the current
 * revision has ended (dead, or finished while the assignment still waits)
 * would never run, so it fails with executor_unavailable instead of looking
 * queued forever. Checks the oldest `limit`. Returns counts only.
 */
export async function reconcileAssignmentJobs(
  admin: Admin,
  queue: JobQueue,
  options: { graceMs?: number; limit?: number; now?: number } = {},
): Promise<{ checked: number; enqueued: number; failed: number }> {
  const cutoff = new Date((options.now ?? Date.now()) - (options.graceMs ?? RECOVERY_GRACE_MS)).toISOString();
  const { data, error } = await admin
    .from("assignments")
    .select("id,revision")
    .eq("state", "queued")
    .eq("executor_kind", "builtin")
    .lt("state_changed_at", cutoff)
    .order("state_changed_at")
    .limit(options.limit ?? RECONCILE_LIMIT)
    .returns<{ id: string; revision: number | string }[]>();
  if (error || !data) throw new Error("reconcile read failed");
  const counts = { checked: data.length, enqueued: 0, failed: 0 };
  for (const row of data) {
    const assignment = { id: row.id, revision: Number(row.revision) };
    const job = await queue.enqueue(assignmentRunJob(assignment));
    if (job.created) counts.enqueued++;
    else if (job.status === "dead" || job.status === "completed" || job.status === "canceled") {
      // The job can no longer run; re-read so a run that finished meanwhile isn't failed.
      if (!(await queuedAt(admin, assignment))) continue;
      if ((await supabaseExecutorStore(admin).failSystem(assignment.id, "executor_unavailable")) === "saved")
        counts.failed++;
    }
  }
  return counts;
}

