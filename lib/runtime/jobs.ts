import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assignmentRunHandler, reconcileAssignmentJobs } from "@/lib/assignments/executor-server";
import type { JobHandler, JobQueue } from "./types";

// The application's job kinds (the registry the worker claims for) and the
// maintenance it runs before claiming. New kinds (D-04 reminders, I-05
// outbound actions) register here; their handlers live with their domain.

export function jobHandlers(admin: SupabaseClient): JobHandler[] {
  return [assignmentRunHandler(admin)];
}

/** Retention purge runs in one minute of each hour. */
export const PURGE_MINUTE = 17;

export function jobMaintenance(admin: SupabaseClient, queue: JobQueue, at: Date) {
  const tasks: { name: string; run: () => Promise<unknown> }[] = [
    {
      // Expired assignment leases → failed/timed_out; queued built-in work
      // whose executor is unavailable → executor_unavailable (ADR 003 §2).
      name: "assignment_leases",
      run: async () => {
        const { error } = await admin.rpc("reap_assignment_leases");
        if (error) throw new Error("reap failed");
      },
    },
    { name: "assignment_jobs", run: () => reconcileAssignmentJobs(admin, queue, { now: at.getTime() }) },
  ];
  if (at.getUTCMinutes() === PURGE_MINUTE) tasks.push({ name: "purge", run: () => queue.purge() });
  return tasks;
}
