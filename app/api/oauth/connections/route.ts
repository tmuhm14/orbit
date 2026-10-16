import { routeUser, json } from "@/lib/supabase/route-auth";
import { toConnection, type ConnectionRow } from "@/lib/oauth/connections";

/**
 * Settings → Agents & API keys → Connected apps (ADR 008; cookie session).
 * The user's OAuth connections with their active grants. Metadata only:
 * never a token, code or hash.
 */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const { data, error } = await auth.supabase.rpc("list_oauth_connections");
  if (error) return json({ error: "Could not load connected apps" }, 500);
  return json({ connections: ((data ?? []) as ConnectionRow[]).map(toConnection) });
}
