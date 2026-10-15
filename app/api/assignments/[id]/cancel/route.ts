import { routeUser } from "@/lib/supabase/route-auth";
import { isAssignmentUuid, parseRevisionOnly } from "@/lib/assignments/validation";
import {
  assignmentError,
  assignmentResultResponse,
  authFailure,
  readJsonBody,
} from "@/lib/assignments/server";

/**
 * Cancels a queued, running or waiting-for-input assignment (T2, T8, T10).
 * Takes effect at once: a running attempt loses its lease in the same
 * transaction, so the executor can't write after this. A result waiting for
 * review is declined with a `reject` review instead.
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
    p_to_state: "canceled",
    p_payload: null,
  });
  const response = error ? null : assignmentResultResponse(data);
  return response ?? assignmentError("save_failed");
}
