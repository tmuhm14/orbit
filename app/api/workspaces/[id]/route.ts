import { routeUser, json } from "@/lib/supabase/route-auth";
import { WORKSPACE_COLUMNS } from "@/lib/workspaces-db";
import { isWorkspaceColor } from "@/lib/notes";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { name, color, agentEnabled } = await request.json().catch(() => ({}));
  const changes: { name?: string; color?: string; agent_enabled?: boolean } =
    {};
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 60)
      return json({ error: "Name must be 1–60 characters" }, 400);
    changes.name = name.trim();
  }
  if (color !== undefined) {
    if (!isWorkspaceColor(color)) return json({ error: "Unknown color" }, 400);
    changes.color = color;
  }
  if (agentEnabled !== undefined) {
    if (typeof agentEnabled !== "boolean")
      return json({ error: "Invalid agent setting" }, 400);
    changes.agent_enabled = agentEnabled;
  }
  if (!Object.keys(changes).length)
    return json({ error: "Nothing to change" }, 400);
  const { data, error } = await auth.supabase
    .from("workspaces")
    .update(changes)
    .eq("id", id)
    .select(WORKSPACE_COLUMNS)
    .single();
  if (error) return json({ error: "Could not update workspace" }, 500);
  return json({ workspace: data });
}
