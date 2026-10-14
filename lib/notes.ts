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
/**
 * What an item is (ADR 001 §2), independent of its bucket (where it sits in
 * the GTD workflow). Items without a kind (older data) are notes.
 */
export const ITEM_KINDS = ["note", "task", "project", "document", "followup"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const isItemKind = (value: unknown): value is ItemKind =>
  ITEM_KINDS.includes(value as ItemKind);
/** The item's kind; notes from before kinds existed are notes. */
export const itemKind = (note: Pick<Note, "kind">): ItemKind => note.kind ?? "note";
/** Longest chain of nested projects: a root project plus four levels. */
export const MAX_PROJECT_DEPTH = 5;
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
  /** Calendar date (YYYY-MM-DD), without a time or timezone. */
  dueDate?: string | null;
  source: "web" | "slack" | "email";
  origin?: NoteOrigin | null;
  /** Empty only for notes from older browser storage, before workspaces. */
  workspaceId: string;
  /**
   * Server-managed revision (ADR 002), as of when this copy was read. The
   * client's synced map is the source of truth for what it last confirmed.
   */
  revision?: number;
  /** Absent in older data, which reads as "note". */
  kind?: ItemKind;
  /** Parent project: a kind "project" item in the same workspace. */
  projectId?: string | null;
};
export type Workspace = {
  id: string;
  name: string;
  position: number;
  color: string | null;
  isDefault: boolean;
  /** Secret part of the workspace's email address. */
  inboxToken: string;
  /** Whether the organizing agent may read and change this workspace's notes. */
  agentEnabled: boolean;
};
/** A Slack account linked to this Orbit account, and where its captures go. */
export type SlackConnection = {
  teamId: string;
  teamName: string | null;
  slackUserId: string;
  workspaceId: string;
};
/** Where a captured note came from, kept so it can be traced back. */
export type NoteOrigin =
  | {
      kind: "slack";
      teamId: string;
      channelId: string;
      channelName?: string;
      messageTs: string;
      authorId?: string;
      permalink?: string;
    }
  | { kind: "email"; from: string; subject?: string; messageId?: string };
export const STORAGE_KEY = "orbit.notes.v1";
export const textDoc = (text: string): JSONContent => ({
  type: "doc",
  content: text.split("\n").map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : undefined,
  })),
});
export function createNote(
  title = "",
  bucket: BucketId = "inbox",
  workspaceId = "",
): Note {
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
    dueDate: null,
    source: "web",
    workspaceId,
    kind: "note",
    projectId: null,
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
    (n.dueDate === undefined || n.dueDate === null || isDueDate(n.dueDate)) &&
    (n.revision === undefined ||
      (Number.isSafeInteger(n.revision) && n.revision >= 1)) &&
    (n.kind === undefined || isItemKind(n.kind)) &&
    (n.projectId === undefined ||
      n.projectId === null ||
      typeof n.projectId === "string") &&
    (n.source === undefined ||
      n.source === "web" ||
      n.source === "slack" ||
      n.source === "email") &&
    n.content?.type === "doc"
  );
}
export function isDueDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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

// --- Kinds and project links (ADR 001 §3, §7) ------------------------------

/**
 * Why a project link or kind change was refused. The database is the source
 * of truth; projectLinkError() mirrors its rules so the UI can explain them
 * before saving.
 */
export const LINK_ERROR_CODES = [
  "invalid_project_link",
  "project_cycle",
  "project_depth_exceeded",
  "linked_item_move",
  "project_has_linked_items",
] as const;
export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];
export const isLinkErrorCode = (value: unknown): value is LinkErrorCode =>
  LINK_ERROR_CODES.includes(value as LinkErrorCode);
/** Short, content-free explanations for each code. */
export const LINK_ERROR_MESSAGES: Record<LinkErrorCode, string> = {
  invalid_project_link: "That item can't be linked to this project.",
  project_cycle: "A project can't be placed inside one of its own sub-projects.",
  project_depth_exceeded: `Projects can be nested at most ${MAX_PROJECT_DEPTH} levels deep.`,
  linked_item_move: "Unlink this item from its project before moving it to another space.",
  project_has_linked_items: "This project still has linked items.",
};

