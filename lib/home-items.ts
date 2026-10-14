import { isDueDate, type BucketId, type Note } from "./notes.ts";
import { groupDueItems } from "./due-items.ts";

/** One Home list: the total in the bucket and the first few items to show. */
export type HomeList = { count: number; items: Note[] };

export const HOME_LIST_LIMIT = 5;

const active = (notes: Note[], workspaceId: string, bucket: BucketId) =>
  notes.filter(note => note.workspaceId === workspaceId && !note.completedAt && note.bucket === bucket);

const take = (notes: Note[], limit: number): HomeList => ({ count: notes.length, items: notes.slice(0, limit) });

/** Inbox items waiting to be clarified, newest capture first. */
export function inboxItems(notes: Note[], workspaceId: string, limit = HOME_LIST_LIMIT): HomeList {
  return take(active(notes, workspaceId, "inbox")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), limit);
}

/** Next actions: dated ones first (soonest due), then most recently touched. */
export function nextActionItems(notes: Note[], workspaceId: string, limit = HOME_LIST_LIMIT): HomeList {
  const due = (note: Note) => (isDueDate(note.dueDate) ? note.dueDate : null);
  return take(active(notes, workspaceId, "next").sort((a, b) => {
    const da = due(a), db = due(b);
    if (da && db && da !== db) return da.localeCompare(db);
    if (da && !db) return -1;
    if (!da && db) return 1;
    return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  }), limit);
}

/** Waiting-for items, least recently touched first: those most likely need a follow-up. */
export function waitingItems(notes: Note[], workspaceId: string, limit = HOME_LIST_LIMIT): HomeList {
  return take(active(notes, workspaceId, "waiting")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)), limit);
}

/** Counts behind the Home summary line. `today` is a local YYYY-MM-DD key. */
export function attentionSummary(notes: Note[], workspaceId: string, today: string) {
  const due = groupDueItems(notes, workspaceId, today);
  return {
    toClarify: active(notes, workspaceId, "inbox").length,
    overdue: due.overdue.length,
    dueToday: due.today.length,
  };
}
