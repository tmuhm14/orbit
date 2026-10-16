"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssignmentListItem } from "@/lib/assignments/types";
import { currentAssignmentFor } from "@/lib/assignment-view";
import { OPEN_STATES } from "@/lib/agents-view";
import { assignments } from "./use-assignment";

/** Bounded: the route's cap, once for open work and once for the newest overall. */
const INDEX_LIMIT = 100;

/**
 * The space's recent assignments by source item, for chips on Tasks rows,
 * the project tree and project detail. Two bounded list calls (every open
 * assignment up to the cap, plus the newest of any state) instead of one
 * per row. Reloads when `version` changes (a detail dialog reported a
 * change) and when the tab becomes visible; errors keep the last copy and
 * nothing is invented.
 */
export function useAssignmentIndex(workspaceId: string, version = 0) {
  const [result, setResult] = useState<{ workspaceId: string; list: AssignmentListItem[] } | null>(null);
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
      const [open, recent] = await Promise.all([
        assignments.list(workspaceId, { states: [...OPEN_STATES], limit: INDEX_LIMIT }),
        assignments.list(workspaceId, { limit: INDEX_LIMIT }),
      ]);
      if (!alive.current || mine !== seq.current) return;
      const byId = new Map<string, AssignmentListItem>();
      for (const a of [...open, ...recent]) if (!byId.has(a.id)) byId.set(a.id, a);
      const list = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setResult({ workspaceId, list });
    } catch {
      /* Keep what was shown; the next change or visit retries. */
    }
  }, [workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh, version]);
  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [refresh]);
  const list = result?.workspaceId === workspaceId ? result.list : null;
  return useMemo(() => {
    const cache = new Map<string, AssignmentListItem | null>();
    return {
      /** Null until the first load for this space. */
      list,
      /** The item's current assignment (its active one, else its newest). */
      forNote(noteId: string): AssignmentListItem | null {
        if (!list) return null;
        if (!cache.has(noteId))
          cache.set(noteId, currentAssignmentFor(list, noteId) as AssignmentListItem | null);
        return cache.get(noteId) ?? null;
      },
    };
  }, [list]);
}
