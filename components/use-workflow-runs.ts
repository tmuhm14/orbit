"use client";

import { useCallback, useEffect, useState } from "react";
import type { RunStatus, WorkflowRun } from "@/lib/workflows/runs";
import { sendWorkflow } from "./use-workflows";

export type RunFilters = {
  workspaceId: string;
  workflowId?: string | null;
  itemId?: string | null;
  status?: RunStatus | null;
};

function runsPath({ workspaceId, workflowId, itemId, status }: RunFilters, before?: string) {
  const query = new URLSearchParams({ workspaceId });
  if (workflowId) query.set("workflowId", workflowId);
  if (itemId) query.set("itemId", itemId);
  if (status) query.set("status", status);
  if (before) query.set("before", before);
  return `/api/workflow-runs?${query}`;
}

/** A space's run history, newest first, with filters and paging. */
export function useWorkflowRuns(filters: RunFilters, { enabled = true } = {}) {
  const { workspaceId, workflowId = null, itemId = null, status = null } = filters;
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const data = await sendWorkflow(runsPath({ workspaceId, workflowId, itemId, status }));
      setRuns(data.runs);
      setMore(data.more);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load runs");
      setRuns((current) => current ?? []);
    }
  }, [workspaceId, workflowId, itemId, status]);
  useEffect(() => {
    if (!enabled) return;
    setRuns(null);
    void load();
  }, [load, enabled]);
  const loadMore = useCallback(async () => {
    const last = runs?.at(-1);
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await sendWorkflow(runsPath({ workspaceId, workflowId, itemId, status }, last.startedAt));
      setRuns((current) => [...(current ?? []), ...data.runs]);
      setMore(data.more);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load runs");
    } finally {
      setLoadingMore(false);
    }
  }, [runs, loadingMore, workspaceId, workflowId, itemId, status]);
  return { runs, more, error, loadMore, loadingMore, reload: load };
}

/** One run with its steps; `missing` for unknown or deleted runs. */
export function useWorkflowRun(id: string) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  useEffect(() => {
    let live = true;
    setState("loading");
    sendWorkflow(`/api/workflow-runs/${encodeURIComponent(id)}`)
      .then((data) => {
        if (!live) return;
        setRun(data.run);
        setState("ready");
      })
      .catch((e) => {
        if (live) setState(e?.status === 404 ? "missing" : "error");
      });
    return () => {
      live = false;
    };
  }, [id]);
  return { run, state };
}
