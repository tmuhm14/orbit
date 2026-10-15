"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AssignmentApiError, assignmentsClient } from "@/lib/assignments/client";
import type { Assignment, AssignmentDetail } from "@/lib/assignments/types";
import {
  currentAssignmentFor,
  detailPollDelay,
  itemPollDelay,
  refetchOn,
} from "@/lib/assignment-view";

/** One client for the page; same-origin cookie session. */
export const assignments = assignmentsClient();

export const errorCodeOf = (error: unknown) =>
  error instanceof AssignmentApiError ? error.code : "unexpected_response";

/** Whether the tab is hidden; polling pauses while it is. */
function useHidden() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return hidden;
}

/**
 * The item's current assignment (its active one, else its newest) for the
 * editor's status chip. Loads on open and refreshes slowly while the agent
 * is moving; the detail dialog pushes fresher copies through `adopt`.
 */
export function useItemAssignment(workspaceId: string, noteId: string) {
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const hidden = useHidden();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      // TODO(client): filter by source item once the list route supports it.
      const list = await assignments.list(workspaceId, { limit: 100 });
      if (!alive.current) return;
      setAssignment(currentAssignmentFor(list, noteId));
      setErrorCode(null);
    } catch (error) {
      if (alive.current) setErrorCode(errorCodeOf(error));
    } finally {
      if (alive.current) {
        setLoaded(true);
        setTick((t) => t + 1);
      }
    }
  }, [workspaceId, noteId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const delay = itemPollDelay(assignment?.state ?? null, { hidden });
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [delay, tick, refresh]);

  const adopt = useCallback(
    (next: Assignment) => {
      if (next.sourceNoteId === noteId) setAssignment(next);
    },
    [noteId],
  );
  return { assignment, loaded, errorCode, refresh, adopt };
}

export type ActionError = { code: string; existingId?: string };

export type AssignmentAction =
  | { kind: "cancel" }
  | { kind: "retry" }
  | { kind: "answer"; questionId: string; answer: string }
  | { kind: "review"; artifactId: string; decision: "accept" | "request_changes" | "reject"; comment?: string };

/**
 * One assignment's detail while its dialog is open: polls every 2s while
 * queued or running (backing off after failed loads, pausing in a hidden
 * tab), stops in every other state and when the dialog closes (unmount).
 * Mutations send the revision on screen; a stale one reloads the latest.
 */
export function useAssignmentDetail(id: string, onChange?: (assignment: Assignment) => void) {
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<AssignmentAction["kind"] | null>(null);
  const hidden = useHidden();
  const alive = useRef(true);
  const loading = useRef(false);
  const again = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    // One request at a time; a load asked for meanwhile runs right after.
    if (loading.current) {
      again.current = true;
      return;
    }
    loading.current = true;
    try {
      const next = await assignments.get(id);
      if (!alive.current) return;
      setDetail(next);
      setLoadErrorCode(null);
      setFailures(0);
      onChangeRef.current?.(next.assignment);
    } catch (error) {
      if (!alive.current) return;
      setLoadErrorCode(errorCodeOf(error));
      setFailures((f) => f + 1);
    } finally {
      loading.current = false;
      if (alive.current) setTick((t) => t + 1);
    }
    if (again.current && alive.current) {
      again.current = false;
      return load();
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const state = detail?.assignment.state ?? null;
  const delay = detailPollDelay(state, { hidden, failures });
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [delay, tick, load]);

  /** Runs an action; returns the error (code, existing assignment) or null when it worked. */
  const act = useCallback(
    async (action: AssignmentAction): Promise<ActionError | null> => {
      if (!detail) return { code: "load_failed" };
      const revision = detail.assignment.revision;
      setBusy(action.kind);
      try {
        const next =
          action.kind === "cancel"
            ? await assignments.cancel(id, revision)
            : action.kind === "retry"
              ? await assignments.retry(id, revision)
              : action.kind === "answer"
                ? await assignments.answer(id, revision, action.questionId, action.answer)
                : (await assignments.review(id, revision, action.artifactId, action.decision, action.comment))
                    .assignment;
        if (alive.current) {
          setDetail((d) => (d ? { ...d, assignment: next } : d));
          onChangeRef.current?.(next);
        }
        await load();
        return null;
      } catch (error) {
        const code = errorCodeOf(error);
        if (refetchOn(code)) await load();
        const existingId = error instanceof AssignmentApiError ? error.body?.assignmentId : undefined;
        return existingId ? { code, existingId } : { code };
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [detail, id, load],
  );

  return { detail, loadErrorCode, busy, act, reload: load };
}

/** A clock for relative times, ticking only while something is moving. */
export function useNow(enabled: boolean, intervalMs = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}
