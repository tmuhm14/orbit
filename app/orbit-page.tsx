import { redirect } from "next/navigation";
import { Workspace } from "@/components/workspace";
import { createClient } from "@/lib/supabase/server";
import { authConfig } from "@/lib/supabase/config";
import { NOTE_COLUMNS, fromRow, type NoteRow } from "@/lib/notes-db";
import { loadWorkspaces } from "@/lib/workspaces-db";
import { recordInitialLoadFailure } from "@/lib/initial-load";
import { agentEncryptionKey } from "@/lib/agent/server";

/**
 * Signs in (or redirects to /login), loads spaces and notes, and renders the
 * workspace shell. Used by app/(workspace)/layout.tsx; the shell reads the
 * initial view (?view=, ?focus=search) from the URL itself.
 */
export async function orbitPage() {
  if (!authConfig()) redirect("/login");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const spaces = await loadWorkspaces(supabase, (failure) =>
    recordInitialLoadFailure("workspaces", failure),
  );
  const { data, error } = await supabase
    .from("notes")
    .select(NOTE_COLUMNS)
    .order("updated_at", { ascending: false })
    .returns<NoteRow[]>();
  if (error) recordInitialLoadFailure("notes", error);
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
    />
  );
}
