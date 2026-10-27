"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Flag, History, LoaderCircle, Play } from "lucide-react";
import { NODE_KINDS, portsOf } from "@/lib/workflows/model";
import {
  RUN_STATUS_LABELS, formatDuration, runDuration, type RunItem, type RunStatus, type WorkflowRun,
} from "@/lib/workflows/runs";
import {
  RUN_STATUS_FILTERS, itemHref, parseWorkflowRunsParams, workflowHref, workflowRunHref, workflowRunsHref,
} from "@/lib/workspace-routes";
import { KIND_ICONS } from "./workflow-designer";
import { useWorkflowRun, useWorkflowRuns } from "./use-workflow-runs";
import { useWorkspaceWorkflows } from "./use-workflows";
import { untitled } from "./work-rows";
import { useWorkspaceShell } from "./workspace-shell-context";

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ROLE_LABELS: Record<RunItem["role"], string> = { source: "Started from", created: "Created", updated: "Updated" };

export function RunStatusChip({ status }: { status: RunStatus }) {
  return <span className={`wf-run-state is-${status}`}>{RUN_STATUS_LABELS[status]}</span>;
}

/** The item a run started from, as a title (items not loaded here read as "An item"). */
function useItemTitle() {
  const { notes } = useWorkspaceShell();
  return (id: string) => {
    const note = notes.find((n) => n.id === id);
    return note ? untitled(note) : "An item";
  };
}

