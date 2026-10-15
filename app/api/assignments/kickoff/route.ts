import { after } from "next/server";
import { routeUser, json } from "@/lib/supabase/route-auth";
import { isAssignmentUuid } from "@/lib/assignments/validation";
import { assignmentError, authFailure, readJsonBody } from "@/lib/assignments/server";
import { routeDeadline, runQueuedAssignment } from "@/lib/assignments/executor-server";

// A queued run continues after the response, up to this limit (ADR 005 tier 2).
export const maxDuration = 300;

/**
 * Recovery ping for lost kickoffs: the client calls this when it sees a
 * built-in assignment still `queued` (for example after a refresh). Reaps the
 * caller's expired leases, then starts the oldest of the caller's queued
 * built-in assignments in the workspace in the background. Safe to repeat:
 * the claim lets only one run start, and a run already in progress or a busy
 * workspace makes this a no-op.
 * Body `{ workspaceId }` → 202 `{ scheduled: 0 | 1 }`.
 */
export async function POST(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return authFailure(auth.error);
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const body = read.body as { workspaceId?: unknown } | null;
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "workspaceId") ||
    !isAssignmentUuid(body.workspaceId)
  )
    return assignmentError("invalid_payload");
  await auth.supabase.rpc("reap_own_assignment_leases").then(
    () => undefined,
    () => undefined,
  );
  const { data, error } = await auth.supabase
    .from("assignments")
    .select("id")
    .eq("workspace_id", body.workspaceId)
    .eq("user_id", auth.user.id)
    .eq("state", "queued")
    .eq("executor_kind", "builtin")
    .order("state_changed_at")
    .limit(1)
    .returns<{ id: string }[]>();
  if (error || !data) return assignmentError("load_failed");
  const next = data[0]?.id;
  if (next) {
    const startedAt = Date.now();
    after(() => runQueuedAssignment(next, { deadlineAt: routeDeadline(startedAt) }));
  }
  return json({ scheduled: next ? 1 : 0 }, 202);
}
