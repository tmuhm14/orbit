import { routeUser, json } from "@/lib/supabase/route-auth";

type LinkKey = {
  teamId?: unknown;
  slackUserId?: unknown;
  workspaceId?: unknown;
};

const isKey = (
  body: LinkKey,
): body is LinkKey & { teamId: string; slackUserId: string } =>
  typeof body.teamId === "string" && typeof body.slackUserId === "string";

/** Sends a linked Slack workspace's captures to a different Orbit workspace. */
export async function PATCH(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const body: LinkKey = await request.json().catch(() => ({}));
  if (!isKey(body) || typeof body.workspaceId !== "string")
    return json({ error: "Invalid request" }, 400);
  // Row-level security limits this to the user's own links, and the composite
  // foreign key rejects a workspace that belongs to someone else.
  const { error } = await auth.supabase
    .from("slack_links")
    .update({ workspace_id: body.workspaceId })
    .eq("slack_team_id", body.teamId)
    .eq("slack_user_id", body.slackUserId);
  if (error) return json({ error: "Could not update Slack connection" }, 500);
  return json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const body: LinkKey = await request.json().catch(() => ({}));
  if (!isKey(body)) return json({ error: "Invalid request" }, 400);
  const { error } = await auth.supabase
    .from("slack_links")
    .delete()
    .eq("slack_team_id", body.teamId)
    .eq("slack_user_id", body.slackUserId);
  if (error) return json({ error: "Could not disconnect Slack" }, 500);
  return json({ ok: true });
}
