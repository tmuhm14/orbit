"use client";

import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";
import { useModalDialog } from "./use-modal-dialog";

/**
 * useModalDialog's key handler, plus: workspace shortcuts (⌘K search, ⌘J
 * capture) wait while this surface is open, so they can't navigate away from
 * unsaved edits. Copy and paste still work; only propagation stops.
 */
function useSurfaceKeys(ref: Parameters<typeof useModalDialog>[0], onClose: () => void) {
  const onKeyDown = useModalDialog(ref, onClose);
  return (event: KeyboardEvent<HTMLElement>) => {
    onKeyDown(event);
    if (event.metaKey || event.ctrlKey) event.stopPropagation();
  };
}

/**
 * One focused editing surface: a right-side slide-out panel (`SidePanel`) for
 * longer or multi-step forms, or a centered modal (`FormDialog`) for short
 * ones. Both are labelled by their title, trap focus (useModalDialog), close
 * on Escape, the close button, Cancel or a backdrop click, and return focus to
 * the trigger. With `dirty`, closing asks "Discard changes?" first. While
 * `busy`, closing waits. Mount it only while open.
 */
export type SurfaceProps = {
  title: string;
  /** Short line under the title. */
  description?: ReactNode;
  children: ReactNode;
  /** Called once closing is allowed (not dirty, or the user chose Discard). */
  onClose: () => void;
  /** Unsaved edits: closing asks before discarding them. */
  dirty?: boolean;
  /** A save is in flight: buttons disable and closing waits. */
  busy?: boolean;
  /** Shown inline above the footer, announced with role="alert". */
  error?: string;
  /** Makes the surface a form; the primary button submits it. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel?: string;
  busyLabel?: string;
  submitDisabled?: boolean;
  cancelLabel?: string;
  /** Secondary actions on the footer's left (for example "Remove key"). */
  extraActions?: ReactNode;
  /** Replaces the whole footer (for example a one-time key reveal). */
  footer?: ReactNode;
  /** The discard prompt's title, body and confirm label. */
  discardTitle?: string;
  discardMessage?: string;
  discardLabel?: string;
};

function Surface({ variant, ...props }: SurfaceProps & { variant: "panel" | "dialog" }) {
  const {
    title, description, children, onClose, dirty = false, busy = false, error, onSubmit,
    submitLabel = "Save", busyLabel = "Saving…", submitDisabled, cancelLabel = "Cancel",
    extraActions, footer, discardTitle = "Discard changes?", discardMessage, discardLabel = "Discard",
  } = props;
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setAsking(true);
    else onClose();
  };
  const onKeyDown = useSurfaceKeys(ref, requestClose);
  const body = (
    <>
      <div className={`${variant === "panel" ? "side-panel" : "settings-dialog"}-body`}>{children}</div>
      {error && <p className="settings-error surface-error" role="alert">{error}</p>}
      {footer ?? (
        <footer className="surface-footer">
          <div className="surface-footer-extra">{extraActions}</div>
          <div className="surface-footer-main">
            <button type="button" className="text-button" disabled={busy} onClick={requestClose}>{cancelLabel}</button>
            {onSubmit && (
              <button type="submit" className="primary-button small" disabled={busy || submitDisabled}>
                {busy ? busyLabel : submitLabel}
              </button>
            )}
          </div>
        </footer>
      )}
    </>
  );
  return createPortal(
    <div
      className={`modal-backdrop ${variant === "panel" ? "side-panel-backdrop" : "settings-dialog-backdrop"}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}
    >
      <div
        ref={ref}
        className={variant === "panel" ? "side-panel" : "settings-dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
      >
        <header className="surface-header">
          <div>
            <h2 id={`${id}-title`}>{title}</h2>
            {description && <p id={`${id}-description`}>{description}</p>}
          </div>
          <button type="button" className="icon-button surface-close" aria-label="Close" disabled={busy} onClick={requestClose}>
            <X size={18} />
          </button>
        </header>
        {onSubmit ? <form className="surface-form" onSubmit={onSubmit} noValidate={false}>{body}</form> : <div className="surface-form">{body}</div>}
        {asking && (
          <ConfirmDialog
            tone="danger"
            title={discardTitle}
            body={discardMessage ?? `Your changes in “${title}” haven’t been saved.`}
            confirmLabel={discardLabel}
            cancelLabel="Keep editing"
            onConfirm={onClose}
            onCancel={() => setAsking(false)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Right-side slide-out panel; a full-screen sheet at 600px and below. */
export function SidePanel(props: SurfaceProps) {
  return <Surface variant="panel" {...props} />;
}

/** Centered modal for a short form. */
export function FormDialog(props: SurfaceProps) {
  return <Surface variant="dialog" {...props} />;
}

/**
 * "Revoke ‘Grok bot’?" A confirm step that names the thing. Focus starts on
 * Cancel; Escape cancels. `onConfirm` may be async: a failure shows inline
 * and keeps the dialog open.
 */
export function ConfirmDialog({
  title, body, hint, confirmLabel, cancelLabel = "Cancel", tone = "default", onConfirm, onCancel,
}: {
  title: string;
  body: ReactNode;
  hint?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  onConfirm: () => unknown;
  onCancel: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = () => { if (!busy) onCancel(); };
  const onKeyDown = useSurfaceKeys(ref, cancel);
  async function confirm() {
    setBusy(true); setError("");
    try {
      await onConfirm();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn’t work. Try again.");
      setBusy(false);
    }
  }
  return createPortal(
    <div className="modal-backdrop confirm-backdrop settings-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <div
        ref={ref}
        className={`confirm-dialog settings-confirm is-${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        onKeyDown={onKeyDown}
      >
        <span className="confirm-icon" aria-hidden="true"><AlertTriangle size={18} /></span>
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-body`}>{body}</p>
        {hint && <p className="confirm-hint">{hint}</p>}
        {error && <p className="settings-error" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="secondary-button" data-autofocus disabled={busy} onClick={cancel}>{cancelLabel}</button>
          <button type="button" className={tone === "danger" ? "danger-button" : "primary-button small"} disabled={busy} onClick={() => void confirm()}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
