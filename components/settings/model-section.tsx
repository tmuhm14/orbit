"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bot, KeyRound, Settings2 } from "lucide-react";
import { PROVIDERS, type ProviderId } from "@/lib/agent/providers";
import { workspaceColor, type Workspace } from "@/lib/notes";
import { GUIDE_ANCHORS, guideHref, isDirty, maskedHint } from "@/lib/settings-sections";
import { ConfirmDialog, SidePanel } from "../side-panel";
import { SpaceDot } from "./spaces-section";

type AgentSettings = { provider: ProviderId; model: string; keyHint: string; autoTriage: boolean };

async function send(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method, cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Request failed");
  return data;
}

/** Provider, key, model and auto-triage: the same PUT the Agent dialog uses. */
function ModelPanel({ settings, models, onSaved, onRemoved, onClose }: {
  settings: AgentSettings | null;
  models: string[];
  onSaved: (settings: AgentSettings, models: string[]) => void;
  onRemoved: () => void;
  onClose: () => void;
}) {
  const initial = {
    provider: settings?.provider ?? ("anthropic" as ProviderId),
    model: settings?.model ?? PROVIDERS.anthropic.defaultModel,
    apiKey: "",
    autoTriage: settings?.autoTriage ?? true,
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const providerChanged = !!settings && settings.provider !== form.provider;
  const needsKey = !settings || providerChanged;
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  return (
    <SidePanel
      title={settings ? "Change model or key" : "Connect a model provider"}
      description="The organizing agent and delegated assignments use this provider. Usage is billed to your provider account."
      onClose={onClose}
      dirty={isDirty(initial, form)}
      busy={busy}
      error={error}
      submitLabel={form.apiKey ? "Check key and save" : "Save"}
      busyLabel="Checking…"
      submitDisabled={(needsKey && !form.apiKey.trim()) || !form.model.trim()}
      extraActions={settings && (
        <button type="button" className="text-button settings-danger-text" disabled={busy} onClick={() => setRemoving(true)}>
          Remove key
        </button>
      )}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true); setError("");
        try {
          const data = await send("/api/agent/settings", "PUT", {
            provider: form.provider, model: form.model, apiKey: form.apiKey || undefined, autoTriage: form.autoTriage,
          });
          onSaved(data.settings, data.models ?? []);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : "Couldn’t save model settings");
          setBusy(false);
        }
      }}
    >
      <div className="settings-fields">
        <label className="settings-field">
          Provider
          <select data-autofocus value={form.provider} onChange={(event) => {
            const next = event.target.value as ProviderId;
            set({ provider: next, model: settings?.provider === next ? settings.model : PROVIDERS[next].defaultModel });
          }}>
            {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => <option key={id} value={id}>{PROVIDERS[id].name}</option>)}
          </select>
        </label>
        <label className="settings-field">
          API key
          <input type="password" autoComplete="off" spellCheck={false} value={form.apiKey}
            onChange={(event) => set({ apiKey: event.target.value })} required={needsKey}
            placeholder={settings && !providerChanged ? `Saved key ${maskedHint(settings.keyHint)}` : `${PROVIDERS[form.provider].name} API key`} />
        </label>
        <p className="settings-hint">
          {needsKey ? `Paste a key from your ${PROVIDERS[form.provider].name} account.` : "Leave blank to keep the saved key."} Orbit checks it, encrypts it on the server and never shows it again.
        </p>
        <label className="settings-field">
          Model
          <input list="settings-models" value={form.model} onChange={(event) => set({ model: event.target.value })} required spellCheck={false} />
          <datalist id="settings-models">{(providerChanged ? [] : models).map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={form.autoTriage} onChange={(event) => set({ autoTriage: event.target.checked })} />
          Triage Slack and email captures as they arrive
        </label>
      </div>
      {removing && (
        <ConfirmDialog
          tone="danger"
          title={`Remove the ${PROVIDERS[settings!.provider].name} key?`}
          body="The organizing agent and delegation stop until you add a key again."
          confirmLabel="Remove key"
          onCancel={() => setRemoving(false)}
          onConfirm={async () => {
            await send("/api/agent/settings", "DELETE");
            onRemoved();
          }}
        />
      )}
    </SidePanel>
  );
}

