import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authConfig } from "@/lib/supabase/config";
import { loadWorkspaces } from "@/lib/workspaces-db";
import { isAdminEmail } from "@/lib/admin";
import { SettingsScreen } from "@/components/settings-screen";

export const metadata = { title: "Settings — Orbit" };

export default async function Settings() {
  if (!authConfig()) redirect("/login");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const spaces = await loadWorkspaces(supabase);
  const { data: rows } = await supabase
    .from("notes")
    .select("workspace_id")
    .is("completed_at", null)
    .returns<{ workspace_id: string }[]>();
  const counts: Record<string, number> = {};
  for (const row of rows ?? [])
    counts[row.workspace_id] = (counts[row.workspace_id] ?? 0) + 1;
  return (
    <SettingsScreen
      userId={user.id}
      email={user.email || ""}
      isAdmin={isAdminEmail(user.email)}
      initialWorkspaces={spaces?.workspaces ?? []}
      initialSlack={spaces?.slack ?? []}
      counts={counts}
      inboundDomain={process.env.RESEND_INBOUND_DOMAIN || null}
    />
  );
}
