import { routeUser, json } from "@/lib/supabase/route-auth";

/** The user's most recent access audit events (content-free; 90-day retention). */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const raw = new URL(request.url).searchParams.get("limit");
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return json({ error: "limit must be 1–200" }, 400);
  const { data, error } = await auth.supabase.from("access_audit_events")
    .select("id,principal_type,principal_id,operation,workspace_id,resource_id,outcome,code,occurred_at")
    .eq("user_id", auth.user.id).order("occurred_at", { ascending: false }).order("id", { ascending: false })
    .limit(limit);
  if (error) return json({ error: "Could not load the access log" }, 500);
  type Row = { id: number; principal_type: string; principal_id: string | null; operation: string;
    workspace_id: string | null; resource_id: string | null; outcome: string; code: string | null; occurred_at: string };
  return json({
    events: ((data ?? []) as Row[]).map((e) => ({
      id: e.id, principalType: e.principal_type, clientId: e.principal_id, operation: e.operation,
      workspaceId: e.workspace_id, resourceId: e.resource_id, outcome: e.outcome, code: e.code, occurredAt: e.occurred_at,
    })),
  });
}
