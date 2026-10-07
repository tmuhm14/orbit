"use client";

import { useState } from "react";
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

// Workspaces, the one being viewed, and where each linked Slack workspace
// sends its captures. Each new session opens the account's default space.
export function useWorkspaces(
  initial: Workspace[],
  initialSlack: SlackConnection[],
) {
  const [workspaces, setWorkspaces] = useState(initial);
  const [slack, setSlack] = useState(initialSlack);
  const [currentId, setCurrentId] = useState(
    initial.find((w) => w.isDefault)?.id ?? initial[0]?.id ?? "",
  );
  function select(id: string) {
    setCurrentId(id);
  }
  async function setDefault(id: string) {
    await send(`/api/workspaces/${id}/default`, "POST", {});
    setWorkspaces((list) =>
      list.map((workspace) => ({ ...workspace, isDefault: workspace.id === id })),
    );
  }
  async function create(name: string) {
    const { workspace } = await send("/api/workspaces", "POST", { name });
    setWorkspaces((list) => [...list, workspace]);
    select(workspace.id);
    return workspace as Workspace;
  }
  async function update(
    id: string,
    changes: { name?: string; color?: string; agentEnabled?: boolean },
  ) {
    const { workspace } = await send(`/api/workspaces/${id}`, "PATCH", changes);
    setWorkspaces((list) => list.map((w) => (w.id === id ? workspace : w)));
  }
  async function newAddress(id: string) {
    const { inboxToken } = await send(
      `/api/workspaces/${id}/inbox-token`,
      "POST",
      {},
    );
    setWorkspaces((list) =>
      list.map((w) => (w.id === id ? { ...w, inboxToken } : w)),
    );
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
    setDefault,
    create,
    rename: (id: string, name: string) => update(id, { name }),
    recolor: (id: string, color: string) => update(id, { color }),
    setAgentEnabled: (id: string, agentEnabled: boolean) =>
      update(id, { agentEnabled }),
    newAddress,
    slack,
    routeSlack,
    disconnectSlack,
  };
}
