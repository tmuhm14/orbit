"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Undo2, X, ArrowUp, FileText, Plus, Settings2, LoaderCircle } from "lucide-react";
import { BUCKETS, type Note, type Workspace } from "@/lib/notes";
import type { AgentProgress } from "@/lib/agent/agent";
import { PROVIDERS, type ProviderId } from "@/lib/agent/providers";

type Settings = {
  provider: ProviderId;
  model: string;
  keyHint: string;
  autoTriage: boolean;
};
type Action = {
  id: string;
  note_id: string;
  kind: "update" | "create";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  undone_at: string | null;
  undoable: boolean;
};
type Run = {
  id: string;
  trigger: "capture" | "manual";
  mode: "triage" | "organize";
  instruction: string | null;
  status: "running" | "done" | "failed";
  summary: string | null;
  error: string | null;
  created_at: string;
  actions: Action[];
  events?: AgentProgress[];
  parent_run_id?: string | null;
};

async function send(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

const bucketName = (id: unknown) =>
  BUCKETS.find((b) => b.id === id)?.name ?? String(id);

/** Plain-language list of what one agent change did. */
function describe(action: Action) {
  const a = action.after;
  if (!a) return ["Change details are no longer available"];
  if (action.kind === "create")
    return [`Created “${a.title}” in ${bucketName(a.bucket)}`];
  const parts: string[] = [];
  if ("bucket" in a) parts.push(`Moved to ${bucketName(a.bucket)}`);
  if ("title" in a) parts.push(`Renamed to “${a.title}”`);
  if ("tags" in a)
    parts.push(
      (a.tags as string[]).length
        ? `Tags: ${(a.tags as string[]).join(", ")}`
        : "Removed tags",
    );
  if ("completed_at" in a)
    parts.push(a.completed_at ? "Marked done" : "Reopened");
  if ("plain_text" in a) parts.push("Added text");
  return parts.length ? parts : ["Marked as triaged"];
}

const timeAgo = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24
    ? `${hours} h ago`
    : new Date(iso).toLocaleDateString();
};

