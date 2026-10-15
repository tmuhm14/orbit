"use client";

import { AlertTriangle, ArrowRight, ArrowUpRight, Mail, MessageSquare, Orbit } from "lucide-react";
import { BUCKETS, followupState, isDueDate, type BucketId, type Note } from "@/lib/notes";
import { followupSummary } from "@/lib/item-properties";
import {
  attentionSummary,
  inboxItems,
  nextActionItems,
  waitingItems,
  type HomeList,
} from "@/lib/home-items";
import { DueItems, dueDateLabel, useLocalToday } from "./due-items";
import { ItemActionsMenu } from "./item-actions-menu";
import { useBucketDropTargets, useDraggableItem } from "./item-drag";
import { bucketIcons, useWorkspaceShell } from "./workspace-shell-context";

const untitled = (note: Note) => note.title || "Untitled thought";
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Slim Home header with a one-line summary of what needs attention. */
export function HomeHeader() {
  const { notes, workspaceId, loaded, loadError } = useWorkspaceShell();
  const today = useLocalToday();
  let summary = "Checking what needs your attention…";
  if (loadError) summary = "Your items couldn’t be loaded right now.";
  else if (loaded && today) {
    const { toClarify, overdue, dueToday } = attentionSummary(notes, workspaceId, today);
    const parts = [
      toClarify && `${toClarify} to clarify`,
      overdue && `${overdue} overdue`,
      dueToday && `${dueToday} due today`,
    ].filter(Boolean);
    summary = parts.length ? parts.join(" · ") : "Nothing needs your attention right now.";
  }
  return (
    <header className="home-header">
      <span className="home-mark" aria-hidden="true">
        <span className="home-mark-ring" />
        <Orbit size={22} strokeWidth={1.1} />
      </span>
      <div>
        <div className="eyebrow">
          <span />
          LESS NOISE. MORE SPACE.
        </div>
        <h1>
          A little space for a <span>clearer mind.</span>
        </h1>
        <p className="home-summary">{summary}</p>
      </div>
    </header>
  );
}

type ListConfig = {
  bucket: BucketId;
  select: (notes: Note[], workspaceId: string) => HomeList;
  caption: string;
  empty: [title: string, body: string];
  meta: (note: Note, today: string | null) => string;
};

const sourceLabel = (note: Note) =>
  note.source === "slack" ? "From Slack" : note.source === "email" ? "From email" : null;

const LISTS: Record<"inbox" | "next" | "waiting", ListConfig> = {
  inbox: {
    bucket: "inbox",
    select: inboxItems,
    caption: "To clarify, newest first",
    empty: ["Inbox is clear", "Anything you capture above lands here until you decide what it is."],
    meta: (note) => [sourceLabel(note), `Captured ${shortDate(note.createdAt)}`].filter(Boolean).join(" · "),
  },
  next: {
    bucket: "next",
    select: nextActionItems,
    caption: "Soonest due first",
    empty: ["No next actions", "When something has a clear next step, move it to Next actions."],
    meta: (note, today) => {
      if (!isDueDate(note.dueDate)) return `Updated ${shortDate(note.updatedAt)}`;
      if (today && note.dueDate === today) return "Due today";
      if (today && note.dueDate < today) return `Overdue · ${dueDateLabel(note.dueDate, today)}`;
      return `Due ${dueDateLabel(note.dueDate, today)}`;
    },
  },
  waiting: {
    bucket: "waiting",
    select: waitingItems,
    caption: "Longest untouched first",
    empty: ["Nothing to wait on", "Things you have handed off or are waiting to hear back on go here."],
    // "Waiting on Sam · check Oct 20" when the follow-up fields are set.
    meta: (note, today) =>
      (today && followupSummary(note, today).text) || `Updated ${shortDate(note.updatedAt)}`,
  },
};

