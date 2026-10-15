// Pure display helpers for the item editor's properties (U-02): kind labels,
// project paths for the picker, snooze presets, reminder wording and
// friendly copy for every error code the editor can show. No note content is
// logged or sent anywhere from here.
import {
  WAITING_FOR_MAX,
  WAITING_ON_MAX,
  followupState,
  isDueDate,
  projectAncestors,
  projectLinkError,
  projectsIn,
  type FollowupField,
  type ItemKind,
  type LinkErrorCode,
  type Note,
} from "./notes.ts";
import {
  REMINDER_ERROR_MESSAGES,
  localDateTimeParts,
  localToday,
  type ReminderErrorCode,
} from "./reminders.ts";

export const KIND_LABELS: Record<ItemKind, string> = {
  note: "Note",
  task: "Task",
  project: "Project",
  document: "Document",
  followup: "Follow-up",
};

const untitledProject = (note: Pick<Note, "title">) => note.title.trim() || "Untitled project";

/** Titles from the root project down to `projectId` itself. */
export function projectPath(notes: Note[], projectId: string): string[] {
  const project = notes.find((n) => n.id === projectId);
  if (!project) return [];
  return [...projectAncestors(notes, projectId).reverse(), project].map(untitledProject);
}

export const PATH_SEPARATOR = " › ";
export const projectPathLabel = (notes: Note[], projectId: string) =>
  projectPath(notes, projectId).join(PATH_SEPARATOR);

export type ProjectOption = {
  id: string;
  title: string;
  /** Parent projects, root first, joined with PATH_SEPARATOR; "" at the top level. */
  parents: string;
  /** Why linking `item` here would be refused, or null. */
  error: LinkErrorCode | null;
};

/**
 * Projects `item` could be linked to in its own workspace (never itself),
 * ordered by full path, filtered by a case-insensitive query on title or
 * path. Options that would be refused carry the reason.
 */
export function projectOptions(notes: Note[], item: Note, query = ""): ProjectOption[] {
  const q = query.trim().toLowerCase();
  return projectsIn(notes, item.workspaceId)
    .filter((p) => p.id !== item.id)
    .map((p) => {
      const path = projectPath(notes, p.id);
      return {
        id: p.id,
        title: path[path.length - 1],
        parents: path.slice(0, -1).join(PATH_SEPARATOR),
        error: projectLinkError(notes, item.id, p.id),
        full: path.join(PATH_SEPARATOR),
      };
    })
    .filter((o) => !q || o.full.toLowerCase().includes(q))
    .sort((a, b) => a.full.localeCompare(b.full) || a.id.localeCompare(b.id))
    .map(({ full: _full, ...option }) => option);
}

/** A workspace move refused because the item is linked (ADR 001: unlink first). */
export function workspaceMoveError(notes: Note[], item: Note): LinkErrorCode | null {
  return item.projectId || notes.some((n) => n.projectId === item.id)
    ? "linked_item_move"
    : null;
}

// --- Calendar dates ---------------------------------------------------------

/** A calendar date `days` later (or earlier), without time zones. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return `${String(at.getUTCFullYear()).padStart(4, "0")}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")}`;
}

/** 0 (Sunday) to 6 (Saturday) for a calendar date. */
export function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const spaces = (text: string) => text.replace(/[  ]/g, " ");