/** Projects in a workspace, by title. */
export function projectsIn(notes: Note[], workspaceId: string): Note[] {
  return notes
    .filter((n) => n.workspaceId === workspaceId && itemKind(n) === "project")
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Items linked directly to a project. */
export const projectChildren = (notes: Note[], projectId: string) =>
  notes.filter((n) => n.projectId === projectId);

/** Projects above an item, nearest first (bounded, so bad data can't loop). */
export function projectAncestors(notes: Note[], id: string): Note[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const out: Note[] = [];
  let parent = byId.get(id)?.projectId;
  while (parent && out.length <= MAX_PROJECT_DEPTH) {
    const next = byId.get(parent);
    if (!next || out.includes(next)) break;
    out.push(next);
    parent = next.projectId;
  }
  return out;
}

/** Everything under a project with its depth (1 = direct contents). */
export function projectDescendants(
  notes: Note[],
  projectId: string,
): { note: Note; depth: number }[] {
  const out: { note: Note; depth: number }[] = [];
  const seen = new Set([projectId]);
  let level = [projectId];
  for (let depth = 1; level.length && depth <= MAX_PROJECT_DEPTH; depth++) {
    const next: string[] = [];
    for (const child of notes.filter((n) => n.projectId && level.includes(n.projectId))) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ note: child, depth });
      if (itemKind(child) === "project") next.push(child.id);
    }
    level = next;
  }
  return out;
}

/** Height of a project's own sub-project subtree (0 without sub-projects). */
function projectHeight(notes: Note[], projectId: string) {
  return projectDescendants(notes, projectId)
    .filter((d) => itemKind(d.note) === "project")
    .reduce((max, d) => Math.max(max, d.depth), 0);
}

/**
 * Whether item `id` may have `projectId` as its parent while being `kind`
 * (its current kind by default), by the same rules as the database. Returns
 * null when allowed. Only sees the notes it is given.
 */
export function projectLinkError(
  notes: Note[],
  id: string,
  projectId: string | null,
  kind?: ItemKind,
): LinkErrorCode | null {
  const item = notes.find((n) => n.id === id);
  const nextKind = kind ?? (item ? itemKind(item) : "note");
  if (item && itemKind(item) === "project" && nextKind !== "project" &&
      notes.some((n) => n.projectId === id))
    return "project_has_linked_items";
  if (projectId === null) return null;
  const parent = notes.find((n) => n.id === projectId);
  if (projectId === id || !parent || itemKind(parent) !== "project" ||
      (item && parent.workspaceId !== item.workspaceId))
    return "invalid_project_link";
  if (nextKind !== "project") return null;
  const above = projectAncestors(notes, projectId);
  if (above.some((n) => n.id === id)) return "project_cycle";
  if (above.length + 2 + projectHeight(notes, id) > MAX_PROJECT_DEPTH)
    return "project_depth_exceeded";
  return null;
}

/**
 * Orders a batch so a new parent is saved before the items that link to it,
 * and unlinks before links. The server checks each item on its own.
 */
export function orderForSave<T extends Note>(notes: T[]): T[] {
  const ids = new Set(notes.map((n) => n.id));
  const placed = new Set<string>();
  const unlinked = notes
    .filter((n) => !n.projectId)
    .sort((a, b) => Number(itemKind(a) === "project") - Number(itemKind(b) === "project"));
  const out: T[] = [...unlinked];
  unlinked.forEach((n) => placed.add(n.id));
  let rest = notes.filter((n) => n.projectId);
  while (rest.length) {
    const ready = rest.filter((n) => !ids.has(n.projectId!) || placed.has(n.projectId!));
    // A cycle within the batch: send the rest as they are; the server refuses it.
    const batch = ready.length ? ready : rest;
    batch.forEach((n) => {
      out.push(n);
      placed.add(n.id);
    });
    rest = rest.filter((n) => !batch.includes(n));
  }
  return out;
}

