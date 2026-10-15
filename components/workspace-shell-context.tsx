"use client";

import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import {
  BookOpen,
  Clock3,
  Inbox,
  Layers,
  Sparkles,
  Zap,
} from "lucide-react";
import type { BucketId, Note } from "@/lib/notes";
import type { Assignment } from "@/lib/assignments/types";
import type { QuickCaptureState } from "./use-quick-capture";
import type { ItemActions } from "./use-item-actions";

export const bucketIcons = {
  inbox: Inbox,
  zap: Zap,
  layers: Layers,
  clock: Clock3,
  sparkles: Sparkles,
  book: BookOpen,
};

export type View = "overview" | "all" | BucketId | "completed";

/**
 * Shared state for the workspace shell. Owned by `Workspace`; read by the
 * sidebar, top bar, Home and list views so they don't need long prop chains.
 */
export type WorkspaceShellValue = {
  email: string;
  notes: Note[];
  setNotes: Dispatch<SetStateAction<Note[]>>;
  loaded: boolean;
  loadError: boolean;
  storageError: boolean;
  workspaceId: string;
  workspaceNotes: Note[];
  activeNotes: Note[];
  completed: Note[];
  bucketCount: (id: BucketId) => number;
  view: View;
  search: string;
  setSearch: (value: string) => void;
  tagFilter: string;
  setTagFilter: (value: string) => void;
  settingsPage: boolean;
  scheduledPage: boolean;
  capture: QuickCaptureState;
  navigate: (next: View) => void;
  openNote: (id: string) => void;
  newNote: () => void;
  exportNotes: () => void;
  openGuide: () => void;
  showToast: (message: string) => void;
  /**
   * Shared move/complete actions and Home drag state (see `useItemActions`).
   * Both actions save through `setNotes`, return whether anything changed,
   * and show a toast when it did.
   */
  items: ItemActions;
  /** Notes that changed elsewhere while edited here (ADR 002); lists mark them. */
  conflictIds: ReadonlySet<string>;
  /** The Agents page (`/agents`, U-05). */
  agentsPage: boolean;
  /** The current space's agent switch. */
  agentEnabled: boolean;
  /** Reloads notes from the server (useNotes' refresh), e.g. after a saved document. */
  refreshNotes: () => Promise<void>;
  /** A toast with one action button, e.g. "Saved to Reference · Open". */
  showActionToast: (message: string, action: ToastAction) => void;
  /** Opens an assignment's detail above the page (Agents page, Home). */
  openAssignment: (id: string) => void;
  /** Bumped when a detail dialog reports a change, so lists reload. */
  assignmentsVersion: number;
  /** Detail dialogs report every fresher copy here. */
  assignmentChanged: (assignment: Assignment) => void;
  /** Settings, and the agent dialog for this space (the "Turn on the agent" links). */
  openSettings: () => void;
  openAgentDialog: () => void;
};

export type ToastAction = { label: string; onAction: () => void };

const WorkspaceShellContext = createContext<WorkspaceShellValue | null>(null);

export const WorkspaceShellProvider = WorkspaceShellContext.Provider;

export function useWorkspaceShell() {
  const value = useContext(WorkspaceShellContext);
  if (!value) throw new Error("useWorkspaceShell must be used inside Workspace");
  return value;
}