/** "Oct 20", with the year when it isn't `today`'s year. */
export function calendarDateLabel(date: string, today: string | null, locale?: string) {
  const [y, m, d] = date.split("-").map(Number);
  return spaces(
    new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(locale, {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(today && date.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" as const } : {}),
    }),
  );
}

/**
 * Home's "Waiting for" line: "Waiting on Sam · check Oct 20", with the
 * check-date state (overdue / due / upcoming) for highlighting. Null text
 * when the item has neither field.
 */
export function followupSummary(
  note: Pick<Note, "waitingOn" | "nextCheckOn" | "completedAt">,
  today: string,
  locale?: string,
): { text: string | null; state: ReturnType<typeof followupState> } {
  const state = followupState(note, today);
  const parts: string[] = [];
  if (note.waitingOn) parts.push(`Waiting on ${note.waitingOn}`);
  if (note.nextCheckOn && isDueDate(note.nextCheckOn)) {
    const label = calendarDateLabel(note.nextCheckOn, today, locale);
    parts.push(
      state === "due" ? "check today" : state === "overdue" ? `check was due ${label}` : `check ${label}`,
    );
  }
  return { text: parts.length ? parts.join(" · ") : null, state };
}

// --- Reminders --------------------------------------------------------------

export type SnoozePreset = {
  id: "later" | "tomorrow" | "next-week";
  label: string;
  localDate: string;
  localTime: string;
};

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Snooze choices as wall-clock times in the reminder's zone: later today
 * (three hours on, rounded up to the half hour; omitted when that would be
 * tomorrow), tomorrow at 9:00 and next Monday at 9:00.
 */
export function snoozePresets(now: Date | number, timezone: string): SnoozePreset[] {
  const parts = localDateTimeParts(now, timezone);
  const today = localToday(timezone, now);
  const out: SnoozePreset[] = [];
  const later = Math.ceil((parts.hour * 60 + parts.minute + 180) / 30) * 30;
  if (later < 24 * 60)
    out.push({ id: "later", label: "Later today", localDate: today, localTime: hhmm(later) });
  out.push({ id: "tomorrow", label: "Tomorrow morning", localDate: addDays(today, 1), localTime: "09:00" });
  const toMonday = (8 - weekday(today)) % 7 || 7;
  out.push({ id: "next-week", label: "Next week", localDate: addDays(today, toMonday), localTime: "09:00" });
  return out;
}

/** "9:00 AM" for a wall-clock "09:00". */
export function wallTimeLabel(localTime: string, locale?: string) {
  const [h, m] = localTime.split(":").map(Number);
  return spaces(
    new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(locale, {
      timeZone: "UTC",
      hour: "numeric",
      minute: "2-digit",
    }),
  );
}

/**
 * When an instant happens, in words for someone in `timeZone`: "Today at
 * 3:00 PM", "Tomorrow at 9:00 AM", "Monday at 9:00 AM" within a week, then
 * "Mon, Oct 27 at 9:00 AM" (with the year when it differs).
 */
export function fireTimeLabel(
  iso: string,
  { now = Date.now(), timeZone, locale }: { now?: Date | number; timeZone: string; locale?: string },
): string {
  const at = new Date(iso);
  const day = localToday(timeZone, at);
  const today = localToday(timeZone, now);
  const time = spaces(at.toLocaleTimeString(locale, { timeZone, hour: "numeric", minute: "2-digit" }));
  const diff = Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  let date: string;
  if (diff === 0) date = "Today";
  else if (diff === 1) date = "Tomorrow";
  else if (diff === -1) date = "Yesterday";
  else if (diff > 1 && diff < 7) date = at.toLocaleDateString(locale, { timeZone, weekday: "long" });
  else
    date = spaces(
      at.toLocaleDateString(locale, {
        timeZone,
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" as const } : {}),
      }),
    );
  return `${date} at ${time}`;
}

export type ReminderProblem = ReminderErrorCode | "unavailable";

/** Friendly copy for every reminder outcome code, plus "unavailable". */
export const REMINDER_COPY: Record<ReminderProblem, string> = {
  ...REMINDER_ERROR_MESSAGES,
  invalid_payload: "Pick a date and a time for the reminder.",
  not_found: "This item or its reminder no longer exists. Reload to see the latest.",
  reminder_in_past: "That time has already passed. Pick a time in the future.",
  reminder_exists: "This item already has a reminder. Change that one instead.",
  reminder_closed: "That reminder already went off or was canceled.",
  revision_conflict: "This reminder changed somewhere else. Showing the latest version.",
  precondition_required: "Orbit was updated. Reload the page to keep saving.",
  unavailable: "Couldn’t reach Orbit, so nothing changed. Try again in a moment.",
};

export const reminderErrorMessage = (code: ReminderProblem) =>
  REMINDER_COPY[code] ?? REMINDER_COPY.unavailable;

// --- Follow-ups -------------------------------------------------------------

/** Friendly copy for a refused follow-up field (setFollowup → FollowupError). */
export const FOLLOWUP_COPY: Record<FollowupField, string> = {
  waitingOn: `Keep “Waiting on” to one line of ${WAITING_ON_MAX} characters or fewer.`,
  waitingFor: `Keep “Waiting for” to one line of ${WAITING_FOR_MAX} characters or fewer.`,
  nextCheckOn: "Pick a real calendar date for the next check.",
};
