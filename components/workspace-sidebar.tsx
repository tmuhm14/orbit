"use client";

import Link from "next/link";
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  CalendarClock,
  CheckCircle2,
  Download,
  Layers,
  LayoutGrid,
  List,
  ListChecks,
  LogOut,
  Orbit,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings2,
  Sparkles,
  Workflow,
} from "lucide-react";
import { BUCKETS } from "@/lib/notes";
import { settingsHref } from "@/lib/settings-sections";
import { signOut } from "@/app/auth/actions";
import { useBucketDropTargets } from "./item-drag";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { bucketIcons, useWorkspaceShell } from "./workspace-shell-context";

type SwitcherProps = Omit<Parameters<typeof WorkspaceSwitcher>[0], "variant">;

export function WorkspaceSidebar({
  open,
  collapsed,
  onToggleCollapsed,
  inert,
  switcherProps,
  onSearch,
  onClose,
}: {
  open: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  inert: boolean;
  switcherProps: SwitcherProps;
  onSearch: () => void;
  onClose: () => void;
}) {
  const {
    email,
    loaded,
    storageError,
    activeNotes,
    completed,
    bucketCount,
    view,
    search,
    settingsPage,
    scheduledPage,
    agentsPage,
    route,
    navigate,
    exportNotes,
    openGuide,
  } = useWorkspaceShell();
  const dropProps = useBucketDropTargets();
  const onRoute = route.page === "notes";
  const current = (active: boolean) => (active ? ("page" as const) : undefined);
  const tasksPage = route.page === "tasks";
  // A project's detail is part of Projects; a full-page item, of the Library.
  const projectsPage = route.page === "projects" || route.page === "project";
  const libraryPage = route.page === "library" || route.page === "item";
  const workflowsPage = route.page === "workflows" || route.page === "workflow";
  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside inert={inert} className={`sidebar ${open ? "is-open" : ""}`}>
        <div className="sidebar-brand-row">
          <button
            className="brand"
            onClick={() => navigate("overview")}
            aria-label="Orbit home"
          >
            <Orbit className="brand-orbit" size={31} strokeWidth={1.5} />
            <span>
              orbit<span className="brand-period">.</span>
            </span>
            <span className="beta-label">BETA</span>
          </button>
          <button
            className="icon-button sidebar-collapse-toggle"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls="sidebar-navigation"
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <WorkspaceSwitcher {...switcherProps} />
        <button className="search-trigger" onClick={onSearch} aria-label="Find anything" title="Find anything (⌘ K)">
          <Search size={16} />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav id="sidebar-navigation" aria-label="Main navigation">
          <button
            className={`nav-item ${onRoute && view === "overview" && !search ? "active" : ""}`}
            aria-current={current(onRoute && view === "overview" && !search)}
            aria-label="My space" title="My space"
            onClick={() => navigate("overview")}
          >
            <LayoutGrid size={18} />
            <span>My space</span>
            <span className="nav-active-dot" />
          </button>
          <button
            className={`nav-item ${onRoute && view === "all" && !search ? "active" : ""}`}
            aria-current={current(onRoute && view === "all" && !search)}
            aria-label="All items" title="All items"
            onClick={() => navigate("all")}
          >
            <List size={18} />
            <span>All items</span>
            <span className="nav-count">{loaded ? activeNotes.length : "–"}</span>
          </button>
          <Link className={`nav-item ${tasksPage ? "active" : ""}`} aria-label="Tasks" title="Tasks" href="/tasks" onClick={onClose} aria-current={current(tasksPage)}>
            <ListChecks size={18} />
            <span>Tasks</span>
          </Link>
          <Link className={`nav-item ${projectsPage ? "active" : ""}`} aria-label="Projects" title="Projects" href="/projects" onClick={onClose} aria-current={current(projectsPage)}>
            <Layers size={18} />
            <span>Projects</span>
          </Link>
          <Link className={`nav-item ${libraryPage ? "active" : ""}`} aria-label="Library" title="Library" href="/library" onClick={onClose} aria-current={current(libraryPage)}>
            <BookOpen size={18} />
            <span>Library</span>
          </Link>
          <div className="nav-label">
            YOUR BUCKETS <span>{BUCKETS.length}</span>
          </div>
          {BUCKETS.map((b) => {
            const Icon = bucketIcons[b.icon];
            return (
              <button
                key={b.id}
                aria-label={b.name} title={b.name}
                className={`nav-item ${onRoute && view === b.id && !search ? "active" : ""}`}
                aria-current={current(onRoute && view === b.id && !search)}
                onClick={() => navigate(b.id)}
                {...dropProps(b.id)}
              >
                <Icon className={b.color} size={18} />
                <span>{b.name}</span>
                <span className="nav-count">{loaded ? bucketCount(b.id) : "–"}</span>
              </button>
            );
          })}
          <div className="nav-divider" />
          <button
            className={`nav-item ${onRoute && view === "completed" ? "active" : ""}`}
            aria-current={current(onRoute && view === "completed")}
            aria-label="Completed" title="Completed"
            onClick={() => navigate("completed")}
          >
            <CheckCircle2 size={18} />
            <span>Completed</span>
            <span className="nav-count">{completed.length || ""}</span>
          </button>
          <div className="nav-divider" />
          <Link className={`nav-item ${agentsPage ? "active" : ""}`} aria-label="Agents" title="Agents" href="/agents" onClick={onClose} aria-current={agentsPage ? "page" : undefined}>
            <Bot size={18} />
            <span>Agents</span>
          </Link>
          <Link className={`nav-item ${workflowsPage ? "active" : ""}`} aria-label="Workflows" title="Workflows" href="/workflows" onClick={onClose} aria-current={current(workflowsPage)}>
            <Workflow size={18} />
            <span>Workflows</span>
          </Link>
          <Link className={`nav-item ${scheduledPage ? "active" : ""}`} aria-label="Scheduled jobs" title="Scheduled jobs" href="/scheduled" onClick={onClose} aria-current={scheduledPage ? "page" : undefined}>
            <CalendarClock size={18} />
            <span>Scheduled jobs</span>
          </Link>
          <Link className={`nav-item ${settingsPage ? "active" : ""}`} aria-label="Settings" title="Settings" href={settingsHref()} onClick={onClose} aria-current={settingsPage ? "page" : undefined}>
            <Settings2 size={18} />
            <span>Settings</span>
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <button aria-label="Your weekly review" title="Your weekly review" className="review-card" onClick={openGuide}>
            <span className="review-icon">
              <Sparkles size={17} />
            </span>
            <strong>A clearer mind starts here</strong>
            <p>
              A small weekly reset.
              <br />A little more headspace.
            </p>
            <span className="review-link">
              Your weekly review <ArrowUpRight size={14} />
            </span>
          </button>
          <button aria-label="Export your notes" title="Export your notes" className="sidebar-export" onClick={exportNotes}>
            <Download size={15} />
            <span>Export your notes</span>
            <ArrowUpRight size={13} />
          </button>
          <form action={signOut}>
            <button aria-label="Sign out" title="Sign out" className="account-signout" type="submit">
              <LogOut size={15} />
              <span>Sign out</span>
            </button>
          </form>
          <div className="profile">
            <div title={storageError ? `${email}: Storage needs attention` : email} className="profile-avatar">{email[0]?.toUpperCase()}</div>
            <div>
              <strong className="account-email" title={email}>
                {email}
              </strong>
              <small>
                <span
                  className={storageError ? "status-dot error" : "status-dot"}
                />
                {storageError
                  ? "Storage needs attention"
                  : "Synced to your account"}
              </small>
            </div>
            <button
              className="icon-button mobile-close"
              onClick={onClose}
              aria-label="Close navigation"
            >
              <PanelLeftClose size={17} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
