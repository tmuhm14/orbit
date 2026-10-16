"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Plus, RefreshCw } from "lucide-react";
import type { Workspace } from "@/lib/notes";
import {
  CODE_LABELS, GRANT_OPTIONS, OPERATION_LABELS, fromKeys, grantKeys, grantSummary, keyDisplay, when,
  type AccessEvent, type AgentClient,
} from "@/lib/grants/view";

async function send(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Request failed");
  return data;
}

/** Checkbox grid: one row per space, one column per capability. */
function GrantGrid({ workspaces, value, onChange, disabled, idPrefix }: {
  workspaces: Workspace[]; value: Set<string>; onChange: (next: Set<string>) => void; disabled?: boolean; idPrefix: string;
}) {
  const toggle = (key: string) => {
    const next = new Set(value);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange(next);
  };
  return <table className="agent-keys-grid">
    <thead><tr><th scope="col">Space</th>{GRANT_OPTIONS.map((o) => <th scope="col" key={o.capability}>{o.label}</th>)}</tr></thead>
    <tbody>{workspaces.map((space) => <tr key={space.id}>
      <th scope="row">{space.name}{!space.agentEnabled && <span className="agent-keys-off" title="Agent access is off for this space, so no key can use it until you turn it on."> · agent access off</span>}</th>
      {GRANT_OPTIONS.map((o) => {
        const key = `${space.id}:${o.capability}`;
        return <td key={o.capability}><input id={`${idPrefix}-${key}`} type="checkbox" aria-label={`${o.label} ${space.name}`}
          checked={value.has(key)} disabled={disabled} onChange={() => toggle(key)} /></td>;
      })}
    </tr>)}</tbody>
  </table>;
}

function ClientRow({ client, workspaces, onChanged, onToast }: {
  client: AgentClient; workspaces: Workspace[]; onChanged: () => Promise<void>; onToast: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => grantKeys(client.grants));
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try { await action(); await onChanged(); onToast(success); setEditing(false); }
    catch (failure) { onToast(failure instanceof Error ? failure.message : "Could not update the key"); }
    finally { setBusy(false); }
  }
  const revoked = !!client.revokedAt;
  return <li className={`agent-keys-client${revoked ? " is-revoked" : ""}`}>
    <div className="agent-keys-client-main">
      <div className="agent-keys-client-name"><strong>{client.name}</strong><code>{keyDisplay(client.keyPrefix)}</code></div>
      <div className="agent-keys-client-meta">
        <span>Created {when(client.createdAt)}</span>
        <span>Last used {when(client.lastUsedAt)}</span>
        {revoked ? <span>Revoked {when(client.revokedAt)}</span> : <span>{grantSummary(client.grants, workspaces)}</span>}
      </div>
    </div>
    {!revoked && <div className="agent-keys-client-actions">
      <button className="text-button" disabled={busy} onClick={() => { setDraft(grantKeys(client.grants)); setEditing(!editing); }}>
        {editing ? "Cancel" : "Edit access"}</button>
      <button className="text-button agent-keys-revoke" disabled={busy} onClick={() => {
        if (confirm(`Revoke ${client.name}? It stops working on its next request.`))
          void run(() => send(`/api/agent-clients/${client.id}/revoke`, { method: "POST" }), "Key revoked");
      }}>Revoke</button>
    </div>}
    {editing && <div className="agent-keys-edit">
      <GrantGrid workspaces={workspaces} value={draft} onChange={setDraft} disabled={busy} idPrefix={`edit-${client.id}`} />
      <button className="secondary-button" disabled={busy} onClick={() => void run(() => send(`/api/agent-clients/${client.id}/grants`,
        { method: "PUT", body: JSON.stringify({ grants: fromKeys(draft) }) }), "Access updated")}>{busy ? "Saving…" : "Save access"}</button>
    </div>}
  </li>;
}

