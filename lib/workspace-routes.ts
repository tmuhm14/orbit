// Routes inside the signed-in workspace (U-03) and their URL parameters.
// Everything a view filters on lives in the URL so links, reloads and the
// browser's back/forward buttons restore it. Pure: no React, no Next.
import { BUCKETS, type BucketId } from "./notes.ts";

/** A page of the workspace shell. `id` is the decoded path segment. */
export type WorkspaceRoute =
  | { page: "notes" }
  | { page: "settings" }
  | { page: "scheduled" }
  | { page: "agents" }
  | { page: "tasks" }
  | { page: "projects" }
  | { page: "project"; id: string }
  | { page: "library" }
  | { page: "item"; id: string };

const STATIC: Record<string, WorkspaceRoute> = {
  "": { page: "notes" },
  settings: { page: "settings" },
  scheduled: { page: "scheduled" },
  agents: { page: "agents" },
  tasks: { page: "tasks" },
  projects: { page: "projects" },
  library: { page: "library" },
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
  if (parts.length === 2 && (parts[0] === "projects" || parts[0] === "items")) {
    const id = decode(parts[1]) ?? "";
    return parts[0] === "projects" ? { page: "project", id } : { page: "item", id };
  }
  if (parts.length > 1) return { page: "notes" };
  return STATIC[parts[0] ?? ""] ?? { page: "notes" };
}

export const projectHref = (id: string) => `/projects/${encodeURIComponent(id)}`;
/** Full-page reading and editing for any item. */
export const itemHref = (id: string) => `/items/${encodeURIComponent(id)}`;

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

// --- Notes route -----------------------------------------------------------

/** The notes route's view from `?view=`: a bucket, all, completed, or Home. */
export function parseNotesView(value: string | null | undefined): "overview" | "all" | "completed" | BucketId {
  if (value === "all" || value === "completed") return value;
  return BUCKETS.some((b) => b.id === value) ? (value as BucketId) : "overview";
}
