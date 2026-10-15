"use client";

import { useEffect, useId, useState } from "react";
import { ChevronRight, Layers, Plus, Sparkles, X } from "lucide-react";
import {
  BUCKETS,
  ITEM_KINDS,
  LINK_ERROR_MESSAGES,
  followupState,
  itemKind,
  normalizeFollowupText,
  type Followup,
  type FollowupField,
  type LinkErrorCode,
  type Note,
} from "@/lib/notes";
import { defaultTimeZone, localToday } from "@/lib/reminders";
import { FOLLOWUP_COPY, KIND_LABELS } from "@/lib/item-properties";
import { isActiveState } from "@/lib/assignment-view";
import { AssignmentDetailDialog } from "./assignment-detail";
import { AssignmentChip } from "./assignment-status";
import { DelegateDialog } from "./delegate-dialog";
import { ProjectPicker } from "./project-picker";
import { useItemAssignment } from "./use-assignment";
import { ReminderControl } from "./reminder-control";
import type { useNotes } from "./use-notes";

/** The parts of useNotes() the editor's properties use. */
export type ItemApi = ReturnType<typeof useNotes>;

/**
 * Kind chips (native radios, so arrow keys move between them). A refused
 * change (a project that still has linked items) shows why and changes
 * nothing.
 */
