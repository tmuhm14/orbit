"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Pencil, Plus, Unlink } from "lucide-react";
import type { SlackConnection, Workspace } from "@/lib/notes";

export function WorkspaceSwitcher({
  workspaces,
  current,
  counts,
  slack,
  onSelect,
  onCreate,
  onRename,
  onRouteSlack,
  onDisconnectSlack,
  onError,
}: {
  workspaces: Workspace[];
  current: Workspace;
  counts: Record<string, number>;
  slack: SlackConnection[];
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
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
    <div className="workspace-switch-wrap" ref={rootRef}>
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
              <span className="workspace-menu-avatar">
                {w.name[0]?.toUpperCase()}
              </span>
              <span>{w.name}</span>
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
            </div>
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
