import "server-only";
import { nextFireAt, type Reminder, type ReminderErrorCode, type ReminderStatus } from "./reminders";

/** Columns of public.note_reminders the API returns. */
export const REMINDER_COLUMNS =
  "id,note_id,workspace_id,local_date,local_time,timezone,fire_at,status,revision,created_at,updated_at";

export type ReminderRow = {
  id: string;
  note_id: string;
  workspace_id: string;
  local_date: string;
  /** "HH:MM" from the functions, "HH:MM:SS" from a table select. */
  local_time: string;
  timezone: string;
  fire_at: string;
  status: ReminderStatus;
  revision: number | string;
  created_at: string;
  updated_at: string;
};

const iso = (value: string) => new Date(value).toISOString();

export function fromReminderRow(row: ReminderRow): Reminder {
  const fireAt = iso(row.fire_at);
  return {
    id: row.id,
    noteId: row.note_id,
    workspaceId: row.workspace_id,
    localDate: row.local_date,
    localTime: row.local_time.slice(0, 5),
    timezone: row.timezone,
    fireAt,
    status: row.status,
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    nextFireAt: nextFireAt({ status: row.status, fireAt }),
  };
}

type RawReminderResult = {
  status:
    | "created"
    | "saved"
    | "not_found"
    | "invalid_timezone"
    | "reminder_in_past"
    | "reminder_exists"
    | "reminder_closed"
    | "conflict"
    | "precondition_required"
    | "invalid_action";
  reminder?: ReminderRow;
  current?: ReminderRow;
  currentRevision?: number;
};

const FAILURES: Record<string, [number, ReminderErrorCode, string]> = {
  not_found: [404, "not_found", "Reminder or item not found"],
  invalid_timezone: [422, "invalid_timezone", "Unknown time zone"],
  reminder_in_past: [422, "reminder_in_past", "That time has already passed"],
  reminder_exists: [409, "reminder_exists", "This item already has a reminder"],
  reminder_closed: [409, "reminder_closed", "That reminder was canceled"],
  conflict: [409, "revision_conflict", "That reminder was changed elsewhere"],
  precondition_required: [428, "precondition_required", "Reload to keep saving"],
  invalid_action: [400, "invalid_payload", "Invalid reminder"],
};

/**
 * Status and body for create_note_reminder() / change_note_reminder()
 * results. Messages are fixed and never contain item content. A conflict
 * returns the current reminder (the caller's own row).
 */
export function reminderResponse(
  raw: unknown,
): { status: number; body: Record<string, unknown> } | null {
  const result = raw as RawReminderResult | null;
  if (!result || typeof result !== "object") return null;
  if ((result.status === "created" || result.status === "saved") && result.reminder)
    return {
      status: result.status === "created" ? 201 : 200,
      body: { reminder: fromReminderRow(result.reminder) },
    };
  const failure = FAILURES[result.status];
  if (!failure) return null;
  const [status, code, error] = failure;
  return {
    status,
    body: {
      error,
      code,
      ...(result.status === "reminder_exists" && result.reminder
        ? { reminder: fromReminderRow(result.reminder) }
        : {}),
      ...(result.status === "conflict"
        ? {
            currentRevision: Number(result.currentRevision),
            ...(result.current ? { current: fromReminderRow(result.current) } : {}),
          }
        : {}),
    },
  };
}

/**
 * Parses a reminder change body: `{ action?, expectedRevision, localDate?,
 * localTime?, timezone? }`. action is "update" (default), "snooze" or
 * "cancel". Wall-clock fields are validated by the caller with
 * parseReminderTime().
 */
export function parseReminderChange(value: unknown):
  | { ok: true; action: "update" | "snooze" | "cancel"; expectedRevision: number | undefined }
  | { ok: false } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const input = value as Record<string, unknown>;
  const action = input.action ?? "update";
  if (action !== "update" && action !== "snooze" && action !== "cancel") return { ok: false };
  const expected = input.expectedRevision;
  if (expected !== undefined && !(typeof expected === "number" && Number.isSafeInteger(expected) && expected >= 1))
    return { ok: false };
  const allowed = new Set(["action", "expectedRevision", "localDate", "localTime", "timezone"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { ok: false };
  return { ok: true, action, expectedRevision: expected as number | undefined };
}
