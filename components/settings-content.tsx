"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Copy, Mail, Plus, RefreshCw, Settings2, Star, Unlink } from "lucide-react";
import { inboundAddress } from "@/lib/email-address";
import { PROVIDERS, type ProviderId } from "@/lib/agent/providers";
import { WORKSPACE_COLORS, workspaceColor, type SlackConnection, type Workspace, type WorkspaceColor } from "@/lib/notes";
import { sendScheduled, type ScheduledConnection } from "@/lib/scheduled/client";
import { signOut } from "@/app/auth/actions";

type AgentSettings = {
  provider: ProviderId;
  model: string;
  keyHint: string;
  autoTriage: boolean;
};

function SpaceSettingsRow({ space, workspaces, onSetDefault, onRename, onRecolor, onToast }: {
  space: Workspace;
  workspaces: Workspace[];
  onSetDefault: (id: string) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onRecolor: (id: string, color: string) => Promise<unknown>;
  onToast: (message: string) => void;
}) {
  const [name, setName] = useState(space.name);
  useEffect(() => setName(space.name), [space.name]);
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try { await action(); onToast(success); }
    catch { onToast("Could not update space"); }
    finally { setBusy(false); }
  }
  return <div className="settings-space-row">
    <form className="settings-space-name" onSubmit={(event) => { event.preventDefault(); if (name.trim() && name.trim() !== space.name) void run(() => onRename(space.id, name.trim()), "Space renamed"); }}>
      <label className="sr-only" htmlFor={`space-name-${space.id}`}>Name for {space.name}</label>
      <input id={`space-name-${space.id}`} value={name} onChange={(event) => setName(event.target.value)} maxLength={60} disabled={busy} />
      {name.trim() !== space.name && <button className="text-button" type="submit" disabled={busy || !name.trim()}>Save</button>}
    </form>
    <select aria-label={`Color for ${space.name}`} value={space.color ?? workspaceColor(workspaces, space.id)} disabled={busy} onChange={(event) => void run(() => onRecolor(space.id, event.target.value as WorkspaceColor), "Space color updated")}>
      {(Object.keys(WORKSPACE_COLORS) as WorkspaceColor[]).map((color) => <option key={color} value={color}>{color[0].toUpperCase() + color.slice(1)}</option>)}
    </select>
    <button className="text-button" disabled={space.isDefault || busy} onClick={() => void run(() => onSetDefault(space.id), "Default space updated")}>
      {space.isDefault ? <><Star size={12} fill="currentColor" /> Default</> : "Make default"}
    </button>
  </div>;
}

