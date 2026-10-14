"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Check } from "lucide-react";
import { BUCKETS, type Note } from "@/lib/notes";
import { groupDueItems, localDateKey } from "@/lib/due-items";

/**
 * Today's local calendar date (YYYY-MM-DD), or null until mounted so server
 * and client renders agree. Refreshes across midnight and on window focus.
 */
export function useLocalToday() {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setToday(localDateKey(new Date()));
    update();
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", update); };
  }, []);
  return today;
}

/** Short local label for a calendar date; adds the year when it isn't this year. */
export function dueDateLabel(date: string, today: string | null) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.slice(0, 4) !== today?.slice(0, 4) ? { year: "numeric" as const } : {}) });
}

export function DueItems({ notes, workspaceId, loading = false, unavailable, onOpen, onComplete }: {
  notes: Note[];
  workspaceId: string;
  loading?: boolean;
  unavailable: boolean;
  onOpen: (id: string) => void;
  onComplete: (id: string) => void;
}) {
  const today = useLocalToday();
  const groups = today && !loading ? groupDueItems(notes, workspaceId, today) : null;
  const count = groups ? groups.overdue.length + groups.today.length + groups.upcoming.length : 0;
  return (
    <aside className="due-panel" aria-labelledby="due-items-heading" aria-busy={!groups && !unavailable}>
      <header className="due-panel-heading">
        <CalendarDays size={17} aria-hidden="true" />
        <h2 id="due-items-heading">Due items</h2>
        {groups && !unavailable && <span className="due-count" aria-label={`${count} due`}>{count}</span>}
      </header>
      <p className="due-panel-caption">Deadlines in this workspace</p>
      {unavailable ? <p className="due-empty" role="alert">Due items couldn’t be loaded. Reload the page to try again.</p> : !groups ? <p className="due-empty">Loading due items…</p> : count === 0 ? (
        <div className="due-empty"><CalendarDays size={24} aria-hidden="true" /><strong>No deadlines yet</strong><p>Open a note and add a due date to see it here.</p></div>
      ) : (Object.keys(groups) as (keyof typeof groups)[]).map(key => groups[key].length > 0 && (
        <section className={`due-group is-${key}`} key={key} aria-labelledby={`due-${key}`}>
          <h3 id={`due-${key}`}>{key === "overdue" ? "Overdue" : key === "today" ? "Today" : "Upcoming"}<span>{groups[key].length}</span></h3>
          <ul>{groups[key].map(note => (
            <li key={note.id}>
              <button className="due-complete" aria-label={`Complete ${note.title || "Untitled thought"}`} onClick={() => onComplete(note.id)}><Check size={12} /></button>
              <button className="due-note" onClick={() => onOpen(note.id)}>
                <strong>{note.title || "Untitled thought"}</strong>
                <span>{BUCKETS.find(bucket => bucket.id === note.bucket)?.name}<time dateTime={note.dueDate!}>{key === "today" ? "Today" : dueDateLabel(note.dueDate!, today)}</time></span>
              </button>
            </li>
          ))}</ul>
        </section>
      ))}
    </aside>
  );
}
