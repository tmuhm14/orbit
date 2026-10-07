"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Mail,
  RefreshCw,
  ChevronsUpDown,
  Pencil,
  Plus,
  Star,
  Unlink,
} from "lucide-react";
import { inboundAddress } from "@/lib/email-address";
import {
  WORKSPACE_COLORS,
  workspaceColor,
  type WorkspaceColor,
  type SlackConnection,
  type Workspace,
} from "@/lib/notes";

/** Sets --space to the workspace's accent for an element and its children. */
export const spaceStyle = (color: WorkspaceColor) =>
  ({
    "--space": WORKSPACE_COLORS[color].accent,
    "--space-ink": WORKSPACE_COLORS[color].ink,
    "--space-line": WORKSPACE_COLORS[color].line,
  }) as CSSProperties;

export function WorkspaceSwitcher({
  variant = "sidebar",
  workspaces,
  current,
  counts,
  slack,
  onSelect,
  onSetDefault,
  onCreate,
  onRename,
  onRecolor,
  inboundDomain,
  onNewAddress,
  onCopied,
  onRouteSlack,
  onDisconnectSlack,
  onError,
}: {
  /** "pill": the compact top-bar indicator; "sidebar": the full card. */
  variant?: "sidebar" | "pill";
  workspaces: Workspace[];
  current: Workspace;
  counts: Record<string, number>;
  slack: SlackConnection[];
  onSelect: (id: string) => void;
  onSetDefault: (id: string) => Promise<unknown>;
  onCreate: (name: string) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onRecolor: (id: string, color: string) => Promise<unknown>;
  /** Receiving domain for email capture; null hides the email section. */
  inboundDomain: string | null;
  onNewAddress: (id: string) => Promise<unknown>;
  onCopied: () => void;
  onRouteSlack: (
    link: SlackConnection,
    workspaceId: string,
  ) => Promise<unknown>;
  onDisconnectSlack: (link: SlackConnection) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<"new" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent | KeyboardEvent) {
      if (
        (event instanceof KeyboardEvent && event.key === "Escape") ||
        (event instanceof MouseEvent &&
          !rootRef.current?.contains(event.target as Node))
      ) {
        setOpen(false);
        setEditing(null);
      }
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  async function run(task: () => Promise<unknown>, failure: string) {
    setBusy(true);
    try {
      await task();
      return true;
    } catch {
      onError(failure);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function submitName(event: React.FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    const ok =
      editing === "new"
        ? await run(() => onCreate(value), "Couldn't create that workspace")
        : await run(
            () => onRename(current.id, value),
            "Couldn't rename that workspace",
          );
    if (ok) {
      setEditing(null);
      setOpen(false);
    }
  }
  return (
    <div
      className={`workspace-switch-wrap is-${variant}`}
      ref={rootRef}
      style={spaceStyle(workspaceColor(workspaces, current.id))}
    >
      {variant === "pill" ? (
        <button
          className="space-pill"
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={`Current workspace: ${current.name}. Switch workspace`}
          onClick={() => setOpen(!open)}
        >
          <span className="space-pill-avatar">
            {current.name[0]?.toUpperCase()}
          </span>
          <span className="space-pill-name">{current.name}</span>
          <ChevronDown size={13} />
        </button>
      ) : (
        <button
          className="workspace-switch"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <div className="workspace-avatar">
            {current.name[0]?.toUpperCase()}
            <span>✦</span>
          </div>
          <div>
            <strong>{current.name}</strong>
            <small>
              {workspaces.length > 1
                ? `${workspaces.length} workspaces`
                : "A little room to think"}
            </small>
          </div>
          <ChevronsUpDown className="workspace-chevron" size={15} />
        </button>
      )}
      {open && (
        <div className="workspace-menu" role="menu">
          <div className="workspace-menu-label">WORKSPACES</div>
          {workspaces.map((w) => (
            <button
              key={w.id}
              role="menuitemradio"
              aria-checked={w.id === current.id}
              className="workspace-menu-item"
              onClick={() => {
                onSelect(w.id);
                setOpen(false);
              }}
            >
              <span
                className="workspace-menu-avatar"
                style={spaceStyle(workspaceColor(workspaces, w.id))}
              >
                {w.name[0]?.toUpperCase()}
              </span>
              <span>{w.name}</span>
              {w.isDefault && (
                <Star className="workspace-default-star" size={13} fill="currentColor" aria-label="Default space" />
              )}
              <small>{counts[w.id] ?? 0}</small>
              {w.id === current.id && <Check size={14} />}
            </button>
          ))}
          {editing ? (
            <form className="workspace-menu-form" onSubmit={submitName}>
              <input
                autoFocus
                aria-label={
                  editing === "new" ? "New workspace name" : "Workspace name"
                }
                placeholder={editing === "new" ? "e.g. Waltz" : current.name}
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <button type="submit" disabled={busy || !name.trim()}>
                {editing === "new" ? "Create" : "Save"}
              </button>
            </form>
          ) : (
            <div className="workspace-menu-actions">
              <button
                onClick={() => {
                  setName("");
                  setEditing("new");
                }}
              >
                <Plus size={14} /> New workspace
              </button>
              <button
                onClick={() => {
                  setName(current.name);
                  setEditing("rename");
                }}
              >
                <Pencil size={13} /> Rename “{current.name}”
              </button>
              <button
                disabled={busy || current.isDefault}
                onClick={() =>
                  run(
                    () => onSetDefault(current.id),
                    "Couldn't set the default space",
                  )
                }
              >
                <Star size={13} />
                {current.isDefault ? "Default space" : `Set “${current.name}” as default`}
              </button>
            </div>
          )}
          <div
            className="workspace-colors"
            role="radiogroup"
            aria-label={`Color for ${current.name}`}
          >
            {(Object.keys(WORKSPACE_COLORS) as WorkspaceColor[]).map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={workspaceColor(workspaces, current.id) === c}
                aria-label={c}
                title={c}
                className="workspace-color"
                style={spaceStyle(c)}
                disabled={busy}
                onClick={() =>
                  run(
                    () => onRecolor(current.id, c),
                    "Couldn't change the color",
                  )
                }
              />
            ))}
          </div>
          {inboundDomain && current.inboxToken && (
            <>
              <div className="workspace-menu-label">
                EMAIL INTO {current.name.toUpperCase()}
              </div>
              <div className="workspace-menu-email">
                <Mail size={13} />
                <code title="Forward or send email here">
                  {inboundAddress(
                    current.name,
                    current.inboxToken,
                    inboundDomain,
                  )}
                </code>
                <button
                  className="icon-button"
                  aria-label="Copy email address"
                  title="Copy"
                  onClick={async () => {
                    await navigator.clipboard.writeText(
                      inboundAddress(
                        current.name,
                        current.inboxToken,
                        inboundDomain,
                      ),
                    );
                    onCopied();
                  }}
                >
                  <Copy size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Create a new email address"
                  title="New address (the old one stops working)"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        "Create a new address for this workspace? Email sent to the current address will stop arriving.",
                      )
                    )
                      run(
                        () => onNewAddress(current.id),
                        "Couldn't create a new address",
                      );
                  }}
                >
                  <RefreshCw size={13} />
                </button>
              </div>
            </>
          )}
          {slack.length > 0 && (
            <>
              <div className="workspace-menu-label">SLACK SENDS TO</div>
              {slack.map((link) => (
                <div
                  className="workspace-menu-slack"
                  key={`${link.teamId}:${link.slackUserId}`}
                >
                  <span title={link.teamName || link.teamId}>
                    {link.teamName || link.teamId}
                  </span>
                  <select
                    aria-label={`Orbit workspace for ${link.teamName || "Slack"}`}
                    value={link.workspaceId}
                    disabled={busy}
                    onChange={(e) =>
                      run(
                        () => onRouteSlack(link, e.target.value),
                        "Couldn't change where Slack sends notes",
                      )
                    }
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="icon-button"
                    aria-label={`Disconnect ${link.teamName || "Slack"}`}
                    title="Disconnect"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          `Disconnect ${link.teamName || "this Slack workspace"}? Send to Orbit will ask you to connect again.`,
                        )
                      )
                        run(
                          () => onDisconnectSlack(link),
                          "Couldn't disconnect Slack",
                        );
                    }}
                  >
                    <Unlink size={13} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
