import { routeUser, json } from "@/lib/supabase/route-auth";
import { isUuid } from "@/lib/notes";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "Invalid space" }, 400);
  const { data, error } = await auth.supabase.rpc("set_default_workspace", {
    workspace: id,
  });
  if (error) return json({ error: "Could not set default space" }, 500);
  if (!data) return json({ error: "Space not found" }, 404);
  return json({ defaultWorkspaceId: id });
}
