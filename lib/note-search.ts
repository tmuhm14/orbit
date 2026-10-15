import type { Note } from "./notes.ts";

/**
 * The workspace's text search: a case-insensitive substring of the title,
 * plain text or tags. Shared by the notes views and the Library. An empty
 * query matches everything.
 */
export function matchesText(note: Pick<Note, "title" | "plainText" | "tags">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${note.title} ${note.plainText} ${note.tags.join(" ")}`.toLowerCase().includes(q);
}
