"use client";

import Link from "next/link";
import { Bot, CalendarClock, ChevronRight, PanelLeftOpen, Plus } from "lucide-react";
import { BUCKETS } from "@/lib/notes";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { useWorkspaceShell } from "./workspace-shell-context";

type SwitcherProps = Omit<Parameters<typeof WorkspaceSwitcher>[0], "variant">;

export function WorkspaceTopbar({
  switcherProps,
  onOpenSidebar,
  onOpenScheduled,
  onOpenAgent,
}: {
  switcherProps: SwitcherProps;
  onOpenSidebar: () => void;
  onOpenScheduled: () => void;
  onOpenAgent: () => void;
}) {
  const { view, search, settingsPage, scheduledPage, agentsPage, loaded, loadError, newNote, route, notes } =
    useWorkspaceShell();
  const bucket = BUCKETS.find((b) => b.id === view);
  const titleOf = (id: string, fallback: string) =>
    notes.find((n) => n.id === id)?.title.trim() || fallback;
  // Projects › <project> and <item> on the U-03 pages; the notes views as before.
  const parent =
    route.page === "project" ? { href: "/projects", label: "Projects" } : null;
  const pageLabel =
    route.page === "tasks"
      ? "Tasks"
      : route.page === "projects"
        ? "Projects"
        : route.page === "project"
          ? titleOf(route.id, "Untitled project")
          : route.page === "library"
            ? "Library"
            : route.page === "item"
              ? titleOf(route.id, "Untitled thought")
              : null;
  return (
    <header className="topbar">
      <div className="breadcrumb">
        <button
          className="icon-button mobile-toggle"
          onClick={onOpenSidebar}
          aria-label="Open navigation"
        >
          <PanelLeftOpen size={20} />
        </button>
        <WorkspaceSwitcher variant="pill" {...switcherProps} />
        <ChevronRight size={13} />
        {parent && (
          <>
            <Link className="breadcrumb-parent" href={parent.href}>
              {parent.label}
            </Link>
            <ChevronRight size={13} />
          </>
        )}
        <strong className="breadcrumb-current">
          {pageLabel ?? (settingsPage ? "Settings" : scheduledPage ? "Scheduled jobs" : agentsPage ? "Agents" : search
            ? "Search"
            : bucket?.name ||
              (view === "completed"
                ? "Completed"
                : view === "all"
                  ? "All items"
                  : "My space"))}
        </strong>
      </div>
      <div className="topbar-right">
        <button
          className="icon-button"
          onClick={onOpenScheduled}
          aria-label="Scheduled work"
          title="Scheduled work"
        >
          <CalendarClock size={18} />
        </button>
        <button
          className="icon-button"
          onClick={onOpenAgent}
          aria-label="Organizing agent"
          title="Organizing agent"
        >
          <Bot size={18} />
        </button>
        {route.page === "notes" && <button
          className="primary-button small topbar-new-note"
          onClick={newNote}
          disabled={!loaded || loadError}
          title="New note"
        >
          <Plus size={16} aria-hidden="true" />
          {/* Visually hidden on phones; still the button's accessible name. */}
          <span className="topbar-new-note-label">New note</span>
        </button>}
      </div>
    </header>
  );
}
