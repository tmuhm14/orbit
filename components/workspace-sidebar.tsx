"use client";

import Link from "next/link";
import {
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Download,
  LayoutGrid,
  List,
  LogOut,
  Orbit,
  PanelLeftClose,
  Search,
  Settings2,
  Sparkles,
} from "lucide-react";
import { BUCKETS } from "@/lib/notes";
import { signOut } from "@/app/auth/actions";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { bucketIcons, useWorkspaceShell } from "./workspace-shell-context";

type SwitcherProps = Omit<Parameters<typeof WorkspaceSwitcher>[0], "variant">;

export function WorkspaceSidebar({
  open,
  inert,
  switcherProps,
  onSearch,
  onClose,
}: {
  open: boolean;
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
    navigate,
    exportNotes,
    openGuide,
  } = useWorkspaceShell();
  const onRoute = !settingsPage && !scheduledPage;
  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside inert={inert} className={`sidebar ${open ? "is-open" : ""}`}>
        <button
          className="brand"
          onClick={() => navigate("overview")}
          aria-label="Orbit home"
        >
          <Orbit size={31} strokeWidth={1.5} />
          <span>
            orbit<span className="brand-period">.</span>
          </span>
          <span className="beta-label">BETA</span>
        </button>
        <WorkspaceSwitcher {...switcherProps} />
        <button className="search-trigger" onClick={onSearch}>
          <Search size={16} />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="Main navigation">
          <button
            className={`nav-item ${onRoute && view === "overview" && !search ? "active" : ""}`}
            onClick={() => navigate("overview")}
          >
            <LayoutGrid size={18} />
            <span>My space</span>
            <span className="nav-active-dot" />
          </button>
          <button
            className={`nav-item ${onRoute && view === "all" && !search ? "active" : ""}`}
            onClick={() => navigate("all")}
          >
            <List size={18} />
            <span>All items</span>
            <span className="nav-count">{loaded ? activeNotes.length : "–"}</span>
          </button>
          <div className="nav-label">
            YOUR BUCKETS <span>{BUCKETS.length}</span>
          </div>
          {BUCKETS.map((b) => {
            const Icon = bucketIcons[b.icon];
            return (
              <button
                key={b.id}
                className={`nav-item ${onRoute && view === b.id && !search ? "active" : ""}`}
                onClick={() => navigate(b.id)}
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
            onClick={() => navigate("completed")}
          >
            <CheckCircle2 size={18} />
            <span>Completed</span>
            <span className="nav-count">{completed.length || ""}</span>
          </button>
          <div className="nav-divider" />
          <Link className={`nav-item ${scheduledPage ? "active" : ""}`} href="/scheduled" onClick={onClose} aria-current={scheduledPage ? "page" : undefined}>
            <CalendarClock size={18} />
            <span>Scheduled jobs</span>
          </Link>
          <Link className={`nav-item ${settingsPage ? "active" : ""}`} href="/settings" onClick={onClose} aria-current={settingsPage ? "page" : undefined}>
            <Settings2 size={18} />
            <span>Settings</span>
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <button className="review-card" onClick={openGuide}>
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
          <button className="sidebar-export" onClick={exportNotes}>
            <Download size={15} />
            Export your notes
            <ArrowUpRight size={13} />
          </button>
          <form action={signOut}>
            <button className="account-signout" type="submit">
              <LogOut size={15} />
              Sign out
            </button>
          </form>
          <div className="profile">
            <div className="profile-avatar">{email[0]?.toUpperCase()}</div>
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
