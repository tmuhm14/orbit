import { routeUser, json } from "@/lib/supabase/route-auth";
import { isUuid } from "@/lib/grants/validation";
import { clientStatus } from "@/lib/grants/clients";

/** Revokes a key and all its grants. The key is refused from its next request. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return clientStatus("not_found");
  const { data, error } = await auth.supabase.rpc("revoke_agent_client", { p_id: id });
  if (error) return json({ error: "Could not revoke the API key" }, 500);
  const result = data as { status?: string; client?: unknown };
  return result?.status === "revoked" ? json({ client: result.client }) : clientStatus(result?.status);
}