/** Runs as rows: status, workflow, start, duration; each links to its details. */
export function RunRows({ runs, showWorkflow = true }: { runs: WorkflowRun[]; showWorkflow?: boolean }) {
  const itemTitle = useItemTitle();
  return (
    <ul className="wf-runs">
      {runs.map((run) => {
        const source = run.items.find((i) => i.role === "source");
        return (
          <li key={run.id}>
            <Link className="wf-run-row" href={workflowRunHref(run.id)}>
              <RunStatusChip status={run.status} />
              <span className="wf-run-row-main">
                <strong>{showWorkflow ? run.workflowName : when(run.startedAt)}</strong>
                <small>
                  {showWorkflow && <span>{when(run.startedAt)}</span>}
                  {run.mode === "test" && <span>Test run</span>}
                  {source && <span>From “{itemTitle(source.itemId)}”</span>}
                </small>
              </span>
              <span className="wf-run-row-time wf-mono">{formatDuration(runDuration(run))}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function RunListBody({
  runs, error, more, loadMore, loadingMore, showWorkflow, empty,
}: ReturnType<typeof useWorkflowRuns> & { showWorkflow?: boolean; empty: string }) {
  if (runs === null) return <p className="wf-muted"><LoaderCircle className="wf-spin" size={14} /> Loading runs…</p>;
  return (
    <>
      {error && <p className="wf-error" role="alert">{error}</p>}
      {runs.length ? <RunRows runs={runs} showWorkflow={showWorkflow} /> : !error && <p className="wf-muted">{empty}</p>}
      {more && (
        <button type="button" className="wf-tool-text wf-runs-more" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore && <LoaderCircle className="wf-spin" size={13} />} Load older runs
        </button>
      )}
    </>
  );
}

/** /workflows/runs: every run in the space, filtered by ?status= and ?workflow=. */
export function WorkflowRunsPage() {
  const { workspaceId } = useWorkspaceShell();
  const router = useRouter();
  const params = parseWorkflowRunsParams(useSearchParams());
  const { workflows } = useWorkspaceWorkflows(workspaceId);
  const list = useWorkflowRuns({ workspaceId, workflowId: params.workflow, status: params.status });
  return (
    <main className="workflows-page wf-runs-page">
      <header className="workflows-header">
        <div className="workflows-mark"><History size={24} /></div>
        <div>
          <div className="eyebrow">AGENT WORKFLOWS</div>
          <h1>Run history</h1>
          <p>Every run in this space, newest first. Open one to see the steps it took.</p>
        </div>
      </header>
      <div className="wf-runs-filters" role="group" aria-label="Filter runs">
        <Link className="wf-tool-text" href="/workflows"><ArrowLeft size={13} /> Workflows</Link>
        <label>
          <span>Status</span>
          <select
            value={params.status ?? ""}
            onChange={(event) => router.push(workflowRunsHref({
              ...params, status: (event.target.value || null) as (typeof RUN_STATUS_FILTERS)[number] | null,
            }))}
          >
            <option value="">All</option>
            {RUN_STATUS_FILTERS.map((s) => <option key={s} value={s}>{RUN_STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <label>
          <span>Workflow</span>
          <select
            value={params.workflow ?? ""}
            onChange={(event) => router.push(workflowRunsHref({ ...params, workflow: event.target.value || null }))}
          >
            <option value="">All workflows</option>
            {params.workflow && !workflows?.some((w) => w.id === params.workflow) && (
              <option value={params.workflow}>This workflow</option>
            )}
            {workflows?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </div>
      <section aria-label="Runs">
        <RunListBody
          {...list}
          empty={params.status || params.workflow ? "No runs match these filters." : "No runs yet. Test-run a workflow from the designer and it shows up here."}
        />
      </section>
    </main>
  );
}

/** /workflows/runs/[id]: one run's summary, the items it touched, and its steps. */
export function WorkflowRunPage({ id }: { id: string }) {
  const { run, state } = useWorkflowRun(id);
  const itemTitle = useItemTitle();
  if (state === "loading")
    return <main className="workflows-page"><p className="wf-muted"><LoaderCircle className="wf-spin" size={14} /> Loading run…</p></main>;
  if (!run)
    return (
      <main className="workflows-page">
        <div className="empty-state">
          <h3>{state === "missing" ? "This run isn’t here" : "The run couldn’t be loaded"}</h3>
          <p>{state === "missing" ? "It may have been deleted, or the link is incomplete." : "Reload the page to try again."}</p>
          <Link className="secondary-button" href={workflowRunsHref()}>Back to run history</Link>
        </div>
      </main>
    );
  return (
    <main className="workflows-page wf-runs-page">
      <header className="workflows-header">
        <div className="workflows-mark"><Play size={22} /></div>
        <div>
          <div className="eyebrow">WORKFLOW RUN</div>
          <h1>{run.workflowName}</h1>
          <p className="wf-muted">
            <RunStatusChip status={run.status} />
            <span>{run.mode === "test" ? "Test run (simulated agents)" : "Live run"}</span>
          </p>
        </div>
      </header>
      <dl className="wf-run-facts">
        <div><dt>Started</dt><dd>{when(run.startedAt)}</dd></div>
        <div><dt>Duration</dt><dd className="wf-mono">{formatDuration(runDuration(run))}</dd></div>
        <div><dt>Trigger</dt><dd>{run.trigger === "manual" ? "On demand" : "Item captured"}</dd></div>
        <div>
          <dt>Workflow</dt>
          <dd>
            {run.workflowId ? <Link href={workflowHref(run.workflowId)}>Open designer</Link> : "Deleted"}
            {" · "}
            <Link href={workflowRunsHref({ workflow: run.workflowId })}>All its runs</Link>
          </dd>
        </div>
        {run.errorCode && <div><dt>Reason</dt><dd className="wf-mono">{run.errorCode}</dd></div>}
      </dl>
      {run.items.length > 0 && (
        <section aria-labelledby="wf-run-items">
          <h2 id="wf-run-items" className="workflows-section-title">Items</h2>
          <ul className="wf-run-items">
            {run.items.map((item) => (
              <li key={`${item.itemId}-${item.role}`}>
                <span>{ROLE_LABELS[item.role]}</span>
                <Link href={itemHref(item.itemId)}>{itemTitle(item.itemId)}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="wf-run-steps">
        <h2 id="wf-run-steps" className="workflows-section-title">Steps <span>{run.steps?.length ?? 0}</span></h2>
        {run.steps?.length ? (
          <ol className="wf-trace wf-run-trace">
            {run.steps.map((step, index) => {
              const Icon = KIND_ICONS[step.kind] ?? Flag;
              const ms = step.finishedAt ? Date.parse(step.finishedAt) - Date.parse(step.startedAt) : null;
              return (
                <li key={`${step.nodeId}-${index}`} className={`is-${step.status} wf-tone-${NODE_KINDS[step.kind].tone}`}>
                  <span className="wf-swatch"><Icon size={13} /></span>
                  <span className="wf-trace-text">
                    <strong>{step.label || NODE_KINDS[step.kind].label}</strong>
                    <small>
                      {NODE_KINDS[step.kind].label}
                      {step.port && portsOf(step.kind).length > 1 && <span className="wf-mono wf-trace-port"> → {step.port}</span>}
                      {step.status === "failed" && " · failed"}
                    </small>
                  </span>
                  <span className="wf-trace-time">{formatDuration(ms)}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="wf-muted">No steps were recorded.</p>
        )}
      </section>
    </main>
  );
}

/** The designer's history panel: this workflow's runs. */
export function WorkflowRunsPanel({ workflowId, version }: { workflowId: string; version: number }) {
  const { workspaceId } = useWorkspaceShell();
  const list = useWorkflowRuns({ workspaceId, workflowId });
  const { reload } = list;
  useRefresh(version, reload);
  return (
    <>
      <RunListBody {...list} showWorkflow={false} empty="No runs yet. Test-run the workflow to start its history." />
      <Link className="wf-tool-text" href={workflowRunsHref({ workflow: workflowId })}><History size={13} /> All runs</Link>
    </>
  );
}

/**
 * Runs that started from or touched an item, on its page. Hidden until there
 * is something to show: a run, or a workflow to test on the item.
 */
export function ItemWorkflowRuns({ itemId }: { itemId: string }) {
  const { workspaceId } = useWorkspaceShell();
  const router = useRouter();
  const list = useWorkflowRuns({ workspaceId, itemId });
  const { workflows } = useWorkspaceWorkflows(workspaceId);
  if (!list.runs?.length && !workflows?.length) return null;
  return (
    <section className="work-section wf-item-runs" aria-labelledby={`wf-item-runs-${itemId}`}>
      <div className="work-section-heading">
        <h2 id={`wf-item-runs-${itemId}`}><History size={16} /> Workflow runs</h2>
        {!!workflows?.length && (
          <select
            className="wf-item-runs-start"
            aria-label="Test a workflow on this item"
            value=""
            onChange={(event) => {
              if (event.target.value) router.push(`${workflowHref(event.target.value)}?item=${encodeURIComponent(itemId)}`);
            }}
          >
            <option value="">Test a workflow on this item…</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
      </div>
      <RunListBody {...list} empty="No runs have used this item yet." />
    </section>
  );
}

/** Reloads when `version` changes after the first render (a run was just recorded). */
function useRefresh(version: number, reload: () => Promise<void>) {
  const first = useRef(version);
  useEffect(() => {
    if (version !== first.current) void reload();
  }, [version, reload]);
}
