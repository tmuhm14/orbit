// The Tasks view (U-03): what is actionable, the Next / Due / Waiting /
// Completed filters, their order and their empty states. Pure; dates are
// local calendar keys (YYYY-MM-DD) compared as strings, never instants.
import {
  followupState,
  isDueDate,
  itemKind,
  projectDescendants,
  type Note,
} from "./notes.ts";
import { groupDueItems } from "./due-items.ts";
import type { TaskFilter } from "./workspace-routes.ts";

/**
 * Actionable: a task or follow-up, or anything sitting in Next actions or
 * Waiting for. Projects are outcomes, listed on the Projects page instead.
 */
export function isActionable(note: Note): boolean {
  const kind = itemKind(note);
  if (kind === "project") return false;
  return kind === "task" || kind === "followup" || note.bucket === "next" || note.bucket === "waiting";
}

/** Waiting on someone: a follow-up, the Waiting for bucket, or a "waiting on" set. */
export function isWaiting(note: Note): boolean {
  return itemKind(note) === "followup" || note.bucket === "waiting" || !!note.waitingOn?.trim();
}

const due = (note: Note) => (isDueDate(note.dueDate) ? note.dueDate : null);

/** Dated first (soonest), then most recently touched; ties by id. */
function byDueThenRecent(a: Note, b: Note) {
  const da = due(a), db = due(b);
  if (da && db && da !== db) return da.localeCompare(db);
  if (da && !db) return -1;
  if (!da && db) return 1;
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

const CHECK_ORDER = { overdue: 0, due: 1, upcoming: 2 } as const;

/**
 * Checks that are late first, then due today, then upcoming by date; items
 * without a check date last, least recently touched first (most likely stale).
 */
function byCheck(today: string) {
  return (a: Note, b: Note) => {
    const sa = followupState(a, today), sb = followupState(b, today);
    if (sa && sb) {
      if (sa !== sb) return CHECK_ORDER[sa] - CHECK_ORDER[sb];
      if (a.nextCheckOn !== b.nextCheckOn) return a.nextCheckOn!.localeCompare(b.nextCheckOn!);
    } else if (sa || sb) return sa ? -1 : 1;
    return a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
  };
}

/** Ids of everything inside a project (any depth), or null for no project filter. */
export function projectScope(notes: Note[], projectId: string | null): Set<string> | null {
  if (!projectId) return null;
  return new Set(projectDescendants(notes, projectId).map((d) => d.note.id));
}

export type DueGroups = ReturnType<typeof groupDueItems>;

export type TasksResult = {
  /** The rows for the filter, in display order (Due: overdue, today, upcoming). */
  items: Note[];
  /** Due only: the same rows split into groups. */
  groups: DueGroups | null;
  /** How many rows each filter has with the current project scope. */
  counts: Record<TaskFilter, number>;
};

/**
 * Rows for the Tasks view in one workspace. Next: open actionable items
 * that aren't waiting. Due: every open item with a due date (as Home's due
 * panel shows them). Waiting: open waiting items. Completed: actionable
 * items that are done, most recent first.
 */
export function tasksView(
  notes: Note[],
  workspaceId: string,
  { filter, project }: { filter: TaskFilter; project: string | null },
  today: string,
): TasksResult {
  const scope = projectScope(notes, project);
  const mine = notes.filter((n) => n.workspaceId === workspaceId && (!scope || scope.has(n.id)));
  const open = mine.filter((n) => !n.completedAt);
  const actionable = open.filter(isActionable);
  const next = actionable.filter((n) => !isWaiting(n)).sort(byDueThenRecent);
  const waiting = open.filter((n) => itemKind(n) !== "project" && isWaiting(n)).sort(byCheck(today));
  const groups = groupDueItems(open, workspaceId, today);
  const dueItems = [...groups.overdue, ...groups.today, ...groups.upcoming];
  const completed = mine
    .filter((n) => n.completedAt && isActionable(n))
    .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!) || a.id.localeCompare(b.id));
  const counts = { next: next.length, due: dueItems.length, waiting: waiting.length, completed: completed.length };
  const items = filter === "next" ? next : filter === "due" ? dueItems : filter === "waiting" ? waiting : completed;
  return { items, groups: filter === "due" ? groups : null, counts };
}

/** Where a dated row stands: "overdue", "today" or "upcoming" (null without a date). */
export function dueState(note: Pick<Note, "dueDate" | "completedAt">, today: string) {
  if (!isDueDate(note.dueDate) || note.completedAt) return null;
  return note.dueDate < today ? "overdue" : note.dueDate === today ? "today" : "upcoming";
}

/** Honest empty-state copy per filter, and whether a project narrows it. */
export function tasksEmptyCopy(filter: TaskFilter, inProject: boolean): { title: string; body: string } {
  const scope = inProject ? " in this project" : "";
  switch (filter) {
    case "next":
      return {
        title: `No next actions${scope}`,
        body: "Tasks, follow-ups and anything in Next actions show up here once there's a clear next step.",
      };
    case "due":
      return {
        title: `Nothing has a due date${scope}`,
        body: "Open an item and set a due date to see it here, grouped by overdue, today and upcoming.",
      };
    case "waiting":
      return {
        title: `Not waiting on anything${scope}`,
        body: "Follow-ups and items in Waiting for show here, with who they're with and when to check in.",
      };
    case "completed":
      return {
        title: `Nothing completed yet${scope}`,
        body: "Tasks you finish land here, most recent first.",
      };
  }
}
