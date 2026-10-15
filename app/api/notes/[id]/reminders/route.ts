import { routeUser, json } from "@/lib/supabase/route-auth";
import { isUuid } from "@/lib/notes";
import { parseReminderTime } from "@/lib/reminders";
import {
  REMINDER_COLUMNS,
  fromReminderRow,
  reminderResponse,
  type ReminderRow,
} from "@/lib/reminders-db";

/** Reminders for one of the user's items, newest first (ADR 001 §4). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Invalid request", code: "invalid_payload" }, 400);
  const { data: note, error: noteError } = await auth.supabase
    .from("notes")
    .select("id")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .maybeSingle<{ id: string }>();
  if (noteError) return json({ error: "Could not load reminders", code: "load_failed" }, 500);
  if (!note) return json({ error: "Reminder or item not found", code: "not_found" }, 404);
  const { data, error } = await auth.supabase
    .from("note_reminders")
    .select(REMINDER_COLUMNS)
    .eq("note_id", id)
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(50)
    .returns<ReminderRow[]>();
  if (error) return json({ error: "Could not load reminders", code: "load_failed" }, 500);
  return json({ reminders: data.map(fromReminderRow) });
}

const CREATE_FIELDS = new Set(["localDate", "localTime", "timezone"]);

/**
 * Creates a reminder from wall-clock fields: `{ localDate: "YYYY-MM-DD",
 * localTime: "HH:MM", timezone: IANA name }`. The server derives the instant
 * it fires; an item has at most one waiting reminder.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON", code: "invalid_payload" }, 400);
  }
  const time = parseReminderTime(body);
  if (
    !isUuid(id) ||
    Array.isArray(body) ||
    Object.keys(body ?? {}).some((key) => !CREATE_FIELDS.has(key)) ||
    (!time.ok && time.code === "invalid_payload")
  )
    return json({ error: "Invalid reminder", code: "invalid_payload" }, 400);
  if (!time.ok) return json({ error: "Unknown time zone", code: "invalid_timezone" }, 422);
  const { data, error } = await auth.supabase.rpc("create_note_reminder", {
    p_note_id: id,
    p_local_date: time.value.localDate,
    p_local_time: time.value.localTime,
    p_timezone: time.value.timezone,
  });
  const result = error ? null : reminderResponse(data);
  if (!result) return json({ error: "Could not save reminder", code: "save_failed" }, 500);
  return json(result.body, result.status);
}
