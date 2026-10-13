import { isDueDate, type Note } from "./notes.ts";

export function localDateKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Calendar dates compare directly, avoiding UTC shifts and DST arithmetic. */
export function groupDueItems(notes: Note[], workspaceId: string, today: string) {
  const groups: { overdue: Note[]; today: Note[]; upcoming: Note[] } = { overdue: [], today: [], upcoming: [] };
  const due = notes.filter(note => note.workspaceId === workspaceId && !note.completedAt && isDueDate(note.dueDate))
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  for (const note of due) {
    groups[note.dueDate! < today ? "overdue" : note.dueDate === today ? "today" : "upcoming"].push(note);
  }
  return groups;
}
