"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Ban,
  BookOpen,
  CheckCircle2,
  CircleCheck,
  LoaderCircle,
  MessageCircleQuestion,
  RotateCcw,
  Send,
  Sparkles,
  ThumbsDown,
  X,
} from "lucide-react";
import type { Note } from "@/lib/notes";
import type { Assignment } from "@/lib/assignments/types";
import { ANSWER_MAX, COMMENT_MAX } from "@/lib/assignments/transitions";
import {
  failureCopy,
  isActiveState,
  itemTitle,
  latestProgress,
  openQuestion,
  reviewableArtifact,
  statusLine,
  timelineEntries,
  viewActions,
} from "@/lib/assignment-view";
import { acceptedArtifactId } from "@/lib/agents-view";
import { ArtifactPreview } from "./artifact-preview";
import { AssignmentErrorNotice, AssignmentStateBadge, type ErrorNoticeActions } from "./assignment-status";
import { SaveDocumentForm, SavedDocumentLink } from "./save-document";
import { useAssignmentDetail, useNow, type ActionError, type AssignmentAction } from "./use-assignment";
import { useModalDialog } from "./use-modal-dialog";
import { useWorkspaceShell } from "./workspace-shell-context";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

/**
 * Assignment detail, above the editor: outcome, state and times, the source
 * item, the selected context, an honest live status, the timeline from real
 * events, and the next step the state allows (answer, review, retry, cancel).
 */
