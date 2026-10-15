import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recoverQueuedAssignments, routeDeadline } from "@/lib/assignments/executor-server";
import { dueReportDate } from "@/lib/scheduled/schedule";
import { runScheduledTask, type ScheduledTask } from "@/lib/scheduled/server";

export const maxDuration = 300;
export const runtime = "nodejs";

// Agent action values (copies of note content) are kept 90 days, the same as
// the undo window (ADR 002 §5). Purged once a day from this one slot; the
// purge only clears values older than the window, so a repeated or retried
// tick is harmless.
const PURGE_SLOT = "03";

// Assignment leases (ADR 003 §2): before durable execution, an expired lease
// ends in failed/timed_out, and queued built-in work whose executor is
// unavailable fails with executor_unavailable. Assignment reads reap the
// caller's own rows; this daily slot is the backstop for everyone else.
// Repeating it is harmless.
const REAP_SLOT = "04";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

async function reapAssignmentLeases(admin: Admin) {
  try {
    const { data, error } = await admin.rpc("reap_assignment_leases");
    if (error) throw new Error("reap failed");
    const counts = (data ?? {}) as { timedOut?: number; unavailable?: number };
    return { timedOut: Number(counts.timedOut) || 0, unavailable: Number(counts.unavailable) || 0 };
  } catch {
    // Counts only; never ids or content.
    console.error("assignment lease reap failed");
    return null;
  }
}

// Built-in assignments still queued after their kickoff was lost (A-02):
// every tick starts a few of them in the background, after the response,
// within this route's maxDuration. Counts only in logs.
async function recoverAssignments(admin: Admin, startedAt: number) {
  try {
    await recoverQueuedAssignments(admin, { deadlineAt: routeDeadline(startedAt) });
  } catch {
    console.error("assignment recovery failed");
  }
}

async function purgeAgentActionValues(admin: NonNullable<ReturnType<typeof createAdminClient>>) {
  try {
    const { data, error } = await admin.rpc("purge_agent_action_values");
    if (error) throw new Error("purge failed");
    return Number(data) || 0;
  } catch {
    // Counts only; never ids or content.
    console.error("agent action purge failed");
    return null;
  }
}

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
  const purged = slot === PURGE_SLOT ? await purgeAgentActionValues(admin) : undefined;
  const reaped = slot === REAP_SLOT ? await reapAssignmentLeases(admin) : undefined;
  const startedAt = now.getTime();
  after(() => recoverAssignments(admin, startedAt));
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
  return Response.json({
    completed,
    failed,
    ...(purged !== undefined ? { purged } : {}),
    ...(reaped !== undefined ? { reaped } : {}),
  });
}
