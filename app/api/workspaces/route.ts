import { routeUser, json } from "@/lib/supabase/route-auth";

const validName = (name: unknown): name is string =>
  typeof name === "string" &&
  name.trim().length > 0 &&
  name.trim().length <= 60;

export async function POST(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { name } = await request.json().catch(() => ({}));
  if (!validName(name))
    return json({ error: "Name must be 1–60 characters" }, 400);
  const { count } = await auth.supabase
    .from("workspaces")
    .select("id", { count: "exact", head: true });
  if ((count ?? 0) >= 20)
    return json({ error: "Workspace limit reached" }, 400);
  const { data, error } = await auth.supabase
    .from("workspaces")
    .insert({ name: name.trim(), position: count ?? 0 })
    .select("id,name,position,color")
    .single();
  if (error) return json({ error: "Could not create workspace" }, 500);
  return json({ workspace: data });
}
