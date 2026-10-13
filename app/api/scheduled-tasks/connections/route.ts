import { routeUser, json } from "@/lib/supabase/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { agentEncryptionKey } from "@/lib/agent/server";
import { encryptSecret, keyHint } from "@/lib/agent/secret";
import { loadConnection } from "@/lib/scheduled/server";

const jiraSite = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname.endsWith(".atlassian.net") ||
        url.username || url.password || url.port || url.pathname !== "/" ||
        url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
};

export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin || !agentEncryptionKey())
    return json({ error: "Connections are not configured on this server" }, 503);
  const connection = await loadConnection(admin, auth.user.id);
  return json({ connection: connection.public });
}

export async function PUT(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  const encryptionKey = agentEncryptionKey();
  if (!admin || !encryptionKey)
    return json({ error: "Scheduled tasks are not configured on this server" }, 503);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid settings" }, 400);
  if (body.source === "jira" || body.source === "github") {
    const existing = await loadConnection(admin, auth.user.id);
    let changes: Record<string, string | null>;
    if (body.source === "jira") {
      const site = jiraSite(body.jiraSite);
      const email = typeof body.jiraEmail === "string" ? body.jiraEmail.trim() : "";
      const suppliedToken = typeof body.jiraToken === "string" ? body.jiraToken.trim() : "";
      const token = suppliedToken || existing.credentials.jiraToken;
      if (!site || !/^\S+@\S+\.\S+$/.test(email) || email.length > 250 ||
          !token || token.length < 10 || token.length > 500)
        return json({ error: "Enter a valid Jira site, email, and API token" }, 400);
      try {
        const response = await fetch(`${site}/rest/api/3/myself`, {
          headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000), cache: "no-store", redirect: "error",
        });
        if (!response.ok) return json({ error: "Jira did not accept those credentials" }, 400);
      } catch { return json({ error: "Could not check Jira" }, 502); }
      changes = {
        jira_site: site, jira_email: email,
        jira_token_ciphertext: encryptSecret(token, encryptionKey),
        jira_key_hint: keyHint(token),
      };
    } else {
      const token = typeof body.githubToken === "string" ? body.githubToken.trim() : "";
      if (token.length < 10 || token.length > 500)
        return json({ error: "Enter a valid GitHub token" }, 400);
      try {
        const response = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          signal: AbortSignal.timeout(15_000), cache: "no-store", redirect: "error",
        });
        if (!response.ok) return json({ error: "GitHub did not accept that token" }, 400);
      } catch { return json({ error: "Could not check GitHub" }, 502); }
      changes = {
        github_token_ciphertext: encryptSecret(token, encryptionKey),
        github_key_hint: keyHint(token),
      };
    }
    const { data: row, error: lookupError } = await admin.from("scheduled_integrations")
      .select("user_id").eq("user_id", auth.user.id).maybeSingle();
    if (lookupError) return json({ error: "Could not save connection" }, 500);
    const query = row
      ? admin.from("scheduled_integrations").update({ ...changes, updated_at: new Date().toISOString() }).eq("user_id", auth.user.id)
      : admin.from("scheduled_integrations").insert({ ...changes, user_id: auth.user.id });
    const { error } = await query;
    if (error) return json({ error: "Could not save connection" }, 500);
    const connection = await loadConnection(admin, auth.user.id);
    return json({ connection: connection.public });
  }
  const site = jiraSite(body.jiraSite);
  const email = typeof body.jiraEmail === "string" ? body.jiraEmail.trim() : "";
  const jiraToken = typeof body.jiraToken === "string" ? body.jiraToken.trim() : "";
  const githubToken = typeof body.githubToken === "string" ? body.githubToken.trim() : "";
  if ((body.jiraSite && !site) || (email && (!/^\S+@\S+\.\S+$/.test(email) || email.length > 250)) ||
      jiraToken.length > 500 || githubToken.length > 500 ||
      (jiraToken && jiraToken.length < 10) || (githubToken && githubToken.length < 10))
    return json({ error: "Check the Jira address, email, and tokens" }, 400);
  const existing = await loadConnection(admin, auth.user.id);
  const chosenSite = site ?? existing.credentials.jiraSite;
  const chosenEmail = email || existing.credentials.jiraEmail;
  const chosenJiraToken = jiraToken || existing.credentials.jiraToken;
  const chosenGithubToken = githubToken || existing.credentials.githubToken;
  if ((chosenSite || chosenEmail || chosenJiraToken) &&
      !(chosenSite && chosenEmail && chosenJiraToken))
    return json({ error: "Enter the Jira site, email, and token together" }, 400);

  try {
    if (chosenJiraToken) {
      const response = await fetch(`${chosenSite}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${Buffer.from(`${chosenEmail}:${chosenJiraToken}`).toString("base64")}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000), cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) return json({ error: "Jira did not accept those credentials" }, 400);
    }
    if (chosenGithubToken) {
      const response = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${chosenGithubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(15_000), cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) return json({ error: "GitHub did not accept that token" }, 400);
    }
  } catch {
    return json({ error: "Could not check the connections" }, 502);
  }

  const { error } = await admin.from("scheduled_integrations").upsert({
    user_id: auth.user.id,
    jira_site: chosenSite || null,
    jira_email: chosenEmail || null,
    jira_token_ciphertext: chosenJiraToken ? encryptSecret(chosenJiraToken, encryptionKey) : null,
    jira_key_hint: chosenJiraToken ? keyHint(chosenJiraToken) : null,
    github_token_ciphertext: chosenGithubToken ? encryptSecret(chosenGithubToken, encryptionKey) : null,
    github_key_hint: chosenGithubToken ? keyHint(chosenGithubToken) : null,
    updated_at: new Date().toISOString(),
  });
  if (error) return json({ error: "Could not save connections" }, 500);
  const connection = await loadConnection(admin, auth.user.id);
  return json({ connection: connection.public });
}

export async function DELETE(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin) return json({ error: "Not configured" }, 503);
  const source = new URL(request.url).searchParams.get("source");
  if (source && source !== "jira" && source !== "github")
    return json({ error: "Unknown connection" }, 400);
  if (source) {
    const { data: tasks, error: tasksError } = await auth.supabase.from("scheduled_tasks")
      .select("id,jira_projects,github_repos")
      .eq("user_id", auth.user.id)
      .eq("enabled", true);
    if (tasksError) return json({ error: "Could not pause affected jobs" }, 500);
    const affected = (tasks ?? []).filter((task) =>
      source === "jira" ? task.jira_projects.length > 0 : task.github_repos.length > 0,
    ).map((task) => task.id);
    if (affected.length) {
      const { error: pauseError } = await auth.supabase.from("scheduled_tasks")
        .update({ enabled: false }).eq("user_id", auth.user.id).in("id", affected);
      if (pauseError) return json({ error: "Could not pause affected jobs" }, 500);
    }
    const fields = source === "jira"
      ? { jira_site: null, jira_email: null, jira_token_ciphertext: null, jira_key_hint: null }
      : { github_token_ciphertext: null, github_key_hint: null };
    const { error } = await admin.from("scheduled_integrations")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("user_id", auth.user.id);
    if (error) return json({ error: "Could not disconnect" }, 500);
    return json({ disconnected: true, pausedJobs: affected.length });
  }
  const { error } = await admin.from("scheduled_integrations")
    .delete().eq("user_id", auth.user.id);
  if (error) return json({ error: "Could not disconnect" }, 500);
  await auth.supabase.from("scheduled_tasks")
    .update({ enabled: false }).eq("user_id", auth.user.id);
  return json({ disconnected: true });
}
