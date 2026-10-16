/**
 * Connected apps (OAuth connections, ADR 008) as Settings shows them.
 * Metadata only: never a token, code or hash. Shared by the route and the UI.
 */

export type ConnectionRow = {
  id: string; name: string; clientId: string; clientName: string | null; redirectUris: string[];
  clientUri: string | null; connectedAt: string; lastUsedAt: string | null; revokedAt: string | null;
  grants: { workspaceId: string; capability: string }[];
};

export type Connection = {
  id: string;
  /** The app's self-chosen name at consent time. */
  name: string;
  /** Hosts Orbit redirects to, for example ["claude.ai"]. */
  redirectHosts: string[];
  clientUri: string | null;
  connectedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  grants: { workspaceId: string; capability: string }[];
};

const host = (uri: string) => {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
};

export const toConnection = (row: ConnectionRow): Connection => ({
  id: row.id,
  name: row.name,
  redirectHosts: [...new Set((row.redirectUris ?? []).map(host))],
  clientUri: row.clientUri,
  connectedAt: row.connectedAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  grants: row.grants ?? [],
});
