import { routeUser, json } from "@/lib/supabase/route-auth";
import { isUuid } from "@/lib/workflows/db";
import { RUN_DETAIL_COLUMNS, runFromRow, type RunRow } from "@/lib/workflows/runs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/workflow-runs/[id] — one run with its steps and items. */
export async function GET(request: Request, { params }: Params) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Run not found" }, 404);
  const { data, error } = await auth.supabase.from("workflow_runs").select(RUN_DETAIL_COLUMNS)
    .eq("id", id).maybeSingle<RunRow>();
  if (error) return json({ error: "Could not load run" }, 500);
  if (!data) return json({ error: "Run not found" }, 404);
  return json({ run: runFromRow(data) });
}
