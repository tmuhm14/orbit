import { routeUser, json } from "@/lib/supabase/route-auth";
import { isUuid } from "@/lib/notes";
import { parseReminderTime } from "@/lib/reminders";
import { parseReminderChange, reminderResponse } from "@/lib/reminders-db";

/**
 * Changes one reminder at its expected revision (ADR 002: required from day
 * one, so a missing one is 428). Body: `{ action?: "update" | "snooze" |
 * "cancel", expectedRevision, localDate?, localTime?, timezone? }`. update
 * and snooze need at least one wall-clock field; absent ones keep their
 * value. Canceled reminders are kept as history.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; reminderId: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id, reminderId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON", code: "invalid_payload" }, 400);
  }
  const change = parseReminderChange(body);
  const time = parseReminderTime(body, { partial: true });
  const fields = time.ok ? Object.keys(time.value).length : 1;
  if (
    !isUuid(id) ||
    !isUuid(reminderId) ||
    !change.ok ||
    (!time.ok && time.code === "invalid_payload") ||
    (change.action !== "cancel" && !fields)
  )
    return json({ error: "Invalid reminder", code: "invalid_payload" }, 400);
  if (change.expectedRevision === undefined)
    return json({ error: "Reload to keep saving", code: "precondition_required" }, 428);
  if (!time.ok) return json({ error: "Unknown time zone", code: "invalid_timezone" }, 422);
  // The reminder must belong to the item in the path.
  const { data: owned, error: ownedError } = await auth.supabase
    .from("note_reminders")
    .select("id")
    .eq("id", reminderId)
    .eq("note_id", id)
    .eq("user_id", auth.user.id)
    .maybeSingle<{ id: string }>();
  if (ownedError) return json({ error: "Could not save reminder", code: "save_failed" }, 500);
  if (!owned) return json({ error: "Reminder or item not found", code: "not_found" }, 404);
  const wallClock = change.action === "cancel" ? {} : time.value;
  const { data, error } = await auth.supabase.rpc("change_note_reminder", {
    p_id: reminderId,
    p_expected_revision: change.expectedRevision,
    p_action: change.action,
    p_local_date: wallClock.localDate ?? null,
    p_local_time: wallClock.localTime ?? null,
    p_timezone: wallClock.timezone ?? null,
  });
  const result = error ? null : reminderResponse(data);
  if (!result) return json({ error: "Could not save reminder", code: "save_failed" }, 500);
  return json(result.body, result.status);
}
