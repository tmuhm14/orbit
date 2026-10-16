"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Check,
  Layers,
  Mail,
  Maximize2,
  MessageSquare,
  RotateCcw,
} from "lucide-react";
import { itemKind, type Note } from "@/lib/notes";
import type { AssignmentListItem } from "@/lib/assignments/types";
import { KIND_LABELS, calendarDateLabel, followupSummary, projectPathLabel } from "@/lib/item-properties";
import { provenance } from "@/lib/library-view";
import { dueState } from "@/lib/tasks-view";
import { itemHref, projectHref } from "@/lib/workspace-routes";
import { AssignmentChip } from "./assignment-status";
import { ItemActionsMenu } from "./item-actions-menu";
import { useWorkspaceShell } from "./workspace-shell-context";

export const untitled = (note: Pick<Note, "title">) => note.title.trim() || "Untitled thought";

/** Page header shared by Tasks, Projects, Library and project detail. */
export function WorkHeader({
  eyebrow,
  title,
  description,
  icon,
  actions,
  before,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  icon: ReactNode;
  actions?: ReactNode;
  /** Above the title, e.g. the project breadcrumb. */
  before?: ReactNode;
}) {
  return (
    <header className="work-header">
      <span className="work-mark" aria-hidden="true">
        {icon}
      </span>
      <div className="work-header-text">
        {before}
        <div className="eyebrow">{eyebrow}</div>
        <h1 tabIndex={-1}>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="work-header-actions">{actions}</div>}
    </header>
  );
}

/** An honest empty state: what's missing and how to add it. */
export function WorkEmpty({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="work-empty">
      <strong>{title}</strong>
      <p>{body}</p>
      {children}
    </div>
  );
}

/** "Root › Sub" for an item's project; links to its detail page. */
export function ProjectTrail({ projectId }: { projectId: string | null | undefined }) {
  const { notes } = useWorkspaceShell();
  const project = projectId ? notes.find((n) => n.id === projectId) : undefined;
  if (!project || itemKind(project) !== "project") return null;
  const path = projectPathLabel(notes, project.id);
  return (
    <Link className="project-trail" href={projectHref(project.id)} aria-label={`Project: ${path}`}>
      <Layers size={11} aria-hidden="true" />
      <span>{path}</span>
    </Link>
  );
}

/** Slack / email / agent-result indicator. Labels are routing metadata only. */
export function ProvenanceBadge({ note }: { note: Note }) {
  const { openAssignment } = useWorkspaceShell();
  const source = provenance(note);
  if (!source) return null;
  if (source.kind === "assignment")
    return source.assignmentId ? (
      <button
        type="button"
        className="source-badge is-assignment"
        aria-haspopup="dialog"
        onClick={() => openAssignment(source.assignmentId!)}
      >
        <Bot size={11} aria-hidden="true" />
        {source.label}
      </button>
    ) : (
      <span className="source-badge is-assignment">
        <Bot size={11} aria-hidden="true" />
        {source.label}
      </span>
    );
  const Icon = source.kind === "slack" ? MessageSquare : Mail;
  if (source.kind === "slack" && source.href)
    return (
      <a className="source-badge is-slack" href={source.href} target="_blank" rel="noreferrer">
        <Icon size={11} aria-hidden="true" />
        {source.label}
        <ArrowUpRight size={11} aria-hidden="true" />
        <span className="sr-only"> (opens Slack)</span>
      </a>
    );
  return (
    <span className={`source-badge is-${source.kind}`}>
      <Icon size={11} aria-hidden="true" />
      {source.label}
    </span>
  );
}

function ConflictBadge({ id }: { id: string }) {
  const { conflictIds } = useWorkspaceShell();
  if (!conflictIds.has(id)) return null;
  return (
    <span className="conflict-badge" title="Changed somewhere else. Open it to choose a version.">
      <AlertTriangle size={11} aria-hidden="true" />
      Changed elsewhere
    </span>
  );
}

/**
 * After a row leaves the list (completed), keep keyboard focus nearby: the
 * next row's first button, else the previous row's, else the list heading.
 */
