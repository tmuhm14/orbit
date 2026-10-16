"use client";

import { useState } from "react";
import { ArrowRight, Mail, MessageSquare, RefreshCw, Unlink } from "lucide-react";
import { inboundAddress } from "@/lib/email-address";
import { workspaceColor, type SlackConnection, type Workspace } from "@/lib/notes";
import { ConfirmDialog, FormDialog } from "../side-panel";
import { CopyButton } from "./copy";
import { SpaceDot } from "./spaces-section";

const slackName = (link: SlackConnection) => link.teamName || "Slack workspace";

function SlackRouteDialog({ link, workspaces, onSave, onClose }: {
  link: SlackConnection; workspaces: Workspace[]; onSave: (workspaceId: string) => Promise<void>; onClose: () => void;
}) {
  const [target, setTarget] = useState(link.workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <FormDialog
      title={`Where ${slackName(link)} sends notes`}
      description="Messages you send to Orbit from this Slack workspace land in this space’s Inbox."
      onClose={onClose}
      dirty={target !== link.workspaceId}
      busy={busy}
      error={error}
      submitDisabled={target === link.workspaceId}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true); setError("");
        try { await onSave(target); }
        catch { setError("Couldn’t change where Slack sends notes. Try again."); setBusy(false); }
      }}
    >
      <label className="settings-field">
        Space
        <select data-autofocus value={target} onChange={(event) => setTarget(event.target.value)}>
          {workspaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select>
      </label>
    </FormDialog>
  );
}

type Pending =
  | { kind: "route"; link: SlackConnection }
  | { kind: "disconnect"; link: SlackConnection }
  | { kind: "address"; space: Workspace }
  | null;

export function CaptureSection({ workspaces, slack, inboundDomain, onRouteSlack, onDisconnectSlack, onNewAddress, onToast }: {
  workspaces: Workspace[];
  slack: SlackConnection[];
  inboundDomain: string | null;
  onRouteSlack: (link: SlackConnection, workspaceId: string) => Promise<unknown>;
  onDisconnectSlack: (link: SlackConnection) => Promise<unknown>;
  onNewAddress: (id: string) => Promise<unknown>;
  onToast: (message: string) => void;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const spaceOf = (id: string) => workspaces.find((w) => w.id === id);
  const close = () => setPending(null);
  return (
    <>
      <section className="settings-card" aria-labelledby="capture-slack">
        <div className="settings-card-heading">
          <h2 id="capture-slack"><MessageSquare size={15} aria-hidden="true" /> Slack</h2>
          <p>Use “Send to Orbit” on any Slack message. The first time, Slack gives you a link to connect your account.</p>
        </div>
        {slack.length ? (
          <ul className="settings-list">
            {slack.map((link) => {
              const space = spaceOf(link.workspaceId);
              return (
                <li key={`${link.teamId}:${link.slackUserId}`} className="settings-row">
                  <div className="settings-row-main">
                    <strong>{slackName(link)}</strong>
                    <span className="settings-row-meta">
                      Sends to <ArrowRight size={11} aria-hidden="true" />
                      {space ? <><SpaceDot color={workspaceColor(workspaces, space.id)} /> {space.name}</> : "a deleted space"}
                    </span>
                  </div>
                  <div className="settings-row-actions">
                    <button type="button" className="text-button" aria-haspopup="dialog" onClick={() => setPending({ kind: "route", link })}>
                      Change space<span className="sr-only"> for {slackName(link)}</span>
                    </button>
                    <button type="button" className="text-button settings-danger-text" aria-haspopup="dialog" onClick={() => setPending({ kind: "disconnect", link })}>
                      <Unlink size={13} aria-hidden="true" /> Disconnect<span className="sr-only"> {slackName(link)}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <p className="settings-empty">No Slack workspaces connected yet.</p>}
      </section>

      <section className="settings-card" aria-labelledby="capture-email">
        <div className="settings-card-heading">
          <h2 id="capture-email"><Mail size={15} aria-hidden="true" /> Email</h2>
          <p>Forward or send email to a space’s address and it lands in that space’s Inbox. Treat an address like a password: anyone who has it can add notes.</p>
        </div>
        {inboundDomain ? (
          <ul className="settings-list">
            {workspaces.filter((space) => space.inboxToken).map((space) => {
              const address = inboundAddress(space.name, space.inboxToken, inboundDomain);
              return (
                <li key={space.id} className="settings-row settings-email-row">
                  <div className="settings-row-main">
                    <strong><SpaceDot color={workspaceColor(workspaces, space.id)} /> {space.name}</strong>
                    <code className="settings-address">{address}</code>
                  </div>
                  <div className="settings-row-actions">
                    <CopyButton text={address} label={`Copy ${space.name} email address`} onToast={onToast} />
                    <button type="button" className="text-button" aria-haspopup="dialog" onClick={() => setPending({ kind: "address", space })}>
                      <RefreshCw size={13} aria-hidden="true" /> New address<span className="sr-only"> for {space.name}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <p className="settings-empty"><Mail size={14} aria-hidden="true" /> Email capture isn’t set up on this server.</p>}
      </section>

      {pending?.kind === "route" && (
        <SlackRouteDialog
          link={pending.link}
          workspaces={workspaces}
          onClose={close}
          onSave={async (id) => {
            await onRouteSlack(pending.link, id);
            onToast(`Slack now sends to ${spaceOf(id)?.name ?? "that space"}`);
            close();
          }}
        />
      )}
      {pending?.kind === "disconnect" && (
        <ConfirmDialog
          tone="danger"
          title={`Disconnect ${slackName(pending.link)}?`}
          body="“Send to Orbit” in this Slack workspace stops adding notes. Notes it already sent stay."
          hint="You can connect again from Slack at any time."
          confirmLabel="Disconnect"
          onCancel={close}
          onConfirm={async () => {
            try { await onDisconnectSlack(pending.link); }
            catch { throw new Error("Couldn’t disconnect Slack. Try again."); }
            onToast("Slack disconnected");
            close();
          }}
        />
      )}
      {pending?.kind === "address" && (
        <ConfirmDialog
          tone="danger"
          title={`New email address for ${pending.space.name}?`}
          body="The current address stops working right away. Anything sent to it afterwards won’t arrive."
          hint="Update any forwarding rules or contacts that use the old address."
          confirmLabel="Create new address"
          onCancel={close}
          onConfirm={async () => {
            try { await onNewAddress(pending.space.id); }
            catch { throw new Error("Couldn’t create a new address. Try again."); }
            onToast("New email address created. The old one no longer works.");
            close();
          }}
        />
      )}
    </>
  );
}
