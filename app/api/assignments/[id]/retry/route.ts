import { after } from "next/server";
import { routeUser } from "@/lib/supabase/route-auth";
import { isAssignmentUuid, parseRevisionOnly } from "@/lib/assignments/validation";
import {
  assignmentError,
  assignmentResultResponse,
  authFailure,
  readJsonBody,
} from "@/lib/assignments/server";
import {
  queuedBuiltinAssignmentId,
  routeDeadline,
  runQueuedAssignment,
} from "@/lib/assignments/executor-server";

// A built-in run queued here continues after the response, up to this limit
// (ADR 005 tier 2; EXECUTOR_ROUTE_MAX_DURATION in executor-server.ts).
export const maxDuration = 300;

/**
 * Retries a failed assignment (T14): back to queued with its error cleared.
 * Refused with active_assignment_exists while another assignment for the
 * same item is active.
 * Body `{ expectedRevision }` → 200 `{ assignment }`.
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
  const parsed = parseRevisionOnly(read.body);
  if (!isAssignmentUuid(id) || !parsed.ok) return assignmentError("invalid_payload");
  const { data, error } = await auth.supabase.rpc("transition_assignment", {
    p_id: id,
    p_expected_revision: parsed.value.expectedRevision,
    p_to_state: "queued",
    p_payload: null,
  });
  const response = error ? null : assignmentResultResponse(data);
  const queued = response && queuedBuiltinAssignmentId(data);
  if (queued) {
    const startedAt = Date.now();
    after(() => runQueuedAssignment(queued, { deadlineAt: routeDeadline(startedAt) }));
  }
  return response ?? assignmentError("save_failed");
}
