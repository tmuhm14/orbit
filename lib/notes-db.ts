import "server-only";
import {
  BUCKETS,
  ITEM_ERROR_CODES,
  followupError,
  isItemKind,
  normalizeFollowupText,
  isNote,
  type ItemKind,
  type Note,
  type NoteWrite,
  type SaveResponse,
  type SaveResult,
} from "./notes";

export const NOTE_COLUMNS =
  "id,workspace_id,title,content,plain_text,bucket,tags,source,origin,created_at,updated_at,completed_at,due_date,revision,kind,project_id,waiting_on,waiting_for,next_check_on";

export type NoteRow = {
  id: string;
  workspace_id: string;
  title: string;
  content: Note["content"];
  plain_text: string;
  bucket: Note["bucket"];
  tags: string[];
  source: Note["source"];
  origin: Note["origin"];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  due_date: string | null;
  /** Absent only in rows selected before revisions existed. */
  revision?: number;
  /** Absent only in rows selected before kinds existed (read as "note"). */
  kind?: ItemKind;
  project_id?: string | null;
  /** Absent only in rows selected before follow-ups existed (read as null). */
  waiting_on?: string | null;
  waiting_for?: string | null;
  next_check_on?: string | null;
};

// Postgres returns microsecond offsets ("+00:00"); the client compares the
// millisecond ISO strings it generated, so normalize on the way out.
const iso = (value: string) => new Date(value).toISOString();

export function fromRow(row: NoteRow): Note {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    content: row.content,
    plainText: row.plain_text,
    bucket: row.bucket,
    tags: row.tags,
    source: row.source,
    origin: row.origin ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at && iso(row.completed_at),
    dueDate: row.due_date ?? null,
    ...(row.revision != null ? { revision: Number(row.revision) } : {}),
    kind: row.kind ?? "note",
    projectId: row.project_id ?? null,
    waitingOn: row.waiting_on ?? null,
    waitingFor: row.waiting_for ?? null,
    nextCheckOn: row.next_check_on ?? null,
  };
}

