import type { JSONContent } from "@tiptap/react";

export const BUCKETS = [
  {
    id: "inbox",
    name: "Inbox",
    description: "Catch it now. Make sense of it later.",
    hint: "Your landing place for everything on your mind.",
    color: "purple",
    icon: "inbox",
  },
  {
    id: "next",
    name: "Next actions",
    description: "Small steps. Forward motion.",
    hint: "The next physical action you can take.",
    color: "green",
    icon: "zap",
  },
  {
    id: "projects",
    name: "Projects",
    description: "Big ideas, broken into possibilities.",
    hint: "Outcomes that need more than one action.",
    color: "blue",
    icon: "layers",
  },
  {
    id: "waiting",
    name: "Waiting for",
    description: "Out of your hands. Off your mind.",
    hint: "Things you have delegated or are waiting on.",
    color: "amber",
    icon: "clock",
  },
  {
    id: "someday",
    name: "Someday / maybe",
    description: "Give your possibilities a place.",
    hint: "Ideas to revisit when the time is right.",
    color: "pink",
    icon: "sparkles",
  },
  {
    id: "reference",
    name: "Reference",
    description: "Good things to keep within reach.",
    hint: "Useful information with no action required.",
    color: "slate",
    icon: "book",
  },
] as const;
export type BucketId = (typeof BUCKETS)[number]["id"];
export type Note = {
  id: string;
  title: string;
  content: JSONContent;
  plainText: string;
  bucket: BucketId;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  source: "web" | "slack";
  origin?: NoteOrigin | null;
};
/** Where a captured note came from, kept so it can be traced back. */
export type NoteOrigin = {
  kind: "slack";
  teamId: string;
  channelId: string;
  channelName?: string;
  messageTs: string;
  authorId?: string;
  permalink?: string;
};
export const STORAGE_KEY = "orbit.notes.v1";
export const textDoc = (text: string): JSONContent => ({
  type: "doc",
  content: text.split("\n").map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : undefined,
  })),
});
export function createNote(title = "", bucket: BucketId = "inbox"): Note {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title,
    content: textDoc(""),
    plainText: "",
    bucket,
    tags: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    source: "web",
  };
}
export function isNote(value: unknown): value is Note {
  if (!value || typeof value !== "object") return false;
  const n = value as Note;
  return (
    typeof n.id === "string" &&
    typeof n.title === "string" &&
    typeof n.plainText === "string" &&
    BUCKETS.some((b) => b.id === n.bucket) &&
    Array.isArray(n.tags) &&
    n.tags.every((t) => typeof t === "string") &&
    typeof n.createdAt === "string" &&
    typeof n.updatedAt === "string" &&
    (n.completedAt === null || typeof n.completedAt === "string") &&
    (n.source === undefined || n.source === "web" || n.source === "slack") &&
    n.content?.type === "doc"
  );
}
export const noteRepository = {
  hasLegacyNotes(userId: string): boolean {
    const owner = localStorage.getItem(`${STORAGE_KEY}:legacy-owner`);
    return (
      localStorage.getItem(STORAGE_KEY) !== null &&
      (!owner || owner === userId) &&
      localStorage.getItem(`${STORAGE_KEY}:${userId}:imported`) !== "true"
    );
  },
  importLegacy(userId: string, current: Note[]): Note[] {
    if (!this.hasLegacyNotes(userId)) return current;
    const legacy: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || "[]",
    );
    if (!Array.isArray(legacy) || !legacy.every(isNote))
      throw new Error(
        "Existing notes could not be read. The original data is unchanged.",
      );
    const ids = new Set(current.map((note) => note.id));
    const merged = [...current, ...legacy.filter((note) => !ids.has(note.id))];
    this.save(userId, merged);
    localStorage.setItem(`${STORAGE_KEY}:legacy-owner`, userId);
    localStorage.setItem(`${STORAGE_KEY}:${userId}:imported`, "true");
    return merged;
  },
  load(userId: string): Note[] {
    const stored = localStorage.getItem(`${STORAGE_KEY}:${userId}`);
    if (stored === null) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every(isNote))
      throw new Error(
        "Your saved notes could not be read. Your original data has been preserved.",
      );
    return parsed;
  },
  save(userId: string, notes: Note[]) {
    localStorage.setItem(`${STORAGE_KEY}:${userId}`, JSON.stringify(notes));
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (id: string) => UUID.test(id);
/**
 * Notes that live only in this browser (from before account storage) and
 * have not been moved into the account yet. Reading never changes them; the
 * originals stay in localStorage as a backup after they are moved.
 */
export const browserNotes = {
  pending(userId: string): Note[] {
    if (localStorage.getItem(`${STORAGE_KEY}:${userId}:uploaded`) === "true")
      return [];
    const notes = noteRepository.load(userId);
    if (noteRepository.hasLegacyNotes(userId)) {
      let legacy: unknown = null;
      try {
        legacy = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      } catch {
        /* Unreadable legacy notes stay untouched in storage. */
      }
      if (Array.isArray(legacy) && legacy.every(isNote)) {
        const ids = new Set(notes.map((note) => note.id));
        notes.push(...legacy.filter((note) => !ids.has(note.id)));
      }
    }
    // Early versions used non-UUID ids, which account storage does not accept.
    return notes.map((note) =>
      isUuid(note.id) ? note : { ...note, id: crypto.randomUUID() },
    );
  },
  markUploaded(userId: string) {
    localStorage.setItem(`${STORAGE_KEY}:${userId}:uploaded`, "true");
    if (noteRepository.hasLegacyNotes(userId)) {
      localStorage.setItem(`${STORAGE_KEY}:legacy-owner`, userId);
      localStorage.setItem(`${STORAGE_KEY}:${userId}:imported`, "true");
    }
  },
};
