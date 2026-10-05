import { routeUser, json } from "@/lib/supabase/route-auth";
import { isWorkspaceColor } from "@/lib/notes";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { name, color } = await request.json().catch(() => ({}));
  const changes: { name?: string; color?: string } = {};
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 60)
      return json({ error: "Name must be 1–60 characters" }, 400);
    changes.name = name.trim();
  }
  if (color !== undefined) {
    if (!isWorkspaceColor(color)) return json({ error: "Unknown color" }, 400);
    changes.color = color;
  }
  if (!Object.keys(changes).length)
    return json({ error: "Nothing to change" }, 400);
  const { data, error } = await auth.supabase
    .from("workspaces")
    .update(changes)
    .eq("id", id)
    .select("id,name,position,color")
    .single();
  if (error) return json({ error: "Could not update workspace" }, 500);
  return json({ workspace: data });
}
