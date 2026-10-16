import { routeUser, json } from "@/lib/supabase/route-auth";
import { grantsInput, isUuid } from "@/lib/grants/validation";
import { clientStatus } from "@/lib/grants/clients";

/** Replaces a client's grants; applies to the key's next request. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return clientStatus("not_found");
  const body = await request.json().catch(() => null) as { grants?: unknown } | null;
  const grants = body && typeof body === "object" && Object.keys(body).every((k) => k === "grants")
    ? grantsInput(body.grants) : null;
  if (!grants) return clientStatus("invalid_payload");
  const { data, error } = await auth.supabase.rpc("set_agent_client_grants", { p_id: id, p_grants: grants });
  if (error) return json({ error: "Could not update the API key" }, 500);
  const result = data as { status?: string; client?: unknown };
  return result?.status === "saved" ? json({ client: result.client }) : clientStatus(result?.status);
}
