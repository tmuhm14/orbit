import { json } from "@/lib/supabase/route-auth";

/** Shapes for the Settings key-management routes. Never includes a key or hash. */

export type ClientRow = {
  id: string; name: string; key_prefix: string; created_at: string;
  last_used_at: string | null; revoked_at: string | null;
};
export type GrantRow = {
  principal_id: string; workspace_id: string; capability: string;
  constraints: Record<string, unknown>; granted_at: string;
};

export const toClient = (c: ClientRow, grants: GrantRow[]) => ({
  id: c.id, name: c.name, keyPrefix: c.key_prefix, createdAt: c.created_at,
  lastUsedAt: c.last_used_at, revokedAt: c.revoked_at,
  grants: grants.filter((g) => g.principal_id === c.id)
    .map((g) => ({ workspaceId: g.workspace_id, capability: g.capability, constraints: g.constraints, grantedAt: g.granted_at }))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.capability.localeCompare(b.capability)),
});

/** Maps a key-management function status to a response. */
export function clientStatus(status: string | undefined) {
  switch (status) {
    case "invalid_payload": return json({ error: "Provide a name (1–100 characters) and valid grants", code: status }, 400);
    case "not_found": return json({ error: "Agent client or workspace not found", code: status }, 404);
    case "limit_reached": return json({ error: "Revoke an unused key first (25 active keys at most)", code: status }, 409);
    case "client_revoked": return json({ error: "This key has been revoked", code: status }, 409);
    default: return json({ error: "Could not update the API key" }, 500);
  }
}
