import { allowed, integrationAuth, reply } from "@/lib/integrations/auth";
import { grantedWorkspaces } from "@/lib/grants/server";

/**
 * API keys: only workspaces the key holds a grant in (kill switch on), each
 * with its capabilities. User tokens: every agent-enabled workspace, with
 * today's implied capabilities.
 */
export async function GET(request: Request) {
  const auth = await integrationAuth(request, "workspace.list");
  if ("error" in auth) return auth.error;
  const granted = auth.principal.type === "agent_client" ? grantedWorkspaces(auth.principal.grants) : null;
  if (granted && granted.size === 0) {
    await allowed(auth, "workspace.list", null);
    return reply({ workspaces: [] }, 200, auth.headers);
  }
  let query = auth.db.from("workspaces").select("id,name,color")
    .eq("user_id", auth.userId).eq("agent_enabled", true);
  if (granted) query = query.in("id", [...granted.keys()]);
  const { data, error } = await query.order("position");
  if (error) return reply({ error: "Could not load workspaces" }, 500, auth.headers);
  await allowed(auth, "workspace.list", null);
  const rows = (data ?? []) as { id: string; name: string; color: string | null }[];
  return reply({
    workspaces: rows.map((w) => ({ ...w,
      capabilities: granted ? [...new Set(granted.get(w.id) ?? [])].sort() : ["item.write", "workspace.read"] })),
  }, 200, auth.headers);
}
