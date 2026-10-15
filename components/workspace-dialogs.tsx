"use client";

import { useEffect, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import type { Note, Workspace as WorkspaceInfo } from "@/lib/notes";
import { AgentDialog } from "./agent-dialog";
import { GuideDialog } from "./guide-dialog";
import { NoteEditor } from "./note-editor";
import { ScheduledDialog } from "./scheduled-dialog";
import { SearchDialog } from "./search-dialog";

/** Open/closed state for the workspace's modal dialogs. */
export function useWorkspaceDialogs(initialSearchOpen: boolean) {
  const [searchOpen, setSearchOpen] = useState(initialSearchOpen);
  const [guideOpen, setGuideOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [scheduledRefreshToken, setScheduledRefreshToken] = useState(0);
  return {
    searchOpen,
    setSearchOpen,
    guideOpen,
    setGuideOpen,
    agentOpen,
    setAgentOpen,
    scheduledOpen,
    setScheduledOpen,
    /** Bumped whenever the scheduled dialog is closed so the audit page reloads. */
    scheduledRefreshToken,
    closeScheduled() {
      setScheduledOpen(false);
      setScheduledRefreshToken((value) => value + 1);
    },
    /** Escape: dismiss every dialog (the note editor handles its own Escape). */
    closeAll() {
      setSearchOpen(false);
      setGuideOpen(false);
      setAgentOpen(false);
      setScheduledOpen(false);
    },
    anyOpen: searchOpen || guideOpen || agentOpen || scheduledOpen,
  };
}

export type WorkspaceDialogsState = ReturnType<typeof useWorkspaceDialogs>;

/** Auto-dismissing status toast. */
export function useToast() {
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  return [toast, setToast] as const;
}

/** Renders the note editor, dialogs and toast on top of the shell. */
export function WorkspaceDialogs({
  dialogs,
  currentNote,
  workspaces,
  currentWorkspace,
  workspaceNotes,
  agentAvailable,
  storageError,
  search,
  onSearchChange,
  searchRef,
  toast,
  onToast,
  onUpdateNote,
  onDeleteNote,
  onCloseNote,
  onToggleAgent,
  onAgentNotesChanged,
}: {
  dialogs: WorkspaceDialogsState;
  currentNote: Note | undefined;
  workspaces: WorkspaceInfo[];
  currentWorkspace: WorkspaceInfo;
  workspaceNotes: Note[];
  agentAvailable: boolean;
  storageError: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  toast: string;
  onToast: (message: string) => void;
  onUpdateNote: (patch: Partial<Note>) => void;
  onDeleteNote: () => void;
  onCloseNote: () => void;
  onToggleAgent: (enabled: boolean) => Promise<unknown>;
  onAgentNotesChanged: () => void;
}) {
  const router = useRouter();
  return (
    <>
      {currentNote && (
        <NoteEditor
          key={currentNote.id}
          note={currentNote}
          workspaces={workspaces}
          onUpdate={onUpdateNote}
          onClose={onCloseNote}
          onDelete={onDeleteNote}
          storageError={storageError}
        />
      )}
      {dialogs.searchOpen && (
        <SearchDialog
          inputRef={searchRef}
          value={search}
          onChange={onSearchChange}
          onClose={() => dialogs.setSearchOpen(false)}
        />
      )}
      {dialogs.guideOpen && <GuideDialog onClose={() => dialogs.setGuideOpen(false)} />}
      {dialogs.agentOpen && (
        <AgentDialog
          key={currentWorkspace.id}
          workspace={currentWorkspace}
          notes={workspaceNotes}
          available={agentAvailable}
          onToggleWorkspace={onToggleAgent}
          onNotesChanged={onAgentNotesChanged}
          onToast={onToast}
          onClose={() => dialogs.setAgentOpen(false)}
        />
      )}
      {dialogs.scheduledOpen && (
        <ScheduledDialog
          onClose={dialogs.closeScheduled}
          onOpenSettings={() => { dialogs.setScheduledOpen(false); router.push("/settings"); }}
          onToast={onToast}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={14} />
          </span>
          {toast}
        </div>
      )}
    </>
  );
}
