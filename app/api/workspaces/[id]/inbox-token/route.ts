import { routeUser, json } from "@/lib/supabase/route-auth";

/** Replaces a workspace's email address; the old one stops working. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { data, error } = await auth.supabase.rpc("regenerate_inbox_token", {
    workspace: id,
  });
  if (error || !data)
    return json({ error: "Could not create a new address" }, 500);
  return json({ inboxToken: data });
}
