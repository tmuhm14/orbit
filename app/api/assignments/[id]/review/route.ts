import { after } from "next/server";
import { routeUser } from "@/lib/supabase/route-auth";
import { isAssignmentUuid, parseReview } from "@/lib/assignments/validation";
import {
  assignmentError,
  assignmentResultResponse,
  authFailure,
  readJsonBody,
} from "@/lib/assignments/server";
import {
  enqueueAssignmentRun,
  kickoffAssignmentRun,
  queuedBuiltinAssignment,
  routeDeadline,
} from "@/lib/assignments/executor-server";

// A built-in run queued here is enqueued as a durable job (ADR 006) and runs
// after the response, up to this limit (EXECUTOR_ROUTE_MAX_DURATION in
// executor-server.ts); the worker cron re-delivers it if this process is lost.
export const maxDuration = 300;

/**
 * Reviews the latest result: accept → completed (T11), request_changes →
 * queued (T12, comment required), reject → canceled (T13). Accepting never
 * completes the source item; that stays a separate, explicit item edit.
 * Body `{ expectedRevision, artifactId, decision, comment? }` →
 * 200 `{ assignment, reviewId }`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return authFailure(auth.error);
  const { id } = await params;
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const parsed = parseReview(read.body);
  if (!isAssignmentUuid(id) || !parsed.ok) return assignmentError("invalid_payload");
  const { data, error } = await auth.supabase.rpc("review_assignment_artifact", {
    p_id: id,
    p_expected_revision: parsed.value.expectedRevision,
    p_artifact_id: parsed.value.artifactId,
    p_decision: parsed.value.decision,
    p_comment: parsed.value.comment,
  });
  const response = error ? null : assignmentResultResponse(data);
  const queued = response && queuedBuiltinAssignment(data);
  if (queued) {
    // Enqueued before answering (the source of truth for recovery), then
    // run at once after the response (the fast path).
    const startedAt = Date.now();
    const jobId = await enqueueAssignmentRun(queued);
    after(() => kickoffAssignmentRun(queued, jobId, { deadlineAt: routeDeadline(startedAt) }));
  }
  return response ?? assignmentError("save_failed");
}