export function AgentDialog({
  workspace,
  notes,
  available,
  onToggleWorkspace,
  onNotesChanged,
  onToast,
  onClose,
}: {
  workspace: Workspace;
  notes: Note[];
  /** False when the server has no AGENT_ENCRYPTION_KEY. */
  available: boolean;
  onToggleWorkspace: (enabled: boolean) => Promise<unknown>;
  onNotesChanged: () => void;
  onToast: (message: string) => void;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [model, setModel] = useState<string>(PROVIDERS.anthropic.defaultModel);
  const [apiKey, setApiKey] = useState("");
  const [autoTriage, setAutoTriage] = useState(true);
  const [runs, setRuns] = useState<Run[]>([]);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const wasRunning = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const loadingRuns = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newRun, setNewRun] = useState(false);
  const [outputId, setOutputId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityError, setActivityError] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const selected = newRun ? undefined : runs.find((run) => run.id === selectedId) ?? runs[0];
  const output = selected?.actions.find((action) => action.id === outputId);
  const runTitle = (run: Run) => run.instruction || (run.mode === "triage" ? "Triage inbox" : "Organize workspace");

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);

  function applySettings(next: Settings | null) {
    setSettings(next);
    if (!next) return;
    setProvider(next.provider);
    setModel(next.model);
    setAutoTriage(next.autoTriage);
  }

  async function loadRuns() {
    if (loadingRuns.current) return;
    loadingRuns.current = true;
    try {
      const data = await send(
        `/api/agent/runs?workspaceId=${encodeURIComponent(workspace.id)}`,
      );
      setRuns(data.runs);
      setActivityError("");
      const running = data.runs.some((r: Run) => r.status === "running");
      if (wasRunning.current && !running) onNotesChanged();
      wasRunning.current = running;
    } catch {
      setActivityError("Couldn’t refresh activity. Retrying automatically…");
    } finally {
      loadingRuns.current = false;
    }
  }

  useEffect(() => {
    if (!available) return setLoaded(true);
    send("/api/agent/settings")
      .then((data) => {
        applySettings(data.settings);
        setModels(data.models);
      })
      .catch(() => onToast("Couldn't load agent settings"))
      .finally(() => setLoaded(true));
    void loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, available]);

  const running = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!available) return;
    const timer = setInterval(() => void loadRuns(), running ? 1500 : 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, available, workspace.id]);

  useEffect(() => {
    if (followBottom.current && feedRef.current)
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [selected?.id, selected?.events?.length, selected?.summary, selected?.actions.length]);

  async function task(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const saveSettings = (event: React.FormEvent) => {
    event.preventDefault();
    return task(async () => {
      const data = await send("/api/agent/settings", "PUT", {
        provider,
        model,
        apiKey: apiKey || undefined,
        autoTriage,
      });
      applySettings(data.settings);
      setModels(data.models);
      setApiKey("");
      onToast("Agent settings saved");
    });
  };

  const removeKey = () =>
    confirm("Remove the saved API key? The agent will stop until you add one.") &&
    task(async () => {
      await send("/api/agent/settings", "DELETE");
      setSettings(null);
      setModels([]);
      onToast("API key removed");
    });

  const start = (mode: "triage" | "organize") =>
    task(async () => {
      const data = await send("/api/agent/runs", "POST", {
        workspaceId: workspace.id,
        mode,
        instruction: mode === "organize" ? instruction : undefined,
        parentRunId: mode === "organize" ? selected?.id : undefined,
      });
      setSelectedId(data.runId);
      setNewRun(false);
      setOutputId(null);
      followBottom.current = true;
      setInstruction("");
      wasRunning.current = true;
      await loadRuns();
    });

  const undo = (action: Action) =>
    task(async () => {
      await send(`/api/agent/actions/${action.id}/undo`, "POST", {});
      await loadRuns();
      onNotesChanged();
      onToast("Change undone");
    });

  const noteTitle = (action: Action) =>
    notes.find((n) => n.id === action.note_id)?.title ||
    String(action.before?.title ?? action.after?.title ?? "Untitled");
  const providerChanged = settings && settings.provider !== provider;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
          )).filter((element) => element.getClientRects().length > 0);
          const first = focusable[0], last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        className="agent-dialog agent-workbench"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-title"
      >
        <button
          className="icon-button guide-close"
          aria-label="Close agent"
          onClick={onClose}
        >
          <X size={21} />
        </button>
        <header className="agent-workbench-header">
          <Bot className="purple" size={26} />
          <div><div className="eyebrow">{workspace.name}</div><h2 id="agent-title">Agent</h2></div>
          <button className="text-button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={16} /> Settings</button>
        </header>

        {!available ? (
          <div className="agent-notice">
            The agent isn&apos;t set up on this server yet. Set{" "}
            <code>AGENT_ENCRYPTION_KEY</code> and redeploy.
          </div>
        ) : !loaded ? (
          <p className="agent-muted">Loading…</p>
        ) : (
          <>
            <div className="agent-settings" hidden={!settingsOpen && !!settings && workspace.agentEnabled}>
            <section className="agent-section">
              <h3>Model provider</h3>
              <form className="agent-form" onSubmit={saveSettings}>
                <label>
                  Provider
                  <select
                    value={provider}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value as ProviderId;
                      setProvider(next);
                      setModel(
                        settings?.provider === next
                          ? settings.model
                          : PROVIDERS[next].defaultModel,
                      );
                    }}
                  >
                    {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => (
                      <option key={id} value={id}>
                        {PROVIDERS[id].name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  API key
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      settings && !providerChanged
                        ? `Saved key ending ${settings.keyHint}`
                        : `${PROVIDERS[provider].name} API key`
                    }
                    value={apiKey}
                    disabled={busy}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </label>
                <label>
                  Model
                  <input
                    list="agent-models"
                    value={model}
                    disabled={busy}
                    onChange={(e) => setModel(e.target.value)}
                  />
                  <datalist id="agent-models">
                    {(providerChanged ? [] : models).map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>
                <label className="agent-check">
                  <input
                    type="checkbox"
                    checked={autoTriage}
                    disabled={busy}
                    onChange={(e) => setAutoTriage(e.target.checked)}
                  />
                  Triage Slack and email captures as they arrive
                </label>
                <div className="agent-row">
                  <button
                    type="submit"
                    className="primary-button small"
                    disabled={
                      busy || (!apiKey && (!settings || !!providerChanged))
                    }
                  >
                    {apiKey ? "Check key and save" : "Save"}
                  </button>
                  {settings && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={removeKey}
                    >
                      Remove key
                    </button>
                  )}
                </div>
              </form>
              <p className="agent-muted">
                Your key is encrypted on the server and never shown again. Usage
                is billed to your provider account.
              </p>
            </section>

            <section className="agent-section">
              <h3>This workspace</h3>
              <label className="agent-check">
                <input
                  type="checkbox"
                  checked={workspace.agentEnabled}
                  disabled={busy}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    if (
                      enabled &&
                      !confirm(
                        `Notes in ${workspace.name} will be sent to ${PROVIDERS[settings?.provider ?? provider].name}. Don't allow this for workspaces that may hold patient or other regulated data unless your agreement with the provider covers it. Continue?`,
                      )
                    )
                      return;
                    void task(() => onToggleWorkspace(enabled));
                  }}
                />
                Allow the agent to read and change notes in {workspace.name}
              </label>
            </section>

            </div>
            <div className="agent-workbench-body">
              <nav className="agent-history" aria-label="Agent runs">
                <button className="text-button" onClick={() => { setNewRun(true); setSelectedId(null); setOutputId(null); setInstruction(""); }}><Plus size={15} /> New request</button>
                <h3>Recent activity</h3>
                {runs.map((run) => <button key={run.id} className={`agent-history-item ${selected?.id === run.id ? "is-selected" : ""}`} aria-pressed={selected?.id === run.id} onClick={() => { setSelectedId(run.id); setNewRun(false); setOutputId(null); setInstruction(""); followBottom.current = true; }}>
                  <span>{runTitle(run)}</span><small>{run.status === "running" ? "Working…" : run.status === "failed" ? "Stopped" : "Completed"} · {timeAgo(run.created_at)}</small>
                </button>)}
                {!runs.length && <p className="agent-muted">Your requests will appear here.</p>}
              </nav>
              <section className="agent-conversation" aria-label="Agent conversation">
                {activityError && <p className="agent-error" role="alert">{activityError}</p>}
                <div className="agent-feed" ref={feedRef} onScroll={() => { const el = feedRef.current; if (el) followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
                  {!selected ? <div className="agent-empty"><Bot size={34} /><h3>What would you like to work on?</h3><p>Organize your notes, find next actions, or turn an idea into a plan. Follow the work here and preview its outputs alongside it.</p><button className="text-button" onClick={() => setInstruction("Review my inbox and suggest clear next actions.")}>Help me find my next actions</button></div> : <>
                    <div className="agent-user-message"><small>You{selected.parent_run_id ? " · Follow-up" : ""}</small><p>{runTitle(selected)}</p></div>
                    <div className="agent-feed-heading"><Bot size={17} /><strong>Orbit</strong><span>{selected.status === "running" ? "Working" : selected.status === "failed" ? "Stopped" : "Completed"}</span></div>
                    <ol className="agent-events">{(selected.events ?? []).map((event, i) => <li key={i} className={`is-${event.kind}`}><span aria-hidden="true">{event.kind === "message" ? "" : "·"}</span><p>{event.text}</p></li>)}</ol>
                    {selected.status === "running" && <p className="agent-live" role="status"><LoaderCircle size={15} /> {selected.events?.at(-1)?.text && selected.events.at(-1)?.kind !== "message" ? selected.events.at(-1)?.text : "Working on your request…"}</p>}
                    {selected.error && <p className="agent-error" role="alert">{selected.error}. Changes already made are available in Outputs.</p>}
                    {selected.summary && <div className="agent-answer">{selected.summary}</div>}
                    {!!selected.actions.length && <p className="agent-muted">{selected.actions.length} changes · Select an output to inspect it.</p>}
                  </>}
                </div>
                <form className="agent-composer" onSubmit={(e) => { e.preventDefault(); if (!busy && !running && instruction.trim()) void start("organize"); }}>
                  <label htmlFor="agent-request" className="agent-muted">{selected ? "Follow up on this run" : "Give the agent a task"}</label>
                  <textarea id="agent-request" className="agent-instruction" rows={3} maxLength={2000} placeholder={running ? "You can draft your next request while the agent works…" : "Ask Orbit to organize, plan, or create a note…"} value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={!settings || !workspace.agentEnabled} />
                  <div className="agent-row"><span className="agent-muted">{running ? "Wait for the current run to finish to send." : "Works with notes in this workspace"}</span><button type="button" className="text-button" disabled={busy || running || !settings || !workspace.agentEnabled} onClick={() => start("triage")}>Triage inbox</button><button type="submit" className="primary-button small" disabled={busy || running || !instruction.trim() || !settings || !workspace.agentEnabled}><ArrowUp size={15} /> Send</button></div>
                </form>
              </section>
              <aside className="agent-outputs" aria-label="Agent outputs">
                <h3><FileText size={16} /> Outputs <span>{selected?.actions.length ?? 0}</span></h3>
                {!selected?.actions.length && <p className="agent-muted">Notes the agent creates or changes will appear here as it works.</p>}
                {selected?.actions.map((action) => <button key={action.id} className={`agent-output-card ${output?.id === action.id ? "is-selected" : ""}`} aria-pressed={output?.id === action.id} onClick={() => setOutputId(action.id)}><strong>{noteTitle(action)}</strong><span>{describe(action).join(" · ")}</span>{action.undone_at && <small>Undone</small>}</button>)}
                {output && <article className="agent-output-preview"><h4>{noteTitle(output)}</h4><p className="agent-muted">Saved change from this run{output.undone_at ? " · Undone" : ""}</p>{output.reason && <p>{output.reason}</p>}{typeof output.after?.plain_text === "string" ? <pre>{output.after.plain_text}</pre> : <p>{describe(output).join(" · ")}</p>}{typeof output.before?.plain_text === "string" && <details><summary>Before this change</summary><pre>{output.before.plain_text}</pre></details>}{output.undoable && <button className="text-button" disabled={busy || running} onClick={() => undo(output)}><Undo2 size={14} /> Undo change</button>}</article>}
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