export function AssignmentDetailDialog({
  assignmentId,
  notes,
  onClose,
  onChange,
  onOpenNote,
  onOpenAssignment,
  onOpenSettings,
  onOpenAgent,
}: {
  assignmentId: string;
  notes: Note[];
  onClose: () => void;
  /** Every fresher copy, so the editor's chip follows along. */
  onChange: (assignment: Assignment) => void;
  onOpenNote: (id: string) => void;
  onOpenAssignment: (id: string) => void;
} & Pick<ErrorNoticeActions, "onOpenSettings" | "onOpenAgent">) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useModalDialog(ref, onClose);
  const shell = useWorkspaceShell();
  const { assignmentChanged } = shell;
  const { detail, loadErrorCode, busy, act, reload } = useAssignmentDetail(assignmentId, (next) => {
    onChange(next);
    assignmentChanged(next);
  });
  const [saving, setSaving] = useState(false);
  /** The document just saved here, shown before the reload carries savedNoteId. */
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [answer, setAnswer] = useState("");
  const [changes, setChanges] = useState<string | null>(null);
  const state = detail?.assignment.state ?? null;
  const now = useNow(state === "queued" || state === "running");
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const timeline = useMemo(() => (detail ? timelineEntries(detail) : []), [detail]);

  async function run(action: AssignmentAction) {
    setActionError(null);
    const error = await act(action);
    if (error) {
      setActionError(error);
      return false;
    }
    setConfirmCancel(false);
    return true;
  }

  const header = (
    <header className="assignment-dialog-head">
      <span className="assignment-orbit" aria-hidden="true">
        <Sparkles size={16} />
      </span>
      <div>
        <span className="assignment-kicker">Delegated</span>
        <h2 id={`${id}-title`}>Assignment</h2>
      </div>
      <button type="button" className="icon-button assignment-close" aria-label="Close assignment" onClick={onClose}>
        <X size={18} />
      </button>
    </header>
  );

  let body;
  if (!detail) {
    body = loadErrorCode ? (
      <AssignmentErrorNotice code={loadErrorCode} onRetry={() => void reload()} />
    ) : (
      <p className="assignment-loading" role="status">
        <LoaderCircle size={15} className="spin" aria-hidden="true" /> Loading the assignment…
      </p>
    );
  } else {
    const { assignment } = detail;
    const actions = viewActions(assignment.state);
    const status = statusLine(detail, now);
    const progress = latestProgress(detail);
    const question = openQuestion(detail);
    const artifact = reviewableArtifact(detail);
    const source = assignment.sourceNoteId ? byId.get(assignment.sourceNoteId) : undefined;
    const answerText = answer.trim();
    const changesText = changes?.trim() ?? "";

    const sendAnswer = async (event: FormEvent) => {
      event.preventDefault();
      if (!question || !answerText || answerText.length > ANSWER_MAX) return;
      if (await run({ kind: "answer", questionId: question.id, answer: answerText })) setAnswer("");
    };
    const review = async (decision: "accept" | "request_changes" | "reject") => {
      if (!artifact) return;
      if (decision === "request_changes" && (!changesText || changesText.length > COMMENT_MAX)) return;
      const done = await run({
        kind: "review",
        artifactId: artifact.id,
        decision,
        ...(decision === "request_changes" ? { comment: changesText } : {}),
      });
      if (done) setChanges(null);
    };

    body = (
      <>
        <section className="assignment-summary" aria-labelledby={`${id}-title`}>
          <div className="assignment-summary-row">
            <AssignmentStateBadge state={assignment.state} />
            <dl className="assignment-times">
              <div>
                <dt>Delegated</dt>
                <dd>
                  <time dateTime={assignment.createdAt}>{when(assignment.createdAt)}</time>
                </dd>
              </div>
              <div>
                <dt>Last change</dt>
                <dd>
                  <time dateTime={assignment.stateChangedAt}>{when(assignment.stateChangedAt)}</time>
                </dd>
              </div>
              {assignment.finishedAt && (
                <div>
                  <dt>Finished</dt>
                  <dd>
                    <time dateTime={assignment.finishedAt}>{when(assignment.finishedAt)}</time>
                  </dd>
                </div>
              )}
            </dl>
          </div>
          <h3 className="assignment-label">Requested outcome</h3>
          <p className="assignment-outcome">{assignment.requestedOutcome}</p>
          <h3 className="assignment-label">From</h3>
          {assignment.sourceNoteId ? (
            <button type="button" className="assignment-link" onClick={() => onOpenNote(assignment.sourceNoteId!)}>
              {itemTitle(source)}
              <ArrowUpRight size={13} aria-hidden="true" />
            </button>
          ) : (
            <p className="assignment-muted">The source item was deleted or moved to another space.</p>
          )}
        </section>

        <div className={`assignment-live is-${assignment.state}`}>
          {/* Announces only the state and new progress text, not the ticking clock. */}
          <p role="status" aria-live="polite" aria-atomic="true">
            <strong>{status.label}</strong>
            {progress && <span className="assignment-progress"> · {progress}</span>}
          </p>
          {status.since && <small>{status.since}</small>}
        </div>

        {actionError && (
          <AssignmentErrorNotice
            code={actionError.code}
            onOpenSettings={onOpenSettings}
            onOpenAgent={onOpenAgent}
            onOpenExisting={actionError.existingId ? () => onOpenAssignment(actionError.existingId!) : undefined}
          />
        )}
        {loadErrorCode && (
          <p className="assignment-muted" role="status">
            Couldn’t refresh just now. Orbit will keep trying.
          </p>
        )}

        {actions.answer && question && (
          <form className="assignment-step is-question" onSubmit={sendAnswer}>
            <h3>
              <MessageCircleQuestion size={15} aria-hidden="true" /> The agent asks
            </h3>
            <p className="assignment-untrusted">{question.prompt}</p>
            <label htmlFor={`${id}-answer`}>Your answer</label>
            <textarea
              id={`${id}-answer`}
              rows={3}
              value={answer}
              maxLength={ANSWER_MAX}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <div className="assignment-step-actions">
              <small>
                {answerText.length.toLocaleString()} / {ANSWER_MAX.toLocaleString()}
              </small>
              <button type="submit" className="primary-button" disabled={!answerText || busy !== null}>
                {busy === "answer" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                Send answer
              </button>
            </div>
          </form>
        )}
        {actions.answer && !question && (
          <p className="assignment-muted">The agent is waiting for input, but the question isn’t loaded yet.</p>
        )}

        {actions.review && artifact && (
          <section className="assignment-step is-review" aria-labelledby={`${id}-result`}>
            <h3 id={`${id}-result`}>
              <CircleCheck size={15} aria-hidden="true" /> Result: {artifact.title || "Untitled result"}
            </h3>
            {/* Executor-written: the safe Tiptap subset, read-only, or plain text. Never HTML. */}
            <ArtifactPreview content={artifact.content} plainText={artifact.plainText} label="Result preview" />
            <p className="assignment-muted">
              Accepting keeps this result with the assignment. It doesn’t complete “{itemTitle(source)}”; mark
              that done yourself when you’re ready.
            </p>
            {changes !== null && (
              <div className="assignment-field">
                <label htmlFor={`${id}-changes`}>What should change?</label>
                <textarea
                  id={`${id}-changes`}
                  rows={3}
                  value={changes}
                  maxLength={COMMENT_MAX}
                  autoFocus
                  onChange={(e) => setChanges(e.target.value)}
                />
              </div>
            )}
            <div className="assignment-step-actions">
              {changes === null ? (
                <>
                  <button type="button" className="danger-button" disabled={busy !== null} onClick={() => void review("reject")}>
                    <ThumbsDown size={14} aria-hidden="true" /> Reject
                  </button>
                  <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setChanges("")}>
                    <RotateCcw size={14} aria-hidden="true" /> Request changes
                  </button>
                  <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void review("accept")}>
                    {busy === "review" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <CircleCheck size={14} aria-hidden="true" />}
                    Accept
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="text-button" onClick={() => setChanges(null)}>
                    Back
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!changesText || busy !== null}
                    onClick={() => void review("request_changes")}
                  >
                    <Send size={14} aria-hidden="true" /> Send changes
                  </button>
                </>
              )}
            </div>
          </section>
        )}
        {assignment.state === "completed" && (() => {
          const acceptedId = acceptedArtifactId(detail.reviews);
          const accepted = detail.artifacts.find((a) => a.id === acceptedId);
          const sourceDone = !!source?.completedAt;
          const canComplete = !!source && !sourceDone && source.workspaceId === shell.workspaceId;
          return (
            <section className="assignment-step is-accepted" aria-labelledby={`${id}-accepted`}>
              <h3 id={`${id}-accepted`}>
                <CircleCheck size={15} aria-hidden="true" /> Accepted{accepted ? `: ${accepted.title || "Untitled result"}` : ""}
              </h3>
              {accepted && (
                <ArtifactPreview content={accepted.content} plainText={accepted.plainText} label="Accepted result" />
              )}
              {accepted && (accepted.savedNoteId ?? justSaved) ? (
                <SavedDocumentLink
                  noteId={(accepted.savedNoteId ?? justSaved)!}
                  notes={notes}
                  onOpenNote={onOpenNote}
                  autoFocus={!!justSaved}
                />
              ) : accepted && saving ? (
                <SaveDocumentForm
                  assignment={assignment}
                  artifact={accepted}
                  notes={notes}
                  onCancel={() => setSaving(false)}
                  onOpenNote={onOpenNote}
                  onReload={reload}
                  onSaved={async (noteId, next) => {
                    onChange(next);
                    assignmentChanged(next);
                    await Promise.all([reload(), shell.refreshNotes()]);
                    setSaving(false);
                    setJustSaved(noteId);
                    shell.showActionToast("Saved to Reference", { label: "Open", onAction: () => onOpenNote(noteId) });
                  }}
                />
              ) : accepted ? (
                <div className="assignment-step-actions">
                  <button type="button" className="secondary-button" onClick={() => setSaving(true)}>
                    <BookOpen size={14} aria-hidden="true" /> Save as document
                  </button>
                </div>
              ) : (
                <p className="assignment-muted">The accepted result isn’t loaded.</p>
              )}
              <div className="accepted-source">
                {sourceDone ? (
                  <p className="assignment-muted">
                    <CheckCircle2 size={13} aria-hidden="true" /> “{itemTitle(source)}” is marked done.
                  </p>
                ) : source ? (
                  <>
                    <p className="assignment-muted">
                      Accepting didn’t complete “{itemTitle(source)}”. Mark it done when you’re ready.
                    </p>
                    {canComplete && (
                      <button type="button" className="text-button" onClick={() => shell.items.completeNote(source.id)}>
                        <CheckCircle2 size={14} aria-hidden="true" /> Mark source complete
                      </button>
                    )}
                  </>
                ) : null}
              </div>
            </section>
          );
        })()}

        {actions.review && !artifact && (
          <p className="assignment-muted">A result is ready, but it isn’t loaded yet.</p>
        )}

        {assignment.state === "failed" && (
          <section className="assignment-step is-failed" aria-labelledby={`${id}-failed`}>
            <h3 id={`${id}-failed`}>It didn’t work out this time</h3>
            <p>{failureCopy(assignment.errorCode)}</p>
            {actions.retry && (
              <div className="assignment-step-actions">
                <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void run({ kind: "retry" })}>
                  {busy === "retry" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
                  Retry
                </button>
              </div>
            )}
          </section>
        )}

        <section className="assignment-section" aria-labelledby={`${id}-context`}>
          <h3 id={`${id}-context`} className="assignment-label">
            Shared context · {detail.context.length}
          </h3>
          {detail.context.length === 0 ? (
            <p className="assignment-muted">No other items were shared.</p>
          ) : (
            <ul className="assignment-context">
              {detail.context.map((item) => (
                <li key={item.position}>
                  {item.noteId ? (
                    <button type="button" className="assignment-link" onClick={() => onOpenNote(item.noteId!)}>
                      {itemTitle(byId.get(item.noteId))}
                      <ArrowUpRight size={13} aria-hidden="true" />
                    </button>
                  ) : (
                    <span className="assignment-muted">A deleted or moved item</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="assignment-section" aria-labelledby={`${id}-timeline`}>
          <h3 id={`${id}-timeline`} className="assignment-label">
            Timeline
          </h3>
          {timeline.length === 0 ? (
            <p className="assignment-muted">Nothing has happened yet.</p>
          ) : (
            <ol className="assignment-timeline">
              {timeline.map((entry) => (
                <li key={entry.id} className={`is-${entry.tone}`}>
                  <span className="assignment-timeline-dot" aria-hidden="true" />
                  <div>
                    <strong>{entry.title}</strong>
                    {entry.text && <p className="assignment-untrusted">{entry.text}</p>}
                    <time dateTime={entry.at}>{when(entry.at)}</time>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </>
    );
  }

  const canCancel = detail ? viewActions(detail.assignment.state).cancel : false;
  return createPortal(
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="assignment-dialog assignment-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-busy={!detail || undefined}
        onKeyDown={onKeyDown}
      >
        {header}
        <div className="assignment-dialog-body">{body}</div>
        <footer className="assignment-dialog-actions">
          {canCancel && detail && isActiveState(detail.assignment.state) ? (
            confirmCancel ? (
              <>
                <span>Stop this assignment?</span>
                <button type="button" className="text-button" onClick={() => setConfirmCancel(false)}>
                  Keep going
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={busy !== null}
                  onClick={() => void run({ kind: "cancel" })}
                >
                  {busy === "cancel" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Ban size={14} aria-hidden="true" />}
                  Cancel assignment
                </button>
              </>
            ) : (
              <button type="button" className="text-button" onClick={() => setConfirmCancel(true)}>
                <Ban size={14} aria-hidden="true" /> Cancel assignment
              </button>
            )
          ) : (
            <span />
          )}
          <button type="button" className="secondary-button" onClick={onClose} data-autofocus>
            Close
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
