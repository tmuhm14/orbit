"use client";

import { useCallback, useEffect, useState } from "react";
import type { Workflow, WorkflowDefinition } from "@/lib/workflows/model";

export class WorkflowRequestError extends Error {
  constructor(message: string, readonly status: number, readonly workflow?: Workflow) {
    super(message);
  }
}

export async function sendWorkflow(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new WorkflowRequestError(data.error || "Request failed", response.status, data.workflow);
  return data;
}

/** The current space's workflows, with create and delete. */
export function useWorkspaceWorkflows(workspaceId: string) {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const data = await sendWorkflow(`/api/workflows?workspaceId=${encodeURIComponent(workspaceId)}`);
      setWorkflows(data.workflows);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load workflows");
      setWorkflows((current) => current ?? []);
    }
  }, [workspaceId]);
  useEffect(() => {
    setWorkflows(null);
    void load();
  }, [load]);
  const create = useCallback(async (name: string, definition: WorkflowDefinition) => {
    const data = await sendWorkflow("/api/workflows", "POST", { workspaceId, name, definition });
    setWorkflows((current) => [data.workflow, ...(current ?? [])]);
    return data.workflow as Workflow;
  }, [workspaceId]);
  const remove = useCallback(async (id: string) => {
    await sendWorkflow(`/api/workflows/${encodeURIComponent(id)}`, "DELETE");
    setWorkflows((current) => current?.filter((w) => w.id !== id) ?? null);
  }, []);
  return { workflows, error, create, remove, reload: load };
}
