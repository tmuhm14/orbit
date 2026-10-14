"use client";

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
  const { view, search, settingsPage, scheduledPage, loaded, loadError, newNote } =
    useWorkspaceShell();
  const bucket = BUCKETS.find((b) => b.id === view);
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
        <strong className="breadcrumb-current">
          {settingsPage ? "Settings" : scheduledPage ? "Scheduled jobs" : search
            ? "Search"
            : bucket?.name ||
              (view === "completed"
                ? "Completed"
                : view === "all"
                  ? "All items"
                  : "My space")}
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
        {!settingsPage && !scheduledPage && <button
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
