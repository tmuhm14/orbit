import { routeUser, json } from "@/lib/supabase/route-auth";
import { ConfigError, apiKeyPepper } from "@/lib/grants/config";
import { generateApiKey } from "@/lib/grants/keys";
import { clientInput } from "@/lib/grants/validation";
import { clientStatus, toClient, type ClientRow, type GrantRow } from "@/lib/grants/clients";

/**
 * Settings → Agents & API keys (cookie session; mutations same-origin only).
 * Lists the user's agent clients with their active grants. Never returns a
 * key or its hash.
 */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const [clients, grants] = await Promise.all([
    // API keys only; OAuth connections are listed by /api/oauth/connections (ADR 008).
    auth.supabase.from("agent_clients").select("id,name,key_prefix,created_at,last_used_at,revoked_at")
      .eq("user_id", auth.user.id).eq("auth_kind", "api_key").order("created_at", { ascending: false }),
    auth.supabase.from("capability_grants").select("principal_id,workspace_id,capability,constraints,granted_at")
      .eq("user_id", auth.user.id).is("revoked_at", null),
  ]);
  if (clients.error || grants.error) return json({ error: "Could not load agent clients" }, 500);
  const rows = (grants.data ?? []) as GrantRow[];
  return json({ clients: ((clients.data ?? []) as ClientRow[]).map((c) => toClient(c, rows)) });
}

/**
 * Creates a client and its key. The full key is in this response only; the
 * server keeps its prefix and HMAC.
 */
export async function POST(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const input = clientInput(await request.json().catch(() => null));
  if (!input) return json({ error: "Provide a name (1–100 characters) and valid grants" }, 400);
  let pepper: string;
  try {
    pepper = apiKeyPepper();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "API key configuration invalid");
    return json({ error: "API keys are not configured on this server" }, 503);
  }
  // A prefix collision (48 random bits) is retried once with a fresh key.
  for (let attempt = 0; attempt < 2; attempt++) {
    const key = generateApiKey(pepper);
    const { data, error } = await auth.supabase.rpc("create_agent_client", {
      p_name: input.name, p_key_prefix: key.prefix, p_key_hash: key.hash, p_grants: input.grants,
    });
    if (error) return json({ error: "Could not create the API key" }, 500);
    const result = data as { status?: string; client?: unknown };
    if (result?.status === "duplicate_prefix") continue;
    if (result?.status !== "created") return clientStatus(result?.status);
    return json({ client: result.client, apiKey: key.key }, 201);
  }
  return json({ error: "Could not create the API key" }, 500);
}
