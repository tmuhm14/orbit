import { routeUser, json } from "@/lib/supabase/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { agentEncryptionKey } from "@/lib/agent/server";
import { loadConnection, type RunRow, type ScheduledTask } from "@/lib/scheduled/server";
import { parseTaskInput } from "@/lib/scheduled/validation";

const TASK_COLUMNS = "id,user_id,name,kind,enabled,timezone,delivery_hour,cadence,jira_projects,github_repos,created_at";
const RUN_COLUMNS = "id,task_id,report_date,trigger,status,report,error,created_at,finished_at";

export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin || !agentEncryptionKey())
    return json({ error: "Scheduled tasks are not configured on this server" }, 503);
  const [tasks, runs, connection] = await Promise.all([
    auth.supabase.from("scheduled_tasks").select(TASK_COLUMNS)
      .order("created_at").returns<ScheduledTask[]>(),
    auth.supabase.from("scheduled_task_runs").select(RUN_COLUMNS)
      .order("created_at", { ascending: false }).limit(30).returns<RunRow[]>(),
    loadConnection(admin, auth.user.id),
  ]);
  if (tasks.error || runs.error)
    return json({ error: "Could not load scheduled work" }, 500);
  return json({ tasks: tasks.data, runs: runs.data, connection: connection.public });
}

export async function POST(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const input = parseTaskInput(await request.json().catch(() => null));
  if (!input) return json({ error: "Check the task name, schedule, and sources" }, 400);
  const { count, error: countError } = await auth.supabase.from("scheduled_tasks")
    .select("id", { count: "exact", head: true });
  if (countError) return json({ error: "Could not check scheduled tasks" }, 500);
  if ((count ?? 0) >= 20) return json({ error: "Task limit reached" }, 400);
  if (input.enabled) {
    const admin = createAdminClient();
    if (!admin) return json({ error: "Scheduled tasks are not configured" }, 503);
    const connection = await loadConnection(admin, auth.user.id);
    if ((input.jira_projects.length && !connection.public.jiraConnected) ||
        (input.github_repos.length && !connection.public.githubConnected))
      return json({ error: "Connect the selected sources before enabling" }, 400);
  }
  const { data, error } = await auth.supabase.from("scheduled_tasks")
    .insert({ ...input, user_id: auth.user.id })
    .select(TASK_COLUMNS).single<ScheduledTask>();
  if (error || !data) return json({ error: "Could not create task" }, 500);
  return json({ task: data }, 201);
}
