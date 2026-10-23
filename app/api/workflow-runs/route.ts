import { routeUser, json } from "@/lib/supabase/route-auth";
import { RUN_COLUMNS, RUN_PAGE_SIZE, parseRecord, parseRunQuery, runFromRow, type RunRow } from "@/lib/workflows/runs";

/**
 * GET /api/workflow-runs?workspaceId=[&workflowId=][&itemId=][&status=][&before=]
 * — the space's runs, newest start first, one page at a time. `itemId` keeps
 * runs that started from or touched that item.
 */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const query = parseRunQuery(new URL(request.url).searchParams);
  if (!query) return json({ error: "Check the run filters" }, 400);
  let runIds: string[] | null = null;
  if (query.itemId) {
    const { data, error } = await auth.supabase.from("workflow_run_items").select("run_id")
      .eq("workspace_id", query.workspaceId).eq("item_id", query.itemId)
      .returns<{ run_id: string }[]>();
    if (error) return json({ error: "Could not load runs" }, 500);
    runIds = [...new Set((data ?? []).map((r) => r.run_id))];
    if (!runIds.length) return json({ runs: [], more: false });
  }
  let select = auth.supabase.from("workflow_runs").select(RUN_COLUMNS).eq("workspace_id", query.workspaceId);
  if (query.workflowId) select = select.eq("workflow_id", query.workflowId);
  if (query.status) select = select.eq("status", query.status);
  if (query.before) select = select.lt("started_at", query.before);
  if (runIds) select = select.in("id", runIds);
  // One extra row says whether another page exists.
  const { data, error } = await select.order("started_at", { ascending: false })
    .limit(RUN_PAGE_SIZE + 1).returns<RunRow[]>();
  if (error) return json({ error: "Could not load runs" }, 500);
  const rows = data ?? [];
  return json({ runs: rows.slice(0, RUN_PAGE_SIZE).map(runFromRow), more: rows.length > RUN_PAGE_SIZE });
}

/** POST /api/workflow-runs — records a finished designer test run. */
export async function POST(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const input = parseRecord(await request.json().catch(() => null));
  if (!input) return json({ error: "Check the run details" }, 400);
  const workflow = await auth.supabase.from("workflows").select("id,workspace_id,name,revision")
    .eq("id", input.workflowId)
    .maybeSingle<{ id: string; workspace_id: string; name: string; revision: number }>();
  if (workflow.error) return json({ error: "Could not record run" }, 500);
  if (!workflow.data) return json({ error: "Workflow not found" }, 404);
  const workspaceId = workflow.data.workspace_id;
  if (input.sourceItemId) {
    const item = await auth.supabase.from("notes").select("id")
      .eq("id", input.sourceItemId).eq("workspace_id", workspaceId).maybeSingle<{ id: string }>();
    if (item.error) return json({ error: "Could not record run" }, 500);
    if (!item.data) return json({ error: "Item not found in this space" }, 400);
  }
  const { data, error } = await auth.supabase.from("workflow_runs")
    .insert({
      user_id: auth.user.id,
      workspace_id: workspaceId,
      workflow_id: workflow.data.id,
      workflow_name: workflow.data.name,
      workflow_revision: workflow.data.revision,
      mode: "test",
      trigger: "manual",
      status: input.status,
      error_code: input.errorCode,
      steps: input.steps,
      started_at: new Date(input.startedAt).toISOString(),
      finished_at: new Date(input.finishedAt).toISOString(),
    })
    .select(RUN_COLUMNS).single<RunRow>();
  if (error || !data) return json({ error: "Could not record run" }, 500);
  if (!input.sourceItemId) return json({ run: runFromRow(data) }, 201);
  const link = await auth.supabase.from("workflow_run_items").insert({
    run_id: data.id, item_id: input.sourceItemId, workspace_id: workspaceId, user_id: auth.user.id, role: "source",
  });
  if (link.error) {
    // Keep history honest: no run without the item it started from.
    await auth.supabase.from("workflow_runs").delete().eq("id", data.id);
    return json({ error: "Could not record run" }, 500);
  }
  return json({ run: runFromRow({ ...data, workflow_run_items: [{ item_id: input.sourceItemId, role: "source" }] }) }, 201);
}
