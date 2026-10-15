import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAgentSettings } from "@/lib/agent/server";
import { createProvider } from "@/lib/agent/providers";
import {
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

// Wires the built-in executor (executor.ts) to Supabase for the bounded
// background tier (ADR 005): the admin (service role) client, because the
// executor RPCs are granted to service_role only and the run continues after
// the browser's request has been answered. Every read filters on the
// assignment's user and workspace; every write is an executor RPC fenced by
// the lease token. Nothing here logs content, keys, lease tokens or raw
// database errors.

/** Route maxDuration for the routes that start runs (seconds). */
export const EXECUTOR_ROUTE_MAX_DURATION = 300;
/** Queued work the recovery sweep leaves alone this long, so the kickoff's own run claims first. */
export const RECOVERY_GRACE_MS = 60_000;
/** Most assignments one recovery sweep starts (one per workspace, in parallel). */
export const RECOVERY_BATCH = 5;
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

/**
 * The id of a queued built-in assignment in a create / transition / answer /
 * review RPC result, or null. Routes schedule a run for it with after().
 */
export function queuedBuiltinAssignmentId(raw: unknown): string | null {
  const assignment = (raw as { status?: string; assignment?: Record<string, unknown> } | null)?.assignment;
  const ok = (raw as { status?: string } | null)?.status;
  if ((ok !== "created" && ok !== "saved") || !assignment) return null;
  return assignment.state === "queued" && assignment.executor_kind === "builtin" && typeof assignment.id === "string"
    ? assignment.id
    : null;
}

/**
 * Recovery for lost kickoffs (process loss before or during the after()
 * callback, or a run that found its workspace busy): starts queued built-in
 * assignments that have waited longer than `graceMs`, the oldest first, at
 * most one per workspace and `limit` in total, in parallel. Duplicate starts
 * are harmless: claim_assignment lets one caller win and the rest skip.
 * Returns outcome counts only.
 */
export async function recoverQueuedAssignments(
  admin: Admin,
  options: { deadlineAt?: number; graceMs?: number; limit?: number; now?: number } = {},
): Promise<Record<string, number>> {
  const now = options.now ?? Date.now();
  const cutoff = new Date(now - (options.graceMs ?? RECOVERY_GRACE_MS)).toISOString();
  const { data, error } = await admin
    .from("assignments")
    .select("id,workspace_id")
    .eq("state", "queued")
    .eq("executor_kind", "builtin")
    .lt("state_changed_at", cutoff)
    .order("state_changed_at")
    .limit(50)
    .returns<{ id: string; workspace_id: string }[]>();
  if (error || !data) throw new Error("recovery read failed");
  const picked = new Map<string, string>();
  for (const row of data) {
    if (picked.size >= (options.limit ?? RECOVERY_BATCH)) break;
    if (!picked.has(row.workspace_id)) picked.set(row.workspace_id, row.id);
  }
  const outcomes = await Promise.all(
    [...picked.values()].map((id) =>
      runQueuedAssignment(id, {
        admin,
        deadlineAt: Math.min(options.deadlineAt ?? Infinity, now + EXECUTOR_WALL_CLOCK_MS),
      }),
    ),
  );
  const counts: Record<string, number> = { started: picked.size };
  for (const { outcome } of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
}
