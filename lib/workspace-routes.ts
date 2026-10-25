// Routes inside the signed-in workspace (U-03) and their URL parameters.
// Everything a view filters on lives in the URL so links, reloads and the
// browser's back/forward buttons restore it. Pure: no React, no Next.
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
  | { page: "workflow-runs" }
  | { page: "workflow-run"; id: string };

const STATIC: Record<string, WorkspaceRoute> = {
  "": { page: "notes" },
  settings: { page: "settings", section: DEFAULT_SETTINGS_SECTION },
  scheduled: { page: "scheduled" },
  agents: { page: "agents" },
  tasks: { page: "tasks" },
  projects: { page: "projects" },
  library: { page: "library" },
  workflows: { page: "workflows" },
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
  // Run history lives under /workflows; "runs" is never a workflow id (uuids).
  if (parts[0] === "workflows" && parts[1] === "runs") {
    if (parts.length === 2) return { page: "workflow-runs" };
    if (parts.length === 3) return { page: "workflow-run", id: decode(parts[2]) ?? "" };
  }
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
/**
 * The item id a link points at, when it is this app's own item page
 * (`origin` + itemHref). Any other URL, host or page is null, so a note
 * can tell its own links from the web's.
 */
export function itemIdFromUrl(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const route = parseRoute(url.pathname);
  return route.page === "item" && route.id ? route.id : null;
}
/** The workflow designer. */
export const workflowHref = (id: string) => `/workflows/${encodeURIComponent(id)}`;
/** One workflow run's details. */
export const workflowRunHref = (id: string) => `/workflows/runs/${encodeURIComponent(id)}`;

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

// --- Workflow runs -----------------------------------------------------------

export const RUN_STATUS_FILTERS = ["running", "completed", "failed", "canceled", "invalid"] as const;
export type RunStatusFilter = (typeof RUN_STATUS_FILTERS)[number];

export type WorkflowRunsParams = { status: RunStatusFilter | null; workflow: string | null };

/** `?status=` (one run status, or all) and `?workflow=` (a workflow id, or all). */
export function parseWorkflowRunsParams(params: Params): WorkflowRunsParams {
  const status = params?.get("status");
  const workflow = params?.get("workflow")?.trim();
  return {
    status: RUN_STATUS_FILTERS.includes(status as RunStatusFilter) ? (status as RunStatusFilter) : null,
    workflow: workflow || null,
  };
}

/** Canonical run history URL: no filters add nothing. */
export function workflowRunsHref({ status = null, workflow = null }: Partial<WorkflowRunsParams> = {}) {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (workflow) query.set("workflow", workflow);
  const text = query.toString();
  return text ? `/workflows/runs?${text}` : "/workflows/runs";
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

// --- Notes route -----------------------------------------------------------

/** The notes route's view from `?view=`: a bucket, all, completed, or Home. */
export function parseNotesView(value: string | null | undefined): "overview" | "all" | "completed" | BucketId {
  if (value === "all" || value === "completed") return value;
  return BUCKETS.some((b) => b.id === value) ? (value as BucketId) : "overview";
}
