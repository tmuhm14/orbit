"use client";

import { AlertCircle, ChevronRight, Info } from "lucide-react";
import type { AssignmentState } from "@/lib/assignments/transitions";
import { STATE_LABELS, errorCopy } from "@/lib/assignment-view";
import { availabilityCopy, type Availability } from "@/lib/agents-view";

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
                href="/settings/model"
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

/**
 * Up-front "Turn on the agent…" note when delegation can't go ahead in this
 * space (agent off, no model key, unreadable key), with the same links as
 * the submit-time error. Renders nothing while availability is unknown.
 */
export function AgentAvailabilityNotice({
  availability,
  id,
  compact = false,
  onOpenSettings,
  onOpenAgent,
}: {
  availability: Availability | null;
  id?: string;
  compact?: boolean;
} & Pick<ErrorNoticeActions, "onOpenSettings" | "onOpenAgent">) {
  const copy = availabilityCopy(availability);
  if (!copy) return null;
  return (
    <div className={`agent-availability ${compact ? "is-compact" : ""}`} id={id}>
      <Info size={14} aria-hidden="true" />
      <div>
        <p>{copy.message}</p>
        {((copy.settings && onOpenSettings) || (copy.agent && onOpenAgent)) && (
          <p className="assignment-error-links">
            {copy.settings && onOpenSettings && (
              <a
                href="/settings/model"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenSettings();
                }}
              >
                Save a model key in Settings
              </a>
            )}
            {copy.agent && onOpenAgent && (
              <button type="button" className="text-button" onClick={onOpenAgent}>
                Turn on the agent for this space
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
