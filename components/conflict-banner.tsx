"use client";

import { useId, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { Note } from "@/lib/notes";
import type { NoteConflict } from "./use-notes";

const titleOf = (note: Pick<Note, "title"> | null | undefined) =>
  note?.title.trim() || "Untitled thought";

function Version({ label, note, missing }: { label: string; note: Note | null; missing: string }) {
  return (
    <section className="conflict-version" aria-label={label}>
      <h4>{label}</h4>
      {note ? (
        <>
          <strong>{titleOf(note)}</strong>
          <p>{note.plainText.trim() || "No text."}</p>
        </>
      ) : (
        <p className="conflict-missing">{missing}</p>
      )}
    </section>
  );
}

/**
 * Non-blocking notice inside the editor when the open note changed
 * somewhere else (ADR 002 §6). The local draft stays in place (and in
 * browser storage) until the user picks one of the recovery actions.
 */
export function ConflictBanner({
  conflict,
  onKeepMine,
  onUseTheirs,
  onSaveCopy,
}: {
  conflict: NoteConflict;
  onKeepMine: () => void;
  onUseTheirs: () => void;
  onSaveCopy: () => void;
}) {
  const [comparing, setComparing] = useState(false);
  const id = useId();
  const deletedThere = conflict.server === null;
  return (
    <div className="conflict-banner" role="region" aria-labelledby={`${id}-title`}>
      <div className="conflict-banner-head">
        <AlertTriangle size={16} aria-hidden="true" />
        <div>
          <strong id={`${id}-title`} role="status">
            {deletedThere ? "This note was deleted somewhere else." : "This note changed somewhere else."}
          </strong>
          <p>
            Your edits are kept here and won’t be lost. Choose which version to keep.
          </p>
        </div>
      </div>
      <div className="conflict-actions">
        <button type="button" className="secondary-button" onClick={onKeepMine}>
          Keep mine
        </button>
        <button type="button" className="secondary-button" onClick={onUseTheirs}>
          {deletedThere ? "Delete it here too" : "Use theirs"}
        </button>
        <button type="button" className="secondary-button" onClick={onSaveCopy}>
          Save mine as a copy
        </button>
        {!deletedThere && (
          <button
            type="button"
            className="text-button"
            aria-expanded={comparing}
            aria-controls={`${id}-compare`}
            onClick={() => setComparing(!comparing)}
          >
            {comparing ? "Hide their version" : "Show their version"}
          </button>
        )}
      </div>
      {comparing && !deletedThere && (
        <div className="conflict-compare" id={`${id}-compare`}>
          <Version label="Your version" note={conflict.local} missing="You deleted it here." />
          <Version label="Their version" note={conflict.server} missing="Deleted elsewhere." />
        </div>
      )}
    </div>
  );
}

/**
 * Small global notice for conflicted notes that aren't open. Notes still in
 * the list open in the editor (which shows the banner); a note deleted here
 * but changed elsewhere can be restored or kept deleted from the notice.
 */
export function ConflictNotice({
  conflicts,
  onOpen,
  onRestore,
  onKeepDeleted,
}: {
  conflicts: NoteConflict[];
  onOpen: (id: string) => void;
  onRestore: (id: string) => void;
  onKeepDeleted: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (!conflicts.length) return null;
  const count = conflicts.length;
  return (
    <div className="sync-notice is-conflict" role="region" aria-labelledby={`${id}-title`}>
      <AlertTriangle size={15} aria-hidden="true" />
      <div className="sync-notice-body">
        <p id={`${id}-title`}>
          <strong>
            {count === 1 ? "A note changed somewhere else." : `${count} notes changed somewhere else.`}
          </strong>{" "}
          Your edits are safe until you choose a version.
        </p>
        {count > 1 && (
          <button
            type="button"
            className="text-button"
            aria-expanded={expanded}
            aria-controls={`${id}-list`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide" : "Show them"}
          </button>
        )}
        {(expanded || conflicts.length === 1) && (
          <ul id={`${id}-list`} className="sync-notice-list">
            {conflicts.map((conflict) => (
              <li key={conflict.id}>
                {conflict.local ? (
                  <button type="button" className="text-button" onClick={() => onOpen(conflict.id)}>
                    Open “{titleOf(conflict.local)}”
                  </button>
                ) : (
                  <>
                    <span>“{titleOf(conflict.server)}” was deleted here but changed elsewhere.</span>
                    <button type="button" className="text-button" onClick={() => onRestore(conflict.id)}>
                      Restore it
                    </button>
                    <button type="button" className="text-button" onClick={() => onKeepDeleted(conflict.id)}>
                      Keep it deleted
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The server needs a newer client: saving resumes after a reload. */
export function ReloadBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`sync-notice is-reload ${compact ? "is-compact" : ""}`} role="alert">
      <RefreshCw size={15} aria-hidden="true" />
      <div className="sync-notice-body">
        <p>
          <strong>Orbit has been updated.</strong> Reload the page to keep saving your changes.
        </p>
        <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}
