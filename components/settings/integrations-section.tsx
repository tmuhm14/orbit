"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, GitBranch, Ticket, Unlink } from "lucide-react";
import { sendScheduled, type ScheduledConnection } from "@/lib/scheduled/client";
import { isDirty, maskedHint } from "@/lib/settings-sections";
import { ConfirmDialog, SidePanel } from "../side-panel";

type Source = "jira" | "github";
const NAMES: Record<Source, string> = { jira: "Jira", github: "GitHub" };
const message = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);

function JiraPanel({ connection, onSaved, onClose }: { connection: ScheduledConnection; onSaved: () => Promise<void>; onClose: () => void }) {
  const initial = { site: connection.jiraSite ?? "", email: connection.jiraEmail ?? "", token: "" };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  return (
    <SidePanel
      title={connection.jiraConnected ? "Edit Jira connection" : "Connect Jira"}
      description="Scheduled reports can then read issues from your Jira site."
      onClose={onClose}
      dirty={isDirty(initial, form)}
      busy={busy}
      error={error}
      submitLabel="Save Jira"
      busyLabel="Checking…"
      submitDisabled={!form.site.trim() || !form.email.trim() || (!connection.jiraConnected && !form.token.trim())}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true); setError("");
        try {
          await sendScheduled("/api/scheduled-tasks/connections", "PUT", {
            source: "jira", jiraSite: form.site, jiraEmail: form.email, jiraToken: form.token,
          });
          await onSaved();
        } catch (failure) {
          setError(message(failure, "Couldn’t save Jira"));
          setBusy(false);
        }
      }}
    >
      <div className="settings-fields">
        <label className="settings-field">Site
          <input data-autofocus type="url" value={form.site} onChange={(event) => set({ site: event.target.value })} placeholder="https://your-team.atlassian.net" required />
        </label>
        <label className="settings-field">Account email
          <input type="email" value={form.email} onChange={(event) => set({ email: event.target.value })} placeholder="you@example.com" required />
        </label>
        <label className="settings-field">API token
          <input type="password" value={form.token} onChange={(event) => set({ token: event.target.value })} autoComplete="off" spellCheck={false}
            placeholder={connection.jiraConnected ? `Saved token ${maskedHint(connection.jiraHint)}` : "Paste an API token"} required={!connection.jiraConnected} />
        </label>
        <p className="settings-hint">
          {connection.jiraConnected ? "Leave the token blank to keep the saved one. " : ""}
          Create a token in your Atlassian account under Security → API tokens. Orbit checks it, encrypts it and never shows it again.
        </p>
      </div>
    </SidePanel>
  );
}

function GitHubPanel({ connection, onSaved, onClose }: { connection: ScheduledConnection; onSaved: () => Promise<void>; onClose: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <SidePanel
      title={connection.githubConnected ? "Replace GitHub token" : "Connect GitHub"}
      description="Scheduled reports can then read pull requests and code from the repositories you choose."
      onClose={onClose}
      dirty={!!token}
      busy={busy}
      error={error}
      submitLabel="Save GitHub"
      busyLabel="Checking…"
      submitDisabled={!token.trim()}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true); setError("");
        try {
          await sendScheduled("/api/scheduled-tasks/connections", "PUT", { source: "github", githubToken: token });
          await onSaved();
        } catch (failure) {
          setError(message(failure, "Couldn’t save GitHub"));
          setBusy(false);
        }
      }}
    >
      <div className="settings-fields">
        <label className="settings-field">Personal access token
          <input data-autofocus type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false}
            placeholder={connection.githubConnected ? `Saved token ${maskedHint(connection.githubHint)}` : "Paste a read-only token"} required />
        </label>
        <p className="settings-hint">
          Use a fine-grained token. Choose the repositories it can read and give it read access to Contents and Pull requests.
        </p>
      </div>
    </SidePanel>
  );
}

