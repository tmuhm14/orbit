import "server-only";

/**
 * Capability checks for external principals (ADR 004 §3, ADR 007). Grants
 * are read from the database on every request (verify_agent_key) and never
 * cached across requests, so a revocation applies to the next call.
 */

/** v1 capabilities. external.read / external.write arrive with I-01 / I-05. */
export const CAPABILITIES = ["workspace.read", "item.write", "assignment.execute"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const isCapability = (value: unknown): value is Capability =>
  typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);

export type Grant = {
  workspaceId: string;
  capability: Capability;
  constraints: { operations?: string[] };
  /** The workspace's kill switch (workspaces.agent_enabled), read with the grant. */
  agentEnabled: boolean;
};

export type Principal =
  | { type: "agent_client"; clientId: string; keyPrefix: string; grants: Grant[] }
  /** Transitional: a Supabase user JWT on /api/v1 during the deprecation window. */
  | { type: "user_token" };

export type DenialCode = "capability_denied" | "agent_disabled";
export type Decision = { ok: true } | { ok: false; code: DenialCode };

/**
 * Checks one operation against an agent client's grants. No grant for the
 * workspace (including a workspace that doesn't exist or isn't the user's)
 * is capability_denied; a grant in a workspace whose kill switch is off is
 * agent_disabled. item.write also needs the operation in its constraints.
 */
export function checkGrant(grants: Grant[], capability: Capability, workspaceId: string,
  operation?: "create" | "update"): Decision {
  const grant = grants.find((g) => g.workspaceId === workspaceId && g.capability === capability &&
    (capability !== "item.write" || (!!operation && !!g.constraints.operations?.includes(operation))));
  if (!grant) return { ok: false, code: "capability_denied" };
  if (!grant.agentEnabled) return { ok: false, code: "agent_disabled" };
  return { ok: true };
}

/** Workspaces with at least one active grant whose kill switch is on, with their capabilities. */
export function grantedWorkspaces(grants: Grant[]) {
  const byWorkspace = new Map<string, Capability[]>();
  for (const g of grants) {
    if (!g.agentEnabled) continue;
    byWorkspace.set(g.workspaceId, [...(byWorkspace.get(g.workspaceId) ?? []), g.capability]);
  }
  return byWorkspace;
}

/** Normalizes verify_agent_key grants; anything unexpected is dropped, never widened. */
export function parseGrants(value: unknown): Grant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((g) => {
    if (!g || typeof g !== "object") return [];
    const row = g as Record<string, unknown>;
    if (typeof row.workspaceId !== "string" || !isCapability(row.capability)) return [];
    const operations = (row.constraints as { operations?: unknown } | null)?.operations;
    return [{
      workspaceId: row.workspaceId,
      capability: row.capability,
      constraints: Array.isArray(operations) ? { operations: operations.filter((o) => typeof o === "string") } : {},
      agentEnabled: row.agentEnabled === true,
    }];
  });
}
