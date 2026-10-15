"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Bell, BellOff, Clock3, Pencil } from "lucide-react";
import type { Note } from "@/lib/notes";
import {
  defaultTimeZone,
  localDateTimeParts,
  localToday,
  reminderFireAt,
  type Reminder,
  type ReminderTime,
} from "@/lib/reminders";
import {
  addDays,
  fireTimeLabel,
  reminderErrorMessage,
  snoozePresets,
  wallTimeLabel,
  type ReminderProblem,
} from "@/lib/item-properties";
import type { useNotes } from "./use-notes";

type NotesApi = ReturnType<typeof useNotes>;
export type ReminderApi = Pick<
  NotesApi,
  | "loadReminders"
  | "remindersFor"
  | "activeReminderFor"
  | "createReminder"
  | "updateReminder"
  | "snoozeReminder"
  | "cancelReminder"
>;

function timeZones(current: string) {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    /* Older browsers: offer the current zone and UTC. */
  }
  return [...new Set([current, "UTC", ...zones])].sort();
}

function freshForm(): ReminderTime {
  const timezone = defaultTimeZone();
  return { localDate: addDays(localToday(timezone), 1), localTime: "09:00", timezone };
}

/** "9:00 AM in Europe/London" when the reminder's zone isn't the viewer's. */
function zoneNote(reminder: Pick<Reminder, "localTime" | "timezone">, viewer: string) {
  return reminder.timezone === viewer
    ? null
    : `${wallTimeLabel(reminder.localTime)} in ${reminder.timezone.replace(/_/g, " ")}`;
}

/**
 * Timed reminder for one item: shows the waiting reminder's next fire time
 * in local words, and lets the user add, change, snooze or cancel it. Each
 * change is its own revision-checked request (not part of autosave).
 */
