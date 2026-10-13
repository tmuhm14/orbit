import { createAdminClient } from "@/lib/supabase/admin";
import { dueReportDate } from "@/lib/scheduled/schedule";
import { runScheduledTask, type ScheduledTask } from "@/lib/scheduled/server";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ slot: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return new Response("Unauthorized", { status: 401 });
  const { slot } = await params;
  if (!/^\d{2}$/.test(slot) || Number(slot) > 23)
    return new Response("Invalid slot", { status: 400 });
  const now = new Date();
  const scheduledInstant = new Date(now);
  scheduledInstant.setUTCHours(Number(slot), 0, 0, 0);
  const admin = createAdminClient();
  if (!admin) return new Response("Unavailable", { status: 503 });
  const { data: tasks, error } = await admin.from("scheduled_tasks")
    .select("id,user_id,name,kind,enabled,timezone,delivery_hour,cadence,jira_projects,github_repos,created_at")
    .eq("enabled", true).returns<ScheduledTask[]>();
  if (error) return new Response("Unavailable", { status: 500 });
  let completed = 0, failed = 0;
  for (const task of tasks ?? []) {
    const date = dueReportDate(task, scheduledInstant);
    if (!date) continue;
    try {
      const run = await runScheduledTask(admin, task, date, "scheduled");
      if (run) completed++;
    } catch {
      failed++;
    }
  }
  return Response.json({ completed, failed });
}
