// Workflow run history: rows of public.workflow_runs and workflow_run_items ↔
// the API's WorkflowRun shape, request parsing for /api/workflow-runs, and the
// record a finished engine run becomes. Pure: no React, no Next, no database.
//
// A run keeps step metadata only (which step, its status, the port it took
// and when): never step output, prompts or item content.
import { isNodeKind, LABEL_MAX, type NodeKind, type WorkflowDefinition } from "./model.ts";
import type { RunOutcome, StepStatus } from "./engine.ts";
import { isUuid } from "./db.ts";

export const RUN_STATUSES = ["running", "completed", "failed", "canceled", "invalid"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const isRunStatus = (value: unknown): value is RunStatus =>
  typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
/** Statuses a recorded run can finish with. */
export const FINAL_STATUSES = ["completed", "failed", "canceled", "invalid"] as const;
export type FinalStatus = (typeof FINAL_STATUSES)[number];

export const RUN_MODES = ["test", "live"] as const;
export type RunMode = (typeof RUN_MODES)[number];
export const RUN_TRIGGERS = ["manual", "item_captured"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export const RUN_ITEM_ROLES = ["source", "created", "updated"] as const;
export type RunItemRole = (typeof RUN_ITEM_ROLES)[number];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  canceled: "Stopped",
  invalid: "Invalid",
};

/** One page of history. */
export const RUN_PAGE_SIZE = 50;
export const MAX_RUN_STEPS = 200;
/** Recorded runs must have started within this window (client clocks drift). */
export const RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type RunStep = {
  nodeId: string;
  kind: NodeKind;
  label: string;
  status: StepStatus;
  port: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type RunItem = { itemId: string; role: RunItemRole };

/** A run as the API returns it. `steps` is present on the detail only. */
export type WorkflowRun = {
  id: string;
  workspaceId: string;
  /** Null once the workflow is deleted; the name is a snapshot. */
  workflowId: string | null;
  workflowName: string;
  workflowRevision: number;
  mode: RunMode;
  trigger: RunTrigger;
  status: RunStatus;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
  items: RunItem[];
  steps?: RunStep[];
};

export const RUN_COLUMNS =
  "id,workspace_id,workflow_id,workflow_name,workflow_revision,mode,trigger,status,error_code,started_at,finished_at,workflow_run_items(item_id,role)";
export const RUN_DETAIL_COLUMNS = `${RUN_COLUMNS},steps`;

export type RunRow = {
  id: string;
  workspace_id: string;
  workflow_id: string | null;
  workflow_name: string;
  workflow_revision: number;
  mode: RunMode;
  trigger: RunTrigger;
  status: RunStatus;
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
  workflow_run_items?: { item_id: string; role: RunItemRole }[] | null;
  steps?: unknown;
};

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PORT = /^[a-z_]{1,32}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const STEP_STATUSES: readonly StepStatus[] = ["running", "succeeded", "failed"];

/** Stored steps that don't parse are dropped, not fatal. */
function stepsFromRow(value: unknown): RunStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const step = parseStoredStep(raw);
    return step ? [step] : [];
  });
}

function parseStoredStep(raw: unknown): RunStep | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.nodeId !== "string" || !isNodeKind(s.kind) || typeof s.label !== "string" ||
      !STEP_STATUSES.includes(s.status as StepStatus) || typeof s.startedAt !== "string") return null;
  return {
    nodeId: s.nodeId,
    kind: s.kind,
    label: s.label,
    status: s.status as StepStatus,
    port: typeof s.port === "string" ? s.port : null,
    startedAt: s.startedAt,
    finishedAt: typeof s.finishedAt === "string" ? s.finishedAt : null,
  };
}

export function runFromRow(row: RunRow): WorkflowRun {
  const run: WorkflowRun = {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    workflowRevision: row.workflow_revision,
    mode: row.mode,
    trigger: row.trigger,
    status: row.status,
    errorCode: row.error_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    items: (row.workflow_run_items ?? []).map((i) => ({ itemId: i.item_id, role: i.role })),
  };
  if (row.steps !== undefined) run.steps = stepsFromRow(row.steps);
  return run;
}

// --- Requests ------------------------------------------------------------------

export type RunQuery = {
  workspaceId: string;
  workflowId: string | null;
  itemId: string | null;
  status: RunStatus | null;
  /** ISO start time: runs that started before it (the next page). */
  before: string | null;
};

