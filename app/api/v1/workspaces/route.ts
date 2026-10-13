import { integrationUser, reply } from "@/lib/integrations/auth";

export async function GET(request: Request) {
  const auth = await integrationUser(request);
  if ("error" in auth) return auth.error;
  const { data, error } = await auth.supabase.from("workspaces")
    .select("id,name,color").eq("user_id", auth.user.id).eq("agent_enabled", true).order("position");
  if (error) return reply({ error: "Could not load workspaces" }, 500);
  return reply({ workspaces: data });
}
