import { routeUser, json } from "@/lib/supabase/route-auth";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { error } = await auth.supabase.from("notes").delete().eq("id", id);
  if (error) return json({ error: "Could not delete note" }, 500);
  return json({ deleted: id });
}