/** Columns a client save may write. Source, origin, and triage are server-owned. */
export function toRow(note: Note, userId: string) {
  return {
    id: note.id,
    user_id: userId,
    workspace_id: note.workspaceId,
    title: note.title,
    content: note.content,
    plain_text: note.plainText,
    bucket: note.bucket,
    tags: note.tags,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    completed_at: note.completedAt,
    // Absent means unchanged, so older clients can never reset these.
    ...(note.dueDate !== undefined ? { due_date: note.dueDate } : {}),
    ...(note.kind !== undefined ? { kind: note.kind } : {}),
    ...(note.projectId !== undefined ? { project_id: note.projectId } : {}),
    // Follow-up text is trimmed; empty means cleared.
    ...(note.waitingOn !== undefined
      ? { waiting_on: normalizeFollowupText(note.waitingOn) ?? null }
      : {}),
    ...(note.waitingFor !== undefined
      ? { waiting_for: normalizeFollowupText(note.waitingFor) ?? null }
      : {}),
    ...(note.nextCheckOn !== undefined
      ? { next_check_on: note.nextCheckOn || null }
      : {}),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONTENT = 500_000;

/** Validates a client-supplied note before it is written. */
export function isSavableNote(value: unknown): value is Note {
  if (!isNote(value)) return false;
  return (
    UUID.test(value.id) &&
    typeof value.workspaceId === "string" &&
    UUID.test(value.workspaceId) &&
    BUCKETS.some((b) => b.id === value.bucket) &&
    value.title.length <= 2000 &&
    value.tags.length <= 50 &&
    value.tags.every((t) => t.length <= 100) &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    !Number.isNaN(Date.parse(value.updatedAt)) &&
    (value.completedAt === null ||
      !Number.isNaN(Date.parse(value.completedAt))) &&
    (value.kind === undefined || isItemKind(value.kind)) &&
    // Whether the link is allowed is left to the database.
    (value.projectId === undefined ||
      value.projectId === null ||
      UUID.test(value.projectId)) &&
    // Lengths after trimming, no control characters, a calendar date.
    followupError(value) === null &&
    JSON.stringify(value.content).length + value.plainText.length <= MAX_CONTENT
  );
}

// --- Revision-checked writes (ADR 002) --------------------------------------

/** undefined (legacy), null (create-only) or a positive revision. */
export const isExpectedRevision = (
  value: unknown,
): value is number | null | undefined =>
  value === undefined ||
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 1);

/** Whether a write states its expected revision (create-only counts). */
export const hasExpectedRevision = (note: object) =>
  Object.hasOwn(note, "expectedRevision") &&
  (note as { expectedRevision?: unknown }).expectedRevision !== undefined;

/**
 * One item for save_notes(). Server-owned columns (user, source, origin,
 * triage, revision, updated_at) are never sent; the function ignores them.
 */
export function toSaveItem(note: NoteWrite) {
  const { user_id: _user, updated_at: _updated, ...row } = toRow(note, "");
  return {
    ...row,
    ...(hasExpectedRevision(note)
      ? { expected_revision: note.expectedRevision }
      : {}),
  };
}

/** Parses ?expectedRevision=: absent, a positive integer, or invalid. */
export function parseExpectedRevision(
  value: string | null,
): number | undefined | "invalid" {
  if (value === null || value === "") return undefined;
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return "invalid";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

type RawSaveResult = {
  id: string;
  status: SaveResult["status"];
  revision?: number;
  updatedAt?: string;
  expectedRevision?: number | null;
  currentRevision?: number | null;
  current?: NoteRow | null;
  code?: string;
};

const INVALID_CODES = new Set<string>([
  ...ITEM_ERROR_CODES,
  "not_found",
  "invalid_note",
]);

/** Maps one save_notes() item to the API shape. */
function saveResult(raw: RawSaveResult, includeCurrent: boolean): SaveResult {
  switch (raw.status) {
    case "saved":
      return {
        id: raw.id,
        status: "saved",
        revision: Number(raw.revision),
        updatedAt: iso(String(raw.updatedAt)),
      };
    case "conflict":
      return {
        id: raw.id,
        status: "conflict",
        expectedRevision: raw.expectedRevision ?? null,
        currentRevision:
          raw.currentRevision == null ? null : Number(raw.currentRevision),
        ...(includeCurrent
          ? { current: raw.current ? fromRow(raw.current) : null }
          : {}),
      };
    case "precondition_required":
      return { id: raw.id, status: "precondition_required" };
    default:
      return {
        id: raw.id,
        status: "invalid",
        code: (INVALID_CODES.has(String(raw.code))
          ? raw.code
          : "invalid_note") as Extract<SaveResult, { status: "invalid" }>["code"],
      };
  }
}

/**
 * Status and body for a batch save (ADR 002 §3). Precedence over items: any
 * conflict → 409, else any missing precondition → 428, else any invalid →
 * 422 with the first item's code, else 200. Messages never contain content.
 * includeCurrent returns the server copy on conflict; only for the owner's
 * browser session.
 */
export function saveResponse(
  raw: unknown,
  { includeCurrent }: { includeCurrent: boolean },
): { status: number; body: SaveResponse } | null {
  if (!Array.isArray(raw)) return null;
  const results = (raw as RawSaveResult[]).map((r) => saveResult(r, includeCurrent));
  const saved = results.filter((r) => r.status === "saved").length;
  const invalid = results.find((r) => r.status === "invalid");
  if (results.some((r) => r.status === "conflict"))
    return {
      status: 409,
      body: {
        error: "Some notes were changed elsewhere",
        code: "revision_conflict",
        saved,
        results,
      },
    };
  if (results.some((r) => r.status === "precondition_required"))
    return {
      status: 428,
      body: {
        error: "Reload to keep saving",
        code: "precondition_required",
        saved,
        results,
      },
    };
  if (invalid)
    return {
      status: 422,
      body: { error: "Some notes could not be saved", code: invalid.code, saved, results },
    };
  return { status: 200, body: { saved, results } };
}

type RawDeleteResult = {
  status:
    | "deleted"
    | "not_found"
    | "conflict"
    | "precondition_required"
    | "project_has_linked_items";
  currentRevision?: number;
  current?: NoteRow;
  /** Direct children, for project_has_linked_items. */
  count?: number;
};

/** Parses ?unlinkChildren=: only "true" unlinks; absent or "false" does not. */
export function parseUnlinkChildren(value: string | null): boolean | "invalid" {
  if (value === null || value === "" || value === "false") return false;
  return value === "true" ? true : "invalid";
}

/**
 * Status and body for a conditional delete. A legacy delete (no expected
 * revision) of a note that is already gone still answers 200, as before, so
 * older tabs do not retry it forever.
 */
export function deleteResponse(
  raw: unknown,
  id: string,
  { includeCurrent, legacy }: { includeCurrent: boolean; legacy: boolean },
): { status: number; body: Record<string, unknown> } | null {
  const result = raw as RawDeleteResult | null;
  switch (result?.status) {
    case "deleted":
      return { status: 200, body: { deleted: id } };
    case "not_found":
      return legacy
        ? { status: 200, body: { deleted: id } }
        : { status: 404, body: { error: "Note not found", code: "not_found" } };
    case "conflict":
      return {
        status: 409,
        body: {
          error: "This note was changed elsewhere and was not deleted",
          code: "revision_conflict",
          currentRevision: Number(result.currentRevision),
          ...(includeCurrent && result.current
            ? { current: fromRow(result.current) }
            : {}),
        },
      };
    case "precondition_required":
      return {
        status: 428,
        body: { error: "Reload to keep saving", code: "precondition_required" },
      };
    case "project_has_linked_items":
      // Confirm with the user, then repeat with unlinkChildren=true.
      return {
        status: 409,
        body: {
          error: "This project has linked items and was not deleted",
          code: "project_has_linked_items",
          count: Number(result.count),
          currentRevision: Number(result.currentRevision),
          ...(includeCurrent && result.current
            ? { current: fromRow(result.current) }
            : {}),
        },
      };
    default:
      return null;
  }
}
