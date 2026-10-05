"use client";

import { useEffect, useState } from "react";
import type { SlackConnection, Workspace } from "@/lib/notes";

async function send(path: string, method: string, body: unknown) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

// Workspaces, the one being viewed (remembered per account in this browser),
// and where each linked Slack workspace sends its captures.
export function useWorkspaces(
  userId: string,
  initial: Workspace[],
  initialSlack: SlackConnection[],
) {
  const [workspaces, setWorkspaces] = useState(initial);
  const [slack, setSlack] = useState(initialSlack);
  const [currentId, setCurrentId] = useState(initial[0]?.id ?? "");
  const storageKey = `orbit.workspace:${userId}`;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && initial.some((w) => w.id === saved)) setCurrentId(saved);
    } catch {
      /* Falls back to the first workspace. */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  function select(id: string) {
    setCurrentId(id);
    try {
      localStorage.setItem(storageKey, id);
    } catch {
      /* Only the remembered choice is lost. */
    }
  }
  async function create(name: string) {
    const { workspace } = await send("/api/workspaces", "POST", { name });
    setWorkspaces((list) => [...list, workspace]);
    select(workspace.id);
    return workspace as Workspace;
  }
  async function rename(id: string, name: string) {
    const { workspace } = await send(`/api/workspaces/${id}`, "PATCH", {
      name,
    });
    setWorkspaces((list) => list.map((w) => (w.id === id ? workspace : w)));
  }
  async function routeSlack(link: SlackConnection, workspaceId: string) {
    await send("/api/slack-links", "PATCH", { ...link, workspaceId });
    setSlack((list) =>
      list.map((l) =>
        l.teamId === link.teamId && l.slackUserId === link.slackUserId
          ? { ...l, workspaceId }
          : l,
      ),
    );
  }
  async function disconnectSlack(link: SlackConnection) {
    await send("/api/slack-links", "DELETE", link);
    setSlack((list) =>
      list.filter(
        (l) =>
          !(l.teamId === link.teamId && l.slackUserId === link.slackUserId),
      ),
    );
  }
  return {
    workspaces,
    current: workspaces.find((w) => w.id === currentId) ?? workspaces[0],
    select,
    create,
    rename,
    slack,
    routeSlack,
    disconnectSlack,
  };
}
