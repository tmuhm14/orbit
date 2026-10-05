import "server-only";
import { BUCKETS, isNote, type Note } from "./notes";

export const NOTE_COLUMNS =
  "id,workspace_id,title,content,plain_text,bucket,tags,source,origin,created_at,updated_at,completed_at";

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
    JSON.stringify(value.content).length + value.plainText.length <= MAX_CONTENT
  );
}
