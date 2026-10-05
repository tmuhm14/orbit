import { routeUser, json } from "@/lib/supabase/route-auth";
import { isWorkspaceColor } from "@/lib/notes";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { name, color, position } = await request.json().catch(() => ({}));
  const changes: { name?: string; color?: string; position?: number } = {};
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 60)
      return json({ error: "Name must be 1–60 characters" }, 400);
    changes.name = name.trim();
  }
  if (color !== undefined) {
    if (!isWorkspaceColor(color)) return json({ error: "Unknown color" }, 400);
    changes.color = color;
  }
  if (position !== undefined) {
    if (!Number.isInteger(position) || position < 0 || position > 1000)
      return json({ error: "Invalid position" }, 400);
    changes.position = position;
  }
  if (!Object.keys(changes).length)
    return json({ error: "Nothing to change" }, 400);
  const { data, error } = await auth.supabase
    .from("workspaces")
    .update(changes)
    .eq("id", id)
    .select("id,name,position,color,inboxToken:inbox_token")
    .single();
  if (error) return json({ error: "Could not update workspace" }, 500);
  return json({ workspace: data });
}

/**
 * Deletes a workspace with its notes and Slack routing (database cascades).
 * The last remaining workspace can't be deleted.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { count } = await auth.supabase
    .from("workspaces")
    .select("id", { count: "exact", head: true });
  if ((count ?? 0) <= 1)
    return json({ error: "You need at least one workspace" }, 400);
  const { data, error } = await auth.supabase
    .from("workspaces")
    .delete()
    .eq("id", id)
    .select("id");
  if (error || !data.length)
    return json({ error: "Could not delete workspace" }, 500);
  return json({ deleted: id });
}
