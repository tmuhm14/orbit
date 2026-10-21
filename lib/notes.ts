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
  /**
   * Follow-up (ADR 001 §4), allowed on any kind. waitingOn: who it is
   * waiting on (free text, not an account). waitingFor: what is expected.
   * nextCheckOn: calendar date (YYYY-MM-DD) to check in, never an instant.
   * Absent in older data; absent on a save means unchanged.
   */
  waitingOn?: string | null;
  waitingFor?: string | null;
  nextCheckOn?: string | null;
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
    waitingOn: null,
    waitingFor: null,
    nextCheckOn: null,
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
    (n.waitingOn === undefined || n.waitingOn === null || typeof n.waitingOn === "string") &&
    (n.waitingFor === undefined || n.waitingFor === null || typeof n.waitingFor === "string") &&
    (n.nextCheckOn === undefined || n.nextCheckOn === null || isDueDate(n.nextCheckOn)) &&
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
/**
 * Every per-item code a save can be refused with and that retrying can't
 * fix: the link codes, plus assignment_active (a workspace move refused
 * while an open assignment uses the item, ADR 003 §2). Kept apart from
 * LinkErrorCode, which the agent's own refusals also use and which can't
 * come from a workspace move.
 */
export const ITEM_ERROR_CODES = [...LINK_ERROR_CODES, "assignment_active"] as const;
export type ItemErrorCode = (typeof ITEM_ERROR_CODES)[number];
export const isItemErrorCode = (value: unknown): value is ItemErrorCode =>
  ITEM_ERROR_CODES.includes(value as ItemErrorCode);
