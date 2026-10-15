// Timed reminders for items (ADR 001 §4, D-03): pure helpers shared by the
// browser and the server. A reminder is stored as a wall-clock date and time
// plus an IANA time zone; that is the source of truth. The instant it fires
// is derived from them (here with Intl, and authoritatively by
// public.reminder_fire_at() in the database, with the same rules):
// - a time that happens once maps to that instant;
// - an ambiguous time (fall-back overlap) maps to its first occurrence;
// - a nonexistent time (spring-forward gap) maps to the first valid instant
//   after it, the moment the clocks jump (02:30 → 03:00 in Chicago).
// Dispatch, delivery and recurrence are D-04; nothing here schedules work.

export const REMINDER_STATUSES = ["scheduled", "snoozed", "fired", "canceled"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
/** Statuses that are still waiting to fire. At most one per item. */
export const ACTIVE_REMINDER_STATUSES: readonly ReminderStatus[] = ["scheduled", "snoozed"];

export type Reminder = {
  id: string;
  noteId: string;
  workspaceId: string;
  /** Wall-clock date the user picked (YYYY-MM-DD). */
  localDate: string;
  /** Wall-clock time the user picked (HH:MM, 24-hour). */
  localTime: string;
  /** IANA time zone the wall-clock fields are in. */
  timezone: string;
  /** Instant derived from the wall-clock fields by the server (ISO, UTC). */
  fireAt: string;
  status: ReminderStatus;
  /** The reminder's own revision; separate from the item's. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** fireAt while the reminder is waiting to fire, otherwise null. For display. */
  nextFireAt: string | null;
};

/** Wall-clock fields of a reminder, as the user picked them. */
export type ReminderTime = { localDate: string; localTime: string; timezone: string };

/** Why a reminder write was refused (machine-readable `code`). */
export const REMINDER_ERROR_CODES = [
  "invalid_payload",
  "not_found",
  "invalid_timezone",
  "reminder_in_past",
  "reminder_exists",
  "reminder_closed",
  "revision_conflict",
  "precondition_required",
] as const;
export type ReminderErrorCode = (typeof REMINDER_ERROR_CODES)[number];
/** Short, content-free explanations for each code. */
export const REMINDER_ERROR_MESSAGES: Record<ReminderErrorCode, string> = {
  invalid_payload: "That reminder isn't valid.",
  not_found: "That item or reminder no longer exists.",
  invalid_timezone: "Pick a valid time zone.",
  reminder_in_past: "Pick a time that hasn't happened yet.",
  reminder_exists: "This item already has a reminder.",
  reminder_closed: "That reminder was canceled.",
  revision_conflict: "That reminder was changed elsewhere.",
  precondition_required: "Reload to keep saving.",
};

const ZONE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

/**
 * The canonical form of an IANA time zone name ("america/chicago" →
 * "America/Chicago"), or null when it is not one. Abbreviations ("CST"),
 * POSIX rules ("EST5EDT") and offsets ("+05:00") are refused even where Intl
 * accepts them, so every stored zone is a tz-database location.
 */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !ZONE.test(value)) return null;
  try {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return ZONE.test(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** Whether a value is an IANA time zone name (see canonicalTimeZone). */
export const isTimeZone = (value: unknown): value is string => canonicalTimeZone(value) !== null;

/** This browser's or server's time zone, falling back to UTC. */
export function defaultTimeZone(): string {
  try {
    return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
  } catch {
    return "UTC";
  }
}

/** A wall-clock time, "HH:MM" from 00:00 to 23:59. */
export const isLocalTime = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

/** A calendar date "YYYY-MM-DD" from 0001-01-01 to 9999-12-31. */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000"))
    return false;
  const [y, m, d] = value.split("-").map(Number);
  const ms = utc(y, m, d, 0, 0, 0);
  return dateString(ms) === value;
}

/** Milliseconds for UTC fields, including years 1–99 (Date.UTC maps those to 19xx). */
function utc(year: number, month: number, day: number, hour: number, minute: number, second: number) {
  const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second));
  date.setUTCFullYear(year);
  return date.getTime();
}
const dateString = (ms: number) => {
  const date = new Date(ms);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, format);
  }
  return format;
}

