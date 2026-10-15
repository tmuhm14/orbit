"use client";

import { useId, useMemo } from "react";
import { ChevronRight, History, Hourglass, LoaderCircle, Sparkles } from "lucide-react";
import type { AssignmentListItem } from "@/lib/assignments/types";
import type { Note } from "@/lib/notes";
import { failureCopy, itemTitle } from "@/lib/assignment-view";
import {
  HISTORY_FILTERS,
  LIST_MAX,
  ROW_ACTION,
  history as historyOf,
  inProgress as inProgressOf,
  needsYou as needsYouOf,
  rowTimes,
} from "@/lib/agents-view";
import { AgentAvailabilityNotice, AssignmentErrorNotice, AssignmentStateBadge } from "./assignment-status";
import { useAvailability, useNow, useWorkspaceAssignments } from "./use-assignment";
import { useWorkspaceShell } from "./workspace-shell-context";

/** One assignment: outcome, source, state, relative times; opens the detail. */
function AgentRow({
  assignment,
  notesById,
  now,
  onOpen,
}: {
  assignment: AssignmentListItem;
  notesById: Map<string, Note>;
  now: number;
  onOpen: (id: string) => void;
}) {
  const source = assignment.sourceNoteId ? notesById.get(assignment.sourceNoteId) : undefined;
  const action = ROW_ACTION[assignment.state];
  return (
    <li>
      <button
        type="button"
        className={`agent-row is-${assignment.state}`}
        aria-haspopup="dialog"
        onClick={() => onOpen(assignment.id)}
      >
        <span className="agent-row-main">
          {/* User-written outcome; plain text. */}
          <strong className="agent-row-outcome">{assignment.requestedOutcome}</strong>
          <span className="agent-row-source">
            {assignment.sourceNoteId ? `From “${itemTitle(source)}”` : "The source item was deleted or moved"}
          </span>
          <span className="agent-row-meta">
            <AssignmentStateBadge state={assignment.state} />
            <small>{rowTimes(assignment, now)}</small>
          </span>
          {assignment.savedNoteId && (
            <span className="agent-row-saved">Saved as a document</span>
          )}
          {assignment.state === "failed" && (
            <span className="agent-row-why">{failureCopy(assignment.errorCode)}</span>
          )}
        </span>
        <span className="agent-row-go">
          {action ?? "Open"}
          <ChevronRight size={14} aria-hidden="true" />
        </span>
      </button>
    </li>
  );
}

function Section({
  title,
  icon: Icon,
  count,
  tone,
  children,
  extra,
}: {
  title: string;
  icon: typeof Sparkles;
  count: number | null;
  tone: string;
  children: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const id = useId();
  return (
    <section className={`agents-section is-${tone}`} aria-labelledby={id}>
      <div className="agents-section-heading">
        <h2 id={id}>
          <span className="agents-section-icon" aria-hidden="true">
            <Icon size={15} />
          </span>
          {title}
          {count !== null && <span className="agents-count">{count}</span>}
        </h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

/**
 * The Agents page (`/agents`) for the current space: what needs you first
 * (questions, then reviews, longest waiting first), what's in progress with
 * honest live status, then history with a state filter and "Show more".
 * Every row opens the assignment detail. Nothing is invented: before the
 * first load it says it's loading, and with no assignments it says so.
 */
export function AgentsPage() {
  const shell = useWorkspaceShell();
  const { workspaceId, notes, openAssignment, assignmentsVersion, agentEnabled } = shell;
  const data = useWorkspaceAssignments(workspaceId, assignmentsVersion);
  const { availability } = useAvailability(workspaceId, agentEnabled);
  const now = useNow(true, 30_000);
  const notesById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const waiting = needsYouOf(data.open);
  const moving = inProgressOf(data.open);
  const past = historyOf(data.history, data.filter);
  const filterId = useId();
  const nothingYet = data.loaded && !data.open.length && !data.history.length && data.filter === "all";
  const row = (a: AssignmentListItem) => (
    <AgentRow key={a.id} assignment={a} notesById={notesById} now={now} onOpen={openAssignment} />
  );

  let body;
  if (!data.loaded) {
    body = data.errorCode ? (
      <AssignmentErrorNotice code={data.errorCode} onRetry={() => void data.refresh()} />
    ) : (
      <p className="agents-loading" role="status">
        <LoaderCircle size={15} className="spin" aria-hidden="true" /> Loading delegated work…
      </p>
    );
  } else if (nothingYet) {
    body = (
      <div className="agents-empty">
        <span className="agents-empty-orbit" aria-hidden="true">
          <Sparkles size={20} />
        </span>
        <strong>Nothing delegated yet.</strong>
        <p>Open an item and choose Delegate. Its questions, results and history will gather here.</p>
      </div>
    );
  } else {
    body = (
      <>
        {data.errorCode && (
          <p className="assignment-muted" role="status">
            Couldn’t refresh just now. Showing what was last loaded; Orbit will try again.
          </p>
        )}
        <Section title="Needs you" icon={Hourglass} count={waiting.length} tone="needs">
          {waiting.length ? (
            <ul className="agents-list">{waiting.map(row)}</ul>
          ) : (
            <p className="agents-section-empty">Nothing needs you right now.</p>
          )}
        </Section>
        <Section title="In progress" icon={Sparkles} count={moving.length} tone="moving">
          {moving.length ? (
            <ul className="agents-list">{moving.map(row)}</ul>
          ) : (
            <p className="agents-section-empty">Nothing is in progress.</p>
          )}
        </Section>
        <Section
          title="History"
          icon={History}
          count={null}
          tone="history"
          extra={
            <div className="agents-filter" role="radiogroup" aria-label="Show history">
              {HISTORY_FILTERS.map((f) => (
                <label key={f.id} className={`agents-filter-chip ${data.filter === f.id ? "is-selected" : ""}`}>
                  <input
                    type="radio"
                    name={`${filterId}-history`}
                    value={f.id}
                    checked={data.filter === f.id}
                    onChange={() => data.setFilter(f.id)}
                  />
                  <span>{f.label}</span>
                </label>
              ))}
            </div>
          }
        >
          {past.length ? (
            <ul className="agents-list">{past.map(row)}</ul>
          ) : (
            <p className="agents-section-empty">
              {data.filter === "all"
                ? "Finished work will show up here."
                : `No ${HISTORY_FILTERS.find((f) => f.id === data.filter)?.label.toLowerCase()} work yet.`}
            </p>
          )}
          {data.hasMore && (
            <button type="button" className="secondary-button agents-more" onClick={data.showMore}>
              Show more
            </button>
          )}
          {data.capped && <p className="agents-section-empty">Showing the latest {LIST_MAX}.</p>}
        </Section>
      </>
    );
  }

  return (
    <main className="agents-page">
      <header className="agents-page-header">
        <span className="agents-mark" aria-hidden="true">
          <span className="agents-mark-ring" />
          <Sparkles size={20} />
        </span>
        <div>
          <div className="eyebrow">DELEGATED WORK</div>
          <h1>Agents</h1>
          <p>What you’ve handed off, what needs you, and what came back.</p>
        </div>
      </header>
      <AgentAvailabilityNotice
        availability={availability}
        onOpenSettings={shell.openSettings}
        onOpenAgent={shell.openAgentDialog}
      />
      {/* Announces counts only when they change, not every poll. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {data.loaded && !nothingYet
          ? `${waiting.length} need${waiting.length === 1 ? "s" : ""} you, ${moving.length} in progress`
          : ""}
      </p>
      {body}
    </main>
  );
}
