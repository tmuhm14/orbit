import { routeUser, json } from "@/lib/supabase/route-auth";
import { isUuid } from "@/lib/grants/validation";

/**
 * Disconnects an app (ADR 008): the connection, its grants and every access
 * and refresh token it holds stop working on the next request. Same-origin
 * only. Repeating it is harmless.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Connected app not found", code: "not_found" }, 404);
  const { data, error } = await auth.supabase.rpc("disconnect_oauth_connection", { p_id: id });
  if (error) return json({ error: "Could not disconnect the app" }, 500);
  const result = data as { status?: string; id?: string; revokedAt?: string } | null;
  if (result?.status !== "revoked") return json({ error: "Connected app not found", code: "not_found" }, 404);
  return json({ id: result.id, revokedAt: result.revokedAt });
}
