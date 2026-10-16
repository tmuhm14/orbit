"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound, PlugZap, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import type { Workspace } from "@/lib/notes";
import {
  CODE_LABELS, GRANT_OPTIONS, OPERATION_LABELS, fromKeys, grantKeys, grantSummary, keyDisplay, when,
  type AccessEvent, type AgentClient, type ClientGrant,
} from "@/lib/grants/view";
import type { Connection } from "@/lib/oauth/connections";
import { GUIDE_ANCHORS, guideHref, isDirty } from "@/lib/settings-sections";
import { ConfirmDialog, FormDialog, SidePanel } from "./side-panel";
import { CopyButton } from "./settings/copy";

async function send(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Request failed");
  return data;
}

const message = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);

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
    <caption className="sr-only">Access per space</caption>
    <thead><tr><th scope="col">Space</th>{GRANT_OPTIONS.map((o) => <th scope="col" key={o.capability}>{o.label}</th>)}</tr></thead>
    <tbody>{workspaces.map((space) => <tr key={space.id}>
      <th scope="row">{space.name}{!space.agentEnabled && <span className="agent-keys-off" title="Agent access is off for this space, so no key can use it until you turn it on."> · agent access off</span>}</th>
      {GRANT_OPTIONS.map((o) => {
        const key = `${space.id}:${o.capability}`;
        return <td key={o.capability}><label className="agent-keys-cell"><input id={`${idPrefix}-${key}`} type="checkbox" aria-label={`${o.label} ${space.name}`}
          checked={value.has(key)} disabled={disabled} onChange={() => toggle(key)} /></label></td>;
      })}
    </tr>)}</tbody>
  </table>;
}

const GRANT_HELP = "Read lists the space’s notes. Capture adds new Inbox notes; it can’t change or delete anything. Grant only what the bot needs.";

/**
 * New key in one dialog, two steps: name and access, then the one-time
 * reveal. Closing the reveal before "I’ve saved it" asks first.
 */
function CreateKeyDialog({ workspaces, onCreated, onClose, onToast }: {
  workspaces: Workspace[]; onCreated: () => Promise<void>; onClose: () => void; onToast: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  if (created) return (
    <FormDialog
      key="reveal"
      title="Copy your key now"
      description={<>You won’t see it again. Orbit keeps only a fingerprint of the key for <strong>{created.name}</strong>.</>}
      onClose={onClose}
      dirty
      discardTitle="Close without saving the key?"
      discardMessage={copied
        ? "Make sure the key is in your bot’s secret store. Orbit can’t show it again."
        : "You haven’t copied the key. Once this closes it can’t be shown again; you’d need to create a new one."}
      discardLabel="Close anyway"
      footer={
        <footer className="surface-footer">
          <div className="surface-footer-extra" />
          <div className="surface-footer-main">
            <button type="button" className="primary-button small" onClick={onClose}>I’ve saved it</button>
          </div>
        </footer>
      }
    >
      <div className="agent-keys-reveal">
        <code aria-label="New API key">{created.key}</code>
        <CopyButton text={created.key} label="Copy key" showLabel className="secondary-button" onToast={onToast} onCopied={() => setCopied(true)} />
      </div>
      <p className="settings-hint">Store it like a password: in the bot’s secret store or environment, never in prompts, logs or source control.</p>
    </FormDialog>
  );

  return (
    <FormDialog
      key="create"
      title="New API key"
      description="Give each bot its own key, so you can see and revoke each one separately."
      onClose={onClose}
      dirty={!!name || grants.size > 0}
      busy={busy}
      error={error}
      submitLabel="Create key"
      busyLabel="Creating…"
      submitDisabled={!name.trim()}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true); setError("");
        try {
          const data = await send("/api/agent-clients", { method: "POST", body: JSON.stringify({ name: name.trim(), grants: fromKeys(grants) }) });
          setCreated({ name: name.trim(), key: data.apiKey as string });
          setBusy(false);
          await onCreated().catch(() => undefined);
        } catch (failure) {
          setError(message(failure, "Couldn’t create the API key"));
          setBusy(false);
        }
      }}
    >
      <div className="settings-fields">
        <label className="settings-field">Name
          <input data-autofocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Grok bot" maxLength={100} required />
        </label>
        <fieldset className="settings-fieldset">
          <legend>Access</legend>
          <GrantGrid workspaces={workspaces} value={grants} onChange={setGrants} disabled={busy} idPrefix="new" />
          <p className="settings-hint">{GRANT_HELP}</p>
        </fieldset>
      </div>
    </FormDialog>
  );
}

