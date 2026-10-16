import { after } from "next/server";
import { routeUser, json } from "@/lib/supabase/route-auth";
import { parseCreateAssignment, parseListQuery } from "@/lib/assignments/validation";
import {
  ASSIGNMENT_COLUMNS,
  assignmentError,
  assignmentResultResponse,
  authFailure,
  fromAssignmentRow,
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
 * The user's assignments in one workspace, newest first (ADR 003 §5),
 * optionally only those delegated from `sourceNoteId`. No artifact content;
 * each row carries `savedNoteId`, the document saved from its result. Expired leases of the caller's assignments are reaped
 * first, so a stalled run shows as failed instead of running forever.
 */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return authFailure(auth.error);
  const query = parseListQuery(new URL(request.url).searchParams);
  if (!query.ok) return assignmentError("invalid_payload");
  const { workspaceId, sourceNoteId, states, limit } = query.value;
  await auth.supabase.rpc("reap_own_assignment_leases").then(
    () => undefined,
    () => undefined,
  );
  const { data: workspace, error: workspaceError } = await auth.supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("user_id", auth.user.id)
    .maybeSingle<{ id: string }>();
  if (workspaceError) return assignmentError("load_failed");
  if (!workspace) return assignmentError("not_found");
  let select = auth.supabase
    .from("assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("user_id", auth.user.id);
  if (sourceNoteId) select = select.eq("source_note_id", sourceNoteId);
  if (states) select = select.in("state", states);
  const { data, error } = await select
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<Record<string, unknown>[]>();
  if (error) return assignmentError("load_failed");
  // The document saved from each accepted result (U-05). Only the accepted,
  // current artifact of a completed assignment can be saved, so there is at
  // most one per assignment.
  const saved = new Map<string, string>();
  if (data.length) {
    const { data: artifacts, error: artifactError } = await auth.supabase
      .from("assignment_artifacts")
      .select("assignment_id,saved_note_id")
      .eq("user_id", auth.user.id)
      .in("assignment_id", data.map((row) => row.id as string))
      .not("saved_note_id", "is", null)
      .returns<{ assignment_id: string; saved_note_id: string }[]>();
    if (artifactError) return assignmentError("load_failed");
    for (const a of artifacts) saved.set(a.assignment_id, a.saved_note_id);
  }
  return json({
    assignments: data.map((row) => ({
      ...fromAssignmentRow(row),
      savedNoteId: saved.get(row.id as string) ?? null,
    })),
  });
}

/**
 * Delegates one item: `{ workspaceId, sourceNoteId, requestedOutcome,
 * contextNoteIds?, executor? }` → 201 `{ assignment }` in `queued`.
 */
export async function POST(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return authFailure(auth.error);
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const parsed = parseCreateAssignment(read.body);
  if (!parsed.ok) return assignmentError("invalid_payload");
  const input = parsed.value;
  const { data, error } = await auth.supabase.rpc("create_assignment", {
    p_workspace_id: input.workspaceId,
    p_source_note_id: input.sourceNoteId,
    p_requested_outcome: input.requestedOutcome,
    p_context_note_ids: input.contextNoteIds,
    p_executor_kind: input.executor,
    p_capabilities: null,
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
