import { previousDate, reportWindow } from "./schedule.ts";

export type DebriefTask = {
  jira_projects: string[];
  github_repos: string[];
  timezone: string;
};
export type DebriefCredentials = {
  jiraSite: string;
  jiraEmail: string;
  jiraToken: string;
  githubToken: string;
};
export type DebriefReport = {
  date: string;
  timezone: string;
  jira: { issues: { key: string; status: string; type: string; url: string }[]; truncated: boolean; error?: string };
  github: {
    prs: { repo: string; number: number; state: string; author: string; url: string }[];
    commits: { repo: string; sha: string; author: string; url: string }[];
    errors: string[];
    truncated: boolean;
  };
};

type JiraIssue = {
  key: string;
  fields: {
    updated: string;
    status?: { name?: string };
    issuetype?: { name?: string };
  };
};
type JiraPage = { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
type GitHubPr = {
  number: number;
  updated_at: string;
  merged_at: string | null;
  state: string;
  user?: { login?: string };
};
type GitHubCommit = {
  sha: string;
  html_url: string;
  author?: { login?: string };
  commit?: { author?: { name?: string }; committer?: { date?: string } };
};

async function readJson<T>(
  url: string,
  headers: Record<string, string>,
  fetcher: typeof fetch,
  init?: RequestInit,
): Promise<T> {
  const response = await fetcher(url, {
    ...init,
    headers: { Accept: "application/json", ...headers, ...init?.headers },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error("Source unavailable");
  return response.json() as Promise<T>;
}

const inWindow = (value: string, start: string, end: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.parse(start) && time < Date.parse(end);
};

/** Builds a source-linked report from metadata only; no issue or PR body is stored. */
export async function buildDebrief(
  task: DebriefTask,
  credentials: DebriefCredentials,
  reportDate: string,
  fetcher: typeof fetch = fetch,
): Promise<DebriefReport> {
  const { start, end } = reportWindow(reportDate, task.timezone);
  const report: DebriefReport = {
    date: reportDate,
    timezone: task.timezone,
    jira: { issues: [], truncated: false },
    github: { prs: [], commits: [], errors: [], truncated: false },
  };

  if (task.jira_projects.length) {
    try {
      const projects = task.jira_projects.map((project) => JSON.stringify(project)).join(", ");
      const jql = `project in (${projects}) AND updated >= "${previousDate(reportDate)}" ORDER BY updated DESC`;
      const auth = Buffer.from(`${credentials.jiraEmail}:${credentials.jiraToken}`).toString("base64");
      let nextPageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const result = await readJson<JiraPage>(
          `${credentials.jiraSite}/rest/api/3/search/jql`,
          { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
          fetcher,
          {
            method: "POST",
            body: JSON.stringify({
              jql,
              fields: ["updated", "status", "issuetype"],
              maxResults: 100,
              ...(nextPageToken ? { nextPageToken } : {}),
            }),
          },
        );
        for (const issue of result.issues ?? []) {
          if (!inWindow(issue.fields.updated, start, end)) continue;
          if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(issue.key)) continue;
          report.jira.issues.push({
            key: issue.key,
            status: issue.fields.status?.name ?? "Unknown",
            type: issue.fields.issuetype?.name ?? "Issue",
            url: `${credentials.jiraSite}/browse/${issue.key}`,
          });
        }
        nextPageToken = result.nextPageToken;
        if (result.isLast || !nextPageToken) break;
        if (page === 4) report.jira.truncated = true;
      }
    } catch {
      report.jira.error = "Jira activity could not be loaded";
    }
  }

  for (const repo of task.github_repos) {
    try {
      const [owner, name] = repo.split("/");
      const base = `https://api.github.com/repos/${owner}/${name}`;
      const headers = {
        Authorization: `Bearer ${credentials.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      };
      for (let page = 1; page <= 3; page++) {
        const prs = await readJson<GitHubPr[]>(
          `${base}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
          headers,
          fetcher,
        );
        for (const pr of prs) {
          if (!inWindow(pr.updated_at, start, end)) continue;
          report.github.prs.push({
            repo,
            number: pr.number,
            state: pr.merged_at && inWindow(pr.merged_at, start, end)
              ? "merged" : pr.state === "closed" ? "closed" : "updated",
            author: pr.user?.login ?? "Unknown",
            url: `https://github.com/${repo}/pull/${pr.number}`,
          });
        }
        if (prs.length < 100 || Date.parse(prs.at(-1)!.updated_at) < Date.parse(start)) break;
        if (page === 3) report.github.truncated = true;
      }
      const query = new URLSearchParams({ since: start, until: end, per_page: "100" });
      const commits = await readJson<GitHubCommit[]>(
        `${base}/commits?${query}`,
        headers,
        fetcher,
      );
      for (const commit of commits) {
        if (!commit.commit?.committer?.date ||
            !inWindow(commit.commit.committer.date, start, end) ||
            !/^[0-9a-f]{40}$/i.test(commit.sha)) continue;
        report.github.commits.push({
          repo,
          sha: commit.sha.slice(0, 7),
          author: commit.author?.login ?? commit.commit.author?.name ?? "Unknown",
          url: `https://github.com/${repo}/commit/${commit.sha}`,
        });
      }
      if (commits.length === 100) report.github.truncated = true;
    } catch {
      report.github.errors.push(`${repo} could not be loaded`);
    }
  }
  return report;
}
