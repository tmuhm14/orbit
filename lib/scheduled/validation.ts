export type TaskInput = {
  name: string;
  kind: "team_debrief";
  enabled: boolean;
  timezone: string;
  delivery_hour: number;
  cadence: "daily" | "weekdays";
  jira_projects: string[];
  github_repos: string[];
};

const textList = (value: unknown, pattern: RegExp) =>
  Array.isArray(value) && value.length <= 20 && value.every(
    (item) => typeof item === "string" && pattern.test(item.trim()),
  );

export function parseTaskInput(value: unknown): TaskInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100 ||
      input.kind !== "team_debrief" || typeof input.enabled !== "boolean" ||
      !Number.isInteger(input.delivery_hour) || Number(input.delivery_hour) < 3 || Number(input.delivery_hour) > 23 ||
      (input.cadence !== "daily" && input.cadence !== "weekdays") ||
      typeof input.timezone !== "string" || input.timezone.length > 60 ||
      !textList(input.jira_projects, /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/) ||
      !textList(input.github_repos, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    return null;
  }
  const jiraProjects = (input.jira_projects as string[]).map((item) => item.trim());
  const githubRepos = (input.github_repos as string[]).map((item) => item.trim());
  if (!jiraProjects.length && !githubRepos.length) return null;
  return {
    name: input.name.trim(),
    kind: "team_debrief",
    enabled: input.enabled,
    timezone: input.timezone,
    delivery_hour: Number(input.delivery_hour),
    cadence: input.cadence,
    jira_projects: [...new Set(jiraProjects)],
    github_repos: [...new Set(githubRepos)],
  };
}