export function ReminderControl({ note, api, labelId }: { note: Note; api: ReminderApi; labelId: string }) {
  const id = useId();
  const viewer = useMemo(() => defaultTimeZone(), []);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ReminderTime>(freshForm);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReminderProblem | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // After a change replaces the buttons, keep focus inside the editor.
  const refocus = useRef(false);
  const zones = useMemo(() => timeZones(form.timezone), [form.timezone]);
  const active = api.activeReminderFor(note.id);
  const latest = api.remindersFor(note.id)[0] ?? null;
  const { loadReminders } = api;
  function switchMode(next: boolean) {
    refocus.current = true;
    setEditing(next);
  }
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const target = editing
      ? rootRef.current?.querySelector<HTMLElement>("input")
      : rootRef.current?.querySelector<HTMLElement>(".reminder-summary button");
    target?.focus();
  });

  async function load() {
    setLoading(true);
    const result = await loadReminders(note.id);
    setLoading(false);
    // An item that hasn't been saved yet simply has no reminders.
    setLoadFailed(!result.ok && result.code !== "not_found");
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  useEffect(() => {
    if (!snoozeOpen) return;
    function outside(event: PointerEvent) {
      if (!snoozeRef.current?.contains(event.target as Node)) setSnoozeOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [snoozeOpen]);

  const preview = editing ? reminderFireAt(form.localDate, form.localTime, form.timezone) : null;
  const shifted = (() => {
    if (!preview) return false;
    const p = localDateTimeParts(new Date(preview), form.timezone);
    const shown = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    return shown !== form.localTime;
  })();
  const inPast = !!preview && Date.parse(preview) <= Date.now();

  function startEditing(from: Reminder | null) {
    setProblem(null);
    setForm(from ? { localDate: from.localDate, localTime: from.localTime, timezone: from.timezone } : freshForm());
    switchMode(true);
  }

  async function run(action: () => Promise<Awaited<ReturnType<ReminderApi["createReminder"]>>>, done: (r: Reminder) => string) {
    setBusy(true);
    setProblem(null);
    const result = await action();
    setBusy(false);
    if (result.ok) {
      switchMode(false);
      setSnoozeOpen(false);
      setAnnouncement(done(result.reminder));
      return;
    }
    setProblem(result.code);
    refocus.current = true;
    // The hook stored the copy the server has; show it rather than the form.
    if (result.code === "reminder_exists" || result.code === "revision_conflict") switchMode(false);
  }

  function save() {
    if (!preview) return setProblem("invalid_payload");
    if (inPast) return setProblem("reminder_in_past");
    const label = (r: Reminder) => `Reminder set for ${fireTimeLabel(r.fireAt, { timeZone: viewer })}.`;
    void run(() => (active ? api.updateReminder(active, form) : api.createReminder(note.id, form)), label);
  }

  const fieldsId = `${id}-fields`;
  const errorId = `${id}-error`;
  return (
    <div ref={rootRef} className="reminder-control" aria-describedby={problem ? errorId : undefined}>
      {loading && !active ? (
        <span className="property-hint">Checking for a reminder…</span>
      ) : loadFailed && !active ? (
        <span className="property-hint">
          Reminders couldn’t be loaded.{" "}
          <button type="button" className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </span>
      ) : editing ? (
        <form
          className="reminder-form"
          aria-labelledby={labelId}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              switchMode(false);
              setProblem(null);
            }
          }}
        >
          <div className="reminder-fields" id={fieldsId}>
            <label>
              <span>Date</span>
              <input
                type="date"
                required
                value={form.localDate}
                onChange={(e) => setForm({ ...form, localDate: e.target.value })}
              />
            </label>
            <label>
              <span>Time</span>
              <input
                type="time"
                required
                value={form.localTime}
                onChange={(e) => setForm({ ...form, localTime: e.target.value })}
              />
            </label>
            <label className="reminder-zone">
              <span>Time zone</span>
              <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="property-hint" aria-live="polite">
            {preview
              ? `${inPast ? "That’s in the past: " : "Reminds you "}${fireTimeLabel(preview, { timeZone: viewer })}${shifted ? " (the clocks skip that time, so it moves to the first valid minute)" : ""}.`
              : "Pick a date and a time."}
          </p>
          <div className="reminder-actions">
            <button type="submit" className="secondary-button" disabled={busy}>
              {busy ? "Saving…" : active ? "Save reminder" : "Set reminder"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                switchMode(false);
                setProblem(null);
              }}
            >
              Never mind
            </button>
          </div>
        </form>
      ) : active ? (
        <div className="reminder-summary">
          <p>
            <Bell size={13} aria-hidden="true" />
            <span>
              {active.status === "snoozed" ? "Snoozed until " : "Reminds you "}
              <time dateTime={active.nextFireAt ?? active.fireAt}>
                {fireTimeLabel(active.nextFireAt ?? active.fireAt, { timeZone: viewer })}
              </time>
              {zoneNote(active, viewer) && <small> · {zoneNote(active, viewer)}</small>}
            </span>
          </p>
          <div className="reminder-actions">
            <button type="button" className="text-button" onClick={() => startEditing(active)} disabled={busy}>
              <Pencil size={13} aria-hidden="true" /> Change
            </button>
            <div
              className="reminder-snooze"
              ref={snoozeRef}
              onKeyDown={(e) => {
                if (e.key === "Escape" && snoozeOpen) {
                  e.stopPropagation();
                  setSnoozeOpen(false);
                  snoozeRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
                }
              }}
            >
              <button
                type="button"
                className="text-button"
                aria-expanded={snoozeOpen}
                aria-controls={`${id}-snooze`}
                onClick={() => setSnoozeOpen(!snoozeOpen)}
                disabled={busy}
              >
                <Clock3 size={13} aria-hidden="true" /> Snooze
              </button>
              {snoozeOpen && (
                <ul id={`${id}-snooze`} className="reminder-snooze-list" aria-label="Snooze until">
                  {snoozePresets(Date.now(), viewer).map((preset) => {
                    const at = reminderFireAt(preset.localDate, preset.localTime, viewer);
                    return (
                      <li key={preset.id}>
                        <button
                          type="button"
                          onClick={() =>
                            void run(
                              () => api.snoozeReminder(active, { localDate: preset.localDate, localTime: preset.localTime, timezone: viewer }),
                              (r) => `Snoozed until ${fireTimeLabel(r.fireAt, { timeZone: viewer })}.`,
                            )
                          }
                        >
                          <strong>{preset.label}</strong>
                          {at && <small>{fireTimeLabel(at, { timeZone: viewer })}</small>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void run(() => api.cancelReminder(active), () => "Reminder canceled.")}
            >
              <BellOff size={13} aria-hidden="true" /> Cancel reminder
            </button>
          </div>
        </div>
      ) : (
        <div className="reminder-summary">
          {latest?.status === "fired" && (
            <p className="property-hint">
              Last reminder went off {fireTimeLabel(latest.fireAt, { timeZone: viewer })}.
            </p>
          )}
          <button type="button" className="text-button reminder-add" onClick={() => startEditing(null)}>
            <Bell size={13} aria-hidden="true" /> Add a reminder
          </button>
        </div>
      )}
      {problem && (
        <p className="property-error" id={errorId} role="alert">
          {reminderErrorMessage(problem)}
        </p>
      )}
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </div>
  );
}