export function ModelSection({ available, workspaces, onSetAgentEnabled, onOpenAgent, onToast }: {
  available: boolean;
  workspaces: Workspace[];
  onSetAgentEnabled: (id: string, enabled: boolean) => Promise<unknown>;
  onOpenAgent: () => void;
  onToast: (message: string) => void;
}) {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [enabling, setEnabling] = useState<Workspace | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!available) return;
    void send("/api/agent/settings")
      .then((data) => { setSettings(data.settings ?? null); setModels(data.models ?? []); })
      .catch((failure) => setLoadError(failure instanceof Error ? failure.message : "Couldn’t load model settings"))
      .finally(() => setLoaded(true));
  }, [available]);

  async function turnOff(space: Workspace) {
    setBusyId(space.id);
    try { await onSetAgentEnabled(space.id, false); onToast(`Agent off in ${space.name}`); }
    catch { onToast("Couldn’t change the agent setting"); }
    finally { setBusyId(null); }
  }

  const providerName = PROVIDERS[settings?.provider ?? "anthropic"].name;
  return (
    <>
      <section className="settings-card" aria-labelledby="model-provider">
        <div className="settings-card-heading has-action">
          <div>
            <h2 id="model-provider"><KeyRound size={15} aria-hidden="true" /> Model provider</h2>
            <p>Bring your own key from Anthropic, OpenAI or xAI. <Link href={guideHref(GUIDE_ANCHORS.organizingAgent)}>How do I set this up?</Link></p>
          </div>
          {available && loaded && !loadError && (
            <button type="button" className="secondary-button" aria-haspopup="dialog" onClick={() => setEditing(true)}>
              {settings ? "Change model or key" : "Connect a provider"}
            </button>
          )}
        </div>
        {!available ? (
          <p className="settings-empty">Model connections need the server encryption key (AGENT_ENCRYPTION_KEY) configured.</p>
        ) : !loaded ? (
          <p className="settings-empty" role="status">Loading…</p>
        ) : loadError ? (
          <p className="settings-error" role="alert">{loadError}</p>
        ) : settings ? (
          <dl className="settings-summary">
            <div><dt>Provider</dt><dd>{providerName} <span className="settings-badge is-on">Connected</span></dd></div>
            <div><dt>Model</dt><dd><code>{settings.model}</code></dd></div>
            <div><dt>API key</dt><dd><code>{maskedHint(settings.keyHint)}</code></dd></div>
            <div><dt>Auto-triage</dt><dd>{settings.autoTriage ? "On: new Slack and email captures are triaged as they arrive" : "Off"}</dd></div>
          </dl>
        ) : (
          <p className="settings-empty">No provider connected. The organizing agent and delegation need one.</p>
        )}
      </section>

      <section className="settings-card" aria-labelledby="model-spaces">
        <div className="settings-card-heading has-action">
          <div>
            <h2 id="model-spaces"><Bot size={15} aria-hidden="true" /> Where the agent may work</h2>
            <p>The agent, delegation and external API keys can only use spaces that are on. Turning a space off stops all of them there immediately.</p>
          </div>
          <button type="button" className="secondary-button" aria-haspopup="dialog" onClick={onOpenAgent}>
            <Settings2 size={14} aria-hidden="true" /> Open the Agent
          </button>
        </div>
        <ul className="settings-list">
          {workspaces.map((space) => (
            <li key={space.id} className="settings-row">
              <div className="settings-row-main">
                <strong id={`agent-space-${space.id}`}><SpaceDot color={workspaceColor(workspaces, space.id)} /> {space.name}</strong>
                <span className="settings-row-meta">{space.agentEnabled ? "The agent may read and change notes here" : "Off: nothing here is sent to a model"}</span>
              </div>
              <div className="settings-row-actions">
                <button
                  type="button"
                  role="switch"
                  className="settings-switch"
                  aria-checked={space.agentEnabled}
                  aria-labelledby={`agent-space-${space.id}`}
                  aria-describedby="agent-switch-label"
                  disabled={busyId === space.id}
                  onClick={() => (space.agentEnabled ? void turnOff(space) : setEnabling(space))}
                >
                  <span aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
        <p className="sr-only" id="agent-switch-label">Allow the agent to read and change notes in this space</p>
      </section>

      {editing && (
        <ModelPanel
          settings={settings}
          models={models}
          onClose={() => setEditing(false)}
          onSaved={(next, nextModels) => { setSettings(next); setModels(nextModels); setEditing(false); onToast("Model settings saved"); }}
          onRemoved={() => { setSettings(null); setModels([]); setEditing(false); onToast("API key removed"); }}
        />
      )}
      {enabling && (
        <ConfirmDialog
          title={`Allow the agent in ${enabling.name}?`}
          body={`Notes in ${enabling.name} will be sent to ${providerName}. Don't allow this for spaces that may hold patient or other regulated data unless your agreement with the provider covers it.`}
          hint="Only this space is affected. You can turn it off here at any time."
          confirmLabel="Allow the agent"
          onCancel={() => setEnabling(null)}
          onConfirm={async () => {
            try { await onSetAgentEnabled(enabling.id, true); }
            catch { throw new Error("Couldn’t turn on the agent. Try again."); }
            onToast(`Agent on in ${enabling.name}`);
            setEnabling(null);
          }}
        />
      )}
    </>
  );
}