export function IntegrationsSection({ onOpenScheduled, onToast }: { onOpenScheduled: () => void; onToast: (message: string) => void }) {
  const [connection, setConnection] = useState<ScheduledConnection | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<Source | null>(null);
  const [disconnecting, setDisconnecting] = useState<Source | null>(null);

  const refresh = useCallback(async () => {
    const data = await sendScheduled("/api/scheduled-tasks/connections");
    setConnection(data.connection as ScheduledConnection);
    setLoadError("");
  }, []);
  useEffect(() => {
    void refresh().catch((failure) => setLoadError(message(failure, "Couldn’t load connections")));
  }, [refresh]);

  const card = (source: Source) => {
    if (!connection) return null;
    const connected = source === "jira" ? connection.jiraConnected : connection.githubConnected;
    const hint = source === "jira" ? connection.jiraHint : connection.githubHint;
    const Icon = source === "jira" ? Ticket : GitBranch;
    return (
      <li className="settings-row settings-service-row" key={source}>
        <div className="settings-row-main">
          <strong><Icon size={14} aria-hidden="true" /> {NAMES[source]}</strong>
          <span className="settings-row-meta">
            <span className={`settings-badge${connected ? " is-on" : ""}`}>{connected ? "Connected" : "Not connected"}</span>
            {connected && <span>Token <code>{maskedHint(hint)}</code></span>}
            {connected && source === "jira" && connection.jiraSite && <span>{connection.jiraSite.replace(/^https?:\/\//, "")} · {connection.jiraEmail}</span>}
          </span>
        </div>
        <div className="settings-row-actions">
          <button type="button" className={connected ? "text-button" : "secondary-button"} aria-haspopup="dialog" onClick={() => setEditing(source)}>
            {connected ? "Edit" : "Connect"}<span className="sr-only"> {NAMES[source]}</span>
          </button>
          {connected && (
            <button type="button" className="text-button settings-danger-text" aria-haspopup="dialog" onClick={() => setDisconnecting(source)}>
              <Unlink size={13} aria-hidden="true" /> Disconnect<span className="sr-only"> {NAMES[source]}</span>
            </button>
          )}
        </div>
      </li>
    );
  };

  const saved = (source: Source) => async () => {
    await refresh();
    setEditing(null);
    onToast(`${NAMES[source]} connection saved`);
  };

  return (
    <>
      <section className="settings-card" aria-labelledby="integrations-sources">
        <div className="settings-card-heading">
          <h2 id="integrations-sources">Report sources</h2>
          <p>Connect each service once, then choose its work in a scheduled job.</p>
        </div>
        {loadError ? <p className="settings-error" role="alert">{loadError}</p>
          : !connection ? <p className="settings-empty" role="status">Loading connections…</p>
          : <ul className="settings-list">{card("jira")}{card("github")}</ul>}
        <div className="settings-card-footer">
          <span>Tokens are encrypted on the server and never shown again.</span>
          <span className="settings-card-footer-links">
            <Link href="/scheduled">Job history</Link>
            <button type="button" className="text-button" aria-haspopup="dialog" onClick={onOpenScheduled}>
              <CalendarClock size={13} aria-hidden="true" /> Manage scheduled jobs
            </button>
          </span>
        </div>
      </section>
      {connection && editing === "jira" && <JiraPanel connection={connection} onClose={() => setEditing(null)} onSaved={saved("jira")} />}
      {connection && editing === "github" && <GitHubPanel connection={connection} onClose={() => setEditing(null)} onSaved={saved("github")} />}
      {disconnecting && (
        <ConfirmDialog
          tone="danger"
          title={`Disconnect ${NAMES[disconnecting]}?`}
          body={`Orbit deletes the saved ${NAMES[disconnecting]} token. Scheduled jobs that use it will be paused.`}
          confirmLabel="Disconnect"
          onCancel={() => setDisconnecting(null)}
          onConfirm={async () => {
            await sendScheduled(`/api/scheduled-tasks/connections?source=${disconnecting}`, "DELETE");
            await refresh().catch(() => undefined);
            onToast(`${NAMES[disconnecting]} disconnected`);
            setDisconnecting(null);
          }}
        />
      )}
    </>
  );
}
