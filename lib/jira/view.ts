// The Jira dashboard (/jira): what the route returns and the pure grouping
// the page shows. No React, no Next, so it is tested in node (view.test.mjs).
// Issue content is fetched live for display and never stored in Orbit.

/** Team activity windows, in days. */
export const JIRA_WINDOWS = [7, 14, 30] as const;
export type JiraWindow = (typeof JIRA_WINDOWS)[number];

export type JiraCategory = "todo" | "doing" | "done";

export type JiraIssue = {
  key: string;
  url: string;
  summary: string;
  status: string;
  category: JiraCategory;
  type: string;
  priority: string | null;
  project: string;
  assignee: string | null;
  assignedToMe: boolean;
  /** ISO timestamps. */
  updated: string;
  resolved: string | null;
  /** Calendar date (YYYY-MM-DD). */
  due: string | null;
  epic: { key: string; summary: string } | null;
  /** The issue's current (active) or next (future) sprint. */
  sprint: { name: string; state: "active" | "future"; end: string | null } | null;
};

export type JiraSection = "mine" | "activity" | "upcoming";

export type JiraDashboard = {
  site: string;
  /** Project keys that make up "the team". */
  projects: string[];
  days: number;
  generatedAt: string;
  mine: JiraIssue[];
  activity: JiraIssue[];
  upcoming: JiraIssue[];
  /** Each section's search, to open in Jira. */
  links: Record<JiraSection, string>;
  truncated: Record<JiraSection, boolean>;
  errors: { section: JiraSection; message: string }[];
};

/**
 * Workflow statuses Upcoming groups on, matched case-insensitively. They are
 * this site's names; on a site without them the groups stay empty.
 */
export const PIPELINE_STATUSES = { shipping: "Ready for Release", queued: "Ready for Development" } as const;

const PRIORITY_RANK: Record<string, number> = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
const priorityRank = (issue: JiraIssue) => PRIORITY_RANK[issue.priority?.toLowerCase() ?? ""] ?? 2;
export const isUrgent = (issue: JiraIssue) => priorityRank(issue) <= 1;

/** Assigned to me: in progress first, then to do; each by priority, then most recently touched. */
export function groupMine(issues: JiraIssue[]) {
  const sorted = [...issues].sort((a, b) =>
    priorityRank(a) - priorityRank(b) || Date.parse(b.updated) - Date.parse(a.updated));
  return {
    doing: sorted.filter((issue) => issue.category === "doing"),
    todo: sorted.filter((issue) => issue.category === "todo"),
  };
}

export type UpcomingGroup = { id: string; label: string; detail?: string; issues: JiraIssue[] };

export function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const shortDate = (date: string) =>
  new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Upcoming, in the order to read it: overdue, due within two weeks, ready to
 * ship, not started in the current sprint, ready for development, then the
 * next sprint. Each issue appears once, in the first group it fits; the
 * search's order (due date, then rank) is kept inside a group.
 */
export function upcomingGroups(issues: JiraIssue[], today: string, soonDays = 14): UpcomingGroup[] {
  const soon = addDays(today, soonDays);
  const groups = new Map<string, UpcomingGroup>();
  const put = (id: string, label: string, issue: JiraIssue, detail?: string) => {
    const group = groups.get(id) ?? { id, label, detail, issues: [] };
    group.issues.push(issue);
    groups.set(id, group);
  };
  const is = (issue: JiraIssue, status: string) => issue.status.toLowerCase() === status.toLowerCase();
  for (const issue of issues) {
    if (issue.category === "done") continue;
    const sprint = issue.sprint;
    if (issue.due && issue.due < today) put("overdue", "Overdue", issue);
    else if (issue.due && issue.due <= soon) put("due", "Due in the next two weeks", issue);
    else if (is(issue, PIPELINE_STATUSES.shipping)) put("shipping", "Ready to ship", issue);
    else if (sprint?.state === "active" && issue.category === "todo")
      put(`sprint:${sprint.name}`, sprint.name, issue, sprint.end ? `Not started · ends ${shortDate(sprint.end)}` : "Not started");
    else if (is(issue, PIPELINE_STATUSES.queued)) put("queued", "Ready for development", issue);
    else if (sprint?.state === "future") put(`future:${sprint.name}`, sprint.name, issue, "Next sprint");
  }
  const order = (id: string) =>
    ["overdue", "due", "shipping", "sprint:", "queued", "future:"].findIndex((prefix) => id === prefix || id.startsWith(prefix));
  return [...groups.values()].sort((a, b) => order(a.id) - order(b.id));
}

export const UNASSIGNED = "Unassigned";
const personOf = (issue: JiraIssue) => issue.assignee ?? UNASSIGNED;

/** Who moved work in the window, busiest first. */
export function activityPeople(issues: JiraIssue[]) {
  const people = new Map<string, { name: string; total: number; completed: number; me: boolean }>();
  for (const issue of issues) {
    const name = personOf(issue);
    const person = people.get(name) ?? { name, total: 0, completed: 0, me: false };
    person.total++;
    if (issue.category === "done") person.completed++;
    person.me ||= issue.assignedToMe;
    people.set(name, person);
  }
  return [...people.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Team activity for one person (or everyone), split into finished and still moving. */
export function splitActivity(issues: JiraIssue[], person: string | null) {
  const shown = person ? issues.filter((issue) => personOf(issue) === person) : issues;
  return {
    completed: shown.filter((issue) => issue.category === "done"),
    moving: shown.filter((issue) => issue.category !== "done"),
  };
}

/** "just now", "5m ago", "3h ago", "yesterday", "4d ago", "3w ago", then a date. */
export function relativeTime(iso: string, now: number = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function initials(name: string | null) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts.at(-1)![0] : "")).toUpperCase();
}

/** Links shown on the page go only to the Jira site. */
export function jiraUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".atlassian.net") ? url.href : undefined;
  } catch {
    return undefined;
  }
}
