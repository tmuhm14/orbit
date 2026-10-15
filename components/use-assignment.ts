"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AssignmentApiError, assignmentsClient } from "@/lib/assignments/client";
import type { Assignment, AssignmentDetail, AssignmentListItem } from "@/lib/assignments/types";
import {
  currentAssignmentFor,
  detailPollDelay,
  itemPollDelay,
  refetchOn,
} from "@/lib/assignment-view";
import {
  HISTORY_PAGE,
  OPEN_STATES,
  homePollDelay,
  historyStates,
  mergeAssignment,
  nextHistoryLimit,
  pagePollDelay,
  parseAvailability,
  type Availability,
  type HistoryFilter,
} from "@/lib/agents-view";

/** One client for the page; same-origin cookie session. */
export const assignments = assignmentsClient();

export const errorCodeOf = (error: unknown) =>
  error instanceof AssignmentApiError ? error.code : "unexpected_response";

/** The existing document an `already_saved` error points at, if any. */
export function savedNoteIdOf(error: unknown): string | null {
  const noteId = error instanceof AssignmentApiError ? error.body?.noteId : undefined;
  return typeof noteId === "string" && noteId ? noteId : null;
}

/** Whether the tab is hidden; polling pauses while it is. */
export function useHidden() {
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
      // Narrowed to this item by the server; currentAssignmentFor still
      // filters, so a server that ignores sourceNoteId stays correct.
      const list = await assignments.list(workspaceId, { sourceNoteId: noteId, limit: 100 });
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

/** Calls `fn` whenever the tab becomes visible again. */
function useOnVisible(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === "visible") ref.current();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
}

/**
 * Whether delegation can go ahead in this space, so the delegate dialog and
 * the editor's Agent row can explain up front. Reloads when `key` changes
 * (the agent switch) and when the tab becomes visible. Null while unknown
 * or when the server can't say; callers then rely on the submit-time error.
 */
export function useAvailability(workspaceId: string, key?: unknown) {
  const [availability, setAvailability] = useState<Availability | null>(null);
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
      // Read defensively: anything unexpected is "unknown", not "available".
      const next = parseAvailability(await assignments.availability(workspaceId));
      if (alive.current) setAvailability(next);
    } catch {
      if (alive.current) setAvailability(null);
    }
  }, [workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh, key]);
  useOnVisible(() => void refresh());
  return { availability, refresh };
}

/**
 * The Agents page's data for one space: open work (needs you, in progress)
 * in one request and history (filtered, limited with "Show more") in
 * another. Polls only while something is queued or running and the tab is
 * visible; reloads when `version` changes (a detail dialog changed
 * something) and when the tab becomes visible.
 */
export function useWorkspaceAssignments(workspaceId: string, version = 0) {
  const [open, setOpen] = useState<AssignmentListItem[]>([]);
  const [past, setPast] = useState<AssignmentListItem[]>([]);
  const [filter, setFilterState] = useState<HistoryFilter>("all");
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [tick, setTick] = useState(0);
  const [space, setSpace] = useState(workspaceId);
  const hidden = useHidden();
  const alive = useRef(true);
  const seq = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A different space starts over (adjusting state while rendering).
  if (space !== workspaceId) {
    setSpace(workspaceId);
    setOpen([]);
    setPast([]);
    setLimit(HISTORY_PAGE);
    setFilterState("all");
    setErrorCode(null);
  }

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const mine = ++seq.current;
    try {
      const [nextOpen, nextPast] = await Promise.all([
        assignments.list(workspaceId, { states: [...OPEN_STATES], limit: 100 }),
        assignments.list(workspaceId, { states: historyStates(filter), limit }),
      ]);
      // A newer request (another space, filter or limit) wins.
      if (!alive.current || mine !== seq.current) return;
      setOpen(nextOpen);
      setPast(nextPast);
      setErrorCode(null);
      setFailures(0);
      setLoadedFor(workspaceId);
    } catch (error) {
      if (!alive.current || mine !== seq.current) return;
      setErrorCode(errorCodeOf(error));
      setFailures((f) => f + 1);
    } finally {
      if (alive.current) setTick((t) => t + 1);
    }
  }, [workspaceId, filter, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);
  useOnVisible(() => void refresh());

  const delay = pagePollDelay(open, { hidden, failures });
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [delay, tick, refresh]);

  /** A fresher copy from the detail dialog, into whichever list holds it now. */
  const adopt = useCallback((fresh: Assignment) => {
    const isOpen = OPEN_STATES.includes(fresh.state);
    // Detail copies have no savedNoteId; keep the row's (open rows have none).
    const next: AssignmentListItem = { savedNoteId: null, ...fresh };
    setOpen((list) => (isOpen ? mergeAssignment(list, next) : list.filter((a) => a.id !== next.id)));
    setPast((list) => (isOpen ? list.filter((a) => a.id !== next.id) : list));
  }, []);

  const more = nextHistoryLimit(limit);
  const setFilter = useCallback((next: HistoryFilter) => {
    setFilterState(next);
    setLimit(HISTORY_PAGE);
  }, []);
  return {
    open,
    history: past,
    filter,
    setFilter,
    /** The route may have more history than shown. */
    hasMore: past.length >= limit && more !== null,
    /** At the route's cap: say so rather than pretend there's nothing older. */
    capped: past.length >= limit && more === null,
    showMore: () => {
      if (more !== null) setLimit(more);
    },
    loaded: loadedFor === workspaceId,
    errorCode,
    refresh,
    adopt,
  };
}

/**
 * Open assignments for Home's agent line. Checks every 30 s while the tab is
 * visible (work can arrive from another device), on return to the tab and
 * when `version` changes. Errors keep the last good copy; nothing is invented.
 */
export function useOpenAssignments(workspaceId: string, version = 0) {
  const [result, setResult] = useState<{ workspaceId: string; list: AssignmentListItem[] } | null>(null);
  const [tick, setTick] = useState(0);
  const hidden = useHidden();
  const alive = useRef(true);
  const seq = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const mine = ++seq.current;
    try {
      const list = await assignments.list(workspaceId, { states: [...OPEN_STATES], limit: 100 });
      if (alive.current && mine === seq.current) setResult({ workspaceId, list });
    } catch {
      /* Keep what was shown; the next check retries. */
    } finally {
      if (alive.current) setTick((t) => t + 1);
    }
  }, [workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh, version]);
  useOnVisible(() => void refresh());
  const delay = homePollDelay({ hidden });
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [delay, tick, refresh]);
  // Another space's copy never shows here.
  return result?.workspaceId === workspaceId ? result.list : null;
}
