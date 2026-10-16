"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { Check, Layers } from "lucide-react";
import type { Note, Workspace as WorkspaceInfo } from "@/lib/notes";
import type { Assignment } from "@/lib/assignments/types";
import { AgentDialog } from "./agent-dialog";
import { AssignmentDetailDialog } from "./assignment-detail";
import { GuideDialog } from "./guide-dialog";
import type { ItemApi } from "./item-properties";
import { NoteEditor } from "./note-editor";
import { ScheduledDialog } from "./scheduled-dialog";
import { SearchDialog } from "./search-dialog";
import type { ToastAction } from "./workspace-shell-context";

/** Open/closed state for the workspace's modal dialogs. */
export function useWorkspaceDialogs(initialSearchOpen: boolean) {
  const [searchOpen, setSearchOpen] = useState(initialSearchOpen);
  const [guideOpen, setGuideOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [scheduledRefreshToken, setScheduledRefreshToken] = useState(0);
  /** The assignment detail opened from the Agents page or Home (not the editor's own). */
  const [assignmentId, setAssignmentId] = useState<string | null>(null);
  return {
    assignmentId,
    setAssignmentId,
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
      setAssignmentId(null);
    },
    anyOpen: searchOpen || guideOpen || agentOpen || scheduledOpen || assignmentId !== null,
  };
}

export type WorkspaceDialogsState = ReturnType<typeof useWorkspaceDialogs>;

/** A toast: plain text, or text with one action (shown longer so it can be used). */
export type ToastValue = string | { message: string; action: ToastAction };

/** Auto-dismissing status toast. */
export function useToast() {
  const [toast, setToast] = useState<ToastValue>("");
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), typeof toast === "string" ? 3500 : 8000);
    return () => clearTimeout(timer);
  }, [toast]);
  return [toast, setToast] as const;
}

/** A project delete waiting for the user's answer. */
export type ProjectDelete = { id: string; count: number };

/**
 * "This project has N linked items. Move them up a level and delete?"
 * Focus starts on Cancel, stays inside the dialog, and Escape cancels.
 */
function ProjectDeleteDialog({
  pending,
  title,
  onConfirm,
  onCancel,
}: {
  pending: ProjectDelete;
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      if (prior?.isConnected) prior.focus();
    };
  }, []);
  const items = pending.count === 1 ? "1 linked item" : `${pending.count} linked items`;
  return (
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={ref}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-delete-title"
        aria-describedby="project-delete-body"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key !== "Tab") return;
          const buttons = ref.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
          if (!buttons?.length) return;
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <span className="confirm-icon" aria-hidden="true">
          <Layers size={18} />
        </span>
        <h2 id="project-delete-title">Delete “{title}”?</h2>
        <p id="project-delete-body">
          This project has {items}. Move {pending.count === 1 ? "it" : "them"} up a level and delete?
        </p>
        <p className="confirm-hint">
          They’ll join the parent project, or stand on their own if there isn’t one. Nothing else is deleted.
        </p>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="text-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={onConfirm}>
            Move items and delete
          </button>
        </div>
      </div>
    </div>
  );
}

/** Renders the note editor, dialogs and toast on top of the shell. */
export function WorkspaceDialogs({
  dialogs,
  currentNote,
  api,
  projectDelete,
  onConfirmProjectDelete,
  onCancelProjectDelete,
  onOpenNote,
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
  onOpenFullPage,
  onToggleAgent,
  onAgentNotesChanged,
  onAssignmentChange,
  onDismissToast,
}: {
  dialogs: WorkspaceDialogsState;
  currentNote: Note | undefined;
  api: ItemApi;
  projectDelete: ProjectDelete | null;
  onConfirmProjectDelete: (id: string) => void;
  onCancelProjectDelete: (id: string) => void;
  onOpenNote: (id: string) => void;
  workspaces: WorkspaceInfo[];
  currentWorkspace: WorkspaceInfo;
  workspaceNotes: Note[];
  agentAvailable: boolean;
  storageError: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  toast: ToastValue;
  onToast: (message: string) => void;
  onUpdateNote: (patch: Partial<Note>) => void;
  onDeleteNote: () => void;
  onCloseNote: () => void;
  onOpenFullPage: (id: string) => void;
  onToggleAgent: (enabled: boolean) => Promise<unknown>;
  onAgentNotesChanged: () => void;
  onAssignmentChange: (assignment: Assignment) => void;
  onDismissToast: () => void;
}) {
  const router = useRouter();
  return (
    <>
      {currentNote && (
        <NoteEditor
          key={currentNote.id}
          note={currentNote}
          workspaces={workspaces}
          api={api}
          onUpdate={onUpdateNote}
          onClose={onCloseNote}
          onOpenFullPage={() => onOpenFullPage(currentNote.id)}
          onDelete={onDeleteNote}
          onOpenNote={onOpenNote}
          onToast={onToast}
          onOpenSettings={() => {
            onCloseNote();
            router.push("/settings");
          }}
          onOpenAgent={() => {
            onCloseNote();
            dialogs.setAgentOpen(true);
          }}
          storageError={storageError}
        />
      )}
      {projectDelete && (
        <ProjectDeleteDialog
          // Not the bare id: the editor for the same note is a sibling.
          key={`delete-${projectDelete.id}`}
          pending={projectDelete}
          title={api.notes.find((n) => n.id === projectDelete.id)?.title.trim() || "Untitled project"}
          onConfirm={() => onConfirmProjectDelete(projectDelete.id)}
          onCancel={() => onCancelProjectDelete(projectDelete.id)}
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
      {dialogs.assignmentId && (
        <AssignmentDetailDialog
          key={dialogs.assignmentId}
          assignmentId={dialogs.assignmentId}
          notes={api.notes}
          onClose={() => dialogs.setAssignmentId(null)}
          onChange={onAssignmentChange}
          onOpenNote={(id) => {
            dialogs.setAssignmentId(null);
            onOpenNote(id);
          }}
          onOpenAssignment={dialogs.setAssignmentId}
          onOpenSettings={() => {
            dialogs.setAssignmentId(null);
            router.push("/settings");
          }}
          onOpenAgent={() => {
            dialogs.setAssignmentId(null);
            dialogs.setAgentOpen(true);
          }}
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
        <div className={`toast ${typeof toast === "string" ? "" : "has-action"}`} role="status">
          <span>
            <Check size={14} />
          </span>
          {typeof toast === "string" ? toast : toast.message}
          {typeof toast !== "string" && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                onDismissToast();
                toast.action.onAction();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </>
  );
}
