import { routeUser, json } from "@/lib/supabase/route-auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { name } = await request.json().catch(() => ({}));
  if (typeof name !== "string" || !name.trim() || name.trim().length > 60)
    return json({ error: "Name must be 1–60 characters" }, 400);
  const { data, error } = await auth.supabase
    .from("workspaces")
    .update({ name: name.trim() })
    .eq("id", id)
    .select("id,name,position")
    .single();
  if (error) return json({ error: "Could not rename workspace" }, 500);
  return json({ workspace: data });
}
