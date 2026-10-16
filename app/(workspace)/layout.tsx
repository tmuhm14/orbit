import { orbitPage } from "../orbit-page";

// Per-user and per-request (session cookies): never prerender these pages,
// even in a build without Supabase settings.
export const dynamic = "force-dynamic";

/**
 * The signed-in workspace. One shell (Workspace) for every page in this
 * group, so it stays mounted across client navigation: notes, unsaved edits,
 * open dialogs and polling survive moving between Home, Tasks, Projects,
 * Library, Agents and Settings. Each page.tsx renders nothing; the shell
 * picks its content from the pathname and search params.
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {await orbitPage()}
      {children}
    </>
  );
}
