"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  BUCKETS,
  createNote,
  itemKind,
  type Note,
  type BucketId,
  workspaceColor,
  type SlackConnection,
  type Workspace as WorkspaceInfo,
} from "@/lib/notes";
import { ConflictNotice, ReloadBanner } from "./conflict-banner";
import { ScheduledAudit } from "./scheduled-audit";
import { SettingsContent } from "./settings-content";
import { useItemActions } from "./use-item-actions";
import { useNotes } from "./use-notes";
import { useQuickCapture } from "./use-quick-capture";
import { useSessionWatch } from "./use-session-watch";
import { useWorkspaces } from "./use-workspaces";
import { useWorkspaceShortcuts } from "./use-workspace-shortcuts";
import { spaceStyle } from "./workspace-switcher";
import {
  WorkspaceDialogs,
  useToast,
  useWorkspaceDialogs,
  type ProjectDelete,
} from "./workspace-dialogs";
import { WorkspaceMain } from "./workspace-main";
import {
  WorkspaceShellProvider,
  type View,
  type WorkspaceShellValue,
} from "./workspace-shell-context";
import { WorkspaceSidebar } from "./workspace-sidebar";
import { WorkspaceTopbar } from "./workspace-topbar";

/**
 * App shell and state owner for the signed-in workspace. Renders the sidebar,
 * top bar, route content (notes views, settings, scheduled jobs) and dialogs.
 */
