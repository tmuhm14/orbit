import { routeUser, json } from "@/lib/supabase/route-auth";
import {
  WORKFLOW_COLUMNS, WORKFLOW_LIMIT, isUuid, parseCreate, workflowFromRow, type WorkflowRow,
} from "@/lib/workflows/db";

/** GET /api/workflows?workspaceId= — the space's workflows, newest change first. */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!isUuid(workspaceId)) return json({ error: "Choose a workspace" }, 400);
  const { data, error } = await auth.supabase.from("workflows").select(WORKFLOW_COLUMNS)
    .eq("workspace_id", workspaceId).order("updated_at", { ascending: false })
    .limit(WORKFLOW_LIMIT).returns<WorkflowRow[]>();
  if (error) return json({ error: "Could not load workflows" }, 500);
  return json({ workflows: (data ?? []).map(workflowFromRow) });
}

export async function POST(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const input = parseCreate(await request.json().catch(() => null));
  if (!input) return json({ error: "Check the workflow name and steps" }, 400);
  const { count, error: countError } = await auth.supabase.from("workflows")
    .select("id", { count: "exact", head: true }).eq("workspace_id", input.workspaceId);
  if (countError) return json({ error: "Could not check workflows" }, 500);
  if ((count ?? 0) >= WORKFLOW_LIMIT) return json({ error: "Workflow limit reached for this space" }, 400);
  const { data, error } = await auth.supabase.from("workflows")
    .insert({
      user_id: auth.user.id,
      workspace_id: input.workspaceId,
      name: input.name,
      description: input.description,
      definition: input.definition,
    })
    .select(WORKFLOW_COLUMNS).single<WorkflowRow>();
  // An unknown or foreign workspace fails the composite foreign key.
  if (error || !data) return json({ error: "Could not create workflow" }, 500);
  return json({ workflow: workflowFromRow(data) }, 201);
}
