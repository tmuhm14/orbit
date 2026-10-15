"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, LoaderCircle, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { itemKind, type Note } from "@/lib/notes";
import { AssignmentApiError } from "@/lib/assignments/client";
import type { Assignment } from "@/lib/assignments/types";
import { MAX_CONTEXT_ITEMS, OUTCOME_MAX } from "@/lib/assignments/transitions";
import { KIND_LABELS } from "@/lib/item-properties";
import { contextOptions, itemTitle, outcomeStatus, toggleContext } from "@/lib/assignment-view";
import { availabilityCopy, type Availability } from "@/lib/agents-view";
import { AgentAvailabilityNotice, AssignmentErrorNotice, type ErrorNoticeActions } from "./assignment-status";
import { assignments, errorCodeOf } from "./use-assignment";
import { useModalDialog } from "./use-modal-dialog";

/**
 * Searchable multi-select for context items (ARIA 1.2 combobox with a
 * multi-selectable listbox). Enter or a click toggles the active option;
 * Escape closes the list without closing the dialog.
 */
function ContextPicker({
  id,
  notes,
  source,
  selected,
  onChange,
  describedBy,
}: {
  id: string;
  notes: Note[];
  source: Note;
  selected: string[];
  onChange: (ids: string[]) => void;
  describedBy: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [refused, setRefused] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = `${id}-list`;
  const options = useMemo(() => contextOptions(notes, source, query), [notes, source, query]);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const full = selected.length >= MAX_CONTEXT_ITEMS;

  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function toggle(optionId: string) {
    const next = toggleContext(selected, optionId);
    setRefused(next.refused);
    if (!next.refused) onChange(next.selected);
  }

  return (
    <div className={`project-picker context-picker ${open ? "is-open" : ""}`}>
      <div className="project-picker-field">
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && options.length ? `${listId}-${activeIndex}` : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Search items in this space…"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setOpen(true);
            setQuery(e.target.value);
            setActive(0);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!open) return setOpen(true);
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((activeIndex + step + options.length) % (options.length || 1));
            } else if (e.key === "Home" && open) {
              e.preventDefault();
              setActive(0);
            } else if (e.key === "End" && open) {
              e.preventDefault();
              setActive(Math.max(0, options.length - 1));
            } else if (e.key === "Enter") {
              // Never submit the form from the search box.
              e.preventDefault();
              if (open && options[activeIndex]) toggle(options[activeIndex].id);
              else setOpen(true);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          className="project-picker-toggle"
          aria-label={open ? "Close item list" : "Show items"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setOpen(!open);
            document.getElementById(id)?.focus();
          }}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-multiselectable="true"
        aria-label="Items in this space"
        className="project-picker-list"
        hidden={!open}
      >
        {options.length ? (
          options.map((option, index) => {
            const chosen = selected.includes(option.id);
            return (
              <li
                key={option.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={chosen}
                aria-disabled={!chosen && full ? true : undefined}
                className={`project-option ${index === activeIndex ? "is-active" : ""} ${!chosen && full ? "is-refused" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => index !== activeIndex && setActive(index)}
                onClick={() => toggle(option.id)}
              >
                <span className="project-option-check" aria-hidden="true">
                  {chosen && <Check size={13} />}
                </span>
                <span className="project-option-text">
                  <strong>{option.title}</strong>
                  <small>
                    {KIND_LABELS[option.kind]}
                    {option.done && " · Done"}
                  </small>
                </span>
              </li>
            );
          })
        ) : (
          <li className="project-option-empty" role="presentation">
            {query.trim() ? `Nothing in this space matches “${query.trim()}”.` : "No other items in this space yet."}
          </li>
        )}
      </ul>
      {refused && full && (
        <p className="property-error" role="alert">
          That’s the limit of {MAX_CONTEXT_ITEMS}. Remove one to add another.
        </p>
      )}
    </div>
  );
}

/**
 * "Delegate" panel: the requested outcome (required, up to the API limit),
 * up to 20 context items from the same space, a plain note about what is
 * shared, and every create error as friendly copy.
 */
export function DelegateDialog({
  note,
  notes,
  onClose,
  onCreated,
  onOpenAssignment,
  onOpenSettings,
  onOpenAgent,
  availability = null,
}: {
  note: Note;
  notes: Note[];
  /** From useAvailability; explains up front when delegation can't go ahead. */
  availability?: Availability | null;
  onClose: () => void;
  onCreated: (assignment: Assignment) => void;
  onOpenAssignment: (id: string) => void;
} & Pick<ErrorNoticeActions, "onOpenSettings" | "onOpenAgent">) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useModalDialog(ref, onClose);
  const [outcome, setOutcome] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<{ code: string; existingId?: string } | null>(null);
  const status = outcomeStatus(outcome);
  const title = itemTitle(note);
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const showOutcomeError = touched && !status.valid;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!status.valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const assignment = await assignments.create({
        workspaceId: note.workspaceId,
        sourceNoteId: note.id,
        requestedOutcome: outcome.trim(),
        contextNoteIds: selected,
      });
      onCreated(assignment);
    } catch (failure) {
      const code = errorCodeOf(failure);
      const existingId =
        failure instanceof AssignmentApiError ? failure.body?.assignmentId : undefined;
      setError({ code, existingId });
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={ref}
        className="assignment-dialog delegate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-intro${availabilityCopy(availability) && !error ? ` ${id}-availability` : ""}`}
        onKeyDown={onKeyDown}
      >
        <header className="assignment-dialog-head">
          <span className="assignment-orbit" aria-hidden="true">
            <Sparkles size={16} />
          </span>
          <div>
            <h2 id={`${id}-title`}>Delegate this {KIND_LABELS[itemKind(note)].toLowerCase()}</h2>
            <p id={`${id}-intro`}>
              Hand “{title}” to your agent. It works from what you write here and the items you pick, then
              checks back with you.
            </p>
          </div>
          <button type="button" className="icon-button assignment-close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <form className="assignment-dialog-body" onSubmit={submit} noValidate>
          {/* Up front; the submit-time error below still covers a stale answer. */}
          {!error && (
            <AgentAvailabilityNotice
              availability={availability}
              id={`${id}-availability`}
              onOpenSettings={onOpenSettings}
              onOpenAgent={onOpenAgent}
            />
          )}
          <div className="assignment-field">
            <label htmlFor={`${id}-outcome`}>
              What should come back? <span className="assignment-required">Required</span>
            </label>
            <textarea
              id={`${id}-outcome`}
              data-autofocus
              rows={4}
              value={outcome}
              maxLength={OUTCOME_MAX + 200}
              required
              aria-required="true"
              aria-invalid={showOutcomeError || undefined}
              aria-describedby={`${id}-outcome-count${showOutcomeError ? ` ${id}-outcome-error` : ""}`}
              placeholder="For example: a short, friendly reply to the vendor that confirms Tuesday"
              onChange={(e) => setOutcome(e.target.value)}
              onBlur={() => outcome && setTouched(true)}
            />
            <div className="assignment-field-foot">
              {showOutcomeError ? (
                <p className="property-error" id={`${id}-outcome-error`}>
                  {status.tooLong
                    ? `Keep it under ${OUTCOME_MAX.toLocaleString()} characters.`
                    : "Describe the outcome you want back."}
                </p>
              ) : (
                <span />
              )}
              <small id={`${id}-outcome-count`} className={status.tooLong ? "is-over" : ""}>
                {status.length.toLocaleString()} / {OUTCOME_MAX.toLocaleString()} characters
              </small>
            </div>
          </div>

          <div className="assignment-field">
            <div className="assignment-field-label">
              <label htmlFor={`${id}-context`}>Context to share</label>
              <span className="assignment-count" id={`${id}-context-count`} aria-live="polite">
                {selected.length} of {MAX_CONTEXT_ITEMS} selected
              </span>
            </div>
            <ContextPicker
              id={`${id}-context`}
              notes={notes}
              source={note}
              selected={selected}
              onChange={setSelected}
              describedBy={`${id}-context-count ${id}-privacy`}
            />
            {selected.length > 0 && (
              <ul className="context-selected" aria-label="Selected context">
                {selected.map((noteId) => {
                  const item = byId.get(noteId);
                  const name = itemTitle(item);
                  return (
                    <li key={noteId}>
                      <span>{name}</span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${name} from context`}
                        onClick={() => setSelected(selected.filter((x) => x !== noteId))}
                      >
                        <X size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <p className="assignment-privacy" id={`${id}-privacy`}>
            <ShieldCheck size={15} aria-hidden="true" />
            <span>
              The text of this item and of each item you select is sent to your own model provider, with
              the key you saved in Settings. Nothing else in this space is shared, and the agent treats that
              text as information, not instructions.
            </span>
          </p>

          {error && (
            <AssignmentErrorNotice
              code={error.code}
              onOpenSettings={onOpenSettings}
              onOpenAgent={onOpenAgent}
              onOpenExisting={error.existingId ? () => onOpenAssignment(error.existingId!) : undefined}
            />
          )}

          <div className="assignment-dialog-actions">
            <button type="button" className="text-button" onClick={onClose}>
              Not now
            </button>
            <button type="submit" className="primary-button" disabled={busy} aria-disabled={!status.valid || undefined}>
              {busy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
              {busy ? "Delegating…" : "Delegate"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
