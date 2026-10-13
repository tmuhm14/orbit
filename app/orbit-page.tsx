import { redirect } from "next/navigation";
import { Workspace } from "@/components/workspace";
import { createClient } from "@/lib/supabase/server";
import { authConfig } from "@/lib/supabase/config";
import { NOTE_COLUMNS, fromRow, type NoteRow } from "@/lib/notes-db";
import { loadWorkspaces } from "@/lib/workspaces-db";
import { agentEncryptionKey } from "@/lib/agent/server";
import { BUCKETS, type BucketId } from "@/lib/notes";

export async function orbitPage(initialView = "overview", initialSearchOpen = false) {
  if (!authConfig()) redirect("/login");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const spaces = await loadWorkspaces(supabase);
  const { data, error } = await supabase
    .from("notes")
    .select(NOTE_COLUMNS)
    .order("updated_at", { ascending: false })
    .returns<NoteRow[]>();
  const view = initialView === "all" || initialView === "completed" ||
    BUCKETS.some((bucket) => bucket.id === initialView)
    ? initialView as "all" | "completed" | BucketId : "overview";
  return (
    <Workspace
      key={user.id}
      userId={user.id}
      email={user.email || "Your account"}
      initialNotes={error || !spaces ? null : data.map(fromRow)}
      initialWorkspaces={spaces?.workspaces ?? [{
        id: "", name: "Personal", position: 0, color: null,
        isDefault: true, inboxToken: "", agentEnabled: false,
      }]}
      initialSlack={spaces?.slack ?? []}
      inboundDomain={process.env.RESEND_INBOUND_DOMAIN || null}
      agentAvailable={!!agentEncryptionKey()}
      initialView={view}
      initialSearchOpen={initialSearchOpen}
    />
  );
}