/** Wall-clock fields of an instant in a zone. */
export function localDateTimeParts(instant: Date | number, timezone: string) {
  const parts = Object.fromEntries(
    formatter(timezone).formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  return {
    year: parts.era === "BC" || parts.era === "B" ? 1 - year : year,
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The calendar date of an instant in a zone, "YYYY-MM-DD". */
export function localToday(timezone: string, now: Date | number = Date.now()): string {
  const { year, month, day } = localDateTimeParts(now, timezone);
  return dateString(utc(year, month, day, 0, 0, 0));
}

/** The zone's offset from UTC at an instant, in milliseconds (whole seconds). */
function offsetAt(ms: number, timezone: string) {
  const at = Math.floor(ms / 1000) * 1000;
  const p = localDateTimeParts(at, timezone);
  return utc(p.year, p.month, p.day, p.hour, p.minute, p.second) - at;
}

const DAY = 86_400_000;

/**
 * The instant (ISO, UTC) at which a wall-clock date and time happens in a
 * zone, by the rules at the top of this file; null for invalid input. Same
 * result as public.reminder_fire_at(), under the same tz rules.
 */
export function reminderFireAt(localDate: string, localTime: string, timezone: string): string | null {
  if (!isLocalDate(localDate) || !isLocalTime(localTime) || !isTimeZone(timezone)) return null;
  const [y, m, d] = localDate.split("-").map(Number);
  const [hh, mm] = localTime.split(":").map(Number);
  const wanted = utc(y, m, d, hh, mm, 0);
  // Offsets a day either side; current zones never change offset twice in a day.
  const first = wanted - offsetAt(wanted - DAY, timezone);
  const second = wanted - offsetAt(wanted + DAY, timezone);
  const shows = (ms: number) => ms + offsetAt(ms, timezone);
  const candidates = [first, second].filter((ms) => shows(ms) === wanted);
  if (candidates.length) return new Date(Math.min(...candidates)).toISOString();
  // In a gap: the first whole second whose local time is at or after it.
  let lo = Math.floor(Math.min(first, second) / 1000);
  let hi = Math.ceil(Math.max(first, second) / 1000);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (shows(mid * 1000) >= wanted) hi = mid;
    else lo = mid;
  }
  return new Date(hi * 1000).toISOString();
}

/** Whether a reminder is still waiting to fire. */
export const isActiveReminder = (reminder: Pick<Reminder, "status">) =>
  ACTIVE_REMINDER_STATUSES.includes(reminder.status);

/**
 * When a reminder will next fire, for display: its fire instant while it is
 * waiting, otherwise null. One-off only; recurrence is D-04.
 */
export function nextFireAt(
  reminder: Pick<Reminder, "status" | "fireAt">,
): string | null {
  return isActiveReminder(reminder) ? reminder.fireAt : null;
}

/**
 * Validates and normalizes client wall-clock fields. Every field is required
 * when `partial` is false; with `partial`, absent fields keep their stored
 * value. The zone is stored in canonical form.
 */
export function parseReminderTime(
  value: unknown,
  { partial = false }: { partial?: boolean } = {},
):
  | { ok: true; value: Partial<ReminderTime> }
  | { ok: false; code: "invalid_payload" | "invalid_timezone" } {
  if (!value || typeof value !== "object") return { ok: false, code: "invalid_payload" };
  const input = value as Record<string, unknown>;
  const out: Partial<ReminderTime> = {};
  if (input.localDate !== undefined) {
    if (!isLocalDate(input.localDate)) return { ok: false, code: "invalid_payload" };
    out.localDate = input.localDate;
  }
  if (input.localTime !== undefined) {
    if (!isLocalTime(input.localTime)) return { ok: false, code: "invalid_payload" };
    out.localTime = input.localTime;
  }
  if (!partial && (!out.localDate || !out.localTime || input.timezone === undefined))
    return { ok: false, code: "invalid_payload" };
  if (input.timezone !== undefined) {
    const zone = canonicalTimeZone(input.timezone);
    if (!zone) return { ok: false, code: "invalid_timezone" };
    out.timezone = zone;
  }
  return { ok: true, value: out };
}
