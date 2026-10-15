"use client";

import { AlertCircle, ChevronRight } from "lucide-react";
import type { AssignmentState } from "@/lib/assignments/transitions";
import { STATE_LABELS, errorCopy } from "@/lib/assignment-view";

/** A small dot + label for an assignment state. */
export function AssignmentStateBadge({ state }: { state: AssignmentState }) {
  return (
    <span className={`assignment-state is-${state}`}>
      <span className="assignment-state-dot" aria-hidden="true" />
      {STATE_LABELS[state]}
    </span>
  );
}

/** The editor's compact status chip; opens the assignment detail. */
export function AssignmentChip({
  state,
  onOpen,
}: {
  state: AssignmentState;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`assignment-chip is-${state}`}
      onClick={onOpen}
      aria-label={`Assignment: ${STATE_LABELS[state]}. Open details`}
      aria-haspopup="dialog"
    >
      <span className="assignment-state-dot" aria-hidden="true" />
      {STATE_LABELS[state]}
      <ChevronRight size={13} aria-hidden="true" />
    </button>
  );
}

/** Links an error message can offer. Missing handlers hide their link. */
export type ErrorNoticeActions = {
  onOpenSettings?: () => void;
  onOpenAgent?: () => void;
  onOpenExisting?: () => void;
  onRetry?: () => void;
};

/** Friendly copy for an assignment error code, with the next step. */
export function AssignmentErrorNotice({
  code,
  id,
  ...actions
}: { code: string; id?: string } & ErrorNoticeActions) {
  const copy = errorCopy(code);
  return (
    <div className="assignment-error" id={id} role="alert">
      <AlertCircle size={15} aria-hidden="true" />
      <div>
        <p>
          {copy.message}
          {copy.action === "settings" ? "." : ""}
        </p>
        {copy.action === "settings" && (
          <p className="assignment-error-links">
            {actions.onOpenSettings && (
              <a
                href="/settings"
                onClick={(e) => {
                  e.preventDefault();
                  actions.onOpenSettings?.();
                }}
              >
                Save a model key in Settings
              </a>
            )}
            {actions.onOpenAgent && (
              <button type="button" className="text-button" onClick={actions.onOpenAgent}>
                Turn on the agent for this space
              </button>
            )}
          </p>
        )}
        {copy.action === "existing" && actions.onOpenExisting && (
          <p className="assignment-error-links">
            <button type="button" className="text-button" onClick={actions.onOpenExisting}>
              Open the current assignment
            </button>
          </p>
        )}
        {copy.action === "reload" && (
          <p className="assignment-error-links">
            <button type="button" className="text-button" onClick={() => window.location.reload()}>
              Reload Orbit
            </button>
          </p>
        )}
        {copy.action === "retry" && actions.onRetry && (
          <p className="assignment-error-links">
            <button type="button" className="text-button" onClick={actions.onRetry}>
              Try again
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
