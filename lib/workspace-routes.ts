// Routes inside the signed-in workspace (U-03) and their URL parameters.
// Everything a view filters on lives in the URL so links, reloads and the
// browser's back/forward buttons restore it. Pure: no React, no Next.
import { JIRA_WINDOWS, type JiraWindow } from "./jira/view.ts";
import { BUCKETS, type BucketId } from "./notes.ts";
import { DEFAULT_SETTINGS_SECTION, parseSettingsSection, type SettingsSection } from "./settings-sections.ts";

/** A page of the workspace shell. `id` is the decoded path segment. */
export type WorkspaceRoute =
  | { page: "notes" }
  | { page: "settings"; section: SettingsSection }
  | { page: "scheduled" }
  | { page: "agents" }
  | { page: "tasks" }
  | { page: "projects" }
  | { page: "project"; id: string }
  | { page: "library" }
  | { page: "item"; id: string }
  | { page: "workflows" }
  | { page: "workflow"; id: string }
  | { page: "jira" };

const STATIC: Record<string, WorkspaceRoute> = {
  "": { page: "notes" },
  settings: { page: "settings", section: DEFAULT_SETTINGS_SECTION },
  scheduled: { page: "scheduled" },
  agents: { page: "agents" },
  tasks: { page: "tasks" },
  projects: { page: "projects" },
  library: { page: "library" },
  workflows: { page: "workflows" },
  jira: { page: "jira" },
};

function decode(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return value.trim() ? value : null;
  } catch {
    return null;
  }
}

/**
 * The page for a pathname. Unknown paths read as the notes route; an id
 * segment that can't be decoded is kept as an id nothing matches, so the
 * page shows its not-found state.
 */
export function parseRoute(pathname: string | null | undefined): WorkspaceRoute {
  const parts = (pathname ?? "/").split("/").filter(Boolean);
  // Settings sub-pages (/settings/account, /settings/agents/setup, ...).
  // An unknown subpath has no page file (404); read it as the default.
  if (parts[0] === "settings")
    return { page: "settings", section: parseSettingsSection(parts.slice(1)) ?? DEFAULT_SETTINGS_SECTION };
  if (parts.length === 2 && (parts[0] === "projects" || parts[0] === "items" || parts[0] === "workflows")) {
    const id = decode(parts[1]) ?? "";
    return parts[0] === "projects" ? { page: "project", id } : parts[0] === "items" ? { page: "item", id } : { page: "workflow", id };
  }
  if (parts.length > 1) return { page: "notes" };
  return STATIC[parts[0] ?? ""] ?? { page: "notes" };
}

export const projectHref = (id: string) => `/projects/${encodeURIComponent(id)}`;
/** Full-page reading and editing for any item. */
export const itemHref = (id: string) => `/items/${encodeURIComponent(id)}`;
/** The workflow designer. */
export const workflowHref = (id: string) => `/workflows/${encodeURIComponent(id)}`;

/** Read-only view of URLSearchParams (Next's ReadonlyURLSearchParams fits). */
type Params = { get(name: string): string | null } | null | undefined;

// --- Tasks -----------------------------------------------------------------

export const TASK_FILTERS = [
  { id: "next", label: "Next" },
  { id: "due", label: "Due" },
  { id: "waiting", label: "Waiting" },
  { id: "completed", label: "Completed" },
] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number]["id"];
export const isTaskFilter = (value: unknown): value is TaskFilter =>
  TASK_FILTERS.some((f) => f.id === value);

export type TasksParams = { filter: TaskFilter; project: string | null };

/** `?filter=` (default next) and `?project=` (a project id, or none). */
export function parseTasksParams(params: Params): TasksParams {
  const filter = params?.get("filter");
  const project = params?.get("project")?.trim();
  return { filter: isTaskFilter(filter) ? filter : "next", project: project || null };
}

/** Canonical Tasks URL: the default filter and no project add nothing. */
export function tasksHref({ filter = "next", project = null }: Partial<TasksParams> = {}) {
  const query = new URLSearchParams();
  if (filter !== "next") query.set("filter", filter);
  if (project) query.set("project", project);
  const text = query.toString();
  return text ? `/tasks?${text}` : "/tasks";
}

// --- Library ---------------------------------------------------------------

export type LibraryParams = { tag: string | null; q: string };

export const LIBRARY_QUERY_MAX = 200;

/** `?tag=` (one tag) and `?q=` (free text, trimmed and bounded). */
export function parseLibraryParams(params: Params): LibraryParams {
  const tag = params?.get("tag")?.trim();
  const q = (params?.get("q") ?? "").slice(0, LIBRARY_QUERY_MAX);
  return { tag: tag || null, q };
}

export function libraryHref({ tag = null, q = "" }: Partial<LibraryParams> = {}) {
  const query = new URLSearchParams();
  if (tag) query.set("tag", tag);
  if (q.trim()) query.set("q", q.slice(0, LIBRARY_QUERY_MAX));
  const text = query.toString();
  return text ? `/library?${text}` : "/library";
}

// --- Jira ------------------------------------------------------------------

export type JiraParams = { days: JiraWindow; person: string | null };

/** `?days=` (team activity window, default 7) and `?person=` (an assignee's name, or everyone). */
export function parseJiraParams(params: Params): JiraParams {
  const days = Number(params?.get("days"));
  const person = params?.get("person")?.trim().slice(0, 120);
  return { days: (JIRA_WINDOWS as readonly number[]).includes(days) ? (days as JiraWindow) : 7, person: person || null };
}

export function jiraHref({ days = 7, person = null }: Partial<JiraParams> = {}) {
  const query = new URLSearchParams();
  if (days !== 7) query.set("days", String(days));
  if (person) query.set("person", person);
  const text = query.toString();
  return text ? `/jira?${text}` : "/jira";
}

// --- Notes route -----------------------------------------------------------

/** The notes route's view from `?view=`: a bucket, all, completed, or Home. */
export function parseNotesView(value: string | null | undefined): "overview" | "all" | "completed" | BucketId {
  if (value === "all" || value === "completed") return value;
  return BUCKETS.some((b) => b.id === value) ? (value as BucketId) : "overview";
}