/** Edit access for an API key or a connected app: both are agent clients with grants (ADR 007, ADR 008). */
function EditAccessPanel({ client, workspaces, onSaved, onClose }: {
  client: { id: string; name: string; grants: ClientGrant[]; keyPrefix?: string; redirectHosts?: string[] };
  workspaces: Workspace[]; onSaved: () => Promise<void>; onClose: () => void;
}) {
  const [initial] = useState(() => grantKeys(client.grants));
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = isDirty({ g: initial }, { g: draft });
  return (
    <SidePanel
      title={`Edit access for ‘${client.name}’`}
      description={client.keyPrefix
        ? <>Key <code>{keyDisplay(client.keyPrefix)}</code>. Changes apply on the bot’s next request.</>
        : <>Connected app returning to <strong>{client.redirectHosts?.join(", ")}</strong>. Changes apply on the app’s next request.</>}
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      submitLabel="Save access"
      submitDisabled={!dirty}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true); setError("");
        try {
          await send(`/api/agent-clients/${client.id}/grants`, { method: "PUT", body: JSON.stringify({ grants: fromKeys(draft) }) });
          await onSaved();
        } catch (failure) {
          setError(message(failure, "Couldn’t update the key"));
          setBusy(false);
        }
      }}
    >
      <GrantGrid workspaces={workspaces} value={draft} onChange={setDraft} disabled={busy} idPrefix={`edit-${client.id}`} />
      <p className="settings-hint">{GRANT_HELP}</p>
      <p className="settings-hint">A space whose agent access is off blocks every key and app, whatever it’s granted. Turn it on in Model &amp; agent.</p>
    </SidePanel>
  );
}

function ConnectionRow({ app, workspaces, onEdit, onDisconnect }: {
  app: Connection; workspaces: Workspace[]; onEdit?: () => void; onDisconnect?: () => void;
}) {
  const revoked = !!app.revokedAt;
  return <li className={`settings-row agent-keys-client${revoked ? " is-revoked" : ""}`}>
    <div className="settings-row-main">
      <strong>{app.name} <span className="agent-apps-host" title="Where Orbit sent you back when you connected it">{app.redirectHosts.join(", ")}</span></strong>
      <span className="settings-row-meta">
        <span>Connected {when(app.connectedAt)}</span>
        <span>Last used {when(app.lastUsedAt)}</span>
        {revoked ? <span>Disconnected {when(app.revokedAt)}</span> : <span className="agent-keys-grants">{grantSummary(app.grants, workspaces)}</span>}
      </span>
    </div>
    {!revoked && <div className="settings-row-actions">
      <button type="button" className="text-button" aria-haspopup="dialog" onClick={onEdit}>Edit access<span className="sr-only"> for {app.name}</span></button>
      <button type="button" className="text-button settings-danger-text" aria-haspopup="dialog" onClick={onDisconnect}>Disconnect<span className="sr-only"> {app.name}</span></button>
    </div>}
  </li>;
}

function ClientRow({ client, workspaces, onEdit, onRevoke }: {
  client: AgentClient; workspaces: Workspace[]; onEdit?: () => void; onRevoke?: () => void;
}) {
  const revoked = !!client.revokedAt;
  return <li className={`settings-row agent-keys-client${revoked ? " is-revoked" : ""}`}>
    <div className="settings-row-main">
      <strong>{client.name} <code className="agent-keys-prefix">{keyDisplay(client.keyPrefix)}</code></strong>
      <span className="settings-row-meta">
        <span>Created {when(client.createdAt)}</span>
        <span>Last used {when(client.lastUsedAt)}</span>
        {revoked ? <span>Revoked {when(client.revokedAt)}</span> : <span className="agent-keys-grants">{grantSummary(client.grants, workspaces)}</span>}
      </span>
    </div>
    {!revoked && <div className="settings-row-actions">
      <button type="button" className="text-button" aria-haspopup="dialog" onClick={onEdit}>Edit access<span className="sr-only"> for {client.name}</span></button>
      <button type="button" className="text-button settings-danger-text" aria-haspopup="dialog" onClick={onRevoke}>Revoke<span className="sr-only"> {client.name}</span></button>
    </div>}
  </li>;
}