export function KindField({ note, api }: { note: Note; api: ItemApi }) {
  const id = useId();
  const [error, setError] = useState<LinkErrorCode | null>(null);
  const kind = itemKind(note);
  return (
    <>
      <span id={`${id}-label`}>Kind</span>
      <div className="property-control">
        <div className="kind-picker" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={error ? `${id}-error` : undefined}>
          {ITEM_KINDS.map((value) => (
            <label key={value} className={`kind-chip is-${value} ${kind === value ? "is-selected" : ""}`}>
              <input
                type="radio"
                name={`${id}-kind`}
                value={value}
                checked={kind === value}
                onChange={() => setError(api.setKind(note.id, value))}
              />
              <span>{KIND_LABELS[value]}</span>
            </label>
          ))}
        </div>
        {error && (
          <p className="property-error" id={`${id}-error`} role="alert">
            {error === "project_has_linked_items"
              ? "This project still has linked items. Move or unlink them before changing what it is."
              : LINK_ERROR_MESSAGES[error]}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * Project link with the inline check (linkErrorFor, before saving) and the
 * server's verdict (itemErrorFor, after) with a way to revert.
 */
export function ProjectField({ note, api }: { note: Note; api: ItemApi }) {
  const id = useId();
  const [error, setError] = useState<LinkErrorCode | null>(null);
  const serverError = api.itemErrorFor(note.id);
  const describedBy = [error && `${id}-error`, serverError && `${id}-server`].filter(Boolean).join(" ") || undefined;
  return (
    <>
      <label htmlFor={`${id}-input`}>Project</label>
      <div className="property-control">
        <ProjectPicker
          id={`${id}-input`}
          notes={api.notes}
          item={note}
          describedBy={describedBy}
          invalid={!!(error || serverError)}
          onSelect={(projectId) => setError(api.linkErrorFor(note.id, projectId) ?? api.setProject(note.id, projectId))}
        />
        {error && (
          <p className="property-error" id={`${id}-error`} role="alert">
            {LINK_ERROR_MESSAGES[error]} Nothing was changed.
          </p>
        )}
        {serverError && (
          <div className="property-error is-server" id={`${id}-server`} role="alert">
            <span>Orbit couldn’t save this change. {LINK_ERROR_MESSAGES[serverError.code]}</span>
            <button type="button" className="text-button" onClick={() => api.revertItemChange(note.id)}>
              Revert
            </button>
          </div>
        )}
      </div>
    </>
  );
}

const FOLLOWUP_FIELDS: FollowupField[] = ["waitingOn", "waitingFor", "nextCheckOn"];
const draftOf = (note: Note): Record<FollowupField, string> => ({
  waitingOn: note.waitingOn ?? "",
  waitingFor: note.waitingFor ?? "",
  nextCheckOn: note.nextCheckOn ?? "",
});
const normalized = (field: FollowupField, value: string) =>
  field === "nextCheckOn" ? value || null : (normalizeFollowupText(value) ?? null);

/**
 * Who and what an item waits on and when to check in. Shown for follow-ups,
 * the Waiting for bucket, or once any field has a value; otherwise behind a
 * small "add" button. Each field keeps what was typed and shows its own
 * error when setFollowup refuses it (nothing is saved for that field).
 */
export function FollowupFields({ note, api }: { note: Note; api: ItemApi }) {
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(note));
  const [errors, setErrors] = useState<Partial<Record<FollowupField, boolean>>>({});
  const [adding, setAdding] = useState(false);
  const hasValue = !!(note.waitingOn || note.waitingFor || note.nextCheckOn);
  const shown = adding || hasValue || itemKind(note) === "followup" || note.bucket === "waiting";

  // Adopt changes made elsewhere (Use theirs, a refresh) unless the field
  // holds a refused value the user is still fixing.
  const saved = draftOf(note);
  useEffect(() => {
    setDraft((current) => {
      let next = current;
      for (const field of FOLLOWUP_FIELDS) {
        if (errors[field]) continue;
        if (normalized(field, current[field]) !== (note[field] ?? null))
          next = { ...next, [field]: saved[field] };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.waitingOn, note.waitingFor, note.nextCheckOn]);

  function change(field: FollowupField, value: string) {
    setDraft((d) => ({ ...d, [field]: value }));
    const error = api.setFollowup(note.id, { [field]: value } as Partial<Followup>);
    setErrors((e) => ({ ...e, [field]: error?.field === field }));
  }

  if (!shown)
    return (
      <>
        <span>Follow-up</span>
        <div className="property-control">
          <button type="button" className="text-button property-add" onClick={() => setAdding(true)}>
            <Plus size={13} aria-hidden="true" /> Track who you’re waiting on
          </button>
        </div>
      </>
    );

  const state = followupState(note, localToday(defaultTimeZone()));
  const field = (name: "waitingOn" | "waitingFor", label: string, placeholder: string) => (
    <>
      <label htmlFor={`${id}-${name}`}>{label}</label>
      <div className="property-control">
        <input
          id={`${id}-${name}`}
          className="property-input"
          value={draft[name]}
          placeholder={placeholder}
          aria-invalid={errors[name] || undefined}
          aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
          onChange={(e) => change(name, e.target.value)}
        />
        {errors[name] && (
          <p className="property-error" id={`${id}-${name}-error`} role="alert">
            {FOLLOWUP_COPY[name]}
          </p>
        )}
      </div>
    </>
  );
  return (
    <>
      {field("waitingOn", "Waiting on", "Who is it with?")}
      {field("waitingFor", "Waiting for", "What are you expecting?")}
      <label htmlFor={`${id}-nextCheckOn`}>Next check</label>
      <div className="property-control">
        <div className="note-due-date">
          <input
            id={`${id}-nextCheckOn`}
            type="date"
            value={draft.nextCheckOn}
            aria-invalid={errors.nextCheckOn || undefined}
            aria-describedby={errors.nextCheckOn ? `${id}-nextCheckOn-error` : undefined}
            onChange={(e) => change("nextCheckOn", e.target.value)}
          />
          {draft.nextCheckOn && (
            <button type="button" className="icon-button" aria-label="Clear next check date" onClick={() => change("nextCheckOn", "")}>
              <X size={14} />
            </button>
          )}
          {state === "overdue" && <span className="followup-flag is-overdue">Overdue</span>}
          {state === "due" && <span className="followup-flag is-due">Check today</span>}
        </div>
        {errors.nextCheckOn && (
          <p className="property-error" id={`${id}-nextCheckOn-error`} role="alert">
            {FOLLOWUP_COPY.nextCheckOn}
          </p>
        )}
      </div>
    </>
  );
}

/** Reminder row (date, time, zone; snooze and cancel). */
export function ReminderField({ note, api }: { note: Note; api: ItemApi }) {
  const id = useId();
  return (
    <>
      <span id={`${id}-label`}>Reminder</span>
      <div className="property-control">
        <ReminderControl note={note} api={api} labelId={`${id}-label`} />
      </div>
    </>
  );
}

/** "Contains N items" for a project, each opening in the editor. */
export function ProjectContents({
  note,
  api,
  onOpenNote,
}: {
  note: Note;
  api: ItemApi;
  onOpenNote: (id: string) => void;
}) {
  const id = useId();
  if (itemKind(note) !== "project") return null;
  const children = [...api.childrenOf(note.id)].sort(
    (a, b) => Number(!!a.completedAt) - Number(!!b.completedAt) || a.title.localeCompare(b.title),
  );
  return (
    <section className="project-contents" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>
        <Layers size={14} aria-hidden="true" />
        {children.length === 0
          ? "No items in this project yet"
          : `Contains ${children.length} ${children.length === 1 ? "item" : "items"}`}
      </h3>
      {children.length === 0 ? (
        <p className="property-hint">Link tasks, notes or sub-projects to this project from their Project field.</p>
      ) : (
        <ul>
          {children.map((child) => {
            const bucket = BUCKETS.find((b) => b.id === child.bucket);
            return (
              <li key={child.id}>
                <button type="button" className={`project-child ${child.completedAt ? "is-complete" : ""}`} onClick={() => onOpenNote(child.id)}>
                  <span className={`kind-dot is-${itemKind(child)}`} aria-hidden="true" />
                  <strong>{child.title.trim() || "Untitled thought"}</strong>
                  <small>
                    {KIND_LABELS[itemKind(child)]}
                    {bucket && ` · ${bucket.name}`}
                    {child.completedAt && " · Done"}
                  </small>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * "Agent" row: the item's current assignment as a status chip (opens the
 * detail) and a Delegate action while nothing is active. Any kind can be
 * delegated. Dialogs stack above the editor.
 */
export function AssignmentField({
  note,
  api,
  onOpenNote,
  onOpenSettings,
  onOpenAgent,
}: {
  note: Note;
  api: ItemApi;
  onOpenNote: (id: string) => void;
  onOpenSettings?: () => void;
  onOpenAgent?: () => void;
}) {
  const id = useId();
  const { assignment, loaded, adopt, refresh } = useItemAssignment(note.workspaceId, note.id);
  const [delegating, setDelegating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const active = !!assignment && isActiveState(assignment.state);
  const canDelegate = !!note.workspaceId;
  return (
    <>
      <span id={`${id}-label`}>Agent</span>
      <div className="property-control">
        <div className="assignment-row" role="group" aria-labelledby={`${id}-label`}>
          {assignment && <AssignmentChip state={assignment.state} onOpen={() => setDetailId(assignment.id)} />}
          {!active && (
            <button
              type="button"
              className="text-button property-add delegate-button"
              aria-haspopup="dialog"
              disabled={!loaded || !canDelegate}
              onClick={() => setDelegating(true)}
            >
              <Sparkles size={13} aria-hidden="true" />
              {assignment ? "Delegate again" : "Delegate"}
            </button>
          )}
        </div>
        {!canDelegate && <p className="property-hint">Move this item into a space to delegate it.</p>}
      </div>
      {delegating && (
        <DelegateDialog
          note={note}
          notes={api.notes}
          onClose={() => setDelegating(false)}
          onCreated={(created) => {
            adopt(created);
            setDelegating(false);
            setDetailId(created.id);
          }}
          onOpenAssignment={(existing) => {
            setDelegating(false);
            setDetailId(existing);
          }}
          onOpenSettings={onOpenSettings}
          onOpenAgent={onOpenAgent}
        />
      )}
      {detailId && (
        <AssignmentDetailDialog
          key={detailId}
          assignmentId={detailId}
          notes={api.notes}
          onClose={() => {
            setDetailId(null);
            void refresh();
          }}
          onChange={adopt}
          onOpenNote={(target) => {
            setDetailId(null);
            if (target !== note.id) onOpenNote(target);
          }}
          onOpenAssignment={setDetailId}
          onOpenSettings={onOpenSettings}
          onOpenAgent={onOpenAgent}
        />
      )}
    </>
  );
}