/** Short, content-free explanations for each code. */
export const LINK_ERROR_MESSAGES: Record<ItemErrorCode, string> = {
  invalid_project_link: "That item can't be linked to this project.",
  project_cycle: "A project can't be placed inside one of its own sub-projects.",
  project_depth_exceeded: `Projects can be nested at most ${MAX_PROJECT_DEPTH} levels deep.`,
  linked_item_move: "Unlink this item from its project before moving it to another space.",
  project_has_linked_items: "This project still has linked items.",
  assignment_active:
    "An open assignment uses this item. Finish or cancel it before moving the item to another space.",
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
 * Adds a new top-level project in the item's workspace and links the item
 * to it, in one change. Returns the link code instead when the link would be
 * refused (for example a project item that would end up too deeply nested).
 */
export function withNewProject(
  notes: Note[],
  id: string,
  title: string,
): { notes: Note[]; projectId: string } | LinkErrorCode {
  const item = notes.find((n) => n.id === id);
  const name = title.trim();
  if (!item || !name) return "invalid_project_link";
  const project: Note = {
    ...createNote(name, "projects", item.workspaceId),
    kind: "project",
  };
  const next = [project, ...notes];
  const error = projectLinkError(next, id, project.id);
  if (error) return error;
  const updatedAt = new Date().toISOString();
  return {
    projectId: project.id,
    notes: next.map((n) => (n.id === id ? { ...n, projectId: project.id, updatedAt } : n)),
  };
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

/**
 * Current export file format. Version 1 files have no kind, projectId or
 * follow-up fields; version 2 has all of them (absent ones read as null).
 */
export const EXPORT_VERSION = 2;
/** The JSON backup of an account's notes, with kind, projectId and follow-up fields on each. */
export function exportDocument(notes: Note[], exportedAt = new Date().toISOString()) {
  return {
    version: EXPORT_VERSION,
    exportedAt,
    notes: notes.map((n) => ({
      ...n,
      kind: itemKind(n),
      projectId: n.projectId ?? null,
      waitingOn: n.waitingOn ?? null,
      waitingFor: n.waitingFor ?? null,
      nextCheckOn: n.nextCheckOn ?? null,
    })),
  };
}

// --- Follow-ups (ADR 001 §4) ------------------------------------------------

/** Longest waitingOn and waitingFor, in characters (code points). */
export const WAITING_ON_MAX = 200;
export const WAITING_FOR_MAX = 2000;
export type Followup = {
  waitingOn: string | null;
  waitingFor: string | null;
  nextCheckOn: string | null;
};
export type FollowupField = keyof Followup;
/** Why a follow-up value was refused (ADR 001 §7: a 400 invalid_payload). */
export type FollowupError = { code: "invalid_payload"; field: FollowupField };

// C0 controls, DEL and C1 controls, as in the database check constraints.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Trimmed text, null when empty, undefined when absent. */
export function normalizeFollowupText(value: string | null | undefined) {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalizes the follow-up fields that are present: text is trimmed (empty
 * becomes null) and a date stays as is. Absent fields stay absent.
 */
export function normalizeFollowup(value: Partial<Followup>): Partial<Followup> {
  const out: Partial<Followup> = {};
  if (value.waitingOn !== undefined) out.waitingOn = normalizeFollowupText(value.waitingOn) ?? null;
  if (value.waitingFor !== undefined) out.waitingFor = normalizeFollowupText(value.waitingFor) ?? null;
  if (value.nextCheckOn !== undefined) out.nextCheckOn = value.nextCheckOn || null;
  return out;
}

function textError(value: unknown, max: number) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  return [...trimmed].length > max || CONTROL.test(trimmed);
}

/**
 * The first follow-up field that would be refused, or null. Text must be at
 * most its limit after trimming and contain no control characters (single
 * line); nextCheckOn must be a calendar date or null/empty.
 */
export function followupError(value: Partial<Record<FollowupField, unknown>>): FollowupError | null {
  if (textError(value.waitingOn, WAITING_ON_MAX)) return { code: "invalid_payload", field: "waitingOn" };
  if (textError(value.waitingFor, WAITING_FOR_MAX)) return { code: "invalid_payload", field: "waitingFor" };
  const date = value.nextCheckOn;
  if (date !== undefined && date !== null && date !== "" && !isDueDate(date))
    return { code: "invalid_payload", field: "nextCheckOn" };
  return null;
}

/**
 * Where an item's next check stands on `today` (YYYY-MM-DD, the user's local
 * calendar date; see localToday() in lib/reminders): "overdue" before today,
 * "due" today, "upcoming" later, or null without a check date or once the
 * item is completed. Dates are compared as calendar dates, never instants.
 */
export function followupState(
  note: Pick<Note, "nextCheckOn" | "completedAt">,
  today: string,
): "overdue" | "due" | "upcoming" | null {
  const date = note.nextCheckOn;
  if (!date || !isDueDate(date) || note.completedAt || !isDueDate(today)) return null;
  return date < today ? "overdue" : date === today ? "due" : "upcoming";
}

/** Whether an item's next check is today or earlier (for Home's "Waiting for"). */
export const followupDue = (
  note: Pick<Note, "nextCheckOn" | "completedAt">,
  today: string,
) => {
  const state = followupState(note, today);
  return state === "overdue" || state === "due";
};

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
      code: ItemErrorCode | "not_found" | "invalid_note";
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
  const rejected: { id: string; code: ItemErrorCode; updatedAt: string }[] = [];
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
    else if (result.status === "invalid" && isItemErrorCode(result.code))
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

/** Prefix for kept drafts: `orbit.drafts.v1:<userId>:<noteId>`. */
export const DRAFTS_KEY = "orbit.drafts.v1";
/**
 * Local edits kept in browser storage: edits that could not be saved because
 * of a conflict, or (unsaved: true) edits not saved yet when the page was
 * left or the server asked for a newer client. Older clients read an unsaved
 * draft as a conflict, which keeps it safe either way.
 */
export type NoteDraft = {
  local: Note;
  baseRevision: number | null;
  savedAt: string;
  unsaved?: true;
};
function isDraft(value: unknown): value is NoteDraft {
  const d = value as NoteDraft;
  return (
    !!d &&
    typeof d === "object" &&
    isNote(d.local) &&
    (d.baseRevision === null || Number.isSafeInteger(d.baseRevision)) &&
    typeof d.savedAt === "string" &&
    (d.unsaved === undefined || d.unsaved === true)
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

/** Same value with object keys sorted (jsonb does not keep key order). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonical(object[key])]),
  );
}
const instant = (value: string | null | undefined) => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
};

/**
 * Whether two copies of a note hold the same values a user can edit.
 * Server-managed fields (revision, timestamps, source) are ignored.
 */
export function sameEdits(a: Note, b: Note): boolean {
  const view = (n: Note) =>
    JSON.stringify(
      canonical({
        workspaceId: n.workspaceId,
        title: n.title,
        content: n.content,
        plainText: n.plainText,
        bucket: n.bucket,
        tags: n.tags,
        completedAt: instant(n.completedAt),
        dueDate: n.dueDate ?? null,
        kind: itemKind(n),
        projectId: n.projectId ?? null,
        waitingOn: n.waitingOn ?? null,
        waitingFor: n.waitingFor ?? null,
        nextCheckOn: n.nextCheckOn ?? null,
      }),
    );
  return view(a) === view(b);
}

export type RestoredConflict = ConflictInfo & { detectedAt: string };

/**
 * What to do with drafts kept from an earlier visit, given the notes as the
 * server rendered them. Conflicted drafts come back as conflicts, as before.
 * An unsaved draft comes back as an ordinary unsaved edit while the server
 * copy is still the one it was based on (or, for a note never saved, while
 * the server has none); it is dropped when the server copy already holds the
 * same edits, and it becomes a conflict otherwise. With `unsaved: false`
 * (the list could not be loaded) unsaved drafts are left in storage.
 * Pure, so restoring twice (React StrictMode) gives the same result.
 */
export function restoreDrafts(
  current: Note[],
  drafts: NoteDraft[],
  { unsaved = true }: { unsaved?: boolean } = {},
) {
  const server = new Map(current.map((n) => [n.id, n]));
  const apply: Note[] = [];
  const conflicts: RestoredConflict[] = [];
  const drop: string[] = [];
  const pending: string[] = [];
  for (const draft of drafts) {
    const id = draft.local.id;
    const copy = server.get(id) ?? null;
    if (draft.unsaved) {
      if (!unsaved) continue;
      if (copy && sameEdits(copy, draft.local)) {
        drop.push(id);
        continue;
      }
      if (
        copy
          ? copy.revision != null && copy.revision === draft.baseRevision
          : draft.baseRevision === null
      ) {
        apply.push(draft.local);
        pending.push(id);
        continue;
      }
    }
    apply.push(draft.local);
    conflicts.push({
      id,
      baseRevision: draft.baseRevision,
      currentRevision: copy?.revision ?? null,
      server: copy,
      detectedAt: draft.savedAt,
    });
  }
  return { apply, conflicts, drop, unsaved: pending };
}

/** Puts restored copies into a list, replacing by id. Idempotent. */
export function withRestored(list: Note[], restored: Note[]): Note[] {
  if (!restored.length) return list;
  const byId = new Map(restored.map((n) => [n.id, n]));
  const ids = new Set(list.map((n) => n.id));
  return [
    ...list.map((n) => byId.get(n.id) ?? n),
    ...restored.filter((n) => !ids.has(n.id)),
  ];
}

/**
 * Which drafts to write and remove after the note list changed.
 * `restoring` (id → the restored copy's updatedAt) holds restored drafts the
 * list does not show yet; they are neither written nor removed until it
 * does, so an effect that runs again with the earlier list (React StrictMode)
 * cannot overwrite a restored draft with the server copy. Conflicted notes
 * are always written. Unsaved edits are written when `persistUnsaved` (the
 * page is being left, or a reload is required) and kept current while a
 * draft for them exists (`unsavedStored`); a stored unsaved draft is removed
 * once its note is saved or deleted.
 */
export function draftPlan({
  notes,
  synced,
  conflicts,
  held = new Map(),
  unsavedStored,
  restoring,
  persistUnsaved,
}: {
  notes: Note[];
  synced: SyncedMap;
  conflicts: ReadonlyMap<string, { baseRevision: number | null }>;
  held?: ReadonlyMap<string, string>;
  unsavedStored: ReadonlySet<string>;
  restoring: ReadonlyMap<string, string>;
  persistUnsaved: boolean;
}) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const stillRestoring = new Map(
    [...restoring].filter(([id, updatedAt]) => byId.get(id)?.updatedAt !== updatedAt),
  );
  const conflictDrafts: { local: Note; baseRevision: number | null }[] = [];
  for (const [id, conflict] of conflicts) {
    const local = byId.get(id);
    if (local && !stillRestoring.has(id))
      conflictDrafts.push({ local, baseRevision: conflict.baseRevision });
  }
  const { changed } = pendingWrites(notes, synced, new Set(conflicts.keys()), held);
  const pendingIds = new Set(changed.map((n) => n.id));
  const unsaved = changed
    .filter((n) => !stillRestoring.has(n.id) && (persistUnsaved || unsavedStored.has(n.id)))
    .map(({ expectedRevision, ...local }) => ({
      local: local as Note,
      baseRevision: expectedRevision ?? null,
    }));
  const remove = [...unsavedStored].filter(
    (id) => !stillRestoring.has(id) && !conflicts.has(id) && !pendingIds.has(id),
  );
  const stored = new Set(
    [...unsavedStored, ...unsaved.map((d) => d.local.id)].filter(
      (id) => !remove.includes(id) && !conflicts.has(id),
    ),
  );
  return { conflictDrafts, unsaved, remove, stored, restoring: stillRestoring };
}

/**
 * Splits conflicts on notes with an unsaved draft (`eligible`) whose server
 * copy already holds the same edits: those were saved before a reload (for
 * example by the page's last keepalive save) and are settled with the
 * server's revision instead of being shown as conflicts.
 */
export function settleIdenticalConflicts(
  found: ConflictInfo[],
  notes: Note[],
  eligible: ReadonlySet<string>,
) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const conflicts: ConflictInfo[] = [];
  const settled: { id: string; entry: SyncedEntry }[] = [];
  for (const conflict of found) {
    const local = byId.get(conflict.id);
    if (
      local &&
      conflict.server &&
      conflict.currentRevision != null &&
      eligible.has(conflict.id) &&
      sameEdits(local, conflict.server)
    )
      settled.push({
        id: conflict.id,
        entry: { revision: conflict.currentRevision, updatedAt: local.updatedAt },
      });
    else conflicts.push(conflict);
  }
  return { conflicts, settled };
}

/** Whether there are conflicts, or edits or deletes not yet confirmed. */
export function hasUnsavedChanges(
  notes: Note[],
  synced: SyncedMap,
  conflicted: ReadonlySet<string>,
  held: ReadonlyMap<string, string> = new Map(),
) {
  if (conflicted.size) return true;
  const { changed, deleted } = pendingWrites(notes, synced, conflicted, held);
  return changed.length > 0 || deleted.length > 0;
}

/** An item deleteWithUnlink() moved: where to, and its copy at the time. */
export type UnlinkMove = {
  id: string;
  to: string | null;
  updatedAt: string;
  /** It had no unsaved edits, so the move was never sent with it. */
  clean: boolean;
};

/**
 * A project deleted with unlinkChildren moves its direct items up to its
 * parent project (or to none) on the server. This applies the same move
 * locally right away, without marking the items as edited (the server makes
 * the change; the follow-up refresh picks up their new revisions). Items
 * with unsaved edits are saved with the new link. Returns the list without
 * the project and the items that moved. Idempotent.
 */
export function deleteWithUnlink(
  notes: Note[],
  projectId: string,
  synced: SyncedMap = new Map(),
) {
  const parent = notes.find((n) => n.id === projectId)?.projectId ?? null;
  const moved: UnlinkMove[] = [];
  const next = notes
    .filter((n) => n.id !== projectId)
    .map((n) => {
      if (n.projectId !== projectId) return n;
      moved.push({
        id: n.id,
        to: parent,
        updatedAt: n.updatedAt,
        clean: synced.get(n.id)?.updatedAt === n.updatedAt,
      });
      return { ...n, projectId: parent };
    });
  return { notes: next, moved };
}

/**
 * Undoes deleteWithUnlink()'s local move after the delete was refused, for
 * items that were clean when moved and are unchanged since (any other item
 * was or will be saved with the new link, or was replaced by a server copy).
 */
export function revertUnlink(notes: Note[], projectId: string, moved: UnlinkMove[]): Note[] {
  const byId = new Map(moved.filter((m) => m.clean).map((m) => [m.id, m]));
  return notes.map((n) => {
    const m = byId.get(n.id);
    return m && n.updatedAt === m.updatedAt && (n.projectId ?? null) === m.to
      ? { ...n, projectId }
      : n;
  });
}

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