/** Current export file format. Version 1 files have no kind or projectId. */
export const EXPORT_VERSION = 2;
/** The JSON backup of an account's notes, with kind and projectId on each. */
export function exportDocument(notes: Note[], exportedAt = new Date().toISOString()) {
  return {
    version: EXPORT_VERSION,
    exportedAt,
    notes: notes.map((n) => ({ ...n, kind: itemKind(n), projectId: n.projectId ?? null })),
  };
}

// --- Revisions and conflicts (ADR 002) -------------------------------------

/** Build number of this client's save protocol, sent as X-Orbit-Client. */
export const NOTES_CLIENT_VERSION = 1;
export const CLIENT_HEADER = "X-Orbit-Client";
export const MIN_CLIENT_HEADER = "X-Orbit-Min-Client";

/**
 * A note as sent to `PUT /api/notes`. expectedRevision: a number applies the
 * write only at that revision, null creates only (fails if the id exists),
 * and leaving it out is a legacy last-writer-wins write.
 */
export type NoteWrite = Note & { expectedRevision?: number | null };

export type SaveResult =
  | { id: string; status: "saved"; revision: number; updatedAt: string }
  | {
      id: string;
      status: "conflict";
      expectedRevision: number | null;
      /** null: deleted elsewhere. */
      currentRevision: number | null;
      /** Server copy, only for the owner's browser session. */
      current?: Note | null;
    }
  | { id: string; status: "precondition_required" }
  | {
      id: string;
      status: "invalid";
      code: LinkErrorCode | "not_found" | "invalid_note";
    };

export type SaveResponse = {
  error?: string;
  code?: string;
  /** Count of saved items, kept for older clients. */
  saved: number;
  results: SaveResult[];
};

/** What the server last confirmed for a note. */
export type SyncedEntry = {
  /** Server revision, or null when the server has not reported one. */
  revision: number | null;
  /** The local updatedAt that was saved; a different one means unsaved edits. */
  updatedAt: string;
};
export type SyncedMap = ReadonlyMap<string, SyncedEntry>;

/** A note changed elsewhere while this browser also changed it. */
export type ConflictInfo = {
  id: string;
  /** Revision the local edits were based on; null for a note never saved. */
  baseRevision: number | null;
  /** null: deleted elsewhere. */
  currentRevision: number | null;
  /** Server copy; null when it was deleted elsewhere. */
  server: Note | null;
};

/** Older callers pass id → updatedAt; treat those as unknown revisions. */
function syncedEntry(value: SyncedEntry | string | undefined) {
  if (value === undefined) return undefined;
  return typeof value === "string" ? { revision: null, updatedAt: value } : value;
}

/** Revision to send with a save: the synced one, or null (create-only). */
export const expectedRevisionFor = (synced: SyncedMap, id: string) =>
  synced.get(id)?.revision ?? null;

/**
 * Local edits and deletes not yet confirmed by the server, with the revision
 * each was based on. Conflicted notes are left out so they are never resent
 * automatically.
 */
export function pendingWrites(
  notes: Note[],
  synced: SyncedMap,
  conflicted: ReadonlySet<string> = new Set(),
  /** Refused link changes (id → updatedAt); resent only after another edit. */
  rejected: ReadonlyMap<string, string> = new Map(),
) {
  const ids = new Set(notes.map((n) => n.id));
  return {
    changed: orderForSave(
      notes
        .filter(
          (n) =>
            !conflicted.has(n.id) &&
            rejected.get(n.id) !== n.updatedAt &&
            synced.get(n.id)?.updatedAt !== n.updatedAt,
        )
        .map(
          (n): NoteWrite => ({ ...n, expectedRevision: expectedRevisionFor(synced, n.id) }),
        ),
    ),
    deleted: [...synced.keys()]
      .filter((id) => !ids.has(id) && !conflicted.has(id))
      .map((id) => ({ id, expectedRevision: synced.get(id)?.revision ?? null })),
  };
}