/** Settings → Agents & API keys: connected apps (ADR 008), API keys (A-05) and the access log. */
export function AgentKeysSettings({ workspaces, onToast }: { workspaces: Workspace[]; onToast: (message: string) => void }) {
  const [clients, setClients] = useState<AgentClient[] | null>(null);
  const [apps, setApps] = useState<Connection[] | null>(null);
  const [events, setEvents] = useState<AccessEvent[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentClient | Connection | null>(null);
  const [revoking, setRevoking] = useState<AgentClient | null>(null);
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);

  const refresh = useCallback(async () => {
    const [list, connected, log] = await Promise.all([send("/api/agent-clients"), send("/api/oauth/connections"),
      send("/api/agent-clients/access-log?limit=50")]);
    setClients(list.clients as AgentClient[]);
    setApps(connected.connections as Connection[]);
    setEvents(log.events as AccessEvent[]);
    setError("");
  }, []);
  useEffect(() => {
    void refresh().catch((failure) => setError(message(failure, "Couldn’t load API keys")));
  }, [refresh]);

  const clientName = (id: string | null) => clients?.find((c) => c.id === id)?.name ??
    (apps?.find((a) => a.id === id) ? `${apps.find((a) => a.id === id)!.name} (app)` : "Deleted key or app");
  const spaceName = (id: string | null) => (id && workspaces.find((w) => w.id === id)?.name) || (id ? "Deleted space" : "—");
  const active = clients?.filter((c) => !c.revokedAt) ?? [];
  const revoked = clients?.filter((c) => c.revokedAt) ?? [];
  const activeApps = apps?.filter((a) => !a.revokedAt) ?? [];
  const pastApps = apps?.filter((a) => a.revokedAt) ?? [];

  return <>
    <section className="settings-card" aria-labelledby="agent-apps-list">
      <div className="settings-card-heading">
        <div>
          <h2 id="agent-apps-list"><PlugZap size={15} aria-hidden="true" /> Connected apps</h2>
          <p>Apps such as Grok or Claude that you connected to Orbit’s MCP server by signing in and approving them. <Link href={guideHref(GUIDE_ANCHORS.connectApps)}>How do I connect one?</Link></p>
        </div>
      </div>
      {!apps ? <p className="settings-empty" role="status">{error ? "Unavailable." : "Loading…"}</p> : !activeApps.length
        ? <p className="settings-empty">No connected apps. Add Orbit as a custom connector in Grok or Claude, then approve it here.</p>
        : <ul className="settings-list">{activeApps.map((a) => <ConnectionRow key={a.id} app={a} workspaces={workspaces}
            onEdit={() => setEditing(a)} onDisconnect={() => setDisconnecting(a)} />)}</ul>}
      {pastApps.length > 0 && <details className="agent-keys-revoked"><summary>{pastApps.length} disconnected</summary>
        <ul className="settings-list">{pastApps.map((a) => <ConnectionRow key={a.id} app={a} workspaces={workspaces} />)}</ul></details>}
    </section>

    <section className="settings-card" aria-labelledby="agent-keys-list">
      <div className="settings-card-heading has-action">
        <div>
          <h2 id="agent-keys-list"><KeyRound size={15} aria-hidden="true" /> API keys</h2>
          <p>Each external agent or bot gets its own key, limited to the spaces and actions you choose. <Link href={guideHref(GUIDE_ANCHORS.externalBots)}>How do I set this up?</Link></p>
        </div>
        <button type="button" className="secondary-button" aria-haspopup="dialog" disabled={!clients} onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" /> New key
        </button>
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {!clients ? <p className="settings-empty" role="status">{error ? "Unavailable." : "Loading…"}</p> : !active.length
        ? <p className="settings-empty">No active keys. Create one for each bot that should read or capture notes.</p>
        : <ul className="settings-list">{active.map((c) => <ClientRow key={c.id} client={c} workspaces={workspaces}
            onEdit={() => setEditing(c)} onRevoke={() => setRevoking(c)} />)}</ul>}
      {revoked.length > 0 && <details className="agent-keys-revoked"><summary>{revoked.length} revoked</summary>
        <ul className="settings-list">{revoked.map((c) => <ClientRow key={c.id} client={c} workspaces={workspaces} />)}</ul></details>}
    </section>

    <section className="settings-card" aria-labelledby="agent-keys-log">
      <div className="settings-card-heading has-action">
        <div>
          <h2 id="agent-keys-log"><ShieldCheck size={15} aria-hidden="true" /> Recent access</h2>
          <p>What each key and connected app did, never what it read or wrote. Kept 90 days. <Link href={guideHref(GUIDE_ANCHORS.accessLog)}>Reading the log</Link></p>
        </div>
        <button type="button" className="icon-button" aria-label="Refresh access log" title="Refresh"
          onClick={() => void refresh().then(() => onToast("Access log refreshed"), () => onToast("Couldn’t refresh"))}><RefreshCw size={14} /></button>
      </div>
      {!events ? <p className="settings-empty">{error ? "Unavailable." : "Loading…"}</p> : !events.length
        ? <p className="settings-empty">No access yet.</p>
        : <div className="agent-keys-events-wrap"><table className="agent-keys-events">
          <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Space</th><th scope="col">Result</th></tr></thead>
          <tbody>{events.map((e) => <tr key={e.id} className={e.outcome === "denied" ? "is-denied" : undefined}>
            <td>{when(e.occurredAt)}</td>
            <td>{e.principalType === "user_token" ? "Session token (deprecated)" : clientName(e.clientId)}</td>
            <td>{OPERATION_LABELS[e.operation] ?? e.operation}</td>
            <td>{spaceName(e.workspaceId)}</td>
            <td>{e.outcome === "allowed" ? "Allowed" : `Refused · ${CODE_LABELS[e.code ?? ""] ?? e.code}`}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    {creating && <CreateKeyDialog workspaces={workspaces} onToast={onToast} onClose={() => setCreating(false)} onCreated={refresh} />}
    {editing && <EditAccessPanel client={editing} workspaces={workspaces} onClose={() => setEditing(null)}
      onSaved={async () => { await refresh(); setEditing(null); onToast("Access updated"); }} />}
    {disconnecting && <ConfirmDialog
      tone="danger"
      title={`Disconnect ‘${disconnecting.name}’?`}
      body={<>The app loses access on its next request, and every token it holds stops working. This can’t be undone.</>}
      hint="To use it again, add Orbit in the app once more and approve it."
      confirmLabel="Disconnect"
      onCancel={() => setDisconnecting(null)}
      onConfirm={async () => {
        await send(`/api/oauth/connections/${disconnecting.id}/disconnect`, { method: "POST" });
        await refresh().catch(() => undefined);
        onToast(`${disconnecting.name} disconnected`);
        setDisconnecting(null);
      }}
    />}
    {revoking && <ConfirmDialog
      tone="danger"
      title={`Revoke ‘${revoking.name}’?`}
      body={<>Key <code>{keyDisplay(revoking.keyPrefix)}</code> stops working on its next request. This can’t be undone.</>}
      hint="To keep the bot running, create a new key first and swap it in."
      confirmLabel="Revoke key"
      onCancel={() => setRevoking(null)}
      onConfirm={async () => {
        await send(`/api/agent-clients/${revoking.id}/revoke`, { method: "POST" });
        await refresh().catch(() => undefined);
        onToast(`${revoking.name} revoked`);
        setRevoking(null);
      }}
    />}
  </>;
}
