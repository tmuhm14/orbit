import {
  AUTHORIZE_PARAMS, checkAuthorize, consentColumns, readAuthorizeParams,
  type AuthorizeParams, type RegisteredClient,
} from "@/lib/oauth/authorize";
import { isLoopbackRedirect, redirectHost } from "@/lib/oauth/validation";

/**
 * What GET /oauth/authorize shows (ADR 008). The request is checked before
 * anything else, so a malformed request never sends anyone through sign-in;
 * then a signed-out visitor is sent to /login with this exact request as a
 * relative `next`; then the consent screen is built. Pure apart from `deps`.
 */

export type ConsentWorkspace = { id: string; name: string; agentEnabled: boolean };

export type ConsentView = {
  kind: "consent";
  /** The app's self-chosen name, or null when it gave none. */
  clientName: string | null;
  clientUri: string | null;
  /** Where Orbit sends the user back: shown prominently (anti-phishing). */
  redirectHost: string;
  /** The app runs on the user's computer (http://localhost). */
  loopback: boolean;
  columns: ReturnType<typeof consentColumns>;
  workspaces: ConsentWorkspace[];
  /** "workspaceId:capability" boxes to start ticked (the current grants when reconnecting). */
  checked: string[];
  reconnecting: boolean;
  /** Echoed as hidden fields; the decision route checks them all again. */
  hidden: AuthorizeParams;
  notice: "choose" | null;
};

export type ConsentResult =
  | { kind: "invalid"; message: string }
  | { kind: "redirect"; url: string }
  | { kind: "login"; url: string }
  | ConsentView;

export type ConsentDeps = {
  getClient: (clientId: string) => Promise<RegisteredClient | null>;
  /** The signed-in user, or null. */
  getUser: () => Promise<{ id: string } | null>;
  workspaces: () => Promise<ConsentWorkspace[]>;
  /** The active connection's grants for this app, or null when not connected. */
  currentGrants: (clientId: string) => Promise<{ workspaceId: string; capability: string }[] | null>;
};

/** The relative URL of this exact authorization request, for /login?next=. */
export function authorizePath(params: AuthorizeParams) {
  const query = new URLSearchParams();
  for (const name of AUTHORIZE_PARAMS) if (params[name] !== undefined) query.set(name, params[name]!);
  return `/oauth/authorize?${query}`;
}

export async function prepareConsent(search: URLSearchParams, endpoints: { issuer: string; resource: string },
  deps: ConsentDeps): Promise<ConsentResult> {
  const params = readAuthorizeParams(search);
  const client = params?.client_id ? await deps.getClient(params.client_id) : null;
  const check = checkAuthorize(params, client, endpoints);
  if (check.kind !== "ok") return check;
  const user = await deps.getUser();
  if (!user) return { kind: "login", url: `/login?next=${encodeURIComponent(authorizePath(check.params))}` };
  const columns = consentColumns(check.scope);
  const [workspaces, current] = await Promise.all([deps.workspaces(), deps.currentGrants(check.client.clientId)]);
  const offered = new Set<string>(columns.map((c) => c.capability));
  return {
    kind: "consent",
    clientName: check.client.clientName,
    clientUri: check.client.clientUri,
    redirectHost: redirectHost(check.redirectUri),
    loopback: isLoopbackRedirect(check.redirectUri),
    columns,
    workspaces,
    checked: (current ?? []).filter((g) => offered.has(g.capability)).map((g) => `${g.workspaceId}:${g.capability}`),
    reconnecting: current !== null,
    hidden: check.params,
    notice: search.get("notice") === "choose" ? "choose" : null,
  };
}

/** Maps get_oauth_client's result. */
export function registeredClient(value: unknown): RegisteredClient | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.clientId !== "string" || !Array.isArray(v.redirectUris)) return null;
  return {
    clientId: v.clientId,
    clientName: typeof v.clientName === "string" ? v.clientName : null,
    redirectUris: v.redirectUris.filter((u): u is string => typeof u === "string"),
    clientUri: typeof v.clientUri === "string" ? v.clientUri : null,
  };
}
