"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Undo2, X } from "lucide-react";
import { BUCKETS, type Note, type Workspace } from "@/lib/notes";
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
  after: Record<string, unknown>;
  reason: string | null;
  undone_at: string | null;
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
};

async function send(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method,
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

  function applySettings(next: Settings | null) {
    setSettings(next);
    if (!next) return;
    setProvider(next.provider);
    setModel(next.model);
    setAutoTriage(next.autoTriage);
  }

  async function loadRuns() {
    try {
      const data = await send(
        `/api/agent/runs?workspaceId=${encodeURIComponent(workspace.id)}`,
      );
      setRuns(data.runs);
      const running = data.runs.some((r: Run) => r.status === "running");
      if (wasRunning.current && !running) onNotesChanged();
      wasRunning.current = running;
    } catch {
      /* Activity is optional; the next poll retries. */
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
    if (!running) return;
    const timer = setInterval(() => void loadRuns(), 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

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
      await send("/api/agent/runs", "POST", {
        workspaceId: workspace.id,
        mode,
        instruction: mode === "organize" ? instruction : undefined,
      });
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
    String(action.before?.title ?? action.after.title ?? "Untitled");
  const providerChanged = settings && settings.provider !== provider;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="guide-dialog agent-dialog"
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
        <Bot className="purple" size={30} />
        <div className="eyebrow">ORGANIZING AGENT</div>
        <h2 id="agent-title">Let an agent tidy {workspace.name}.</h2>
        <p>
          Bring your own Anthropic, OpenAI, or xAI key. The agent reads notes in
          workspaces you allow, triages new captures, files and retitles notes,
          and adds next actions. Every change is listed below and can be
          undone.
        </p>

        {!available ? (
          <div className="agent-notice">
            The agent isn&apos;t set up on this server yet. Set{" "}
            <code>AGENT_ENCRYPTION_KEY</code> and redeploy.
          </div>
        ) : !loaded ? (
          <p className="agent-muted">Loading…</p>
        ) : (
          <>
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

            {workspace.agentEnabled && settings && (
              <section className="agent-section">
                <h3>Run</h3>
                <textarea
                  className="agent-instruction"
                  rows={2}
                  maxLength={2000}
                  placeholder="Optional: tell it what to do, e.g. “Group the Q4 planning notes into a project and list next actions.”"
                  value={instruction}
                  disabled={busy || running}
                  onChange={(e) => setInstruction(e.target.value)}
                />
                <div className="agent-row">
                  <button
                    className="primary-button small"
                    disabled={busy || running}
                    onClick={() => start("organize")}
                  >
                    {instruction.trim() ? "Run" : "Organize workspace"}
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || running}
                    onClick={() => start("triage")}
                  >
                    Triage inbox
                  </button>
                  {running && <span className="agent-muted">Working…</span>}
                </div>
              </section>
            )}

            {runs.length > 0 && (
              <section className="agent-section">
                <h3>Activity</h3>
                <ol className="agent-runs">
                  {runs.map((run) => (
                    <li key={run.id} className={`agent-run is-${run.status}`}>
                      <div className="agent-run-head">
                        <strong>
                          {run.trigger === "capture"
                            ? "New capture"
                            : run.instruction
                              ? `“${run.instruction}”`
                              : run.mode === "triage"
                                ? "Triage inbox"
                                : "Organize workspace"}
                        </strong>
                        <small>
                          {run.status === "running"
                            ? "working…"
                            : timeAgo(run.created_at)}
                        </small>
                      </div>
                      {run.error && <p className="agent-error">{run.error}</p>}
                      {run.summary && <p>{run.summary}</p>}
                      {run.actions.length > 0 && (
                        <ul>
                          {run.actions.map((action) => (
                            <li
                              key={action.id}
                              className={action.undone_at ? "is-undone" : ""}
                            >
                              <div>
                                <span className="agent-note">
                                  {noteTitle(action)}
                                </span>
                                <span>{describe(action).join(" · ")}</span>
                                {action.reason && <small>{action.reason}</small>}
                              </div>
                              {action.undone_at ? (
                                <small>Undone</small>
                              ) : (
                                <button
                                  className="icon-button"
                                  aria-label="Undo this change"
                                  title="Undo"
                                  disabled={busy}
                                  onClick={() => undo(action)}
                                >
                                  <Undo2 size={14} />
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
