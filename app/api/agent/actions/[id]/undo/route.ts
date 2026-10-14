import { routeUser, json } from "@/lib/supabase/route-auth";
import { isUuid } from "@/lib/notes";

type UndoResult =
  | { status: "undone"; undone: string; revision: number | null; alreadyDeleted?: boolean }
  | {
      status: "undo_conflict";
      fields: string[];
      /** Set when restoring kind or project_id would break a project rule. */
      reason?: string;
    }
  | {
      status:
        | "not_found"
        | "already_undone"
        | "undo_expired"
        | "note_deleted"
        | "edited_since_created"
        | "project_has_linked_items";
    };

// Messages carry no note content; conflicts list column names only.
const FAILURES = {
  not_found: [404, "Change not found"],
  already_undone: [409, "Already undone"],
  undo_conflict: [409, "That note was changed since, so this can't be undone"],
  edited_since_created: [409, "That note was edited after the agent created it"],
  project_has_linked_items: [409, "That project has linked items"],
  note_deleted: [404, "That note has been deleted"],
  undo_expired: [410, "Changes can only be undone for 90 days"],
} as const;

/**
 * Reverts one agent change through undo_agent_action(), which never erases
 * later edits or silently deletes an edited note (ADR 002 §5).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Invalid change", code: "invalid_payload" }, 400);
  const { data, error } = await auth.supabase.rpc("undo_agent_action", {
    p_action_id: id,
  });
  const result = data as UndoResult | null;
  if (error || !result)
    return json({ error: "Couldn't undo that change", code: "undo_failed" }, 500);
  if (result.status === "undone")
    return json({
      undone: result.undone,
      revision: result.revision,
      ...(result.alreadyDeleted ? { alreadyDeleted: true } : {}),
    });
  const failure = FAILURES[result.status];
  if (!failure)
    return json({ error: "Couldn't undo that change", code: "undo_failed" }, 500);
  const [status, message] = failure;
  return json(
    {
      error: message,
      code: result.status,
      ...(result.status === "undo_conflict"
        ? { fields: result.fields, ...(result.reason ? { reason: result.reason } : {}) }
        : {}),
    },
    status,
  );
}
