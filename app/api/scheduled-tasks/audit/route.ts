import { routeUser, json } from "@/lib/supabase/route-auth";
import type { RunRow, ScheduledTask } from "@/lib/scheduled/server";

const TASK_COLUMNS = "id,user_id,name,kind,enabled,timezone,delivery_hour,cadence,jira_projects,github_repos,created_at";
const RUN_COLUMNS = "id,task_id,report_date,trigger,status,report,error,created_at,finished_at";
const PAGE_SIZE = 50;

export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const before = new URL(request.url).searchParams.get("before");
  if (before && (before.length > 40 || !Number.isFinite(Date.parse(before))))
    return json({ error: "Invalid history cursor" }, 400);
  let runsQuery = auth.supabase.from("scheduled_task_runs").select(RUN_COLUMNS)
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE + 1);
  if (before) runsQuery = runsQuery.lt("created_at", before);
  const [tasks, runs] = await Promise.all([
    auth.supabase.from("scheduled_tasks").select(TASK_COLUMNS)
      .eq("user_id", auth.user.id).order("created_at")
      .returns<ScheduledTask[]>(),
    runsQuery.returns<RunRow[]>(),
  ]);
  if (tasks.error || runs.error)
    return json({ error: "Could not load job history" }, 500);
  return json({
    tasks: tasks.data ?? [],
    runs: (runs.data ?? []).slice(0, PAGE_SIZE),
    hasMore: (runs.data?.length ?? 0) > PAGE_SIZE,
  });
}