export function SettingsContent({
  email, workspaces, slack, inboundDomain, agentAvailable,
  onSetDefault, onCreateSpace, onRenameSpace, onRecolorSpace,
  onNewAddress, onRouteSlack, onDisconnectSlack,
  onOpenScheduled, onToast,
}: {
  email: string;
  workspaces: Workspace[];
  slack: SlackConnection[];
  inboundDomain: string | null;
  agentAvailable: boolean;
  onSetDefault: (id: string) => Promise<unknown>;
  onCreateSpace: (name: string) => Promise<unknown>;
  onRenameSpace: (id: string, name: string) => Promise<unknown>;
  onRecolorSpace: (id: string, color: string) => Promise<unknown>;
  onNewAddress: (id: string) => Promise<unknown>;
  onRouteSlack: (link: SlackConnection, workspaceId: string) => Promise<unknown>;
  onDisconnectSlack: (link: SlackConnection) => Promise<unknown>;
  onOpenScheduled: () => void;
  onToast: (message: string) => void;
}) {
  const [connection, setConnection] = useState<ScheduledConnection | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [jiraSite, setJiraSite] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraToken, setJiraToken] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [jiraBusy, setJiraBusy] = useState(false);
  const [githubBusy, setGithubBusy] = useState(false);
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [agentLoaded, setAgentLoaded] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [model, setModel] = useState<string>(PROVIDERS.anthropic.defaultModel);
  const [apiKey, setApiKey] = useState("");
  const [autoTriage, setAutoTriage] = useState(true);
  const [spaceName, setSpaceName] = useState("");
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);

  async function refreshConnections() {
    const data = await sendScheduled("/api/scheduled-tasks/connections");
    const next = data.connection as ScheduledConnection;
    setConnection(next);
    setJiraSite(next.jiraSite ?? "");
    setJiraEmail(next.jiraEmail ?? "");
  }

  useEffect(() => {
    void refreshConnections().catch((failure) => setConnectionError(failure instanceof Error ? failure.message : "Could not load connections"));
    void fetch("/api/agent/settings", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load model settings");
        const next = data.settings as AgentSettings | null;
        setAgentSettings(next);
        if (next) {
          setProvider(next.provider);
          setModel(next.model);
          setAutoTriage(next.autoTriage);
        }
      })
      .catch((failure) => setAgentError(failure instanceof Error ? failure.message : "Could not load model settings"))
      .finally(() => setAgentLoaded(true));
  }, []);

  async function saveJira(event: React.FormEvent) {
    event.preventDefault(); setJiraBusy(true); setConnectionError("");
    try {
      await sendScheduled("/api/scheduled-tasks/connections", "PUT", {
        source: "jira", jiraSite, jiraEmail, jiraToken,
      });
      setJiraToken("");
      await refreshConnections();
      onToast("Jira connection saved");
    } catch (failure) {
      setConnectionError(failure instanceof Error ? failure.message : "Could not save Jira");
    } finally { setJiraBusy(false); }
  }

  async function saveGitHub(event: React.FormEvent) {
    event.preventDefault(); setGithubBusy(true); setConnectionError("");
    try {
      await sendScheduled("/api/scheduled-tasks/connections", "PUT", {
        source: "github", githubToken,
      });
      setGithubToken("");
      await refreshConnections();
      onToast("GitHub connection saved");
    } catch (failure) {
      setConnectionError(failure instanceof Error ? failure.message : "Could not save GitHub");
    } finally { setGithubBusy(false); }
  }

  async function disconnect(source: "jira" | "github") {
    if (!confirm(`Disconnect ${source === "jira" ? "Jira" : "GitHub"}? Jobs that use it will be paused.`)) return;
    const busy = source === "jira" ? setJiraBusy : setGithubBusy;
    busy(true); setConnectionError("");
    try {
      await sendScheduled(`/api/scheduled-tasks/connections?source=${source}`, "DELETE");
      await refreshConnections();
      onToast(`${source === "jira" ? "Jira" : "GitHub"} disconnected`);
    } catch (failure) {
      setConnectionError(failure instanceof Error ? failure.message : "Could not disconnect");
    } finally { busy(false); }
  }

  async function saveAgent(event: React.FormEvent) {
    event.preventDefault(); setAgentBusy(true); setAgentError("");
    try {
      const response = await fetch("/api/agent/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, apiKey: apiKey || undefined, autoTriage }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save model settings");
      setAgentSettings(data.settings);
      setApiKey("");
      onToast("Model connection saved");
    } catch (failure) {
      setAgentError(failure instanceof Error ? failure.message : "Could not save model settings");
    } finally { setAgentBusy(false); }
  }

  async function createSpace(event: React.FormEvent) {
    event.preventDefault();
    if (!spaceName.trim()) return;
    setSpaceBusy(true);
    try {
      await onCreateSpace(spaceName.trim());
      setSpaceName("");
      onToast("Space created");
    } catch { onToast("Could not create space"); }
    finally { setSpaceBusy(false); }
  }

  async function runCapture(action: () => Promise<unknown>, success: string) {
    setCaptureBusy(true);
    try { await action(); onToast(success); }
    catch { onToast("Could not update capture settings"); }
    finally { setCaptureBusy(false); }
  }

  const providerChanged = !!agentSettings && agentSettings.provider !== provider;

  return (
    <main className="settings-page">
      <header className="settings-page-header">
        <Settings2 size={26} className="purple" />
        <div><div className="eyebrow">YOUR ORBIT</div><h1>Settings</h1><p>Manage your account, spaces, and the services Orbit connects to.</p></div>
      </header>

      <div className="settings-grid">
        <section className="settings-card settings-card-wide" aria-labelledby="settings-connections">
          <div className="settings-card-heading"><div><h2 id="settings-connections">Connections</h2><p>Connect each service once, then choose its work in a scheduled job.</p></div></div>
          {connectionError && <p className="scheduled-error" role="alert">{connectionError}</p>}
          {!connection && !connectionError ? <p className="agent-muted">Loading connections…</p> : connection && (
            <div className="settings-connection-grid">
              <form className="settings-service" onSubmit={saveJira}>
                <div className="settings-service-heading"><h3>Jira</h3><span>{connection.jiraConnected ? `Connected · token ending ${connection.jiraHint}` : "Not connected"}</span></div>
                <label>Site<input type="url" value={jiraSite} onChange={(event) => setJiraSite(event.target.value)} placeholder="https://your-team.atlassian.net" required /></label>
                <label>Account email<input type="email" value={jiraEmail} onChange={(event) => setJiraEmail(event.target.value)} placeholder="you@example.com" required /></label>
                <label>API token<input type="password" value={jiraToken} onChange={(event) => setJiraToken(event.target.value)} placeholder={connection.jiraConnected ? "Leave blank to keep saved token" : "Paste an API token"} autoComplete="off" required={!connection.jiraConnected} /></label>
                <button className="secondary-button" type="submit" disabled={jiraBusy}>{jiraBusy ? "Checking…" : "Save Jira"}</button>
                {connection.jiraConnected && <button className="text-button" type="button" disabled={jiraBusy} onClick={() => void disconnect("jira")}>Disconnect Jira</button>}
              </form>
              <form className="settings-service" onSubmit={saveGitHub}>
                <div className="settings-service-heading"><h3>GitHub</h3><span>{connection.githubConnected ? `Connected · token ending ${connection.githubHint}` : "Not connected"}</span></div>
                <label>Personal access token<input type="password" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} placeholder={connection.githubConnected ? "Leave blank to keep saved token" : "Paste a read-only token"} autoComplete="off" required={!connection.githubConnected} /></label>
                <p className="settings-help">Choose the repositories this token can read. Give it Contents and Pull requests read access.</p>
                <button className="secondary-button" type="submit" disabled={githubBusy || !githubToken.trim()}>{githubBusy ? "Checking…" : "Save GitHub"}</button>
                {connection.githubConnected && <button className="text-button" type="button" disabled={githubBusy} onClick={() => void disconnect("github")}>Disconnect GitHub</button>}
              </form>
            </div>
          )}
          <div className="settings-card-footer"><span>Tokens are encrypted on the server and are never shown again.</span><button className="text-button" onClick={onOpenScheduled}>Manage scheduled jobs</button></div>
        </section>

        <section className="settings-card" aria-labelledby="settings-model">
          <div className="settings-card-heading"><div><h2 id="settings-model">Model provider</h2><p>Used by the organizing agent.</p></div></div>
          {!agentAvailable ? <p className="agent-muted">Model connections need the server encryption key configured.</p> : !agentLoaded ? <p className="agent-muted">Loading…</p> : (
            <form className="settings-service" onSubmit={saveAgent}>
              <label>Provider<select value={provider} onChange={(event) => { const next = event.target.value as ProviderId; setProvider(next); setModel(agentSettings?.provider === next ? agentSettings.model : PROVIDERS[next].defaultModel); }}>
                {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => <option key={id} value={id}>{PROVIDERS[id].name}</option>)}
              </select></label>
              <label>API key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={agentSettings && !providerChanged ? `Saved key ending ${agentSettings.keyHint}` : `${PROVIDERS[provider].name} API key`} autoComplete="off" required={!agentSettings || providerChanged} /></label>
              <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} required /></label>
              <label className="settings-checkbox"><input type="checkbox" checked={autoTriage} onChange={(event) => setAutoTriage(event.target.checked)} /> Triage new captures automatically</label>
              {agentError && <p className="scheduled-error" role="alert">{agentError}</p>}
              <button className="secondary-button" type="submit" disabled={agentBusy}>{agentBusy ? "Checking…" : "Save model settings"}</button>
            </form>
          )}
        </section>

        <section className="settings-card" aria-labelledby="settings-spaces">
          <div className="settings-card-heading"><div><h2 id="settings-spaces">Spaces</h2><p>Choose which space opens by default.</p></div></div>
          <div className="settings-space-list">{workspaces.map((space) => <SpaceSettingsRow key={space.id} space={space} workspaces={workspaces} onSetDefault={onSetDefault} onRename={onRenameSpace} onRecolor={onRecolorSpace} onToast={onToast} />)}</div>
          <form className="settings-inline-form" onSubmit={createSpace}><label className="sr-only" htmlFor="new-settings-space">New space name</label><input id="new-settings-space" value={spaceName} onChange={(event) => setSpaceName(event.target.value)} placeholder="New space name" maxLength={60} /><button className="secondary-button" type="submit" disabled={spaceBusy || !spaceName.trim()}><Plus size={14} /> Add space</button></form>
          <p className="settings-help">Each new session opens your default space.</p>
        </section>

        <section className="settings-card settings-card-wide" aria-labelledby="settings-capture">
          <div className="settings-card-heading"><div><h2 id="settings-capture">Capture connections</h2><p>Choose where Slack and email send new notes.</p></div></div>
          <h3>Slack</h3>
          {slack.length ? slack.map((link) => <div className="settings-capture-row" key={`${link.teamId}:${link.slackUserId}`}><span>{link.teamName || "Slack workspace"}</span><select aria-label={`Space for ${link.teamName || "Slack"}`} value={link.workspaceId} disabled={captureBusy} onChange={(event) => void runCapture(() => onRouteSlack(link, event.target.value), "Slack destination updated")}>{workspaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select><button className="icon-button" aria-label={`Disconnect ${link.teamName || "Slack"}`} disabled={captureBusy} onClick={() => { if (confirm(`Disconnect ${link.teamName || "this Slack workspace"}?`)) void runCapture(() => onDisconnectSlack(link), "Slack disconnected"); }}><Unlink size={15} /></button></div>) : <p className="agent-muted">No Slack workspaces connected.</p>}
          <h3>Email</h3>
          {inboundDomain ? workspaces.map((space) => space.inboxToken && <div className="settings-email-row" key={space.id}><span>{space.name}</span><code>{inboundAddress(space.name, space.inboxToken, inboundDomain)}</code><button className="icon-button" aria-label={`Copy ${space.name} email address`} onClick={() => void navigator.clipboard.writeText(inboundAddress(space.name, space.inboxToken, inboundDomain)).then(() => onToast("Email address copied"), () => onToast("Could not copy address"))}><Copy size={15} /></button><button className="icon-button" aria-label={`Create new ${space.name} email address`} disabled={captureBusy} onClick={() => { if (confirm(`Create a new email address for ${space.name}? The old address will stop working.`)) void runCapture(() => onNewAddress(space.id), "New email address created"); }}><RefreshCw size={15} /></button></div>) : <p className="agent-muted"><Mail size={14} /> Email capture is not configured on this server.</p>}
        </section>

        <section className="settings-card" aria-labelledby="settings-account">
          <div className="settings-card-heading"><div><h2 id="settings-account">Account</h2><p>Your Orbit sign-in and session.</p></div></div>
          <div className="settings-account-email"><span>Email</span><strong>{email}</strong></div>
          <Link className="text-button settings-password-link" href="/auth/reset-password">Change password</Link>
          <form action={signOut}><button className="text-button" type="submit">Sign out</button></form>
        </section>
      </div>
    </main>
  );
}
