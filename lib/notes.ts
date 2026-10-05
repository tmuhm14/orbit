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
  source: "web";
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
export function exampleNotes(): Note[] {
  const samples: [string, string, BucketId, string[]][] = [
    [
      "A place for all those little ideas",
      "You do not need to organize a thought before you capture it. That is what your inbox is for.\nOpen a note, type / to add a heading, a list, or a checkbox. Move it to a bucket whenever you are ready.",
      "inbox",
      ["getting started"],
    ],
    [
      "Try a slower Sunday morning",
      "Coffee, a long walk, and absolutely no notifications. Maybe find a new bookshop along the way.",
      "inbox",
      ["personal"],
    ],
    [
      "An idea for the next chapter",
      "What would I make if I had a little more room to think?\nCollect a few possibilities here. There is no need to decide yet.",
      "inbox",
      ["ideas"],
    ],
    [
      "Make a little room to focus",
      "Set aside 25 minutes. Pick one small thing. Start there.",
      "next",
      ["personal"],
    ],
    [
      "Build my personal workspace",
      "A calm place to capture thoughts and turn them into meaningful next steps.\nFirst step: collect what is on my mind.",
      "projects",
      ["work"],
    ],
    [
      "Weekend plans with friends",
      "Waiting for everyone to share their availability.",
      "waiting",
      ["personal"],
    ],
    [
      "See the northern lights",
      "Find a quiet place, far from the city, and look up.",
      "someday",
      ["travel"],
    ],
    [
      "A simple weekly review",
      "Collect your loose notes.\nClarify your inbox.\nReview your next actions, projects, and waiting list.\nReconnect with what matters.",
      "reference",
      ["getting started"],
    ],
  ];
  return samples.map(([title, body, bucket, tags], index) => ({
    id: `welcome-${index}`,
    title,
    content: textDoc(body),
    plainText: body,
    bucket,
    tags,
    createdAt: new Date(Date.now() - index * 3600000).toISOString(),
    updatedAt: new Date(Date.now() - index * 3600000).toISOString(),
    completedAt: null,
    source: "web",
  }));
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
