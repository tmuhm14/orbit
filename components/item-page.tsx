"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import { itemKind, type Note, type Workspace } from "@/lib/notes";
import { isActionable } from "@/lib/tasks-view";
import { projectHref } from "@/lib/workspace-routes";
import { NoteEditor } from "./note-editor";
import { WorkEmpty, WorkHeader } from "./work-rows";
import { useWorkspaceShell } from "./workspace-shell-context";

/** Where "Back" goes when there's no earlier page in this tab. */
function fallbackFor(note: Note) {
  if (itemKind(note) === "project") return projectHref(note.id);
  if (note.projectId) return projectHref(note.projectId);
  return isActionable(note) ? "/tasks" : "/library";
}

/**
 * Full-page reading and editing (`/items/[id]`) for any item: the same
 * editor as the dialog (properties, autosave status, conflict banner) in
 * the page flow. Edits save through the shell exactly as in the dialog.
 */
export function ItemPage({
  id,
  workspaces,
  storageError,
  onUpdate,
  onDelete,
  onToast,
  onOpenAgent,
}: {
  id: string;
  workspaces: Workspace[];
  storageError: boolean;
  onUpdate: (patch: Partial<Note>) => void;
  onDelete: () => void;
  onToast: (message: string) => void;
  onOpenAgent: () => void;
}) {
  const { notes, api, openNote, openSettings, loadError, goBack } = useWorkspaceShell();
  const note = notes.find((n) => n.id === id);
  if (!note)
    return (
      <main className="work-page item-page">
        <WorkHeader icon={<FileText size={22} />} eyebrow="FULL PAGE" title="Item not found" />
        <WorkEmpty
          title={loadError ? "Your items couldn’t be loaded" : "This item isn’t here"}
          body={loadError ? "Reload the page to try again." : "It may have been deleted, or the link is incomplete."}
        >
          <Link className="secondary-button" href="/library">
            Back to the Library
          </Link>
        </WorkEmpty>
      </main>
    );
  return (
    <main className="item-page">
      <NoteEditor
        layout="page"
        note={note}
        workspaces={workspaces}
        api={api}
        onUpdate={onUpdate}
        onClose={() => goBack(fallbackFor(note))}
        onDelete={onDelete}
        onOpenNote={openNote}
        onToast={onToast}
        onOpenSettings={openSettings}
        onOpenAgent={onOpenAgent}
        storageError={storageError}
      />
    </main>
  );
}
