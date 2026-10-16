// The Library (U-03): notes and documents worth keeping, their tags and
// where they came from. Pure. Provenance labels use only routing metadata
// (channel name, sender address), never captured content.
import { itemKind, type Note } from "./notes.ts";
import { matchesText } from "./note-search.ts";
import { isAgentResult } from "./projects-view.ts";

/**
 * In the Library: open documents anywhere, open notes once they've left the
 * Inbox (captures still to clarify stay there), and anything in Reference.
 */
export function isLibraryItem(note: Note): boolean {
  if (note.completedAt) return false;
  if (note.bucket === "reference") return true;
  const kind = itemKind(note);
  return kind === "document" || (kind === "note" && note.bucket !== "inbox");
}

export type Provenance =
  | { kind: "slack"; label: string; href: string | null }
  | { kind: "email"; label: string; href: null }
  | { kind: "assignment"; label: string; assignmentId: string | null }
  | null;

/** Where an item came from, for the source indicator. */
export function provenance(note: Pick<Note, "origin" | "source">): Provenance {
  const origin = note.origin as
    | { kind?: string; channelName?: string; permalink?: string; from?: string; assignmentId?: string }
    | null
    | undefined;
  if (isAgentResult(note))
    return {
      kind: "assignment",
      label: "Agent result",
      assignmentId: typeof origin?.assignmentId === "string" ? origin.assignmentId : null,
    };
  if (origin?.kind === "slack" || note.source === "slack") {
    const href = typeof origin?.permalink === "string" && /^https:\/\//.test(origin.permalink) ? origin.permalink : null;
    return { kind: "slack", label: origin?.channelName ? `Slack · #${origin.channelName}` : "Slack", href };
  }
  if (origin?.kind === "email" || note.source === "email")
    return { kind: "email", label: origin?.from ? `Email · ${origin.from}` : "Email", href: null };
  return null;
}

export type LibraryFilter = { tag: string | null; q: string };

/** Library items in a workspace, filtered by tag and text, most recently updated first. */
export function libraryItems(notes: Note[], workspaceId: string, { tag, q }: LibraryFilter): Note[] {
  return notes
    .filter((n) => n.workspaceId === workspaceId && isLibraryItem(n))
    .filter((n) => (!tag || n.tags.includes(tag)) && matchesText(n, q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** Tags used in the Library with how many items carry each, most used first. */
export function libraryTags(notes: Note[], workspaceId: string): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of notes)
    if (n.workspaceId === workspaceId && isLibraryItem(n))
      for (const t of new Set(n.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
