import { routeUser, json } from "@/lib/supabase/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/notes";
import { loadConnection, type ScheduledTask } from "@/lib/scheduled/server";
import { parseTaskInput } from "@/lib/scheduled/validation";

const COLUMNS = "id,user_id,name,kind,enabled,timezone,delivery_hour,cadence,jira_projects,github_repos,created_at";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Invalid task" }, 400);
  const input = parseTaskInput(await request.json().catch(() => null));
  if (!input) return json({ error: "Check the task name, schedule, and sources" }, 400);
  if (input.enabled) {
    const admin = createAdminClient();
    if (!admin) return json({ error: "Scheduled tasks are not configured" }, 503);
    const connection = await loadConnection(admin, auth.user.id);
    if ((input.jira_projects.length && !connection.public.jiraConnected) ||
        (input.github_repos.length && !connection.public.githubConnected))
      return json({ error: "Connect the selected sources before enabling" }, 400);
  }
  const { data, error } = await auth.supabase.from("scheduled_tasks")
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", auth.user.id)
    .select(COLUMNS).maybeSingle<ScheduledTask>();
  if (error) return json({ error: "Could not save task" }, 500);
  if (!data) return json({ error: "Task not found" }, 404);
  return json({ task: data });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Invalid task" }, 400);
  const { error } = await auth.supabase.from("scheduled_tasks")
    .delete().eq("id", id).eq("user_id", auth.user.id);
  if (error) return json({ error: "Could not remove task" }, 500);
  return json({ removed: true });
}
