"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Check } from "lucide-react";
import { BUCKETS, type Note } from "@/lib/notes";
import { groupDueItems, localDateKey } from "@/lib/due-items";

export function DueItems({ notes, workspaceId, unavailable, onOpen, onComplete }: {
  notes: Note[];
  workspaceId: string;
  unavailable: boolean;
  onOpen: (id: string) => void;
  onComplete: (id: string) => void;
}) {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setToday(localDateKey(new Date()));
    update();
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", update); };
  }, []);
  const groups = today ? groupDueItems(notes, workspaceId, today) : null;
  const count = groups ? groups.overdue.length + groups.today.length + groups.upcoming.length : 0;
  const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.slice(0, 4) !== today?.slice(0, 4) ? { year: "numeric" as const } : {}) });
  return (
    <aside className="due-panel" aria-labelledby="due-items-heading">
      <header className="due-panel-heading">
        <CalendarDays size={17} />
        <h2 id="due-items-heading">Due items</h2>
        {groups && !unavailable && <span className="due-count">{count}</span>}
      </header>
      <p className="due-panel-caption">Deadlines in this workspace</p>
      {unavailable ? <p className="due-empty">Due items couldn’t be loaded. Try refreshing.</p> : !groups ? <p className="due-empty">Loading due items…</p> : count === 0 ? (
        <div className="due-empty"><CalendarDays size={24} /><strong>No deadlines yet</strong><p>Open a note and add a due date to see it here.</p></div>
      ) : (Object.keys(groups) as (keyof typeof groups)[]).map(key => groups[key].length > 0 && (
        <section className={`due-group is-${key}`} key={key} aria-labelledby={`due-${key}`}>
          <h3 id={`due-${key}`}>{key === "overdue" ? "Overdue" : key === "today" ? "Today" : "Upcoming"}<span>{groups[key].length}</span></h3>
          <ul>{groups[key].map(note => (
            <li key={note.id}>
              <button className="due-complete" aria-label={`Complete ${note.title || "Untitled thought"}`} onClick={() => onComplete(note.id)}><Check size={12} /></button>
              <button className="due-note" onClick={() => onOpen(note.id)}>
                <strong>{note.title || "Untitled thought"}</strong>
                <span>{BUCKETS.find(bucket => bucket.id === note.bucket)?.name}<time dateTime={note.dueDate!}>{key === "today" ? "Today" : dateLabel(note.dueDate!)}</time></span>
              </button>
            </li>
          ))}</ul>
        </section>
      ))}
    </aside>
  );
}
