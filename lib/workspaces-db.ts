import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SlackConnection, Workspace } from "./notes";

type SlackLinkRow = {
  slack_team_id: string;
  slack_team_name: string | null;
  slack_user_id: string;
  workspace_id: string;
};

export function fromSlackLinkRow(row: SlackLinkRow): SlackConnection {
  return {
    teamId: row.slack_team_id,
    teamName: row.slack_team_name,
    slackUserId: row.slack_user_id,
    workspaceId: row.workspace_id,
  };
}

/**
 * The signed-in user's workspaces (creating Personal on first use) and Slack
 * links. Uses the user's session, so row-level security scopes both reads.
 */
export async function loadWorkspaces(
  supabase: SupabaseClient,
): Promise<{ workspaces: Workspace[]; slack: SlackConnection[] } | null> {
  const list = () =>
    supabase
      .from("workspaces")
      .select("id,name,position,color,inboxToken:inbox_token")
      .order("position")
      .order("created_at")
      .returns<Workspace[]>();
  let { data: workspaces, error } = await list();
  if (error || !workspaces) return null;
  if (!workspaces.length) {
    await supabase.from("workspaces").insert({ name: "Personal" });
    ({ data: workspaces, error } = await list());
    if (error || !workspaces?.length) return null;
  }
  const { data: links, error: linkError } = await supabase
    .from("slack_links")
    .select("slack_team_id,slack_team_name,slack_user_id,workspace_id")
    .returns<SlackLinkRow[]>();
  if (linkError) return null;
  return { workspaces, slack: links.map(fromSlackLinkRow) };
}
