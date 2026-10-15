"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { ArrowUpRight, BookOpen, CircleCheck, LoaderCircle } from "lucide-react";
import { createNote, type Note } from "@/lib/notes";
import type { Assignment, AssignmentArtifact } from "@/lib/assignments/types";
import { itemTitle, refetchOn } from "@/lib/assignment-view";
import {
  DOCUMENT_TITLE_MAX,
  saveDocumentBody,
  sourceProject,
  type ProjectChoice,
} from "@/lib/agents-view";
import { savedNoteIdOf } from "@/lib/assignment-api";
import { AssignmentErrorNotice } from "./assignment-status";
import { ProjectPicker } from "./project-picker";
import { assignmentsU05, errorCodeOf } from "./use-assignment";

/** "Saved as <document>", opening it in the editor. */
export function SavedDocumentLink({
  noteId,
  notes,
  onOpenNote,
  prefix = "Saved as",
  autoFocus = false,
}: {
  noteId: string;
  notes: Note[];
  onOpenNote: (id: string) => void;
  prefix?: string;
  /** Right after saving, so focus doesn't fall back to the page. */
  autoFocus?: boolean;
}) {
  const note = notes.find((n) => n.id === noteId);
  return (
    <p className="saved-document">
      <BookOpen size={14} aria-hidden="true" />
      <span>{prefix}</span>
      <button type="button" className="assignment-link" autoFocus={autoFocus} onClick={() => onOpenNote(noteId)}>
        {note ? itemTitle(note) : "the saved document"}
        <ArrowUpRight size={13} aria-hidden="true" />
      </button>
    </p>
  );
}

/**
 * "Save as document" for an accepted result: a title (prefilled from the
 * result), the project (same as the source by default, any project in the
 * space, or None) and save. The server creates the Reference document and
 * records the link; nothing is written locally until it answers.
 */
export function SaveDocumentForm({
  assignment,
  artifact,
  notes,
  onSaved,
  onReload,
  onOpenNote,
  onCancel,
}: {
  assignment: Assignment;
  artifact: AssignmentArtifact;
  notes: Note[];
  /** The new document's id. */
  onSaved: (noteId: string, assignment: Assignment) => void;
  onReload: () => Promise<void>;
  onOpenNote: (id: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(artifact.title);
  const [choice, setChoice] = useState<ProjectChoice>({ mode: "source" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; noteId: string | null } | null>(null);
  const source = sourceProject(notes, assignment.sourceNoteId);
  const sourceLabel = assignment.sourceNoteId
    ? source.title ?? "no project"
    : "no project (the source item is gone)";
  // The picker works on an item; this stands in for the document to be.
  const draft = useMemo<Note>(
    () => ({
      ...createNote("", "reference", assignment.workspaceId),
      id: `draft-document-${assignment.id}`,
      kind: "document",
      projectId: choice.mode === "pick" ? choice.projectId : source.id,
    }),
    [assignment.workspaceId, assignment.id, choice, source.id],
  );
  const trimmed = title.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await assignmentsU05.saveDocument(
        assignment.id,
        saveDocumentBody({
          expectedRevision: assignment.revision,
          artifactId: artifact.id,
          artifactTitle: artifact.title,
          title,
          choice,
        }),
      );
      onSaved(result.note.id, result.assignment);
    } catch (failure) {
      // Save-document codes (already_saved, project_*) arrive on the same error type.
      const code: string = errorCodeOf(failure);
      setError({ code, noteId: savedNoteIdOf(failure) });
      setBusy(false);
      if (refetchOn(code) || code === "already_saved") await onReload();
    }
  }

  return (
    <form className="save-document" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>
        <BookOpen size={14} aria-hidden="true" /> Save as document
      </h4>
      <p className="assignment-muted">A new document in Reference, with this result as its text.</p>
      <div className="assignment-field">
        <label htmlFor={`${id}-name`}>Title</label>
        <input
          id={`${id}-name`}
          className="property-input"
          value={title}
          maxLength={DOCUMENT_TITLE_MAX}
          autoFocus
          required
          aria-invalid={!trimmed || undefined}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <fieldset className="assignment-field save-document-project">
        <legend>Project</legend>
        <label className="save-document-choice">
          <input
            type="radio"
            name={`${id}-project`}
            checked={choice.mode === "source"}
            onChange={() => setChoice({ mode: "source" })}
          />
          <span>
            Same as source <small>· {sourceLabel}</small>
          </span>
        </label>
        <label className="save-document-choice">
          <input
            type="radio"
            name={`${id}-project`}
            checked={choice.mode === "pick"}
            onChange={() => setChoice({ mode: "pick", projectId: source.id })}
          />
          <span>Choose a project, or None</span>
        </label>
        {choice.mode === "pick" && (
          <div className="save-document-picker">
            <label htmlFor={`${id}-picker`} className="sr-only">
              Project for the document
            </label>
            <ProjectPicker
              id={`${id}-picker`}
              notes={notes}
              item={draft}
              onSelect={(projectId) => setChoice({ mode: "pick", projectId })}
            />
          </div>
        )}
      </fieldset>
      {error && (
        <>
          <AssignmentErrorNotice code={error.code} onRetry={() => setError(null)} />
          {error.code === "already_saved" && error.noteId && (
            <SavedDocumentLink noteId={error.noteId} notes={notes} onOpenNote={onOpenNote} prefix="It’s saved as" />
          )}
        </>
      )}
      <div className="assignment-step-actions">
        <button type="button" className="text-button" onClick={onCancel} disabled={busy}>
          Not now
        </button>
        <button type="submit" className="primary-button" disabled={busy || !trimmed}>
          {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <CircleCheck size={14} aria-hidden="true" />}
          {busy ? "Saving…" : "Save document"}
        </button>
      </div>
    </form>
  );
}
