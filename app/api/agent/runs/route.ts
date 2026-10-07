import { after } from "next/server";
import { routeUser, json } from "@/lib/supabase/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/notes";
import {
  RUN_COLUMNS,
  RUN_TIMEOUT_MS,
  createRun,
  executeRun,
} from "@/lib/agent/server";

// The run continues after the response, up to this limit.
export const maxDuration = 300;

/** Recent runs in a workspace and the changes each one made. */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!workspaceId || !isUuid(workspaceId))
    return json({ error: "Invalid workspace" }, 400);
  const admin = createAdminClient();
  // Runs the platform cut off never recorded an outcome.
  await admin
    ?.from("agent_runs")
    .update({
      status: "failed",
      error: "Timed out",
      finished_at: new Date().toISOString(),
    })
    .eq("user_id", auth.user.id)
    .eq("status", "running")
    .lt("created_at", new Date(Date.now() - RUN_TIMEOUT_MS).toISOString());

  const { data: runs, error } = await auth.supabase
    .from("agent_runs")
    .select(RUN_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return json({ error: "Couldn't load agent activity" }, 500);
  const { data: actions, error: actionError } = runs.length
    ? await auth.supabase
        .from("agent_actions")
        .select("id,run_id,note_id,kind,before,after,reason,created_at,undone_at")
        .in(
          "run_id",
          runs.map((r) => r.id),
        )
        .order("created_at")
    : { data: [], error: null };
  if (actionError) return json({ error: "Couldn't load agent activity" }, 500);
  return json({
    runs: runs.map((run) => ({
      ...run,
      actions: actions.filter((a) => a.run_id === run.id),
    })),
  });
}

/** Starts a run in the background and returns it right away. */
export async function POST(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin) return json({ error: "Not configured" }, 503);
  const { workspaceId, mode, instruction } = await request
    .json()
    .catch(() => ({}));
  if (typeof workspaceId !== "string" || !isUuid(workspaceId))
    return json({ error: "Invalid workspace" }, 400);
  if (mode !== "triage" && mode !== "organize")
    return json({ error: "Invalid mode" }, 400);
  if (
    instruction !== undefined &&
    (typeof instruction !== "string" || instruction.length > 2000)
  )
    return json({ error: "Instructions must be under 2,000 characters" }, 400);

  const { count } = await admin
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.user.id)
    .eq("workspace_id", workspaceId)
    .eq("status", "running")
    .gte("created_at", new Date(Date.now() - RUN_TIMEOUT_MS).toISOString());
  if (count) return json({ error: "The agent is already working here" }, 409);

  const run = {
    userId: auth.user.id,
    workspaceId,
    trigger: "manual",
    mode,
    instruction: instruction?.trim() || undefined,
  } as const;
  const created = await createRun(admin, run);
  if ("error" in created) return json({ error: created.error }, 400);
  after(() => executeRun(admin, created.runId, run));
  return json({ runId: created.runId });
}