/** GET /api/workflow-runs: a workspace is required; filters are optional. */
export function parseRunQuery(params: URLSearchParams): RunQuery | null {
  const workspaceId = params.get("workspaceId");
  if (!isUuid(workspaceId)) return null;
  const workflowId = params.get("workflowId");
  const itemId = params.get("itemId");
  const status = params.get("status");
  const before = params.get("before");
  if ((workflowId && !isUuid(workflowId)) || (itemId && !isUuid(itemId)) || (status && !isRunStatus(status))) return null;
  if (before && Number.isNaN(Date.parse(before))) return null;
  return {
    workspaceId,
    workflowId: workflowId || null,
    itemId: itemId || null,
    status: (status as RunStatus) || null,
    before: before ? new Date(before).toISOString() : null,
  };
}

export type RecordInput = {
  workflowId: string;
  status: FinalStatus;
  errorCode: string | null;
  startedAt: number;
  finishedAt: number;
  steps: RunStep[];
  sourceItemId: string | null;
};

const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);

function parseInputStep(raw: unknown): RunStep | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const startedAt = time(s.startedAt);
  const finishedAt = s.finishedAt === null ? null : time(s.finishedAt);
  if (typeof s.nodeId !== "string" || !NODE_ID.test(s.nodeId) || !isNodeKind(s.kind) ||
      typeof s.label !== "string" || s.label.length > LABEL_MAX ||
      !STEP_STATUSES.includes(s.status as StepStatus) ||
      !(s.port === null || (typeof s.port === "string" && PORT.test(s.port))) ||
      startedAt === null || (s.finishedAt !== null && finishedAt === null) ||
      (finishedAt !== null && finishedAt < startedAt)) return null;
  return {
    nodeId: s.nodeId,
    kind: s.kind,
    label: s.label,
    status: s.status as StepStatus,
    port: s.port as string | null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: finishedAt === null ? null : new Date(finishedAt).toISOString(),
  };
}

/**
 * POST /api/workflow-runs: a finished test run. Times are epoch milliseconds
 * from the client, checked for order and a plausible window around `now`.
 */
export function parseRecord(value: unknown, now = Date.now()): RecordInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const startedAt = time(input.startedAt);
  const finishedAt = time(input.finishedAt);
  if (!isUuid(input.workflowId) || !(FINAL_STATUSES as readonly string[]).includes(input.status as string)) return null;
  if (!(input.errorCode === null || input.errorCode === undefined ||
        (typeof input.errorCode === "string" && ERROR_CODE.test(input.errorCode)))) return null;
  if (startedAt === null || finishedAt === null || finishedAt < startedAt) return null;
  if (startedAt < now - RUN_MAX_AGE_MS || finishedAt > now + CLOCK_SKEW_MS) return null;
  if (!(input.sourceItemId === null || input.sourceItemId === undefined || isUuid(input.sourceItemId))) return null;
  if (!Array.isArray(input.steps) || input.steps.length > MAX_RUN_STEPS) return null;
  const steps: RunStep[] = [];
  for (const raw of input.steps) {
    const step = parseInputStep(raw);
    if (!step) return null;
    steps.push(step);
  }
  return {
    workflowId: input.workflowId,
    status: input.status as FinalStatus,
    errorCode: (input.errorCode as string | null | undefined) ?? null,
    startedAt,
    finishedAt,
    steps,
    sourceItemId: (input.sourceItemId as string | null | undefined) ?? null,
  };
}

// --- From the engine -----------------------------------------------------------

/** The request body for a finished engine run, with labels from the definition it ran. */
export function recordFromOutcome(
  workflowId: string,
  definition: WorkflowDefinition,
  outcome: RunOutcome,
  { startedAt, finishedAt, sourceItemId = null }: { startedAt: number; finishedAt: number; sourceItemId?: string | null },
) {
  const labels = new Map(definition.nodes.map((n) => [n.id, n.label]));
  const status: FinalStatus =
    outcome.status === "completed" ? "completed"
      : outcome.status === "invalid" ? "invalid"
        : outcome.error === "canceled" ? "canceled" : "failed";
  return {
    workflowId,
    status,
    errorCode: outcome.error,
    startedAt,
    finishedAt,
    sourceItemId,
    steps: outcome.steps.slice(0, MAX_RUN_STEPS).map((s) => ({
      nodeId: s.nodeId,
      kind: s.kind,
      label: (labels.get(s.nodeId) ?? "").slice(0, LABEL_MAX),
      status: s.status,
      port: s.port,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
    })),
  };
}

// --- Display -------------------------------------------------------------------

/** Milliseconds a run took, or has taken so far; null for unreadable times. */
export function runDuration(run: Pick<WorkflowRun, "startedAt" | "finishedAt">, now = Date.now()): number | null {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** "0.4s", "12s", "3m 05s", "2h 10m". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "–";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