/**
 * Applies per-item save results. Saved items record the server revision and
 * the updatedAt that was sent (later local edits stay dirty). Conflicts are
 * returned for the caller to keep as drafts. Items refused by a project rule
 * (ADR 001 §7) are returned as `rejected`: retrying cannot help, so the
 * caller holds them until the user changes them again. `failed` is true when
 * an item could not be saved for another reason and should be retried later.
 */
export function applySaveResults(
  synced: SyncedMap,
  sent: NoteWrite[],
  results: SaveResult[],
) {
  const next = new Map(synced);
  const sentById = new Map(sent.map((n) => [n.id, n]));
  const conflicts: ConflictInfo[] = [];
  const rejected: { id: string; code: LinkErrorCode; updatedAt: string }[] = [];
  let failed = false;
  for (const result of results) {
    const note = sentById.get(result.id);
    if (!note) continue;
    if (result.status === "saved")
      next.set(result.id, { revision: result.revision, updatedAt: note.updatedAt });
    else if (result.status === "conflict")
      conflicts.push({
        id: result.id,
        baseRevision: note.expectedRevision ?? null,
        currentRevision: result.currentRevision,
        server: result.current ?? null,
      });
    else if (result.status === "invalid" && isLinkErrorCode(result.code))
      rejected.push({ id: result.id, code: result.code, updatedAt: note.updatedAt });
    else failed = true;
  }
  if (results.length < sent.length) failed = true;
  return { synced: next, conflicts, rejected, failed };
}

/**
 * Combines a fresh server list with local state. `synced` maps note id to what
 * the server last confirmed: a local note whose updatedAt differs has unsaved
 * edits (kept), and a synced id missing locally was deleted here (stays
 * deleted). A note with unsaved edits whose server revision moved past the
 * one it was based on, or that was deleted elsewhere, is reported as a
 * conflict (local copy kept). Notes in `conflicted` are kept as they are.
 * Pure, so it is safe inside a React state updater.
 */
export function mergeServerNotes(
  local: Note[],
  server: Note[],
  synced: ReadonlyMap<string, SyncedEntry | string>,
  conflicted: ReadonlySet<string> = new Set(),
): { notes: Note[]; synced: Map<string, SyncedEntry>; conflicts: ConflictInfo[] } {
  const known = new Map<string, SyncedEntry>();
  for (const [id, value] of synced) known.set(id, syncedEntry(value)!);
  const nextSynced = new Map(known);
  const dirty = (n: Note) => known.get(n.id)?.updatedAt !== n.updatedAt;
  const localById = new Map(local.map((n) => [n.id, n]));
  const serverIds = new Set(server.map((n) => n.id));
  const notes: Note[] = [];
  const conflicts: ConflictInfo[] = [];
  const conflict = (id: string, remote: Note | null) =>
    conflicts.push({
      id,
      baseRevision: known.get(id)?.revision ?? null,
      currentRevision: remote?.revision ?? null,
      server: remote,
    });
  for (const remote of server) {
    const mine = localById.get(remote.id);
    const entry = known.get(remote.id);
    if (mine && (conflicted.has(mine.id) || dirty(mine))) {
      notes.push(mine);
      if (
        conflicted.has(mine.id) ||
        (entry?.revision != null &&
          remote.revision != null &&
          remote.revision > entry.revision)
      )
        conflict(mine.id, remote);
    } else if (
      mine &&
      entry?.revision != null &&
      entry.revision === remote.revision
    ) {
      // Same revision: nothing changed that the user can see. Keep the local
      // object so an open editor is not reset.
      notes.push(mine);
    } else if (mine || !entry) {
      notes.push(remote);
      nextSynced.set(remote.id, {
        revision: remote.revision ?? null,
        updatedAt: remote.updatedAt,
      });
    }
  }
  // Keep local notes the server hasn't seen yet; drop clean ones it deleted.
  // Edited notes deleted elsewhere are kept as conflicts.
  for (const mine of local) {
    if (serverIds.has(mine.id)) continue;
    const entry = known.get(mine.id);
    if (!entry) notes.push(mine);
    else if (conflicted.has(mine.id) || dirty(mine)) {
      notes.push(mine);
      if (conflicted.has(mine.id) || entry.revision != null) conflict(mine.id, null);
    }
  }
  const kept = new Set(notes.map((n) => n.id));
  for (const id of known.keys())
    if (!serverIds.has(id) && !kept.has(id)) nextSynced.delete(id);
  return { notes, synced: nextSynced, conflicts };
}

