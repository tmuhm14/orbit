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

/**
 * The user's assignments in one workspace, newest first (ADR 003 §5). No
 * artifact content. Expired leases of the caller's assignments are reaped
 * first, so a stalled run shows as failed instead of running forever.
 */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return authFailure(auth.error);
  const query = parseListQuery(new URL(request.url).searchParams);
  if (!query.ok) return assignmentError("invalid_payload");
  const { workspaceId, states, limit } = query.value;
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
  if (states) select = select.in("state", states);
  const { data, error } = await select
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<Record<string, unknown>[]>();
  if (error) return assignmentError("load_failed");
  return json({ assignments: data.map(fromAssignmentRow) });
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
  return response ?? assignmentError("save_failed");
}
