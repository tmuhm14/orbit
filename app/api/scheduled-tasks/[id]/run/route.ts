import { routeUser, json } from "@/lib/supabase/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/notes";
import { runScheduledTask, type ScheduledTask } from "@/lib/scheduled/server";
import { localDate, previousDate } from "@/lib/scheduled/schedule";

export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Invalid task" }, 400);
  const { data: task, error } = await auth.supabase.from("scheduled_tasks")
    .select("id,user_id,name,kind,enabled,timezone,delivery_hour,cadence,jira_projects,github_repos,created_at")
    .eq("id", id).maybeSingle<ScheduledTask>();
  if (error) return json({ error: "Could not load task" }, 500);
  if (!task) return json({ error: "Task not found" }, 404);
  const admin = createAdminClient();
  if (!admin) return json({ error: "Scheduled tasks are not configured" }, 503);
  try {
    const reportDate = previousDate(localDate(new Date(), task.timezone));
    const run = await runScheduledTask(admin, task, reportDate, "manual");
    return json({ run });
  } catch (failure) {
    return json({ error: failure instanceof Error ? failure.message : "Could not run task" }, 500);
  }
}
