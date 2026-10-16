import { createAdminClient } from "@/lib/supabase/admin";
import { postgresJobQueue } from "@/lib/runtime/postgres";
import { jobHandlers, jobMaintenance } from "@/lib/runtime/jobs";
import { WORKER_DEADLINE_MARGIN_MS, runWorker, workerId } from "@/lib/runtime/worker";

// The durable-jobs worker (A-04, ADR 006), invoked every minute by Vercel
// cron. 300 s is within Vercel Pro's limit without Fluid compute and leaves
// the built-in executor its 240 s budget plus a 30 s margin. Overlapping
// invocations are safe: claims use FOR UPDATE SKIP LOCKED and leases.
export const maxDuration = 300;
export const runtime = "nodejs";

/**
 * Reaps expired job and assignment leases, reconciles queued assignments
 * with their jobs, then claims and runs ready jobs until the queue is empty
 * or too little time is left. Authenticated with CRON_SECRET like the
 * scheduler tick. Responds with counts only.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return new Response("Unauthorized", { status: 401 });
  const startedAt = Date.now();
  const admin = createAdminClient();
  if (!admin) return new Response("Unavailable", { status: 503 });
  const queue = postgresJobQueue(admin);
  const summary = await runWorker({
    queue,
    handlers: jobHandlers(admin),
    workerId: workerId("cron"),
    deadlineAt: startedAt + maxDuration * 1000 - WORKER_DEADLINE_MARGIN_MS,
    maintenance: jobMaintenance(admin, queue, new Date(startedAt)),
  });
  return Response.json(summary);
}