/** Prefix for conflicted drafts: `orbit.drafts.v1:<userId>:<noteId>`. */
export const DRAFTS_KEY = "orbit.drafts.v1";
/** Local edits that could not be saved because of a conflict. */
export type NoteDraft = {
  local: Note;
  baseRevision: number | null;
  savedAt: string;
};
function isDraft(value: unknown): value is NoteDraft {
  const d = value as NoteDraft;
  return (
    !!d &&
    typeof d === "object" &&
    isNote(d.local) &&
    (d.baseRevision === null || Number.isSafeInteger(d.baseRevision)) &&
    typeof d.savedAt === "string"
  );
}
function storageKeys() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) keys.push(key);
  }
  return keys;
}
/**
 * Conflicted drafts kept in browser storage, so a reload or crash does not
 * lose them. Removed when the conflict is resolved and on sign-out.
 */
export const noteDrafts = {
  key: (userId: string, noteId: string) => `${DRAFTS_KEY}:${userId}:${noteId}`,
  save(userId: string, draft: NoteDraft) {
    localStorage.setItem(this.key(userId, draft.local.id), JSON.stringify(draft));
  },
  remove(userId: string, noteId: string) {
    localStorage.removeItem(this.key(userId, noteId));
  },
  /** The account's readable drafts. Unreadable entries are left untouched. */
  load(userId: string): NoteDraft[] {
    const prefix = `${DRAFTS_KEY}:${userId}:`;
    const drafts: NoteDraft[] = [];
    for (const key of storageKeys()) {
      if (!key.startsWith(prefix)) continue;
      try {
        const draft: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
        if (isDraft(draft) && key === this.key(userId, draft.local.id))
          drafts.push(draft);
      } catch {
        /* Leave unreadable drafts in place. */
      }
    }
    return drafts;
  },
  /** Removes drafts for every account except `keepUserId` (all when omitted). */
  clear(keepUserId?: string) {
    const keep = keepUserId && `${DRAFTS_KEY}:${keepUserId}:`;
    for (const key of storageKeys())
      if (key.startsWith(`${DRAFTS_KEY}:`) && !(keep && key.startsWith(keep)))
        localStorage.removeItem(key);
  },
};

/** Accent palette for workspaces. ink is the text color on a solid accent. */
export const WORKSPACE_COLORS = {
  black: { accent: "#050506", ink: "#f4f1fa", line: "#4b4954" },
  purple: { accent: "#b09aeb", ink: "#17141d", line: "#b09aeb" },
  blue: { accent: "#8fafd9", ink: "#11161d", line: "#8fafd9" },
  green: { accent: "#91cbb3", ink: "#111a16", line: "#91cbb3" },
  amber: { accent: "#d0b185", ink: "#1c160e", line: "#d0b185" },
  pink: { accent: "#c69eb9", ink: "#1c1219", line: "#c69eb9" },
  slate: { accent: "#a4a8bc", ink: "#14151b", line: "#a4a8bc" },
} as const;
export type WorkspaceColor = keyof typeof WORKSPACE_COLORS;
export const isWorkspaceColor = (value: unknown): value is WorkspaceColor =>
  typeof value === "string" && value in WORKSPACE_COLORS;
const AUTO_COLORS: WorkspaceColor[] = [
  "purple",
  "blue",
  "green",
  "amber",
  "pink",
  "slate",
];
/** The workspace's chosen color, or an automatic one by its position. */
export function workspaceColor(
  workspaces: Workspace[],
  id: string,
): WorkspaceColor {
  const index = Math.max(
    0,
    workspaces.findIndex((w) => w.id === id),
  );
  const chosen = workspaces[index]?.color;
  return isWorkspaceColor(chosen)
    ? chosen
    : AUTO_COLORS[index % AUTO_COLORS.length];
}