export function Workspace({
  userId,
  email,
  initialNotes,
  initialWorkspaces,
  initialSlack,
  inboundDomain,
  agentAvailable,
  initialView = "overview",
  initialSearchOpen = false,
}: {
  userId: string;
  email: string;
  initialNotes: Note[] | null;
  initialWorkspaces: WorkspaceInfo[];
  initialSlack: SlackConnection[];
  inboundDomain: string | null;
  agentAvailable: boolean;
  initialView?: View;
  initialSearchOpen?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const settingsPage = pathname === "/settings";
  const scheduledPage = pathname === "/scheduled";
  const notesApi = useNotes(userId, initialNotes);
  const {
    notes,
    setNotes,
    loaded,
    loadError,
    storageError,
    browserNoteCount,
    dismissBrowserNotes,
    importBrowserNotes,
    refresh,
    conflicts,
    deleteConflictIds,
    dismissDeleteConflicts,
    blockedDeletes,
  } = notesApi;
  const sessionExpired = useSessionWatch(userId);
  const spaces = useWorkspaces(initialWorkspaces, initialSlack);
  const workspaceId = spaces.current.id;
  const [view, setView] = useState<View>(initialView);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useToast();
  // A project delete the user started here (it has linked items locally).
  // Deletes the server refused arrive through blockedDeletes instead.
  const [localProjectDelete, setLocalProjectDelete] = useState<ProjectDelete | null>(null);
  const projectDelete = localProjectDelete ?? blockedDeletes[0] ?? null;
  const conflictIds = useMemo(() => new Set(conflicts.map((c) => c.id)), [conflicts]);
  useEffect(() => {
    if (!deleteConflictIds.length) return;
    setToast("This note was changed elsewhere and was not deleted.");
    dismissDeleteConflicts();
  }, [deleteConflictIds, dismissDeleteConflicts, setToast]);
  const dialogs = useWorkspaceDialogs(initialSearchOpen);
  const capture = useQuickCapture({ setNotes, workspaceId, onToast: setToast });
  const items = useItemActions({ notes, setNotes, workspaceId, showToast: setToast });
  const searchRef = useRef<HTMLInputElement>(null);
  const { setSearchOpen } = dialogs;
  useEffect(() => {
    if (initialSearchOpen && !settingsPage) {
      setSearchOpen(true);
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [initialSearchOpen, settingsPage, setSearchOpen]);
  useWorkspaceShortcuts({
    disabled: !!selected || !!projectDelete,
    onSearch: openSearch,
    onCapture: capture.focus,
    onEscape: () => {
      dialogs.closeAll();
      setSidebarOpen(false);
    },
  });
  async function importExistingNotes() {
    setToast(
      (await importBrowserNotes(workspaceId))
        ? "Notes moved into your account"
        : "Unable to move notes. They are still saved in this browser.",
    );
  }
  const workspaceNotes = notes.filter((n) => n.workspaceId === workspaceId);
  const activeNotes = workspaceNotes.filter((n) => !n.completedAt);
  const completed = workspaceNotes.filter((n) => n.completedAt);
  const bucket = BUCKETS.find((b) => b.id === view);
  const currentNote = notes.find((n) => n.id === selected);
  function openSearch() {
    if (settingsPage || scheduledPage) { router.push("/?focus=search"); return; }
    setSearchOpen(true);
    setTimeout(() => searchRef.current?.focus(), 0);
  }
  function switchWorkspace(id: string) {
    spaces.select(id);
    if (!settingsPage && !scheduledPage) navigate("overview");
  }
  const notesPerWorkspace = Object.fromEntries(
    spaces.workspaces.map((w) => [
      w.id,
      notes.filter((n) => n.workspaceId === w.id && !n.completedAt).length,
    ]),
  );
  const switcherProps = {
    workspaces: spaces.workspaces,
    current: spaces.current,
    counts: notesPerWorkspace,
    slack: spaces.slack,
    onSelect: switchWorkspace,
    onSetDefault: async (id: string) => {
      await spaces.setDefault(id);
      setToast("Default space updated");
    },
    onCreate: async (name: string) => {
      await spaces.create(name);
      navigate("overview");
      setToast(`Created ${name}`);
    },
    onRename: spaces.rename,
    onRecolor: spaces.recolor,
    inboundDomain,
    onNewAddress: async (id: string) => {
      await spaces.newAddress(id);
      setToast("New email address created. The old one no longer works.");
    },
    onCopied: () => setToast("Email address copied"),
    onRouteSlack: async (link: SlackConnection, id: string) => {
      await spaces.routeSlack(link, id);
      setToast(
        `Slack now sends to ${spaces.workspaces.find((w) => w.id === id)?.name}`,
      );
    },
    onDisconnectSlack: async (link: SlackConnection) => {
      await spaces.disconnectSlack(link);
      setToast("Slack disconnected");
    },
    onError: setToast,
  };
  function navigate(next: View) {
    if (settingsPage || scheduledPage) router.push(next === "overview" ? "/" : `/?view=${next}`);
    setView(next);
    setSearch("");
    setTagFilter("");
    setSidebarOpen(false);
    if (BUCKETS.some((b) => b.id === next)) capture.setBucket(next as BucketId);
    else capture.setBucket("inbox");
  }
  function newNote() {
    const note = createNote("", bucket?.id || "inbox", workspaceId);
    setNotes((n) => [note, ...n]);
    setSelected(note.id);
  }
  function updateNote(patch: Partial<Note>) {
    setNotes((n) =>
      n.map((item) =>
        item.id === selected
          ? { ...item, ...patch, updatedAt: new Date().toISOString() }
          : item,
      ),
    );
  }
  function deleteSelected() {
    const id = selected;
    if (!id) return;
    const note = notes.find((n) => n.id === id);
    const linked = note && itemKind(note) === "project" ? notesApi.childrenOf(id).length : 0;
    if (linked) {
      setLocalProjectDelete({ id, count: linked });
      return;
    }
    notesApi.deleteNote(id);
    setSelected(null);
    setToast("Note deleted");
  }
  function confirmProjectDelete(id: string) {
    setLocalProjectDelete(null);
    notesApi.deleteNote(id, { unlinkChildren: true });
    if (selected === id) setSelected(null);
    setToast("Project deleted. Its items moved up a level.");
  }
  function cancelProjectDelete(id: string) {
    if (localProjectDelete?.id === id) setLocalProjectDelete(null);
    else notesApi.dismissBlockedDelete(id);
  }
  function exportNotes() {
    const file = new Blob(
      [JSON.stringify(notesApi.exportData(), null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orbit-notes-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setToast("Your notes have been exported");
  }
  const shell: WorkspaceShellValue = {
    email,
    notes,
    setNotes,
    loaded,
    loadError,
    storageError,
    workspaceId,
    workspaceNotes,
    activeNotes,
    completed,
    bucketCount: (id: BucketId) =>
      activeNotes.filter((n) => n.bucket === id).length,
    view,
    search,
    setSearch,
    tagFilter,
    setTagFilter,
    settingsPage,
    scheduledPage,
    capture,
    navigate,
    openNote: setSelected,
    newNote,
    exportNotes,
    openGuide: () => dialogs.setGuideOpen(true),
    showToast: setToast,
    items,
    conflictIds,
  };
  if (sessionExpired)
    return (
      <div className="session-cover" role="status">
        Returning to sign in…
      </div>
    );
  const covered = !!currentNote || dialogs.anyOpen || !!projectDelete;
  const closedConflicts = conflicts.filter((c) => c.id !== selected);
  return (
    <WorkspaceShellProvider value={shell}>
      <div
        className="app-shell"
        style={spaceStyle(workspaceColor(spaces.workspaces, workspaceId))}
      >
        <WorkspaceSidebar
          open={sidebarOpen}
          inert={covered}
          switcherProps={switcherProps}
          onSearch={openSearch}
          onClose={() => setSidebarOpen(false)}
        />
        <div className="main-shell" inert={covered}>
          <WorkspaceTopbar
            switcherProps={switcherProps}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenScheduled={() => dialogs.setScheduledOpen(true)}
            onOpenAgent={() => dialogs.setAgentOpen(true)}
          />
          {(notesApi.reloadRequired || closedConflicts.length > 0) && (
            <div className="sync-notices">
              {notesApi.reloadRequired && <ReloadBanner />}
              <ConflictNotice
                conflicts={closedConflicts}
                onOpen={setSelected}
                onRestore={(id) => {
                  notesApi.takeTheirs(id);
                  setToast("Note restored");
                }}
                onKeepDeleted={(id) => {
                  notesApi.keepMine(id);
                  setToast("Note deleted");
                }}
              />
            </div>
          )}
          {scheduledPage ? <ScheduledAudit onOpenScheduled={() => dialogs.setScheduledOpen(true)} refreshToken={dialogs.scheduledRefreshToken} /> : settingsPage ? <SettingsContent
            email={email}
            workspaces={spaces.workspaces}
            slack={spaces.slack}
            inboundDomain={inboundDomain}
            agentAvailable={agentAvailable}
            onSetDefault={spaces.setDefault}
            onCreateSpace={spaces.create}
            onRenameSpace={spaces.rename}
            onRecolorSpace={spaces.recolor}
            onNewAddress={spaces.newAddress}
            onRouteSlack={spaces.routeSlack}
            onDisconnectSlack={spaces.disconnectSlack}
            onOpenScheduled={() => dialogs.setScheduledOpen(true)}
            onToast={setToast}
          /> : <WorkspaceMain
            browserNoteCount={browserNoteCount}
            onDismissBrowserNotes={dismissBrowserNotes}
            onImportBrowserNotes={importExistingNotes}
          />}
        </div>
        <WorkspaceDialogs
          dialogs={dialogs}
          currentNote={currentNote}
          api={notesApi}
          projectDelete={projectDelete}
          onConfirmProjectDelete={confirmProjectDelete}
          onCancelProjectDelete={cancelProjectDelete}
          onOpenNote={setSelected}
          workspaces={spaces.workspaces}
          currentWorkspace={spaces.current}
          workspaceNotes={workspaceNotes}
          agentAvailable={agentAvailable}
          storageError={storageError}
          search={search}
          onSearchChange={setSearch}
          searchRef={searchRef}
          toast={toast}
          onToast={setToast}
          onUpdateNote={updateNote}
          onDeleteNote={deleteSelected}
          onCloseNote={() => setSelected(null)}
          onToggleAgent={(enabled) => spaces.setAgentEnabled(workspaceId, enabled)}
          onAgentNotesChanged={() => void refresh()}
        />
      </div>
    </WorkspaceShellProvider>
  );
}
