"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft, Bot, Check, CircleAlert, Cloud, CloudOff, FilePlus2, Flag, GitBranch, LoaderCircle,
  Maximize2, Play, Square, Timer, Trash2, TriangleAlert, UserCheck, X, Zap, ZoomIn, ZoomOut, type LucideIcon,
} from "lucide-react";
import {
  ACTION_BUCKETS, CONDITION_OPERATORS, LABEL_MAX, NODE_KINDS, PROMPT_MAX, TEXT_MAX, TRIGGER_MODES,
  connect, createNode, fillTemplate, portsOf, removeNode, runnable, validateWorkflow,
  type NodeKind, type Workflow, type WorkflowDefinition, type WorkflowIssue, type WorkflowNode,
} from "@/lib/workflows/model";
import { runWorkflow, type RunOutcome, type StepRecord } from "@/lib/workflows/engine";
import { NODE_H, NODE_W, bounds, edgeMidpoint, edgePath, inputPoint, outputPoint } from "./workflow-graph";
import { WorkflowRequestError, sendWorkflow } from "./use-workflows";
import { useWorkspaceShell } from "./workspace-shell-context";

export const KIND_ICONS: Record<NodeKind, LucideIcon> = {
  trigger: Zap, agent: Bot, condition: GitBranch, approval: UserCheck, action: FilePlus2, delay: Timer, end: Flag,
};
const PALETTE: NodeKind[] = ["trigger", "agent", "condition", "approval", "action", "delay", "end"];
const TRIGGER_COPY = { manual: "Run on demand", item_captured: "When an item is captured" } as const;
const OPERATOR_COPY = {
  contains: "Previous result contains", not_contains: "Previous result doesn't contain",
  is_empty: "Previous result is empty", not_empty: "Previous result isn't empty",
} as const;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.8;