function keepFocusNear(button: HTMLElement) {
  const row = button.closest("li");
  const next = row?.nextElementSibling ?? row?.previousElementSibling;
  const scope = button.closest("section");
  requestAnimationFrame(() => {
    if (button.isConnected) return button.focus();
    const target = next?.isConnected ? next.querySelector<HTMLElement>("button") : null;
    if (target) return target.focus();
    const heading = scope?.querySelector<HTMLElement>("h2, h3") ?? document.querySelector<HTMLElement>(".main-shell main h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  });
}

/**
 * One actionable row: complete (or reopen), title (opens the editor), due
 * and follow-up badges, project breadcrumb, assignment chip and the quick
 * actions menu.
 */
export function TaskRow({
  note,
  today,
  assignment,
  showProject = true,
}: {
  note: Note;
  /** Local YYYY-MM-DD, or null before mount (badges wait for it). */
  today: string | null;
  assignment: AssignmentListItem | null;
  showProject?: boolean;
}) {
  const { items, openNote, setNotes, showToast, openAssignment } = useWorkspaceShell();
  const done = !!note.completedAt;
  const title = untitled(note);
  const due = today ? dueState(note, today) : null;
  const follow = today && !done ? followupSummary(note, today) : null;
  const kind = itemKind(note);
  function reopen() {
    setNotes((list) =>
      list.map((n) => (n.id === note.id ? { ...n, completedAt: null, updatedAt: new Date().toISOString() } : n)),
    );
    showToast("Reopened");
  }
  return (
    <li className={`task-row ${done ? "is-complete" : ""}`}>
      <button
        type="button"
        className="task-check"
        aria-label={done ? `Reopen ${title}` : `Complete ${title}`}
        title={done ? "Reopen" : "Complete"}
        onClick={(e) => {
          const button = e.currentTarget;
          if (done) reopen();
          else if (items.completeNote(note.id)) keepFocusNear(button);
        }}
      >
        {done ? <RotateCcw size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
      </button>
      <div className="task-main">
        <button type="button" className="task-open" aria-haspopup="dialog" onClick={() => openNote(note.id)}>
          <strong>{title}</strong>
          <ConflictBadge id={note.id} />
        </button>
        <div className="task-meta">
          {kind !== "task" && <span className="task-kind">{KIND_LABELS[kind]}</span>}
          {due && note.dueDate && (
            <span className={`task-badge is-${due}`}>
              {due === "today"
                ? "Due today"
                : due === "overdue"
                  ? `Overdue · ${calendarDateLabel(note.dueDate, today)}`
                  : `Due ${calendarDateLabel(note.dueDate, today)}`}
            </span>
          )}
          {follow?.text && <span className={`task-badge is-check-${follow.state ?? "none"}`}>{follow.text}</span>}
          {done && note.completedAt && (
            <span className="task-badge">Done {calendarDateLabel(note.completedAt.slice(0, 10), today)}</span>
          )}
          {showProject && <ProjectTrail projectId={note.projectId} />}
          {assignment && <AssignmentChip state={assignment.state} onOpen={() => openAssignment(assignment.id)} />}
        </div>
      </div>
      {!done && <ItemActionsMenu note={note} />}
    </li>
  );
}

/** A note or document row: title, kind, source, tags, updated date, full page. */
export function ItemRow({ note, showProject = false }: { note: Note; showProject?: boolean }) {
  const { openNote } = useWorkspaceShell();
  const title = untitled(note);
  const kind = itemKind(note);
  return (
    <li className="item-row">
      <div className="item-row-main">
        <button type="button" className="task-open" aria-haspopup="dialog" onClick={() => openNote(note.id)}>
          <strong>{title}</strong>
          <ConflictBadge id={note.id} />
        </button>
        {note.plainText.trim() && <p className="item-row-snippet">{note.plainText.trim().slice(0, 180)}</p>}
        <div className="task-meta">
          <span className={`task-kind is-${kind}`}>{KIND_LABELS[kind]}</span>
          <ProvenanceBadge note={note} />
          {showProject && <ProjectTrail projectId={note.projectId} />}
          {note.tags.slice(0, 6).map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
          {/* Local date; the server's render may differ by time zone. */}
          <time className="item-row-time" dateTime={note.updatedAt} suppressHydrationWarning>
            Updated {new Date(note.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </time>
        </div>
      </div>
      <Link className="icon-button item-row-full" href={itemHref(note.id)} aria-label={`Open ${title} full page`} title="Open full page">
        <Maximize2 size={15} aria-hidden="true" />
      </Link>
    </li>
  );
}
