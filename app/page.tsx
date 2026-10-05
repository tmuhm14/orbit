import { redirect } from "next/navigation";
import { Workspace } from "@/components/workspace";
import { createClient } from "@/lib/supabase/server";
import { authConfig } from "@/lib/supabase/config";
import { NOTE_COLUMNS, fromRow, type NoteRow } from "@/lib/notes-db";

export default async function Home() {
  if (!authConfig()) redirect("/login");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data, error } = await supabase
    .from("notes")
    .select(NOTE_COLUMNS)
    .order("updated_at", { ascending: false })
    .returns<NoteRow[]>();
  return (
    <Workspace
      key={user.id}
      userId={user.id}
      email={user.email || "Your account"}
      initialNotes={error ? null : data.map(fromRow)}
    />
  );
}
