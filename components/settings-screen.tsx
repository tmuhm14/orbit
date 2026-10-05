"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Copy,
  Download,
  Mail,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  Unlink,
} from "lucide-react";
import {
  WORKSPACE_COLORS,
  workspaceColor,
  type SlackConnection,
  type Workspace,
  type WorkspaceColor,
} from "@/lib/notes";
import { inboundAddress } from "@/lib/email-address";
import { useWorkspaces } from "./use-workspaces";
import { spaceStyle } from "./workspace-switcher";
import { changePassword, type PasswordState } from "@/app/settings/actions";
import { signOut } from "@/app/auth/actions";

export function SettingsScreen({
  userId,
  email,
  isAdmin,
  initialWorkspaces,
  initialSlack,
  counts,
  inboundDomain,
}: {
  userId: string;
  email: string;
  isAdmin: boolean;
  initialWorkspaces: Workspace[];
  initialSlack: SlackConnection[];
  counts: Record<string, number>;
  inboundDomain: string | null;
}) {
  const spaces = useWorkspaces(userId, initialWorkspaces, initialSlack);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [password, passwordAction, passwordPending] = useActionState<
    PasswordState,
    FormData
  >(changePassword, {});

  async function run(task: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await task();
      setStatus(done);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Something went wrong",
      );
    } finally {
      setBusy(false);
    }
  }
  async function exportAll() {
    const response = await fetch("/api/notes", { cache: "no-store" });
    if (!response.ok) return setStatus("Couldn't export your notes");
    const { notes } = await response.json();
    const file = new Blob(
      [
        JSON.stringify(
          {
            version: 2,
            exportedAt: new Date().toISOString(),
            workspaces: spaces.workspaces.map(({ id, name }) => ({ id, name })),
            notes,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orbit-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${notes.length} notes`);
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <Link href="/" className="text-button">
          <ArrowLeft size={15} /> Back to Orbit
        </Link>
        {isAdmin && (
          <Link href="/admin" className="text-button">
            <Shield size={14} /> Administration
          </Link>
        )}
      </header>
      <h1>Settings</h1>
      <p className="admin-lede">Your workspaces, connections, and account.</p>
      {status && (
        <div className="admin-status" role="status">
          {status}
        </div>
      )}

      <section className="panel">
        <h2>Workspaces</h2>
        <p className="panel-hint">
          Each workspace has its own buckets, notes, and email address.
        </p>
        <ul className="settings-list">
          {spaces.workspaces.map((w, index) => {
            const color = workspaceColor(spaces.workspaces, w.id);
            const address =
              inboundDomain && w.inboxToken
                ? inboundAddress(w.name, w.inboxToken, inboundDomain)
                : null;
            return (
              <li
                key={w.id}
                className="settings-workspace"
                style={spaceStyle(color)}
              >
                <div className="settings-row">
                  <span className="workspace-menu-avatar">
                    {w.name[0]?.toUpperCase()}
                  </span>
                  <input
                    className="settings-name"
                    aria-label={`Name of ${w.name}`}
                    defaultValue={w.name}
                    maxLength={60}
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      if (value && value !== w.name)
                        run(
                          () => spaces.rename(w.id, value),
                          `Renamed to ${value}`,
                        );
                      else e.target.value = w.name;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                  <small>{counts[w.id] ?? 0} open notes</small>
                  <div className="settings-actions">
                    <button
                      className="icon-button"
                      aria-label={`Move ${w.name} up`}
                      disabled={busy || index === 0}
                      onClick={() =>
                        run(() => spaces.move(w.id, -1), "Order saved")
                      }
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Move ${w.name} down`}
                      disabled={busy || index === spaces.workspaces.length - 1}
                      onClick={() =>
                        run(() => spaces.move(w.id, 1), "Order saved")
                      }
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Delete ${w.name}`}
                      disabled={busy || spaces.workspaces.length === 1}
                      title={
                        spaces.workspaces.length === 1
                          ? "You need at least one workspace"
                          : "Delete workspace"
                      }
                      onClick={() => {
                        setDeleting(w.id);
                        setConfirmName("");
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div
                  className="workspace-colors"
                  role="radiogroup"
                  aria-label={`Color for ${w.name}`}
                >
                  {(Object.keys(WORKSPACE_COLORS) as WorkspaceColor[]).map(
                    (c) => (
                      <button
                        key={c}
                        role="radio"
                        aria-checked={color === c}
                        aria-label={c}
                        title={c}
                        className="workspace-color"
                        style={spaceStyle(c)}
                        disabled={busy}
                        onClick={() =>
                          run(() => spaces.recolor(w.id, c), "Color saved")
                        }
                      />
                    ),
                  )}
                </div>
                {address && (
                  <div className="workspace-menu-email">
                    <Mail size={13} />
                    <code>{address}</code>
                    <button
                      className="icon-button"
                      aria-label={`Copy email address for ${w.name}`}
                      onClick={async () => {
                        await navigator.clipboard.writeText(address);
                        setStatus("Email address copied");
                      }}
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`New email address for ${w.name}`}
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            "Create a new address? Email sent to the current one will stop arriving.",
                          )
                        )
                          run(
                            () => spaces.newAddress(w.id),
                            "New address created",
                          );
                      }}
                    >
                      <RefreshCw size={13} />
                    </button>
                  </div>
                )}
                {deleting === w.id && (
                  <form
                    className="settings-danger"
                    onSubmit={(e) => {
                      e.preventDefault();
                      run(async () => {
                        await spaces.remove(w.id);
                        setDeleting(null);
                      }, `Deleted ${w.name}`);
                    }}
                  >
                    <p>
                      This permanently deletes <strong>{w.name}</strong>, its{" "}
                      {counts[w.id] ?? 0} open notes and all completed notes,
                      and stops Slack and email from sending to it. Type the
                      workspace name to confirm.
                    </p>
                    <input
                      autoFocus
                      aria-label="Type the workspace name to confirm"
                      value={confirmName}
                      onChange={(e) => setConfirmName(e.target.value)}
                      placeholder={w.name}
                    />
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setDeleting(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="danger-button"
                      disabled={busy || confirmName !== w.name}
                    >
                      Delete workspace
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
        <form
          className="settings-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim();
            if (name)
              run(async () => {
                await spaces.create(name);
                setNewName("");
              }, `Created ${name}`);
          }}
        >
          <input
            aria-label="New workspace name"
            placeholder="New workspace name"
            maxLength={60}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            className="secondary-button"
            disabled={busy || !newName.trim()}
          >
            <Plus size={14} /> Add workspace
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Slack</h2>
        {spaces.slack.length ? (
          <ul className="settings-list">
            {spaces.slack.map((link) => (
              <li
                key={`${link.teamId}:${link.slackUserId}`}
                className="settings-row"
              >
                <strong>{link.teamName || link.teamId}</strong>
                <span className="panel-hint">sends to</span>
                <select
                  aria-label={`Orbit workspace for ${link.teamName || "Slack"}`}
                  value={link.workspaceId}
                  disabled={busy}
                  onChange={(e) =>
                    run(
                      () => spaces.routeSlack(link, e.target.value),
                      "Slack routing saved",
                    )
                  }
                >
                  {spaces.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        `Disconnect ${link.teamName || "this Slack workspace"}? Send to Orbit will ask you to connect again.`,
                      )
                    )
                      run(
                        () => spaces.disconnectSlack(link),
                        "Slack disconnected",
                      );
                  }}
                >
                  <Unlink size={13} /> Disconnect
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="panel-hint">
            Not connected. Use <strong>Send to Orbit</strong> on a Slack message
            to connect.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Account</h2>
        <p className="panel-hint">
          Signed in as <strong>{email}</strong>
        </p>
        <form action={passwordAction} className="settings-password">
          <h3>Change password</h3>
          <input
            type="hidden"
            name="email"
            value={email}
            autoComplete="username"
          />
          <input
            type="password"
            name="current"
            aria-label="Current password"
            placeholder="Current password"
            autoComplete="current-password"
            required
          />
          <input
            type="password"
            name="password"
            aria-label="New password"
            placeholder="New password (12+ characters)"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
          <input
            type="password"
            name="confirmPassword"
            aria-label="Confirm new password"
            placeholder="Confirm new password"
            autoComplete="new-password"
            required
          />
          {password.error && <p className="error-text">{password.error}</p>}
          {password.message && <p className="panel-hint">{password.message}</p>}
          <button className="secondary-button" disabled={passwordPending}>
            {passwordPending ? "Updating…" : "Update password"}
          </button>
        </form>
        <div className="settings-row">
          <button className="secondary-button" onClick={exportAll}>
            <Download size={14} /> Export all notes (JSON)
          </button>
          <form action={signOut}>
            <button className="text-button" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
