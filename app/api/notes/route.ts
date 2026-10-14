import { routeUser, json } from "@/lib/supabase/route-auth";
import {
  NOTE_COLUMNS,
  fromRow,
  hasExpectedRevision,
  isExpectedRevision,
  isSavableNote,
  saveResponse,
  toSaveItem,
  type NoteRow,
} from "@/lib/notes-db";
import {
  notesMinClient,
  notesRevisionEnforcement,
  recordLegacyWrite,
} from "@/lib/server-config";

const MIN_CLIENT_HEADER = "X-Orbit-Min-Client";

export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const { data, error } = await auth.supabase
    .from("notes")
    .select(NOTE_COLUMNS)
    .order("updated_at", { ascending: false })
    .returns<NoteRow[]>();
  if (error) return json({ error: "Could not load notes" }, 500);
  const response = json({ notes: data.map(fromRow) });
  response.headers.set(MIN_CLIENT_HEADER, String(notesMinClient()));
  return response;
}

/**
 * Creates or updates a batch of the user's notes through save_notes(), which
 * checks each item's expected revision (ADR 002 §2–3). Items are atomic on
 * their own, so a 409 can still contain saved items.
 */
export async function PUT(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON", code: "invalid_payload" }, 400);
  }
  const notes = (body as { notes?: unknown })?.notes;
  if (
    !Array.isArray(notes) ||
    notes.length > 500 ||
    !notes.every(
      (note) =>
        isSavableNote(note) &&
        isExpectedRevision((note as { expectedRevision?: unknown }).expectedRevision),
    ) ||
    new Set(notes.map((note: { id: string }) => note.id)).size !== notes.length
  )
    return json({ error: "Invalid notes", code: "invalid_payload" }, 400);
  const minClient = String(notesMinClient());
  if (!notes.length) {
    const empty = json({ saved: 0, results: [] });
    empty.headers.set(MIN_CLIENT_HEADER, minClient);
    return empty;
  }
  const enforcement = notesRevisionEnforcement();
  recordLegacyWrite({
    writer: "W1",
    route: "PUT /api/notes",
    count: notes.filter((note) => !hasExpectedRevision(note)).length,
    outcome: enforcement === "enforce" ? "rejected" : "accepted",
  });
  const { data, error } = await auth.supabase.rpc("save_notes", {
    p_notes: notes.map(toSaveItem),
    p_require_revision: enforcement === "enforce",
  });
  const result = error ? null : saveResponse(data, { includeCurrent: true });
  if (!result)
    return json({ error: "Could not save notes", code: "save_failed" }, 500);
  const response = json(result.body, result.status);
  response.headers.set(MIN_CLIENT_HEADER, minClient);
  return response;
}
