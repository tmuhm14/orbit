import { routeUser, json } from "@/lib/supabase/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { agentEncryptionKey } from "@/lib/agent/server";
import { loadConnection } from "@/lib/scheduled/server";
import { buildJiraDashboard } from "@/lib/jira/dashboard";
import { JIRA_WINDOWS, type JiraWindow } from "@/lib/jira/view";

/**
 * GET /api/jira/dashboard?days=7|14|30: the signed-in user's Jira dashboard,
 * read live with their saved Jira connection. Nothing is stored.
 */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin || !agentEncryptionKey())
    return json({ error: "Jira is not configured on this server" }, 503);
  const days = Number(new URL(request.url).searchParams.get("days") ?? 7);
  if (!(JIRA_WINDOWS as readonly number[]).includes(days))
    return json({ error: "Choose 7, 14, or 30 days" }, 400);
  const [connection, tasks] = await Promise.all([
    loadConnection(admin, auth.user.id),
    auth.supabase.from("scheduled_tasks").select("jira_projects").returns<{ jira_projects: string[] }[]>(),
  ]);
  if (!connection.public.jiraConnected)
    return json({ error: "Connect Jira in Settings to see your dashboard", code: "not_connected" }, 409);
  const dashboard = await buildJiraDashboard(connection.credentials, {
    days: days as JiraWindow,
    configuredProjects: (tasks.data ?? []).flatMap((task) => task.jira_projects ?? []),
  });
  return json({ dashboard });
}
