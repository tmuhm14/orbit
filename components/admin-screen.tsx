"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  KeyRound,
  Settings,
  UserPlus,
  XCircle,
} from "lucide-react";
import {
  createUser,
  setUserDisabled,
  setUserPassword,
  type AdminResult,
} from "@/app/admin/actions";

export type AdminData = {
  me: string;
  databaseError: string | null;
  checks: { name: string; ok: boolean; warn?: boolean; detail: string }[];
  integrations: {
    slackUrl: string;
    emailUrl: string;
    inboundDomain: string | null;
  };
  users: {
    id: string;
    email: string;
    createdAt: string;
    lastSignInAt: string | null;
    disabled: boolean;
    isAdmin: boolean;
    notes: number;
    pending: number;
    bySource: { web: number; slack: number; email: number };
    workspaces: string[];
    slack: string[];
  }[];
  events: {
    id: number;
    source: string;
    status: string;
    detail: string | null;
    user: string | null;
    workspace: string | null;
    createdAt: string;
  }[];
};

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Never";

export function AdminScreen({ data }: { data: AdminData }) {
  const router = useRouter();
  const [result, setResult] = useState<AdminResult>({});
  const [pending, startTransition] = useTransition();
  const [passwordFor, setPasswordFor] = useState<string | null>(null);

  function act(task: () => Promise<AdminResult>) {
    startTransition(async () => {
      const outcome = await task();
      setResult(outcome);
      if (!outcome.error) router.refresh();
    });
  }
  const totals = {
    users: data.users.length,
    notes: data.users.reduce((sum, u) => sum + u.notes, 0),
    pending: data.users.reduce((sum, u) => sum + u.pending, 0),
    errors: data.events.filter((e) => e.status === "error").length,
  };

  return (
    <main className="admin-page">
      <header className="admin-header">
        <Link href="/" className="text-button">
          <ArrowLeft size={15} /> Back to Orbit
        </Link>
        <Link href="/settings" className="text-button">
          <Settings size={14} /> My settings
        </Link>
      </header>
      <h1>Administration</h1>
      <p className="admin-lede">Site-wide users, health, and integrations.</p>
      {(result.error || result.message) && (
        <div
          className={`admin-status ${result.error ? "is-error" : ""}`}
          role="status"
        >
          {result.error || result.message}
        </div>
      )}
      {data.databaseError && (
        <div className="admin-status is-error" role="alert">
          Database: {data.databaseError}
        </div>
      )}

      <div className="admin-stats">
        <div>
          <strong>{totals.users}</strong>
          <span>Users</span>
        </div>
        <div>
          <strong>{totals.notes}</strong>
          <span>Notes</span>
        </div>
        <div>
          <strong>{totals.pending}</strong>
          <span>Waiting for triage</span>
        </div>
        <div className={totals.errors ? "is-error" : ""}>
          <strong>{totals.errors}</strong>
          <span>Capture errors (last 50)</span>
        </div>
      </div>

      <section className="panel">
        <h2>System health</h2>
        <ul className="health-list">
          {data.checks.map((check) => (
            <li key={check.name}>
              {check.ok ? (
                <CheckCircle2 className="green" size={16} />
              ) : check.warn ? (
                <AlertTriangle className="amber" size={16} />
              ) : (
                <XCircle className="error-text" size={16} />
              )}
              <strong>{check.name}</strong>
              <span>{check.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Users</h2>
        <form
          className="settings-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const target = e.currentTarget;
            act(async () => {
              const outcome = await createUser(form);
              if (!outcome.error) target.reset();
              return outcome;
            });
          }}
        >
          <input
            name="email"
            type="email"
            aria-label="New user email"
            placeholder="Email"
            autoComplete="off"
            required
          />
          <input
            name="password"
            type="password"
            aria-label="Temporary password"
            placeholder="Temporary password (12+)"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <button className="secondary-button" disabled={pending}>
            <UserPlus size={14} /> Create user
          </button>
        </form>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Workspaces</th>
                <th>Notes</th>
                <th>Last sign-in</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className={u.disabled ? "is-disabled" : ""}>
                  <td>
                    <strong>{u.email}</strong>
                    <small>
                      {u.isAdmin ? "Admin · " : ""}
                      {u.disabled ? "Disabled · " : ""}
                      joined {when(u.createdAt)}
                    </small>
                  </td>
                  <td>
                    {u.workspaces.join(", ") || "—"}
                    {u.slack.length > 0 && (
                      <small>Slack: {u.slack.join(", ")}</small>
                    )}
                  </td>
                  <td>
                    {u.notes}
                    <small>
                      web {u.bySource.web} · Slack {u.bySource.slack} · email{" "}
                      {u.bySource.email}
                      {u.pending ? ` · ${u.pending} pending` : ""}
                    </small>
                  </td>
                  <td>{when(u.lastSignInAt)}</td>
                  <td className="admin-row-actions">
                    {passwordFor === u.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const password = String(
                            new FormData(e.currentTarget).get("password") || "",
                          );
                          act(async () => {
                            const outcome = await setUserPassword(
                              u.id,
                              password,
                            );
                            if (!outcome.error) setPasswordFor(null);
                            return outcome;
                          });
                        }}
                      >
                        <input
                          name="password"
                          type="password"
                          aria-label={`New password for ${u.email}`}
                          placeholder="New password"
                          autoComplete="new-password"
                          minLength={12}
                          autoFocus
                          required
                        />
                        <button className="text-button" disabled={pending}>
                          Set
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setPasswordFor(null)}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          className="text-button"
                          disabled={pending}
                          onClick={() => setPasswordFor(u.id)}
                        >
                          <KeyRound size={13} /> Set password
                        </button>
                        {!u.isAdmin && (
                          <button
                            className="text-button"
                            disabled={pending}
                            onClick={() => {
                              if (
                                u.disabled ||
                                confirm(
                                  `Disable ${u.email}? They won't be able to sign in until re-enabled.`,
                                )
                              )
                                act(() => setUserDisabled(u.id, !u.disabled));
                            }}
                          >
                            {u.disabled ? "Enable" : "Disable"}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Integrations</h2>
        <dl className="admin-integrations">
          <dt>Slack request URL</dt>
          <dd>
            <CopyText text={data.integrations.slackUrl} />
            <small>
              Slack app → Interactivity &amp; Shortcuts. Shortcut callback ID{" "}
              <code>send_to_orbit</code>.
            </small>
          </dd>
          <dt>Resend webhook URL</dt>
          <dd>
            <CopyText text={data.integrations.emailUrl} />
            <small>
              Resend → Webhooks, event <code>email.received</code>.
            </small>
          </dd>
          <dt>Receiving domain</dt>
          <dd>
            {data.integrations.inboundDomain ? (
              <CopyText text={data.integrations.inboundDomain} />
            ) : (
              <small>Not set (RESEND_INBOUND_DOMAIN)</small>
            )}
          </dd>
        </dl>
        <p className="panel-hint">
          Secrets are environment variables in Vercel and are never shown here.
          Change them in Vercel, then redeploy.
        </p>
      </section>

      <section className="panel">
        <h2>Recent captures</h2>
        {data.events.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th>Result</th>
                  <th>Where</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id}>
                    <td>{when(e.createdAt)}</td>
                    <td>{e.source === "slack" ? "Slack" : "Email"}</td>
                    <td>
                      <span className={`event-status is-${e.status}`}>
                        {e.status}
                      </span>
                    </td>
                    <td>
                      {e.user || "—"}
                      {e.workspace && <small>{e.workspace}</small>}
                    </td>
                    <td className="admin-detail">{e.detail || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="panel-hint">
            No captures logged yet. Slack and email captures will appear here.
          </p>
        )}
      </section>
    </main>
  );
}

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-text">
      <code>{text}</code>
      <button
        className="icon-button"
        aria-label={`Copy ${text}`}
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
      </button>
    </span>
  );
}
