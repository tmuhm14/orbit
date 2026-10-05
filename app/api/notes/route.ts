import { routeUser, json } from "@/lib/supabase/route-auth";
import {
  NOTE_COLUMNS,
  fromRow,
  isSavableNote,
  toRow,
  type NoteRow,
} from "@/lib/notes-db";

export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const { data, error } = await auth.supabase
    .from("notes")
    .select(NOTE_COLUMNS)
    .order("updated_at", { ascending: false })
    .returns<NoteRow[]>();
  if (error) return json({ error: "Could not load notes" }, 500);
  return json({ notes: data.map(fromRow) });
}

/** Creates or updates a batch of notes. Row-level security scopes writes to the user. */
export async function PUT(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const notes = (body as { notes?: unknown })?.notes;
  if (
    !Array.isArray(notes) ||
    notes.length > 500 ||
    !notes.every(isSavableNote)
  )
    return json({ error: "Invalid notes" }, 400);
  if (!notes.length) return json({ saved: 0 });
  const { error } = await auth.supabase
    .from("notes")
    .upsert(notes.map((note) => toRow(note, auth.user.id)));
  if (error) return json({ error: "Could not save notes" }, 500);
  return json({ saved: notes.length });
}
