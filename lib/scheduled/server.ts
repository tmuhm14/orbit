import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { agentEncryptionKey } from "@/lib/agent/server";
import { decryptSecret } from "@/lib/agent/secret";
import { buildDebrief, type DebriefCredentials, type DebriefReport } from "./debrief";
import type { TaskInput } from "./validation";

export type ScheduledTask = TaskInput & { id: string; user_id: string; created_at: string };

type ConnectionRow = {
  jira_site: string | null;
  jira_email: string | null;
  jira_token_ciphertext: string | null;
  jira_key_hint: string | null;
  github_token_ciphertext: string | null;
  github_key_hint: string | null;
};

export async function loadConnection(admin: SupabaseClient, userId: string) {
  const { data } = await admin.from("scheduled_integrations")
    .select("jira_site,jira_email,jira_token_ciphertext,jira_key_hint,github_token_ciphertext,github_key_hint")
    .eq("user_id", userId).maybeSingle<ConnectionRow>();
  const key = agentEncryptionKey();
  const jiraToken = data?.jira_token_ciphertext && key
    ? decryptSecret(data.jira_token_ciphertext, key) : null;
  const githubToken = data?.github_token_ciphertext && key
    ? decryptSecret(data.github_token_ciphertext, key) : null;
  return {
    public: {
      jiraSite: data?.jira_site ?? "",
      jiraEmail: data?.jira_email ?? "",
      jiraHint: data?.jira_key_hint ?? "",
      githubHint: data?.github_key_hint ?? "",
      jiraConnected: !!(data?.jira_site && data.jira_email && jiraToken),
      githubConnected: !!githubToken,
    },
    credentials: {
      jiraSite: data?.jira_site ?? "",
      jiraEmail: data?.jira_email ?? "",
      jiraToken: jiraToken ?? "",
      githubToken: githubToken ?? "",
    } satisfies DebriefCredentials,
  };
}

export type RunRow = {
  id: string;
  task_id: string;
  report_date: string;
  trigger: "scheduled" | "manual";
  status: "running" | "done" | "partial" | "failed";
  report: DebriefReport | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

/** Claims a run before network work; the unique scheduled key blocks duplicates. */
export async function runScheduledTask(
  admin: SupabaseClient,
  task: ScheduledTask,
  reportDate: string,
  trigger: "scheduled" | "manual",
) {
  const { data: run, error: claimError } = await admin
    .from("scheduled_task_runs")
    .insert({
      task_id: task.id,
      user_id: task.user_id,
      report_date: reportDate,
      trigger,
    })
    .select("id")
    .single<{ id: string }>();
  if (claimError?.code === "23505") return null;
  if (claimError || !run) throw new Error("Could not start the report");

  try {
    const connection = await loadConnection(admin, task.user_id);
    const credentials = connection.credentials;
    if ((task.jira_projects.length && !connection.public.jiraConnected) ||
        (task.github_repos.length && !connection.public.githubConnected)) {
      throw new Error("Connect the selected Jira and GitHub sources first");
    }
    const report = await buildDebrief(task, credentials, reportDate);
    const failedSources = !!report.jira.error || report.github.errors.length > 0;
    const hasResults = report.jira.issues.length + report.github.prs.length + report.github.commits.length > 0;
    const status = failedSources ? (hasResults ? "partial" : "failed") : "done";
    const { data, error } = await admin.from("scheduled_task_runs")
      .update({
        status,
        report,
        error: failedSources ? "Some sources could not be loaded" : null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.id).eq("user_id", task.user_id)
      .select("id,task_id,report_date,trigger,status,report,error,created_at,finished_at")
      .single<RunRow>();
    if (error || !data) throw new Error("Could not save the report");
    return data;
  } catch (error) {
    const message = error instanceof Error && error.message === "Connect the selected Jira and GitHub sources first"
      ? error.message : "The report could not be completed";
    await admin.from("scheduled_task_runs")
      .update({ status: "failed", error: message, finished_at: new Date().toISOString() })
      .eq("id", run.id).eq("user_id", task.user_id);
    throw new Error(message);
  }
}
