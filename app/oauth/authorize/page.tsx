import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authConfig } from "@/lib/supabase/config";
import { oauthEndpoints, oauthOrigin } from "@/lib/oauth/config";
import { prepareConsent, registeredClient } from "@/lib/oauth/consent";
import { ConsentForm, ConsentMessage } from "./consent-form";

// Per-user and per-request (session cookies, the request host).
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Connect an app — Orbit", robots: { index: false } };

type Search = Record<string, string | string[] | undefined>;

function toParams(search: Search) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  return params;
}

/**
 * GET /oauth/authorize (ADR 008): checks the request, requires a signed-in
 * Orbit session, then asks the user which spaces the app may read or capture
 * into. Framing is refused (proxy.ts), so the page can't be clickjacked.
 */
export default async function Authorize({ searchParams }: { searchParams: Promise<Search> }) {
  let origin: string | null = null;
  try {
    origin = oauthOrigin(await headers());
  } catch {
    origin = null;
  }
  const admin = createAdminClient();
  if (!origin || !admin || !authConfig())
    return <ConsentMessage title="Connections aren’t available" message="This Orbit server isn’t set up for app connections yet." />;
  const endpoints = oauthEndpoints(origin);
  const supabase = await createClient();
  const result = await prepareConsent(toParams(await searchParams), endpoints, {
    getClient: async (clientId) => {
      const { data, error } = await admin.rpc("get_oauth_client", { p_client_id: clientId });
      return error ? null : registeredClient(data);
    },
    getUser: async () => (await supabase.auth.getUser()).data.user ?? null,
    workspaces: async () => {
      const { data } = await supabase.from("workspaces").select("id,name,agent_enabled").order("position");
      return ((data ?? []) as { id: string; name: string; agent_enabled: boolean }[])
        .map((w) => ({ id: w.id, name: w.name, agentEnabled: w.agent_enabled }));
    },
    currentGrants: async (clientId) => {
      const { data } = await supabase.rpc("list_oauth_connections");
      const active = ((data ?? []) as { clientId: string; revokedAt: string | null; grants: { workspaceId: string; capability: string }[] }[])
        .find((c) => c.clientId === clientId && !c.revokedAt);
      return active ? active.grants : null;
    },
  });
  if (result.kind === "redirect" || result.kind === "login") redirect(result.url);
  if (result.kind === "invalid") return <ConsentMessage title="This connection can’t continue" message={result.message} />;
  return <ConsentForm view={result} />;
}
