"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import type { Assignment } from "@/lib/assignments/types";
import { itemHref, parseNotesView, parseRoute } from "@/lib/workspace-routes";
import { settingsHref } from "@/lib/settings-sections";
import { AgentsPage } from "./agents-page";
import { ItemPage } from "./item-page";
import { LibraryPage } from "./library-page";
import { ProjectPage, ProjectsPage } from "./projects-page";
import { TasksPage } from "./tasks-page";
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
 * top bar, route content (notes views, Tasks, Projects, Library, full-page
 * items, Agents, settings, scheduled jobs) and dialogs. Mounted once by
 * app/(workspace)/layout.tsx, so it survives client navigation; the page
 * comes from the pathname and the notes view from `?view=`.
 */
export function Workspace({
  userId,
  email,
  initialNotes,
  initialWorkspaces,
  initialSlack,
  inboundDomain,
  agentAvailable,
}: {
  userId: string;
  email: string;
  initialNotes: Note[] | null;
  initialWorkspaces: WorkspaceInfo[];
  initialSlack: SlackConnection[];
  inboundDomain: string | null;
  agentAvailable: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const route = parseRoute(pathname);
  const settingsPage = route.page === "settings";
  const scheduledPage = route.page === "scheduled";
  const agentsPage = route.page === "agents";
  // Pages other than the notes route (/): navigating to a view leaves them.
  const otherPage = route.page !== "notes";
  const viewParam = searchParams.get("view");
  const [initialSearchOpen] = useState(() => searchParams.get("focus") === "search");
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
  const [view, setView] = useState<View>(() => parseNotesView(viewParam));
  // Arriving on / with ?view= (a link, or back/forward from another page).
  useEffect(() => {
    if (route.page === "notes" && viewParam) setView(parseNotesView(viewParam));
  }, [route.page, viewParam]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toast, setToast] = useToast();
  // Detail dialogs and Delegate report fresher copies; a new assignment or
  // revision bumps the version so the Agents page and Home reload.
  const [assignmentsVersion, setAssignmentsVersion] = useState(0);
  const seenRevisions = useRef(new Map<string, number>());
  const assignmentChanged = useCallback((assignment: Assignment) => {
    const seen = seenRevisions.current.get(assignment.id);
    seenRevisions.current.set(assignment.id, assignment.revision);
    if (seen !== assignment.revision) setAssignmentsVersion((v) => v + 1);
  }, []);
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
    // The assignment detail handles its own Escape and keeps focus inside.
    disabled: !!selected || !!projectDelete || !!dialogs.assignmentId,
    onSearch: openSearch,
    onCapture: capture.focus,
    onEscape: () => {
      dialogs.closeAll();
      setSidebarOpen(false);
    },
  });
  // A new page (link, back/forward): close the editor dialog left over from
  // the last page and move focus to the new page's heading, unless the page
  // already placed it (the full-page editor focuses its title). Filter
  // changes keep the path, so they don't move focus.
  const lastPath = useRef(pathname);
  const navigated = useRef(false);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    navigated.current = true;
    setSelected(null);
    setSidebarOpen(false);
    const frame = requestAnimationFrame(() => {
      const main = document.querySelector<HTMLElement>(".main-shell main");
      const active = document.activeElement;
      // Leave focus alone when the page or a dialog (search) already took it.
      if (!main || main.contains(active) || active?.closest('[role="dialog"], [role="alertdialog"]')) return;
      const heading = main.querySelector<HTMLElement>("h1");
      if (!heading) return;
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);
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
    // Results show on the notes route; the shell stays mounted, so open here.
    if (otherPage) router.push("/");
    setSearchOpen(true);
    setTimeout(() => searchRef.current?.focus(), 0);
  }
  function switchWorkspace(id: string) {
    spaces.select(id);
    // List pages show the new space's work; settings and jobs stay put. An
    // item or project belongs to the old space, so go to its list instead.
    if (!otherPage) navigate("overview");
    else if (route.page === "project") router.push("/projects");
    else if (route.page === "item") router.push("/library");
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
    if (otherPage) router.push(next === "overview" ? "/" : `/?view=${next}`);
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
  /** A new item, opened in the editor. Fields override createNote's defaults. */
  function createItem(fields: Partial<Note> = {}) {
    const note = { ...createNote("", bucket?.id || "inbox", workspaceId), ...fields };
    setNotes((n) => [note, ...n]);
    setSelected(note.id);
    return note.id;
  }
  function updateNoteById(id: string, patch: Partial<Note>) {
    setNotes((n) =>
      n.map((item) =>
        item.id === id
          ? { ...item, ...patch, updatedAt: new Date().toISOString() }
          : item,
      ),
    );
  }
  function updateNote(patch: Partial<Note>) {
    if (selected) updateNoteById(selected, patch);
  }
  /** Leaves a full page or project detail whose item no longer exists. */
  function leaveDeleted(id: string, project: boolean) {
    if ((route.page === "item" || route.page === "project") && route.id === id)
      router.push(project ? "/projects" : "/library");
  }
  function deleteItem(id: string) {
    const note = notes.find((n) => n.id === id);
    const project = !!note && itemKind(note) === "project";
    const linked = project ? notesApi.childrenOf(id).length : 0;
    if (linked) {
      setLocalProjectDelete({ id, count: linked });
      return;
    }
    notesApi.deleteNote(id);
    if (selected === id) setSelected(null);
    setToast(project ? "Project deleted" : "Note deleted");
    leaveDeleted(id, project);
  }
  function deleteSelected() {
    if (selected) deleteItem(selected);
  }
  function confirmProjectDelete(id: string) {
    setLocalProjectDelete(null);
    notesApi.deleteNote(id, { unlinkChildren: true });
    if (selected === id) setSelected(null);
    setToast("Project deleted. Its items moved up a level.");
    leaveDeleted(id, true);
  }
  function openFullPage(id: string) {
    setSelected(null);
    router.push(itemHref(id));
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
    route,
    api: notesApi,
    createItem,
    openFullPage,
    goBack: (fallback) => {
      if (navigated.current) router.back();
      else router.push(fallback);
    },
    exportNotes,
    openGuide: () => dialogs.setGuideOpen(true),
    showToast: setToast,
    items,
    conflictIds,
    agentsPage,
    agentEnabled: spaces.current.agentEnabled,
    refreshNotes: refresh,
    showActionToast: (message, action) => setToast({ message, action }),
    openAssignment: (id) => dialogs.setAssignmentId(id),
    assignmentsVersion,
    assignmentChanged,
    openSettings: () => {
      setSelected(null);
      dialogs.setAssignmentId(null);
      // Every caller is a "save a model key" link.
      router.push(settingsHref("model"));
    },
    openAgentDialog: () => {
      setSelected(null);
      dialogs.setAssignmentId(null);
      dialogs.setAgentOpen(true);
    },
  };
  if (sessionExpired)
    return (
      <div className="session-cover" role="status">
        Returning to sign in…
      </div>
    );
  const covered = !!currentNote || dialogs.anyOpen || !!projectDelete;
  // A conflict shows in the open editor (dialog or full page) instead.
  const pageItemId = route.page === "item" ? route.id : null;
  const closedConflicts = conflicts.filter((c) => c.id !== selected && c.id !== pageItemId);
  return (
    <WorkspaceShellProvider value={shell}>
      <div
        className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
        style={spaceStyle(workspaceColor(spaces.workspaces, workspaceId))}
      >
        <WorkspaceSidebar
          open={sidebarOpen}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
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
          {route.page === "tasks" ? <TasksPage /> : route.page === "projects" ? <ProjectsPage /> : route.page === "project" ? <ProjectPage key={route.id} id={route.id} /> : route.page === "library" ? <LibraryPage /> : route.page === "item" ? <ItemPage
            key={route.id}
            id={route.id}
            workspaces={spaces.workspaces}
            storageError={storageError}
            onUpdate={(patch) => updateNoteById(route.id, patch)}
            onDelete={() => deleteItem(route.id)}
            onToast={setToast}
            onOpenAgent={() => dialogs.setAgentOpen(true)}
          /> : agentsPage ? <AgentsPage /> : scheduledPage ? <ScheduledAudit onOpenScheduled={() => dialogs.setScheduledOpen(true)} refreshToken={dialogs.scheduledRefreshToken} /> : route.page === "settings" ? <SettingsContent
            section={route.section}
            email={email}
            workspaces={spaces.workspaces}
            slack={spaces.slack}
            inboundDomain={inboundDomain}
            agentAvailable={agentAvailable}
            onSetDefault={spaces.setDefault}
            onCreateSpace={spaces.create}
            onRenameSpace={spaces.rename}
            onRecolorSpace={spaces.recolor}
            onSetAgentEnabled={spaces.setAgentEnabled}
            onNewAddress={spaces.newAddress}
            onRouteSlack={spaces.routeSlack}
            onDisconnectSlack={spaces.disconnectSlack}
            onOpenScheduled={() => dialogs.setScheduledOpen(true)}
            onOpenAgent={() => dialogs.setAgentOpen(true)}
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
          onOpenFullPage={openFullPage}
          onToggleAgent={(enabled) => spaces.setAgentEnabled(workspaceId, enabled)}
          onAgentNotesChanged={() => void refresh()}
          onAssignmentChange={assignmentChanged}
          onDismissToast={() => setToast("")}
        />
      </div>
    </WorkspaceShellProvider>
  );
}