/** A short Home list for one bucket, with a link to the full bucket view. */
export function HomeList({ kind }: { kind: keyof typeof LISTS }) {
  const { notes, workspaceId, loaded, loadError, navigate, openNote, capture, items, conflictIds } =
    useWorkspaceShell();
  const dragProps = useDraggableItem();
  // Only a real quick capture or move sets these; loads and refreshes don't.
  const justArrived = (id: string) => id === capture.feedback?.id || id === items.arrived;
  // Dates are locale/timezone dependent, so they render only after mount.
  const today = useLocalToday();
  const config = LISTS[kind];
  const bucket = BUCKETS.find((b) => b.id === config.bucket)!;
  const Icon = bucketIcons[bucket.icon];
  const list = loaded && !loadError ? config.select(notes, workspaceId) : null;
  const headingId = `home-${kind}-heading`;
  return (
    <section
      className={`home-list ${bucket.color} is-${kind}`}
      aria-labelledby={headingId}
      aria-busy={!loaded && !loadError}
    >
      <header className="home-list-heading">
        <span className="home-list-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        <div>
          <h2 id={headingId}>
            {bucket.name}
            {list && <span className="home-list-count" aria-label={`${list.count} items`}>{list.count}</span>}
          </h2>
          <p>{config.caption}</p>
        </div>
        {list && list.count > 0 && (
          <button
            className="text-button home-view-all"
            onClick={() => navigate(config.bucket)}
            aria-label={`View all ${list.count} in ${bucket.name}`}
          >
            View all <ArrowRight size={13} aria-hidden="true" />
          </button>
        )}
      </header>
      {loadError ? (
        <p className="home-list-state" role="alert">
          {bucket.name} couldn’t be loaded. Reload the page to try again.
        </p>
      ) : !list ? (
        <p className="home-list-state">Loading {bucket.name.toLowerCase()}…</p>
      ) : list.count === 0 ? (
        <div className="home-list-state is-empty">
          <strong>{config.empty[0]}</strong>
          <p>{config.empty[1]}</p>
        </div>
      ) : (
        <>
          <ul className="home-list-items">
            {list.items.map((note) => {
              const meta = today ? config.meta(note, today) : null;
              const SourceIcon = note.source === "slack" ? MessageSquare : note.source === "email" ? Mail : null;
              const overdue = kind === "next" && today && isDueDate(note.dueDate) && note.dueDate <= today;
              const check = kind === "waiting" && today ? followupState(note, today) : null;
              const metaClass = overdue || check === "due" ? "is-due" : check === "overdue" ? "is-overdue" : "";
              return (
                <li
                  key={note.id}
                  className={`home-row ${justArrived(note.id) ? "home-item-new" : ""}`}
                  {...dragProps(note)}
                >
                  <button className="home-item" onClick={() => openNote(note.id)}>
                    <strong>
                      {untitled(note)}
                      {conflictIds.has(note.id) && (
                        <span className="conflict-badge">
                          <AlertTriangle size={11} aria-hidden="true" />
                          Changed elsewhere
                        </span>
                      )}
                    </strong>
                    <span className={`home-item-meta ${metaClass}`}>
                      {kind === "inbox" && SourceIcon && <SourceIcon size={11} aria-hidden="true" />}
                      {meta ?? " "}
                    </span>
                  </button>
                  <ItemActionsMenu note={note} />
                </li>
              );
            })}
          </ul>
          {list.count > list.items.length && (
            <p className="home-list-more">
              {list.count - list.items.length} more in {bucket.name}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Compact, demoted bucket navigation with live counts. */
export function HomeBucketLinks() {
  const { loaded, loadError, bucketCount, navigate, openGuide } = useWorkspaceShell();
  const dropProps = useBucketDropTargets();
  return (
    <nav className="home-buckets" aria-labelledby="home-buckets-heading">
      <div className="home-buckets-heading">
        <h2 id="home-buckets-heading">Your buckets</h2>
        <button className="text-button" onClick={openGuide}>
          How it works <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      </div>
      <ul>
        {BUCKETS.map((b) => {
          const Icon = bucketIcons[b.icon];
          const count = loaded && !loadError ? bucketCount(b.id) : null;
          return (
            <li key={b.id}>
              <button
                className={`home-bucket-link ${b.color}`}
                onClick={() => navigate(b.id)}
                aria-label={count === null ? b.name : `${b.name}, ${count} items`}
                {...dropProps(b.id)}
              >
                <Icon size={15} aria-hidden="true" />
                <span>{b.name}</span>
                <span className="home-bucket-count" aria-hidden="true">{count ?? "–"}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Home side panel listing due items for the current workspace. */
export function HomeDueItems() {
  const { notes, workspaceId, loaded, loadError, openNote, items } = useWorkspaceShell();
  const dragProps = useDraggableItem();
  return (
    <DueItems
      notes={notes}
      workspaceId={workspaceId}
      loading={!loaded}
      unavailable={loadError}
      onOpen={openNote}
      onComplete={items.completeNote}
      rowProps={dragProps}
      renderActions={(note) => <ItemActionsMenu note={note} className="due-actions" />}
    />
  );
}
