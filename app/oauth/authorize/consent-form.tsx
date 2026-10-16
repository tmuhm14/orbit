"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, Orbit, PlugZap } from "lucide-react";
import type { ConsentView } from "@/lib/oauth/consent";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-page oauth-page">
      <div className="auth-orbits" aria-hidden="true"><i /><i /><i /></div>
      <Link href="/" className="auth-brand">
        <Orbit size={32} strokeWidth={1.4} />
        <span>orbit.</span>
      </Link>
      <div className="oauth-layout">{children}</div>
    </main>
  );
}

export function ConsentMessage({ title, message }: { title: string; message: string }) {
  return (
    <Frame>
      <section className="auth-card oauth-card" aria-labelledby="oauth-title">
        <div className="auth-card-icon"><AlertTriangle size={22} aria-hidden="true" /></div>
        <h2 id="oauth-title">{title}</h2>
        <p className="auth-subtitle">{message}</p>
        <p className="oauth-foot"><Link href="/">Back to Orbit</Link></p>
      </section>
    </Frame>
  );
}

/**
 * The consent screen (ADR 008): who is asking, where Orbit will send you
 * back, and per-space Read / Capture boxes. Allow stays disabled until at
 * least one box is ticked; the server checks that too.
 */
export function ConsentForm({ view }: { view: ConsentView }) {
  const [checked, setChecked] = useState(() => new Set(view.checked));
  const name = view.clientName ?? "An app that didn’t give its name";
  const toggle = (key: string) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <Frame>
      <section className="auth-card oauth-card" aria-labelledby="oauth-title">
        <div className="auth-card-icon"><PlugZap size={22} aria-hidden="true" /></div>
        <h2 id="oauth-title">{view.reconnecting ? "Reconnect" : "Connect"} <span className="oauth-app-name">{name}</span> to Orbit?</h2>
        <dl className="oauth-facts">
          <div>
            <dt>After you choose, Orbit sends you to</dt>
            <dd><strong className="oauth-host">{view.redirectHost}</strong></dd>
          </div>
          {view.clientUri && <div>
            <dt>The app says its website is</dt>
            <dd><a href={view.clientUri} target="_blank" rel="noopener noreferrer nofollow">{view.clientUri} <ExternalLink size={12} aria-hidden="true" /></a></dd>
          </div>}
        </dl>
        <p className="auth-subtitle">
          Orbit didn’t check this app’s name; the app chose it. Only continue if you just started connecting <strong>{name}</strong> and
          you expect to return to <strong>{view.redirectHost}</strong>.
        </p>
        {view.loopback && <p className="auth-notice oauth-warning" role="note">
          This app runs on your computer (<strong>{view.redirectHost}</strong>). Any program on this computer could claim to be it, so only
          continue if you started this yourself.
        </p>}
        {view.notice === "choose" && <p className="auth-error" role="alert">Tick at least one box, or choose Deny.</p>}

        <form method="post" action="/oauth/authorize/decision" className="oauth-form">
          {Object.entries(view.hidden).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}
          <fieldset className="oauth-fieldset">
            <legend>What it may do in each space</legend>
            {view.workspaces.length === 0 ? <p className="auth-subtitle">You have no spaces yet.</p> : (
              <table className="oauth-grid">
                <thead><tr><th scope="col">Space</th>{view.columns.map((c) => <th scope="col" key={c.capability}>{c.label}</th>)}</tr></thead>
                <tbody>{view.workspaces.map((space) => (
                  <tr key={space.id}>
                    <th scope="row">
                      {space.name}
                      {!space.agentEnabled && <span className="oauth-off" title="Agent access is off for this space, so the app can’t use it until you turn it on in Settings → Model & agent."> · agent access off</span>}
                    </th>
                    {view.columns.map((c) => {
                      const key = `${space.id}:${c.capability}`;
                      return <td key={c.capability}><input type="checkbox" name="grant" value={key} aria-label={`${c.label} ${space.name}`}
                        checked={checked.has(key)} onChange={() => toggle(key)} /></td>;
                    })}
                  </tr>
                ))}</tbody>
              </table>
            )}
            <p className="oauth-hint">
              {view.columns.some((c) => c.label === "Read") && <>Read lets it list a space’s notes. </>}
              {view.columns.some((c) => c.label === "Capture") && <>Capture lets it add Inbox notes; it can’t change or delete anything. </>}
              You can change this or disconnect at any time in Settings → Agents &amp; API keys.
            </p>
          </fieldset>
          <div className="oauth-actions">
            <button type="submit" name="decision" value="deny" className="secondary-button">Deny</button>
            <button type="submit" name="decision" value="allow" className="auth-submit oauth-allow" disabled={checked.size === 0}>
              Allow access
            </button>
          </div>
        </form>
      </section>
    </Frame>
  );
}
