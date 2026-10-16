// The Projects page and project detail (U-03): the nested project tree with
// real counts, and a project's linked work split into sections. Pure; it
// reads only the notes it is given (ADR 001: nesting via project_id).
import {
  itemKind,
  projectAncestors,
  projectDescendants,
  type Note,
} from "./notes.ts";
import { isActiveState } from "./assignment-view.ts";
import type { Assignment } from "./assignments/types.ts";

/** Counts of the non-project items inside a project, at any depth. */
export type ProjectCounts = { open: number; done: number; total: number };

/** done / total, or null when there is nothing to measure (never invented). */
export const progressOf = ({ done, total }: ProjectCounts): number | null =>
  total > 0 ? done / total : null;

export function projectCounts(notes: Note[], projectId: string): ProjectCounts {
  let open = 0, done = 0;
  for (const { note } of projectDescendants(notes, projectId)) {
    if (itemKind(note) === "project") continue;
    if (note.completedAt) done++;
    else open++;
  }
  return { open, done, total: open + done };
}

export type ProjectNode = {
  project: Note;
  depth: number;
  counts: ProjectCounts;
  children: ProjectNode[];
};

const byTitle = (a: Note, b: Note) =>
  Number(!!a.completedAt) - Number(!!b.completedAt) ||
  (a.title.trim() || "￿").localeCompare(b.title.trim() || "￿") ||
  a.id.localeCompare(b.id);

/**
 * Projects in a workspace as a tree. A project whose parent is missing, not
 * a project or in another space is a root, so bad data never hides one.
 * Open projects first, then by title. Bounded by the projects given.
 */
export function projectTree(notes: Note[], workspaceId: string): ProjectNode[] {
  const projects = notes.filter((n) => n.workspaceId === workspaceId && itemKind(n) === "project");
  const ids = new Set(projects.map((p) => p.id));
  const kids = new Map<string, Note[]>();
  const roots: Note[] = [];
  for (const p of projects) {
    if (p.projectId && ids.has(p.projectId) && p.projectId !== p.id) {
      kids.set(p.projectId, [...(kids.get(p.projectId) ?? []), p]);
    } else roots.push(p);
  }
  const seen = new Set<string>();
  const build = (project: Note, depth: number): ProjectNode => {
    seen.add(project.id);
    return {
      project,
      depth,
      counts: projectCounts(notes, project.id),
      children: (kids.get(project.id) ?? [])
        .filter((c) => !seen.has(c.id))
        .sort(byTitle)
        .map((c) => build(c, depth + 1)),
    };
  };
  const tree = roots.sort(byTitle).map((r) => build(r, 1));
  // A cycle in stored data has no root; show its members at the top level.
  for (const p of projects.sort(byTitle)) if (!seen.has(p.id)) tree.push(build(p, 1));
  return tree;
}

/** Every project id in a tree (for "expand all"). */
export const treeIds = (tree: ProjectNode[]): string[] =>
  tree.flatMap((node) => [node.project.id, ...treeIds(node.children)]);

/** Ids of the project and everything inside it, for scoping assignments. */
export function projectScopeIds(notes: Note[], projectId: string): Set<string> {
  return new Set([projectId, ...projectDescendants(notes, projectId).map((d) => d.note.id)]);
}

/** Assignments delegated from inside a scope that are still active. */
export const activeIn = (assignments: Assignment[], scope: Set<string>) =>
  assignments.filter((a) => a.sourceNoteId && scope.has(a.sourceNoteId) && isActiveState(a.state)).length;

/** A saved agent result (ADR 003: origin kind "assignment"). */
export const isAgentResult = (note: Pick<Note, "origin">) =>
  (note.origin as { kind?: unknown } | null | undefined)?.kind === "assignment";

export type ProjectDetail = {
  project: Note;
  /** Root first, nearest last; each is a link in the breadcrumb. */
  ancestors: Note[];
  subprojects: { project: Note; counts: ProjectCounts }[];
  /** Tasks and follow-ups: open (soonest due, then recent), then done (latest first). */
  tasks: { open: Note[]; done: Note[] };
  notes: Note[];
  /** Documents, including saved agent results. */
  documents: Note[];
};

const dueKey = (n: Note) => n.dueDate || "￿";

/** A project's direct contents by section, or null when it isn't a loaded project. */
export function projectDetail(notes: Note[], projectId: string): ProjectDetail | null {
  const project = notes.find((n) => n.id === projectId);
  if (!project || itemKind(project) !== "project") return null;
  const children = notes.filter((n) => n.projectId === projectId && n.id !== projectId);
  const recent = (a: Note, b: Note) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  const tasks = children.filter((n) => ["task", "followup"].includes(itemKind(n)));
  return {
    project,
    ancestors: projectAncestors(notes, projectId).reverse(),
    subprojects: children
      .filter((n) => itemKind(n) === "project")
      .sort(byTitle)
      .map((p) => ({ project: p, counts: projectCounts(notes, p.id) })),
    tasks: {
      open: tasks
        .filter((n) => !n.completedAt)
        .sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || recent(a, b)),
      done: tasks
        .filter((n) => n.completedAt)
        .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!) || a.id.localeCompare(b.id)),
    },
    notes: children.filter((n) => itemKind(n) === "note" && !isAgentResult(n)).sort(recent),
    documents: children
      .filter((n) => itemKind(n) === "document" || (itemKind(n) === "note" && isAgentResult(n)))
      .sort(recent),
  };
}