type Selection = { type: "node" | "edge"; id: string } | null;
type View = { x: number; y: number; zoom: number };
type Drag =
  | { type: "pan"; startX: number; startY: number; view: View }
  | { type: "node"; id: string; offsetX: number; offsetY: number; moved: boolean }
  | { type: "connect"; from: string; port: string };
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type RunState = {
  steps: StepRecord[];
  outcome: RunOutcome | null;
  approval: { nodeId: string; previous: string; resolve: (approved: boolean) => void } | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** A one-line summary of a step's settings, shown on its card. */
function nodeSummary(node: WorkflowNode) {
  switch (node.kind) {
    case "trigger": return TRIGGER_COPY[node.config.mode];
    case "agent": return node.config.prompt.trim() || "No prompt yet";
    case "condition":
      return node.config.operator === "is_empty" || node.config.operator === "not_empty"
        ? OPERATOR_COPY[node.config.operator]
        : `${node.config.operator === "contains" ? "Contains" : "Lacks"} “${node.config.value || "…"}”`;
    case "approval": return node.config.instructions.trim() || "You approve or reject";
    case "action": return `New item in ${node.config.bucket}`;
    case "delay": return node.config.minutes >= 60 && node.config.minutes % 60 === 0
      ? `Wait ${node.config.minutes / 60} h` : `Wait ${node.config.minutes} min`;
    case "end": return "Workflow finishes";
  }
}

/** /workflows/[id]: the canvas designer, autosaving against the read revision. */
export function WorkflowDesigner({ id }: { id: string }) {
  const { showToast } = useWorkspaceShell();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [name, setName] = useState("");
  const [definition, setDefinition] = useState<WorkflowDefinition>({ version: 1, nodes: [], edges: [] });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [conflict, setConflict] = useState<Workflow | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [testInput, setTestInput] = useState("");
  const revision = useRef(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const latest = useRef({ name, definition });
  latest.current = { name, definition };
  const canceled = useRef(false);

  const issues = useMemo(() => validateWorkflow(definition), [definition]);
  const ready = runnable(issues);
  const byId = useMemo(() => new Map(definition.nodes.map((n) => [n.id, n])), [definition.nodes]);
  const running = !!run && !run.outcome;

  // --- Loading and saving ---------------------------------------------------

  const fit = useCallback((def: WorkflowDefinition) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Keep clear of the floating palette (left), inspector (right) and toolbar.
    const wide = rect.width > 900;
    const left = wide ? 240 : 0;
    const right = wide ? 320 : 0;
    const top = 60;
    const width = Math.max(200, rect.width - left - right);
    const height = Math.max(200, rect.height - top - 50);
    const box = bounds(def, 40);
    const zoom = clampZoom(Math.min(width / box.width, height / box.height, 1.1));
    setView({
      zoom,
      x: left + (width - box.width * zoom) / 2 - box.x * zoom,
      y: top + (height - box.height * zoom) / 2 - box.y * zoom,
    });
  }, []);

  const accept = useCallback((workflow: Workflow) => {
    revision.current = workflow.revision;
    setName(workflow.name);
    setDefinition(workflow.definition);
  }, []);

  useEffect(() => {
    let live = true;
    sendWorkflow(`/api/workflows/${encodeURIComponent(id)}`)
      .then((data) => {
        if (!live) return;
        accept(data.workflow);
        setLoadState("ready");
        requestAnimationFrame(() => fit(data.workflow.definition));
      })
      .catch((e) => live && setLoadState(e instanceof WorkflowRequestError && e.status === 404 ? "missing" : "error"));
    return () => {
      live = false;
    };
  }, [id, accept, fit]);

  const save = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    const sent = latest.current;
    setSaveState("saving");
    try {
      const data = await sendWorkflow(`/api/workflows/${encodeURIComponent(id)}`, "PATCH", {
        revision: revision.current,
        name: sent.name.trim() || "Untitled workflow",
        definition: sent.definition,
      });
      revision.current = data.workflow.revision;
      // Edits made while this save was in flight are saved next.
      const now = latest.current;
      setSaveState(now.definition === sent.definition && now.name === sent.name ? "saved" : "dirty");
    } catch (e) {
      if (e instanceof WorkflowRequestError && e.status === 409 && e.workflow) {
        setConflict(e.workflow);
        setSaveState("conflict");
      } else setSaveState("error");
    } finally {
      saving.current = false;
    }
  }, [id]);

  const edit = useCallback((change: (def: WorkflowDefinition) => WorkflowDefinition) => {
    setDefinition((def) => change(def));
    setSaveState((state) => (state === "conflict" ? state : "dirty"));
  }, []);

  useEffect(() => {
    if (saveState !== "dirty" || drag?.type === "node") return;
    const timer = setTimeout(() => void save(), 700);
    return () => clearTimeout(timer);
  }, [saveState, name, definition, drag, save]);

  // Unsaved edits warn before the tab closes.
  useEffect(() => {
    if (saveState === "saved") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  // --- Canvas interaction ---------------------------------------------------

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.zoom, y: (clientY - rect.top - view.y) / view.zoom };
  }, [view]);

  const addNode = useCallback((kind: NodeKind, at?: { x: number; y: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const center = at ?? (rect ? toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2) : { x: 0, y: 0 });
    const node = createNode(kind, center.x - NODE_W / 2, center.y - NODE_H / 2);
    edit((def) => ({ ...def, nodes: [...def.nodes, node] }));
    setSelection({ type: "node", id: node.id });
  }, [edit, toWorld]);

  const deleteSelection = useCallback(() => {
    if (!selection || running) return;
    if (selection.type === "node") edit((def) => removeNode(def, selection.id));
    else edit((def) => ({ ...def, edges: def.edges.filter((e) => e.id !== selection.id) }));
    setSelection(null);
  }, [selection, running, edit]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const typing = target?.closest("input, textarea, select, [contenteditable]");
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        void save();
      } else if (!typing && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteSelection();
      } else if (!typing && event.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, deleteSelection]);

  function onCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const port = target.closest<HTMLElement>("[data-port]");
    const card = target.closest<HTMLElement>("[data-node]");
    if (target.closest("[data-edge]") || (card && target.closest("button:not([data-port])"))) return;
    canvasRef.current!.setPointerCapture(event.pointerId);
    if (port && !running) {
      setDrag({ type: "connect", from: port.dataset.node!, port: port.dataset.port! });
      setPointer(toWorld(event.clientX, event.clientY));
    } else if (card) {
      const node = byId.get(card.dataset.node!)!;
      const at = toWorld(event.clientX, event.clientY);
      setSelection({ type: "node", id: node.id });
      if (!running) setDrag({ type: "node", id: node.id, offsetX: at.x - node.x, offsetY: at.y - node.y, moved: false });
    } else {
      setSelection(null);
      setDrag({ type: "pan", startX: event.clientX, startY: event.clientY, view });
    }
  }

  function onCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    if (drag.type === "pan") {
      setView({ ...drag.view, x: drag.view.x + event.clientX - drag.startX, y: drag.view.y + event.clientY - drag.startY });
    } else if (drag.type === "node") {
      const at = toWorld(event.clientX, event.clientY);
      const x = Math.round((at.x - drag.offsetX) / 8) * 8;
      const y = Math.round((at.y - drag.offsetY) / 8) * 8;
      if (!drag.moved) setDrag({ ...drag, moved: true });
      edit((def) => ({ ...def, nodes: def.nodes.map((n) => (n.id === drag.id ? { ...n, x, y } : n)) }));
    } else {
      setPointer(toWorld(event.clientX, event.clientY));
    }
  }

  function onCanvasPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag?.type === "connect") {
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node]");
      const to = hit?.dataset.node;
      if (to && to !== drag.from && byId.get(to)?.kind !== "trigger") edit((def) => connect(def, drag.from, drag.port, to));
    }
    setDrag(null);
    setPointer(null);
  }

  // Wheel zooms around the pointer; listened natively so it can preventDefault.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || loadState !== "ready") return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setView((v) => {
        // Scrolling pans; pinch (ctrlKey on trackpads) or ⌘/Ctrl + wheel zooms.
        if (!event.ctrlKey && !event.metaKey) return { ...v, x: v.x - event.deltaX, y: v.y - event.deltaY };
        const zoom = clampZoom(v.zoom * Math.exp(-event.deltaY * 0.0015));
        return { zoom, x: px - ((px - v.x) / v.zoom) * zoom, y: py - ((py - v.y) / v.zoom) * zoom };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [loadState]);

  const zoomBy = (factor: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = rect.width / 2;
    const py = rect.height / 2;
    setView((v) => {
      const zoom = clampZoom(v.zoom * factor);
      return { zoom, x: px - ((px - v.x) / v.zoom) * zoom, y: py - ((py - v.y) / v.zoom) * zoom };
    });
  };

  // --- Test run ---------------------------------------------------------------

  async function startRun() {
    if (!ready || running) return;
    canceled.current = false;
    setSelection(null);
    setRun({ steps: [], outcome: null, approval: null });
    const outcome = await runWorkflow(
      definition,
      {
        agent: async (node, { previous }) => {
          await sleep(1100);
          const prompt = fillTemplate(node.config.prompt, previous).replace(/\s+/g, " ").trim();
          return { output: `[simulated] ${prompt.slice(0, 240)}` };
        },
        approval: (node, { previous }) =>
          new Promise((resolve) =>
            setRun((r) => r && {
              ...r,
              approval: {
                nodeId: node.id,
                previous,
                resolve: (approved) => {
                  setRun((current) => current && { ...current, approval: null });
                  resolve({ output: previous, port: approved ? "approved" : "rejected" });
                },
              },
            })),
        action: async (node, { previous }) => {
          await sleep(600);
          return { output: `Would add “${fillTemplate(node.config.title, previous).slice(0, 120)}” to ${node.config.bucket}` };
        },
        delay: async (_, { previous }) => {
          await sleep(700);
          return { output: previous };
        },
      },
      {
        input: testInput,
        canceled: () => canceled.current,
        onStep: (steps) => setRun((r) => r && { ...r, steps }),
      },
    );
    setRun((r) => r && { ...r, steps: outcome.steps, outcome, approval: null });
  }

  function stopRun() {
    canceled.current = true;
    run?.approval?.resolve(false);
  }

  const stepFor = useMemo(() => {
    const map = new Map<string, StepRecord>();
    for (const step of run?.steps ?? []) map.set(step.nodeId, step);
    return map;
  }, [run?.steps]);
  // An edge the run took: its source finished through this port and the next step began.
  const traversed = useCallback((edge: { from: string; to: string; port: string }) => {
    const from = stepFor.get(edge.from);
    return !!from && from.status === "succeeded" && from.port === edge.port && stepFor.has(edge.to);
  }, [stepFor]);

  // --- Render -----------------------------------------------------------------

  if (loadState !== "ready")
    return (
      <main className="wf-designer-state">
        {loadState === "loading" ? (
          <p className="wf-muted"><LoaderCircle className="wf-spin" size={15} /> Opening the designer…</p>
        ) : (
          <div className="empty-state">
            <h3>{loadState === "missing" ? "Workflow not found" : "Couldn't open this workflow"}</h3>
            <p>{loadState === "missing" ? "It may have been deleted, or it belongs to another account." : "Reload the page to try again."}</p>
            <Link className="secondary-button" href="/workflows">Back to workflows</Link>
          </div>
        )}
      </main>
    );

  const selectedNode = selection?.type === "node" ? byId.get(selection.id) : undefined;
  const selectedEdge = selection?.type === "edge" ? definition.edges.find((e) => e.id === selection.id) : undefined;
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const connectFrom = drag?.type === "connect" ? byId.get(drag.from) : undefined;

  return (
    <div className="wf-designer" data-running={running || undefined}>
      <div
        ref={canvasRef}
        className={`wf-canvas ${drag?.type === "pan" ? "is-panning" : ""} ${drag?.type === "connect" ? "is-connecting" : ""}`}
        style={{
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundSize: `${22 * view.zoom}px ${22 * view.zoom}px`,
        }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("application/x-orbit-step")) event.preventDefault();
        }}
        onDrop={(event) => {
          const kind = event.dataTransfer.getData("application/x-orbit-step") as NodeKind;
          if (!NODE_KINDS[kind]) return;
          event.preventDefault();
          addNode(kind, toWorld(event.clientX, event.clientY));
        }}
        role="application"
        aria-label="Workflow canvas. Drag steps to move them; drag from an output dot to connect."
      >
        <div className="wf-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <svg className="wf-edges" width="1" height="1" aria-hidden="true">
            <defs>
              <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 z" className="wf-arrowhead" />
              </marker>
              <marker id="wf-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 z" className="wf-arrowhead is-hot" />
              </marker>
            </defs>
            {definition.edges.map((edge) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) return null;
              const a = outputPoint(from, edge.port);
              const b = inputPoint(to);
              const d = edgePath(a, b);
              const hot = traversed(edge);
              const live = hot && stepFor.get(edge.to)?.status === "running";
              const branch = portsOf(from.kind).length > 1;
              const mid = edgeMidpoint(a, b);
              const isSelected = selection?.type === "edge" && selection.id === edge.id;
              const tone = branch ? NODE_KINDS[from.kind].tone : null;
              return (
                <g
                  key={edge.id}
                  data-edge={edge.id}
                  className={`wf-edge ${hot ? "is-hot" : ""} ${live ? "is-live" : ""} ${isSelected ? "is-selected" : ""} ${run && !hot ? "is-dim" : ""}`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    setSelection({ type: "edge", id: edge.id });
                  }}
                >
                  <path className="wf-edge-hit" d={d} />
                  <path className="wf-edge-line" d={d} markerEnd={`url(#${hot ? "wf-arrow-hot" : "wf-arrow"})`} />
                  {hot && <path className="wf-edge-flow" d={d} pathLength={1} />}
                  {branch && (
                    <g className={`wf-edge-chip wf-tone-${tone}`} transform={`translate(${mid.x}, ${mid.y})`}>
                      <rect x={-edge.port.length * 3.6 - 9} y={-10} width={edge.port.length * 7.2 + 18} height={20} rx={7} />
                      <text textAnchor="middle" dominantBaseline="central">{edge.port}</text>
                    </g>
                  )}
                </g>
              );
            })}
            {connectFrom && drag?.type === "connect" && pointer && (
              <path className="wf-edge-draft" d={edgePath(outputPoint(connectFrom, drag.port), pointer)} />
            )}
          </svg>

          {definition.nodes.map((node) => {
            const meta = NODE_KINDS[node.kind];
            const Icon = KIND_ICONS[node.kind];
            const step = stepFor.get(node.id);
            const nodeIssues = issues.filter((i) => i.nodeId === node.id);
            const ports = portsOf(node.kind);
            return (
              <div
                key={node.id}
                data-node={node.id}
                className={[
                  "wf-node", `wf-tone-${meta.tone}`, `is-${node.kind}`,
                  selection?.type === "node" && selection.id === node.id ? "is-selected" : "",
                  step ? `run-${step.status}` : run ? "run-idle" : "",
                  drag?.type === "connect" && drag.from !== node.id && node.kind !== "trigger" ? "is-target" : "",
                ].join(" ")}
                style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: NODE_W, height: NODE_H }}
              >
                {node.kind !== "trigger" && <span className="wf-port wf-port-in" aria-hidden="true" />}
                <span className="wf-node-icon"><Icon size={16} strokeWidth={1.8} /></span>
                <span className="wf-node-text">
                  <span className="wf-node-kind">{meta.label}</span>
                  <strong className="wf-node-label">{node.label || meta.label}</strong>
                  <span className="wf-node-summary">{nodeSummary(node)}</span>
                </span>
                {step?.status === "running" && <LoaderCircle className="wf-node-status wf-spin" size={15} />}
                {step?.status === "succeeded" && <Check className="wf-node-status is-ok" size={15} />}
                {step?.status === "failed" && <X className="wf-node-status is-bad" size={15} />}
                {!step && nodeIssues.length > 0 && (
                  <span
                    className={`wf-node-flag ${nodeIssues.some((i) => i.severity === "error") ? "is-error" : ""}`}
                    title={nodeIssues.map((i) => i.message).join("\n")}
                  >
                    {nodeIssues.length}
                  </span>
                )}
                {ports.map((port, index) => (
                  <button
                    key={port}
                    type="button"
                    tabIndex={-1}
                    data-port={port}
                    data-node={node.id}
                    className="wf-port wf-port-out"
                    style={{ top: `${((index + 1) * 100) / (ports.length + 1)}%` }}
                    aria-label={`Connect ${port} output`}
                    title={ports.length > 1 ? `Drag to connect “${port}”` : "Drag to connect"}
                  >
                    {/* Connected branches show their name on the edge instead. */}
                    {ports.length > 1 && !definition.edges.some((e) => e.from === node.id && e.port === port) && (
                      <span className="wf-port-label">{port}</span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </div>

        {definition.nodes.length === 0 && (
          <div className="wf-canvas-empty">
            <strong>An empty canvas</strong>
            <span>Drag a step from the left, starting with a trigger.</span>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="wf-toolbar wf-float" role="toolbar" aria-label="Workflow">
        <Link className="wf-tool" href="/workflows" title="All workflows" aria-label="All workflows">
          <ArrowLeft size={16} />
        </Link>
        <input
          className="wf-name"
          value={name}
          maxLength={80}
          aria-label="Workflow name"
          onChange={(event) => {
            setName(event.target.value);
            setSaveState((s) => (s === "conflict" ? s : "dirty"));
          }}
        />
        <span className={`wf-save is-${saveState}`} role="status">
          {saveState === "saved" ? <><Cloud size={13} /> Saved</>
            : saveState === "saving" ? <><LoaderCircle className="wf-spin" size={13} /> Saving</>
              : saveState === "dirty" ? <><Cloud size={13} /> Edited</>
                : saveState === "conflict" ? <><CloudOff size={13} /> Changed elsewhere</>
                  : <><CloudOff size={13} /> Not saved</>}
        </span>
        {saveState === "error" && <button type="button" className="wf-tool-text" onClick={() => void save()}>Retry</button>}
        <span className="wf-toolbar-rule" />
        <span className={`wf-health ${errors.length ? "is-error" : warnings.length ? "is-warning" : "is-ok"}`}>
          {errors.length ? <><CircleAlert size={13} /> {errors.length} to fix</>
            : warnings.length ? <><TriangleAlert size={13} /> {warnings.length} notes</>
              : <><Check size={13} /> Valid</>}
        </span>
        {running ? (
          <button type="button" className="wf-run is-stop" onClick={stopRun}><Square size={13} /> Stop</button>
        ) : (
          <button
            type="button"
            className="wf-run"
            disabled={!ready}
            title={ready ? "Walk the workflow with simulated agents" : "Fix the problems first"}
            onClick={() => void startRun()}
          >
            <Play size={13} /> Test run
          </button>
        )}
      </div>

      {conflict && (
        <div className="wf-conflict wf-float" role="alert">
          <span>This workflow was changed in another tab or device.</span>
          <button type="button" className="wf-tool-text" onClick={() => {
            accept(conflict);
            setConflict(null);
            setSaveState("saved");
          }}>Load theirs</button>
          <button type="button" className="wf-tool-text is-strong" onClick={() => {
            revision.current = conflict.revision;
            setConflict(null);
            setSaveState("dirty");
          }}>Keep mine</button>
        </div>
      )}

      {/* Palette */}
      <aside className="wf-palette wf-float" aria-label="Steps">
        <div className="wf-panel-title">Steps</div>
        {PALETTE.map((kind) => {
          const meta = NODE_KINDS[kind];
          const Icon = KIND_ICONS[kind];
          return (
            <button
              key={kind}
              type="button"
              draggable={!running}
              disabled={running}
              className={`wf-palette-item wf-tone-${meta.tone}`}
              onDragStart={(event) => {
                event.dataTransfer.setData("application/x-orbit-step", kind);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => addNode(kind)}
              title={`${meta.hint}. Click or drag onto the canvas.`}
            >
              <span className="wf-swatch"><Icon size={14} strokeWidth={1.8} /></span>
              <span>
                <strong>{meta.label}</strong>
                <small>{meta.hint}</small>
              </span>
            </button>
          );
        })}
      </aside>

      {/* Inspector */}
      {!run && (
        <aside className="wf-inspector wf-float" aria-label="Inspector">
          {selectedNode ? (
            <NodeInspector
              key={selectedNode.id}
              node={selectedNode}
              issues={issues.filter((i) => i.nodeId === selectedNode.id)}
              onChange={(next) => edit((def) => ({ ...def, nodes: def.nodes.map((n) => (n.id === next.id ? next : n)) }))}
              onDelete={deleteSelection}
            />
          ) : selectedEdge ? (
            <div className="wf-inspector-body">
              <div className="wf-panel-title">Connection</div>
              <p className="wf-edge-desc">
                <strong>{byId.get(selectedEdge.from)?.label}</strong>
                <span className="wf-mono"> —{selectedEdge.port}→ </span>
                <strong>{byId.get(selectedEdge.to)?.label}</strong>
              </p>
              <button type="button" className="wf-danger" onClick={deleteSelection}><Trash2 size={14} /> Remove connection</button>
            </div>
          ) : (
            <div className="wf-inspector-body">
              <div className="wf-panel-title">Overview</div>
              <p className="wf-muted">
                {definition.nodes.length} steps · {definition.edges.length} connections. Select a step to edit it; drag from an
                output dot to connect; <kbd>⌫</kbd> removes the selection.
              </p>
              {issues.length > 0 ? (
                <ul className="wf-issues">
                  {issues.map((issue, index) => (
                    <li key={index} className={`is-${issue.severity}`}>
                      <button
                        type="button"
                        disabled={!issue.nodeId && !issue.edgeId}
                        onClick={() => setSelection(issue.nodeId ? { type: "node", id: issue.nodeId } : issue.edgeId ? { type: "edge", id: issue.edgeId } : null)}
                      >
                        {issue.severity === "error" ? <CircleAlert size={13} /> : <TriangleAlert size={13} />}
                        {issue.message}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="wf-ok"><Check size={14} /> Ready for a test run.</p>
              )}
              <label className="wf-field">
                <span>Test input</span>
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={testInput}
                  placeholder="Text the trigger hands to the first step, e.g. an item's content"
                  onChange={(event) => setTestInput(event.target.value)}
                />
              </label>
            </div>
          )}
        </aside>
      )}

      {/* Run panel */}
      {run && (
        <aside className="wf-inspector wf-run-panel wf-float" aria-label="Test run" aria-live="polite">
          <div className="wf-inspector-body">
            <div className="wf-panel-head">
              <div className="wf-panel-title">Test run</div>
              <span className={`wf-run-state is-${run.outcome?.status ?? "running"}`}>
                {!run.outcome ? "Running" : run.outcome.status === "completed" ? "Completed" : run.outcome.error === "canceled" ? "Stopped" : "Failed"}
              </span>
              {run.outcome && (
                <button type="button" className="wf-tool" aria-label="Close test run" onClick={() => setRun(null)}><X size={15} /></button>
              )}
            </div>
            <p className="wf-muted">Agents are simulated and nothing is saved. Approvals wait for you.</p>
            <ol className="wf-trace">
              {run.steps.map((step, index) => {
                const node = byId.get(step.nodeId);
                const Icon = node ? KIND_ICONS[node.kind] : Flag;
                return (
                  <li key={`${step.nodeId}-${index}`} className={`is-${step.status} wf-tone-${node ? NODE_KINDS[node.kind].tone : "external"}`}>
                    <span className="wf-swatch"><Icon size={13} /></span>
                    <span className="wf-trace-text">
                      <strong>{node?.label ?? "Step"}</strong>
                      {step.status === "running" ? (
                        <small>{run.approval?.nodeId === step.nodeId ? "Waiting for your decision" : "Working…"}</small>
                      ) : (
                        <>
                          {step.port && portsOf(step.kind).length > 1 && <span className="wf-mono wf-trace-port">→ {step.port}</span>}
                          {step.output && step.kind !== "trigger" && step.kind !== "end" && (
                            <small className="wf-trace-output">{step.output}</small>
                          )}
                        </>
                      )}
                    </span>
                    {step.finishedAt && <span className="wf-trace-time">{((step.finishedAt - step.startedAt) / 1000).toFixed(1)}s</span>}
                  </li>
                );
              })}
            </ol>
            {run.approval && (() => {
              const node = byId.get(run.approval.nodeId);
              const instructions = node?.kind === "approval" ? node.config.instructions : "";
              return (
                <div className="wf-approval">
                  <strong>{node?.label}</strong>
                  {instructions && <p>{instructions}</p>}
                  {run.approval.previous && <pre>{run.approval.previous}</pre>}
                  <div>
                    <button type="button" className="wf-tool-text" onClick={() => run.approval?.resolve(false)}>Reject</button>
                    <button type="button" className="wf-run" onClick={() => run.approval?.resolve(true)}><Check size={13} /> Approve</button>
                  </div>
                </div>
              );
            })()}
            {run.outcome && (
              <button type="button" className="wf-tool-text" onClick={() => void startRun()}><Play size={13} /> Run again</button>
            )}
          </div>
        </aside>
      )}

      {/* Legend + zoom */}
      <div className="wf-legend wf-float" aria-hidden="true">
        {PALETTE.map((kind) => (
          <span key={kind} className={`wf-tone-${NODE_KINDS[kind].tone}`}><i />{NODE_KINDS[kind].label}</span>
        ))}
      </div>
      <div className="wf-nav wf-float" role="group" aria-label="Zoom">
        <button type="button" className="wf-tool" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out"><ZoomOut size={15} /></button>
        <span className="wf-zoom wf-mono">{Math.round(view.zoom * 100)}%</span>
        <button type="button" className="wf-tool" onClick={() => zoomBy(1.2)} aria-label="Zoom in"><ZoomIn size={15} /></button>
        <button type="button" className="wf-tool" onClick={() => fit(definition)} aria-label="Fit to screen" title="Fit to screen"><Maximize2 size={14} /></button>
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  issues,
  onChange,
  onDelete,
}: {
  node: WorkflowNode;
  issues: WorkflowIssue[];
  onChange: (node: WorkflowNode) => void;
  onDelete: () => void;
}) {
  const meta = NODE_KINDS[node.kind];
  const Icon = KIND_ICONS[node.kind];
  const set = (config: Partial<WorkflowNode["config"]>) =>
    onChange({ ...node, config: { ...node.config, ...config } } as WorkflowNode);
  return (
    <div className="wf-inspector-body">
      <div className={`wf-inspector-head wf-tone-${meta.tone}`}>
        <span className="wf-swatch"><Icon size={15} /></span>
        <div>
          <div className="wf-panel-title">{meta.label}</div>
          <small className="wf-muted">{meta.hint}</small>
        </div>
      </div>
      <label className="wf-field">
        <span>Name</span>
        <input value={node.label} maxLength={LABEL_MAX} onChange={(event) => onChange({ ...node, label: event.target.value })} />
      </label>
      {node.kind === "trigger" && (
        <label className="wf-field">
          <span>Starts</span>
          <select value={node.config.mode} onChange={(event) => set({ mode: event.target.value as (typeof TRIGGER_MODES)[number] })}>
            {TRIGGER_MODES.map((mode) => <option key={mode} value={mode}>{TRIGGER_COPY[mode]}</option>)}
          </select>
        </label>
      )}
      {node.kind === "agent" && (
        <label className="wf-field">
          <span>Prompt</span>
          <textarea
            rows={8}
            maxLength={PROMPT_MAX}
            value={node.config.prompt}
            placeholder="What should the agent do?"
            onChange={(event) => set({ prompt: event.target.value })}
          />
          <small><code>{"{{previous}}"}</code> inserts the previous step&apos;s result, as data.</small>
        </label>
      )}
      {node.kind === "condition" && (
        <>
          <label className="wf-field">
            <span>Check</span>
            <select value={node.config.operator} onChange={(event) => set({ operator: event.target.value as (typeof CONDITION_OPERATORS)[number] })}>
              {CONDITION_OPERATORS.map((op) => <option key={op} value={op}>{OPERATOR_COPY[op]}</option>)}
            </select>
          </label>
          {(node.config.operator === "contains" || node.config.operator === "not_contains") && (
            <label className="wf-field">
              <span>Text</span>
              <input value={node.config.value} maxLength={TEXT_MAX} onChange={(event) => set({ value: event.target.value })} />
              <small>Not case-sensitive. Matches go to <b>yes</b>, the rest to <b>no</b>.</small>
            </label>
          )}
        </>
      )}
      {node.kind === "approval" && (
        <label className="wf-field">
          <span>What to check</span>
          <textarea rows={4} maxLength={TEXT_MAX} value={node.config.instructions} onChange={(event) => set({ instructions: event.target.value })} />
        </label>
      )}
      {node.kind === "action" && (
        <>
          <label className="wf-field">
            <span>Item title</span>
            <input value={node.config.title} maxLength={TEXT_MAX} onChange={(event) => set({ title: event.target.value })} />
          </label>
          <label className="wf-field">
            <span>Bucket</span>
            <select value={node.config.bucket} onChange={(event) => set({ bucket: event.target.value as (typeof ACTION_BUCKETS)[number] })}>
              {ACTION_BUCKETS.map((bucket) => <option key={bucket} value={bucket}>{bucket[0].toUpperCase() + bucket.slice(1)}</option>)}
            </select>
          </label>
        </>
      )}
      {node.kind === "delay" && (
        <label className="wf-field">
          <span>Minutes</span>
          <input
            type="number"
            min={1}
            max={10080}
            value={node.config.minutes}
            onChange={(event) => set({ minutes: Math.min(10080, Math.max(1, Math.round(Number(event.target.value) || 1))) })}
          />
        </label>
      )}
      {issues.length > 0 && (
        <ul className="wf-issues">
          {issues.map((issue) => (
            <li key={issue.message} className={`is-${issue.severity}`}>
              <span>{issue.severity === "error" ? <CircleAlert size={13} /> : <TriangleAlert size={13} />}{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="wf-danger" onClick={onDelete}><Trash2 size={14} /> Delete step</button>
    </div>
  );
}