/** Settings → Connections → Agents & API keys. */
export function AgentKeysSettings({ workspaces, onToast }: { workspaces: Workspace[]; onToast: (message: string) => void }) {
  const [clients, setClients] = useState<AgentClient[] | null>(null);
  const [events, setEvents] = useState<AccessEvent[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const [list, log] = await Promise.all([send("/api/agent-clients"), send("/api/agent-clients/access-log?limit=50")]);
    setClients(list.clients as AgentClient[]);
    setEvents(log.events as AccessEvent[]);
    setError("");
  }, []);
  useEffect(() => {
    void refresh().catch((failure) => setError(failure instanceof Error ? failure.message : "Could not load API keys"));
  }, [refresh]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const data = await send("/api/agent-clients", { method: "POST", body: JSON.stringify({ name: name.trim(), grants: fromKeys(grants) }) });
      setNewKey({ name: name.trim(), key: data.apiKey as string });
      setCopied(false);
      setName(""); setGrants(new Set());
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not create the API key");
    } finally { setBusy(false); }
  }

  const clientName = (id: string | null) => clients?.find((c) => c.id === id)?.name ?? "Deleted key";
  const spaceName = (id: string | null) => (id && workspaces.find((w) => w.id === id)?.name) || (id ? "Deleted space" : "—");
  const active = clients?.filter((c) => !c.revokedAt) ?? [];
  const revoked = clients?.filter((c) => c.revokedAt) ?? [];

  return <section className="settings-card settings-card-wide" aria-labelledby="settings-agent-keys">
    <div className="settings-card-heading"><div><h2 id="settings-agent-keys">Agents & API keys</h2>
      <p>Give each external agent or bot its own key, limited to the spaces and actions you choose. Revoking a key or removing access applies on its next request.</p></div></div>
    {error && <p className="scheduled-error" role="alert">{error}</p>}

    {newKey && <div className="agent-keys-reveal" role="status">
      <div><strong>Copy the key for {newKey.name} now.</strong> Orbit stores only a fingerprint and won’t show it again.</div>
      <div className="agent-keys-reveal-row">
        <code aria-label="New API key">{newKey.key}</code>
        <button className="icon-button" aria-label="Copy API key" onClick={() => void navigator.clipboard.writeText(newKey.key)
          .then(() => { setCopied(true); onToast("API key copied"); }, () => onToast("Could not copy the key"))}>
          {copied ? <Check size={15} /> : <Copy size={15} />}</button>
      </div>
      <button className="text-button" onClick={() => setNewKey(null)}>I’ve saved it</button>
    </div>}

    <div className="agent-keys-layout">
      <form className="settings-service agent-keys-create" onSubmit={create}>
        <div className="settings-service-heading"><h3><KeyRound size={13} /> New key</h3></div>
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Grok bot" maxLength={100} required /></label>
        <GrantGrid workspaces={workspaces} value={grants} onChange={setGrants} disabled={busy} idPrefix="new" />
        <p className="settings-help">Read lists the space’s notes. Capture adds new Inbox notes; it can’t change or delete anything.</p>
        <button className="secondary-button" type="submit" disabled={busy || !name.trim()}><Plus size={14} /> {busy ? "Creating…" : "Create key"}</button>
      </form>

      <div className="agent-keys-clients">
        <h3>Keys</h3>
        {!clients ? <p className="agent-muted">{error ? "Unavailable." : "Loading…"}</p> : !active.length
          ? <p className="agent-muted">No active keys.</p>
          : <ul>{active.map((c) => <ClientRow key={`${c.id}:${c.grants.length}:${c.lastUsedAt}`} client={c} workspaces={workspaces} onChanged={refresh} onToast={onToast} />)}</ul>}
        {revoked.length > 0 && <details className="agent-keys-revoked"><summary>{revoked.length} revoked</summary>
          <ul>{revoked.map((c) => <ClientRow key={c.id} client={c} workspaces={workspaces} onChanged={refresh} onToast={onToast} />)}</ul></details>}
      </div>
    </div>

    <div className="agent-keys-log">
      <div className="agent-keys-log-heading"><h3>Recent access</h3>
        <button className="icon-button" aria-label="Refresh access log" onClick={() => void refresh().catch(() => onToast("Could not refresh"))}><RefreshCw size={14} /></button></div>
      {!events ? <p className="agent-muted">{error ? "Unavailable." : "Loading…"}</p> : !events.length
        ? <p className="agent-muted">No access yet.</p>
        : <table className="agent-keys-events">
          <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Space</th><th scope="col">Result</th></tr></thead>
          <tbody>{events.map((e) => <tr key={e.id} className={e.outcome === "denied" ? "is-denied" : undefined}>
            <td>{when(e.occurredAt)}</td>
            <td>{e.principalType === "user_token" ? "Session token (deprecated)" : clientName(e.clientId)}</td>
            <td>{OPERATION_LABELS[e.operation] ?? e.operation}</td>
            <td>{spaceName(e.workspaceId)}</td>
            <td>{e.outcome === "allowed" ? "Allowed" : `Refused · ${CODE_LABELS[e.code ?? ""] ?? e.code}`}</td>
          </tr>)}</tbody>
        </table>}
      <p className="settings-help">Shows what each agent did, never what it read or wrote. Kept 90 days.</p>
    </div>
  </section>;
}
