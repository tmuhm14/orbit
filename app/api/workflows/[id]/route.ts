import { routeUser, json } from "@/lib/supabase/route-auth";
import { WORKFLOW_COLUMNS, isUuid, parseUpdate, workflowFromRow, type WorkflowRow } from "@/lib/workflows/db";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Workflow not found" }, 404);
  const { data, error } = await auth.supabase.from("workflows").select(WORKFLOW_COLUMNS)
    .eq("id", id).maybeSingle<WorkflowRow>();
  if (error) return json({ error: "Could not load workflow" }, 500);
  if (!data) return json({ error: "Workflow not found" }, 404);
  return json({ workflow: workflowFromRow(data) });
}

/** Saves against the revision the client read; a stale revision gets 409 and the current copy. */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Workflow not found" }, 404);
  const input = parseUpdate(await request.json().catch(() => null));
  if (!input) return json({ error: "Check the workflow name and steps" }, 400);
  const { data, error } = await auth.supabase.from("workflows")
    .update({ ...input.changes, revision: input.revision + 1, updated_at: new Date().toISOString() })
    .eq("id", id).eq("revision", input.revision)
    .select(WORKFLOW_COLUMNS).maybeSingle<WorkflowRow>();
  if (error) return json({ error: "Could not save workflow" }, 500);
  if (data) return json({ workflow: workflowFromRow(data) });
  const current = await auth.supabase.from("workflows").select(WORKFLOW_COLUMNS)
    .eq("id", id).maybeSingle<WorkflowRow>();
  if (current.error) return json({ error: "Could not save workflow" }, 500);
  if (!current.data) return json({ error: "Workflow not found" }, 404);
  return json({ error: "This workflow changed elsewhere", workflow: workflowFromRow(current.data) }, 409);
}

export async function DELETE(request: Request, { params }: Params) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Workflow not found" }, 404);
  const { data, error } = await auth.supabase.from("workflows").delete().eq("id", id).select("id");
  if (error) return json({ error: "Could not delete workflow" }, 500);
  if (!data?.length) return json({ error: "Workflow not found" }, 404);
  return json({ ok: true });
}
