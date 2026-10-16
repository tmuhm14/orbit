/** Client-side shapes and labels for Settings → Agents & API keys. No secrets. */

export type ClientGrant = { workspaceId: string; capability: string };
export type AgentClient = {
  id: string; name: string; keyPrefix: string; createdAt: string;
  lastUsedAt: string | null; revokedAt: string | null; grants: ClientGrant[];
};
export type AccessEvent = {
  id: number; principalType: "agent_client" | "user_token"; clientId: string | null; operation: string;
  workspaceId: string | null; resourceId: string | null; outcome: "allowed" | "denied"; code: string | null; occurredAt: string;
};

/** The capabilities Settings offers. assignment.execute waits for A-06. */
export const GRANT_OPTIONS = [
  { capability: "workspace.read", label: "Read" },
  { capability: "item.write", label: "Capture" },
] as const;

export const CAPABILITY_LABELS: Record<string, string> = {
  "workspace.read": "read", "item.write": "capture", "assignment.execute": "run assignments",
};
export const OPERATION_LABELS: Record<string, string> = {
  "workspace.list": "Listed spaces", "item.read": "Read notes", "item.create": "Captured a note",
};
export const CODE_LABELS: Record<string, string> = {
  capability_denied: "not granted", agent_disabled: "agent access off", client_revoked: "key revoked",
};

/** "workspaceId:capability" set, for checkbox state. */
export const grantKeys = (grants: ClientGrant[]) => new Set(grants.map((g) => `${g.workspaceId}:${g.capability}`));
export const fromKeys = (keys: Set<string>): ClientGrant[] => [...keys].sort().map((key) => {
  const [workspaceId, capability] = key.split(":");
  return { workspaceId, capability };
});

/** "Personal: read, capture · Work: capture", in workspace order. */
export function grantSummary(grants: ClientGrant[], workspaces: { id: string; name: string }[]) {
  const parts = workspaces.flatMap((w) => {
    const caps = grants.filter((g) => g.workspaceId === w.id).map((g) => CAPABILITY_LABELS[g.capability] ?? g.capability).sort().reverse();
    return caps.length ? [`${w.name}: ${caps.join(", ")}`] : [];
  });
  return parts.length ? parts.join(" · ") : "No access";
}

export const keyDisplay = (prefix: string) => `orbit_sk_${prefix}_…`;

export function when(value: string | null, now = Date.now()) {
  if (!value) return "Never";
  const ms = now - Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60_000) return "Just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
