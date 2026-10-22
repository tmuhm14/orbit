import type { DebriefCredentials } from "../scheduled/debrief.ts";
import {
  PIPELINE_STATUSES, type JiraCategory, type JiraDashboard, type JiraIssue, type JiraSection, type JiraWindow,
} from "./view.ts";

/**
 * Live Jira reads for the dashboard, with the user's saved Jira connection.
 * Three searches: issues assigned to the user, what the team's projects moved
 * in the window, and what is coming up. Nothing is stored; logs carry the
 * section and HTTP status only, never issue content or credentials.
 */

export type JiraCredentials = Pick<DebriefCredentials, "jiraSite" | "jiraEmail" | "jiraToken">;

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const MAX_PROJECTS = 20;
const PAGE_SIZE = 100;
const FIELDS = ["summary", "status", "issuetype", "priority", "project", "assignee", "updated", "resolutiondate", "duedate", "parent"];

class JiraHttpError extends Error {
  status: number;
  constructor(status: number) {
    super("Jira request failed");
    this.status = status;
  }
}

type Fetcher = typeof fetch;

async function jira<T>(credentials: JiraCredentials, path: string, fetcher: Fetcher, body?: unknown): Promise<T> {
  const auth = Buffer.from(`${credentials.jiraEmail}:${credentials.jiraToken}`).toString("base64");
  const response = await fetcher(`${credentials.jiraSite}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new JiraHttpError(response.status);
  return response.json() as Promise<T>;
}

type RawSprint = { name?: unknown; state?: unknown; startDate?: unknown; endDate?: unknown };
type RawIssue = {
  key?: unknown;
  fields?: {
    summary?: unknown;
    status?: { name?: unknown; statusCategory?: { key?: unknown } };
    issuetype?: { name?: unknown };
    priority?: { name?: unknown } | null;
    project?: { key?: unknown };
    assignee?: { accountId?: unknown; displayName?: unknown } | null;
    updated?: unknown;
    resolutiondate?: unknown;
    duedate?: unknown;
    parent?: { key?: unknown; fields?: { summary?: unknown } };
    [field: string]: unknown;
  };
};
type SearchPage = { issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean };

const text = (value: unknown, max = 300) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const iso = (value: unknown) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);
const CATEGORIES: Record<string, JiraCategory> = { new: "todo", indeterminate: "doing", done: "done" };

/** The issue's active sprint, else its earliest future one; closed sprints don't count. */
export function currentSprint(value: unknown): JiraIssue["sprint"] {
  if (!Array.isArray(value)) return null;
  const sprints = (value as RawSprint[]).filter((s) => typeof s?.name === "string");
  const active = sprints.find((s) => s.state === "active");
  const future = sprints.filter((s) => s.state === "future")
    .sort((a, b) => (Date.parse(String(a.startDate)) || Infinity) - (Date.parse(String(b.startDate)) || Infinity))[0];
  const sprint = active ?? future;
  if (!sprint) return null;
  return { name: text(sprint.name, 120), state: active ? "active" : "future", end: iso(sprint.endDate) };
}

/** A search result as the page shows it, or null for anything malformed. */
export function toIssue(raw: RawIssue, site: string, sprintField: string | null, me: string | null): JiraIssue | null {
  const key = typeof raw?.key === "string" ? raw.key : "";
  const fields = raw?.fields;
  const updated = iso(fields?.updated);
  if (!ISSUE_KEY.test(key) || !fields || !updated) return null;
  const parentKey = typeof fields.parent?.key === "string" && ISSUE_KEY.test(fields.parent.key) ? fields.parent.key : null;
  const due = typeof fields.duedate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fields.duedate) ? fields.duedate : null;
  return {
    key,
    url: `${site}/browse/${key}`,
    summary: text(fields.summary) || key,
    status: text(fields.status?.name, 80) || "Unknown",
    category: CATEGORIES[String(fields.status?.statusCategory?.key)] ?? "todo",
    type: text(fields.issuetype?.name, 60) || "Issue",
    priority: text(fields.priority?.name, 40) || null,
    project: text(fields.project?.key, 20) || key.split("-")[0],
    assignee: text(fields.assignee?.displayName, 120) || null,
    assignedToMe: !!me && fields.assignee?.accountId === me,
    updated,
    resolved: iso(fields.resolutiondate),
    due,
    epic: parentKey ? { key: parentKey, summary: text(fields.parent?.fields?.summary) || parentKey } : null,
    sprint: sprintField ? currentSprint(fields[sprintField]) : null,
  };
}

/**
 * The team's projects: those on the user's open assignments, plus project
 * keys saved on their scheduled debriefs. Project names ("Specialty") and
 * anything else that isn't an uppercase key are skipped, so every value is
 * safe to quote into JQL.
 */
export function teamProjects(configured: string[], assigned: JiraIssue[]) {
  const keys = new Set<string>();
  for (const value of [...configured.map((v) => v.trim()), ...assigned.map((i) => i.project)])
    if (PROJECT_KEY.test(value) && keys.size < MAX_PROJECTS) keys.add(value);
  return [...keys].sort();
}

const quote = (value: string) => JSON.stringify(value);
const projectClause = (projects: string[]) => `project in (${projects.map(quote).join(", ")})`;

export const MINE_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

/**
 * Activity: issues in the team's projects whose status changed, that were
 * resolved, or that are in progress and touched within the window. Upcoming:
 * open issues due within two weeks (or overdue), not started in an open or
 * future sprint, or waiting in a pipeline status. Sprint clauses need Jira
 * Software (a Sprint field); pipeline clauses need the site's status names.
 */
export function teamJql(projects: string[], days: number, { sprints = true, pipeline = true } = {}) {
  const upcoming = ["duedate <= 14d"];
  if (sprints) upcoming.push(`(statusCategory = "To Do" AND (sprint in openSprints() OR sprint in futureSprints()))`);
  if (pipeline) upcoming.push(`status in (${[PIPELINE_STATUSES.shipping, PIPELINE_STATUSES.queued].map(quote).join(", ")})`);
  return {
    activity: `${projectClause(projects)} AND (status CHANGED AFTER -${days}d OR resolved >= -${days}d OR ` +
      `(statusCategory = "In Progress" AND updated >= -${days}d)) ORDER BY updated DESC`,
    upcoming: `${projectClause(projects)} AND statusCategory != Done AND (${upcoming.join(" OR ")}) ` +
      "ORDER BY duedate ASC, Rank ASC",
  };
}

// The Sprint field's id differs per site; look it up once per site.
const sprintFields = new Map<string, { id: string | null; at: number }>();
const SPRINT_SCHEMA = "com.pyxis.greenhopper.jira:gh-sprint";

async function sprintField(credentials: JiraCredentials, fetcher: Fetcher) {
  const cached = sprintFields.get(credentials.jiraSite);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.id;
  try {
    const fields = await jira<{ id?: unknown; schema?: { custom?: unknown } }[]>(credentials, "/rest/api/3/field", fetcher);
    const found = fields.find((f) => f?.schema?.custom === SPRINT_SCHEMA && typeof f.id === "string");
    const id = found && /^customfield_\d+$/.test(String(found.id)) ? String(found.id) : null;
    sprintFields.set(credentials.jiraSite, { id, at: Date.now() });
    return id;
  } catch {
    return null;
  }
}

async function myAccountId(credentials: JiraCredentials, fetcher: Fetcher) {
  try {
    const me = await jira<{ accountId?: unknown }>(credentials, "/rest/api/3/myself", fetcher);
    return typeof me.accountId === "string" ? me.accountId : null;
  } catch {
    return null;
  }
}

async function search(credentials: JiraCredentials, jql: string, fields: string[], pages: number, fetcher: Fetcher) {
  const issues: RawIssue[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < pages; page++) {
    const result = await jira<SearchPage>(credentials, "/rest/api/3/search/jql", fetcher, {
      jql, fields, maxResults: PAGE_SIZE, ...(nextPageToken ? { nextPageToken } : {}),
    });
    issues.push(...(result.issues ?? []));
    nextPageToken = result.nextPageToken;
    if (result.isLast || !nextPageToken) return { issues, truncated: false };
  }
  return { issues, truncated: true };
}

const failureMessage = (error: unknown) =>
  error instanceof JiraHttpError && (error.status === 401 || error.status === 403)
    ? "Jira didn’t accept the saved credentials. Update the connection in Settings → Integrations."
    : "Jira couldn’t be reached. Try again in a moment.";

export async function buildJiraDashboard(
  credentials: JiraCredentials,
  { days, configuredProjects }: { days: JiraWindow; configuredProjects: string[] },
  fetcher: Fetcher = fetch,
  log: (line: string) => void = console.warn,
): Promise<JiraDashboard> {
  const site = credentials.jiraSite;
  const [sprint, me] = await Promise.all([sprintField(credentials, fetcher), myAccountId(credentials, fetcher)]);
  const fields = sprint ? [...FIELDS, sprint] : FIELDS;
  const parse = (raw: RawIssue[]) =>
    raw.map((issue) => toIssue(issue, site, sprint, me)).filter((issue): issue is JiraIssue => !!issue);
  const dashboard: JiraDashboard = {
    site, projects: [], days, generatedAt: new Date().toISOString(),
    mine: [], activity: [], upcoming: [],
    links: { mine: "", activity: "", upcoming: "" },
    truncated: { mine: false, activity: false, upcoming: false },
    errors: [],
  };
  const fail = (section: JiraSection, error: unknown) => {
    log(JSON.stringify({ event: "jira_dashboard.failed", section,
      status: error instanceof JiraHttpError ? error.status : "network" }));
    dashboard.errors.push({ section, message: failureMessage(error) });
  };
  const link = (jql: string) => `${site}/issues/?jql=${encodeURIComponent(jql)}`;

  dashboard.links.mine = link(MINE_JQL);
  try {
    const mine = await search(credentials, MINE_JQL, fields, 1, fetcher);
    dashboard.mine = parse(mine.issues).map((issue) => ({ ...issue, assignedToMe: true }));
    dashboard.truncated.mine = mine.truncated;
  } catch (error) {
    fail("mine", error);
  }

  dashboard.projects = teamProjects(configuredProjects, dashboard.mine);
  if (!dashboard.projects.length) return dashboard;
  const jql = teamJql(dashboard.projects, days, { sprints: !!sprint });
  dashboard.links.activity = link(jql.activity);
  dashboard.links.upcoming = link(jql.upcoming);
  await Promise.all([
    search(credentials, jql.activity, fields, 3, fetcher).then((result) => {
      dashboard.activity = parse(result.issues);
      dashboard.truncated.activity = result.truncated;
    }, (error) => fail("activity", error)),
    search(credentials, jql.upcoming, fields, 2, fetcher)
      // A site without the pipeline statuses rejects the JQL; search again without them.
      .catch((error) => {
        if (!(error instanceof JiraHttpError && error.status === 400)) throw error;
        const fallback = teamJql(dashboard.projects, days, { sprints: !!sprint, pipeline: false }).upcoming;
        dashboard.links.upcoming = link(fallback);
        return search(credentials, fallback, fields, 2, fetcher);
      })
      .then((result) => {
        dashboard.upcoming = parse(result.issues);
        dashboard.truncated.upcoming = result.truncated;
      }, (error) => fail("upcoming", error)),
  ]);
  return dashboard;
}
