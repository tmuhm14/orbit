import { routeUser, json } from "@/lib/supabase/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/notes";

// Columns an agent change can touch, and so the only ones undo restores.
const RESTORABLE = [
  "title",
  "bucket",
  "tags",
  "completed_at",
  "content",
  "plain_text",
  "triage_status",
];

/** Reverts one agent change: restores the replaced values, or removes a created note. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin) return json({ error: "Not configured" }, 503);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Invalid change" }, 400);

  const { data: action } = await admin
    .from("agent_actions")
    .select("id,note_id,kind,before,undone_at")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .maybeSingle<{
      id: string;
      note_id: string;
      kind: "update" | "create";
      before: Record<string, unknown> | null;
      undone_at: string | null;
    }>();
  if (!action) return json({ error: "Change not found" }, 404);
  if (action.undone_at) return json({ error: "Already undone" }, 409);

  if (action.kind === "create") {
    const { error } = await admin
      .from("notes")
      .delete()
      .eq("id", action.note_id)
      .eq("user_id", auth.user.id);
    if (error) return json({ error: "Couldn't undo that change" }, 500);
  } else {
    const restore = Object.fromEntries(
      Object.entries(action.before ?? {}).filter(([k]) =>
        RESTORABLE.includes(k),
      ),
    );
    const { data: updated, error } = await admin
      .from("notes")
      .update({ ...restore, updated_at: new Date().toISOString() })
      .eq("id", action.note_id)
      .eq("user_id", auth.user.id)
      .select("id");
    if (error) return json({ error: "Couldn't undo that change" }, 500);
    if (!updated.length)
      return json({ error: "That note has been deleted" }, 404);
  }
  await admin
    .from("agent_actions")
    .update({ undone_at: new Date().toISOString() })
    .eq("id", action.id);
  return json({ undone: action.id });
}
