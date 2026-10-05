"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { verifyLinkToken } from "@/lib/slack";

export async function linkSlackAccount(form: FormData) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  const admin = createAdminClient();
  const token = String(form.get("token") || "");
  const identity = secret ? verifyLinkToken(token, secret) : null;
  if (!identity || !admin) redirect("/slack/link?status=expired");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  // Read through the user's session so only their own workspace can be chosen.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", String(form.get("workspace") || ""))
    .maybeSingle();
  if (!workspace) redirect("/slack/link?status=failed");
  // The token proves control of the Slack account; the session proves the
  // Orbit account. Re-linking moves the Slack account to this Orbit account.
  const { error } = await admin.from("slack_links").upsert({
    slack_team_id: identity.teamId,
    slack_user_id: identity.userId,
    slack_team_name: identity.teamName ?? null,
    user_id: user.id,
    workspace_id: workspace.id,
  });
  redirect(`/slack/link?status=${error ? "failed" : "linked"}`);
}
