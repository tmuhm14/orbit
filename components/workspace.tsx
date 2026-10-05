"use client";

import { useEffect, useRef, useState } from "react";
import {
  Orbit,
  Search,
  Plus,
  Inbox,
  Zap,
  Layers,
  Clock3,
  Sparkles,
  BookOpen,
  LayoutGrid,
  ArrowUpRight,
  ArrowUp,
  ChevronRight,
  Check,
  PanelLeftClose,
  PanelLeftOpen,
  List,
  X,
  Download,
  SlidersHorizontal,
  CheckCircle2,
  Feather,
  LogOut,
} from "lucide-react";
import {
  BUCKETS,
  createNote,
  textDoc,
  type Note,
  type BucketId,
} from "@/lib/notes";
import { NoteEditor } from "./note-editor";
import { GuideDialog } from "./guide-dialog";
import { SearchDialog } from "./search-dialog";
import { useNotes } from "./use-notes";
import { useSessionWatch } from "./use-session-watch";
import { signOut } from "@/app/auth/actions";

const icons = {
  inbox: Inbox,
  zap: Zap,
  layers: Layers,
  clock: Clock3,
  sparkles: Sparkles,
  book: BookOpen,
};
type View = "overview" | BucketId | "completed";

export function Workspace({
  userId,
  email,
  initialNotes,
}: {
  userId: string;
  email: string;
  initialNotes: Note[] | null;
}) {
  const {
    notes,
    setNotes,
    loaded,
    loadError,
    storageError,
    browserNoteCount,
    dismissBrowserNotes,
    importBrowserNotes,
  } = useNotes(userId, initialNotes);
  const sessionExpired = useSessionWatch(userId);
  const [view, setView] = useState<View>("overview");
  const [selected, setSelected] = useState<string | null>(null);
  const [capture, setCapture] = useState("");
  const [captureBucket, setCaptureBucket] = useState<BucketId>("inbox");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<"newest" | "oldest" | "title">("newest");
  const [layout, setLayout] = useState<"list" | "grid">("list");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (selected) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        captureRef.current?.focus();
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setGuideOpen(false);
        setSidebarOpen(false);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected]);
  async function importExistingNotes() {
    setToast(
      (await importBrowserNotes())
        ? "Notes moved into your account"
        : "Unable to move notes. They are still saved in this browser.",
    );
  }
  const activeNotes = notes.filter((n) => !n.completedAt);
  const completed = notes.filter((n) => n.completedAt);
  const bucket = BUCKETS.find((b) => b.id === view);
  const currentNote = notes.find((n) => n.id === selected);
  const allTags = [...new Set(notes.flatMap((n) => n.tags))].sort();
  const visible = notes
    .filter((n) => {
      const matchesView = search
        ? true
        : view === "overview"
          ? !n.completedAt
          : view === "completed"
            ? !!n.completedAt
            : n.bucket === view && !n.completedAt;
      const matchesText =
        !search ||
        `${n.title} ${n.plainText} ${n.tags.join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase());
      return (
        matchesView && matchesText && (!tagFilter || n.tags.includes(tagFilter))
      );
    })
    .sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "oldest"
          ? a.updatedAt.localeCompare(b.updatedAt)
          : b.updatedAt.localeCompare(a.updatedAt),
    );
  function openSearch() {
    setSearchOpen(true);
    setTimeout(() => searchRef.current?.focus(), 0);
  }
  function navigate(next: View) {
    setView(next);
    setSearch("");
    setTagFilter("");
    setSidebarOpen(false);
    if (BUCKETS.some((b) => b.id === next)) setCaptureBucket(next as BucketId);
    else setCaptureBucket("inbox");
  }
  function newNote() {
    const note = createNote("", bucket?.id || "inbox");
    setNotes((n) => [note, ...n]);
    setSelected(note.id);
  }
  function quickCapture() {
    if (!capture.trim()) {
      captureRef.current?.focus();
      return;
    }
    const [title, ...body] = capture.trim().split("\n");
    const note = {
      ...createNote(title, captureBucket),
      content: textDoc(body.join("\n")),
      plainText: body.join("\n"),
    };
    setNotes((n) => [note, ...n]);
    setCapture("");
    setToast(
      `Captured in ${BUCKETS.find((b) => b.id === captureBucket)?.name}`,
    );
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
  function exportNotes() {
    const file = new Blob(
      [
        JSON.stringify(
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            notes,
          },
          null,
          2,
        ),
      ],
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
  const count = (id: BucketId) =>
    activeNotes.filter((n) => n.bucket === id).length;
  if (sessionExpired)
    return (
      <div className="session-cover" role="status">
        Returning to sign in…
      </div>
    );
  return (
    <div className="app-shell">
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        inert={!!currentNote || searchOpen || guideOpen}
        className={`sidebar ${sidebarOpen ? "is-open" : ""}`}
      >
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
        <div className="workspace-switch">
          <div className="workspace-avatar">
            Y<span>✦</span>
          </div>
          <div>
            <strong>Your workspace</strong>
            <small>A little room to think</small>
          </div>
          <span className="workspace-spark">✧</span>
        </div>
        <button className="search-trigger" onClick={openSearch}>
          <Search size={16} />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="Main navigation">
          <button
            className={`nav-item ${view === "overview" && !search ? "active" : ""}`}
            onClick={() => navigate("overview")}
          >
            <LayoutGrid size={18} />
            <span>My space</span>
            <span className="nav-active-dot" />
          </button>
          <div className="nav-label">
            YOUR BUCKETS <span>{BUCKETS.length}</span>
          </div>
          {BUCKETS.map((b) => {
            const Icon = icons[b.icon];
            return (
              <button
                key={b.id}
                className={`nav-item ${view === b.id && !search ? "active" : ""}`}
                onClick={() => navigate(b.id)}
              >
                <Icon className={b.color} size={18} />
                <span>{b.name}</span>
                <span className="nav-count">{loaded ? count(b.id) : "–"}</span>
              </button>
            );
          })}
          <div className="nav-divider" />
          <button
            className={`nav-item ${view === "completed" ? "active" : ""}`}
            onClick={() => navigate("completed")}
          >
            <CheckCircle2 size={18} />
            <span>Completed</span>
            <span className="nav-count">{completed.length || ""}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button className="review-card" onClick={() => setGuideOpen(true)}>
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
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation"
            >
              <PanelLeftClose size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div
        className="main-shell"
        inert={!!currentNote || searchOpen || guideOpen}
      >
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-toggle"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
            >
              <PanelLeftOpen size={20} />
            </button>
            <span className="breadcrumb-orbit">
              <Orbit size={16} />
            </span>
            <span>Your workspace</span>
            <ChevronRight size={13} />
            <strong>
              {search
                ? "Search"
                : bucket?.name ||
                  (view === "completed" ? "Completed" : "My space")}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="local-label">
              <span className="status-dot" />
              Personal workspace
            </span>
            <button
              className="primary-button small"
              onClick={newNote}
              disabled={!loaded || loadError}
            >
              <Plus size={16} />
              New note
            </button>
          </div>
        </header>
        <main>
          {browserNoteCount > 0 && !loadError && (
            <div className="legacy-import">
              <p>
                {browserNoteCount === 1
                  ? "1 note is saved only in this browser. Move it into your account so it syncs everywhere."
                  : `${browserNoteCount} notes are saved only in this browser. Move them into your account so they sync everywhere.`}
              </p>
              <div>
                <button className="text-button" onClick={dismissBrowserNotes}>
                  Not now
                </button>
                <button
                  className="secondary-button"
                  onClick={importExistingNotes}
                >
                  Move my notes
                </button>
              </div>
            </div>
          )}
          {storageError && (
            <div className="storage-warning" role="alert">
              {loadError
                ? "Your notes could not be loaded. Reload the page to try again; editing is paused."
                : "Your latest changes have not been saved yet. Orbit will keep retrying; export your notes to keep a backup."}
              {!loadError && (
                <button onClick={exportNotes}>Export backup</button>
              )}
            </div>
          )}
          {view === "overview" && !search ? (
            <>
              <section className="welcome-section">
                <div className="welcome-copy">
                  <div className="eyebrow">
                    <span />
                    LESS NOISE. MORE SPACE.
                  </div>
                  <h1>
                    A little space for
                    <br />a <span>clearer mind.</span>
                  </h1>
                  <p>Capture the thought. Find its place. Let it go.</p>
                  <div className="welcome-meta">
                    <span className="mini-stars">✧</span>Your ideas have a home
                    here.
                  </div>
                </div>
                <div className="orbital-art" aria-hidden="true">
                  <div className="orbit-track track-one" />
                  <div className="orbit-track track-two" />
                  <div className="orbit-track track-three" />
                  <div className="orbit-glow" />
                  <div className="orbit-core">
                    <Orbit size={45} strokeWidth={0.75} />
                  </div>
                  <div className="orbital-node node-one">
                    <Zap size={16} />
                  </div>
                  <div className="orbital-node node-two">
                    <Feather size={16} />
                  </div>
                  <div className="orbital-node node-three">
                    <Sparkles size={14} />
                  </div>
                  <i className="star star-one" />
                  <i className="star star-two" />
                  <i className="star star-three" />
                  <span className="orbital-caption">
                    EVERYTHING, IN ITS OWN ORBIT.
                  </span>
                </div>
              </section>
            </>
          ) : (
            <section className="page-heading">
              <div className={`heading-icon ${bucket?.color || "purple"}`}>
                {bucket ? (
                  (() => {
                    const Icon = icons[bucket.icon];
                    return <Icon size={25} />;
                  })()
                ) : search ? (
                  <Search size={25} />
                ) : (
                  <CheckCircle2 size={25} />
                )}
              </div>
              <div>
                <div className="eyebrow">
                  {search ? "ACROSS YOUR WORKSPACE" : "A PLACE FOR EVERYTHING"}
                </div>
                <h1>
                  {search ? "Find a thought" : bucket?.name || "Completed"}
                </h1>
                <p>
                  {search
                    ? `Results for “${search}”`
                    : bucket?.hint ||
                      "A little evidence of how far you have come."}
                </p>
              </div>
            </section>
          )}
          {!search && view !== "completed" && (
            <section className="capture-box" aria-label="Quick capture">
              <div className="capture-main">
                <Plus size={21} />
                <textarea
                  ref={captureRef}
                  rows={1}
                  value={capture}
                  onChange={(e) => setCapture(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      quickCapture();
                    }
                  }}
                  placeholder="What's on your mind?"
                  aria-label="Quick capture"
                  disabled={!loaded || loadError}
                />
                <button
                  aria-label="Capture note"
                  className="capture-submit"
                  onClick={quickCapture}
                  disabled={!capture.trim() || !loaded || loadError}
                >
                  <ArrowUp size={18} />
                </button>
              </div>
              <div className="capture-bottom">
                <span>No need to sort it out. Just get it out.</span>
                <div>
                  <span className="capture-destination">
                    Save to{" "}
                    <select
                      aria-label="Capture bucket"
                      value={captureBucket}
                      onChange={(e) =>
                        setCaptureBucket(e.target.value as BucketId)
                      }
                    >
                      {BUCKETS.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </span>
                  <span className="capture-shortcut">
                    <kbd>↵</kbd> to capture
                  </span>
                </div>
              </div>
            </section>
          )}
          {view === "overview" && !search && (
            <section className="buckets-section">
              <div className="section-heading">
                <h2>
                  Your buckets <span>A place for everything</span>
                </h2>
                <button
                  className="text-button"
                  onClick={() => setGuideOpen(true)}
                >
                  How it works <ArrowUpRight size={14} />
                </button>
              </div>
              <div className="bucket-grid">
                {BUCKETS.map((b, i) => {
                  const Icon = icons[b.icon];
                  return (
                    <button
                      key={b.id}
                      className={`bucket-card ${b.color}`}
                      style={{ animationDelay: `${i * 45}ms` }}
                      onClick={() => navigate(b.id)}
                    >
                      <div className="bucket-card-top">
                        <span className="bucket-icon">
                          <Icon size={20} strokeWidth={1.6} />
                        </span>
                        <span className="bucket-number">
                          {loaded
                            ? count(b.id).toString().padStart(2, "0")
                            : "–"}
                        </span>
                      </div>
                      <div className="bucket-card-title">
                        <h3>{b.name}</h3>
                        <ArrowUpRight size={16} />
                      </div>
                      <p>{b.description}</p>
                      <span className="bucket-bottom-line" />
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          <section className="notes-section">
            <div className="section-heading">
              <h2>
                {search
                  ? "Search results"
                  : view === "overview"
                    ? "Recent thoughts"
                    : "Your notes"}
                <span className="item-count">{visible.length}</span>
              </h2>
              <div className="notes-tools">
                <button
                  className={`icon-button ${filtersOpen ? "active" : ""}`}
                  aria-label="Filter notes"
                  onClick={() => setFiltersOpen(!filtersOpen)}
                >
                  <SlidersHorizontal size={16} />
                </button>
                <div className="view-toggle">
                  <button
                    className={layout === "list" ? "active" : ""}
                    onClick={() => setLayout("list")}
                    aria-label="List view"
                  >
                    <List size={16} />
                  </button>
                  <button
                    className={layout === "grid" ? "active" : ""}
                    onClick={() => setLayout("grid")}
                    aria-label="Grid view"
                  >
                    <LayoutGrid size={15} />
                  </button>
                </div>
              </div>
            </div>
            {(filtersOpen || search) && (
              <div className="filters-row">
                <div className="inline-search">
                  <Search size={15} />
                  <input
                    aria-label="Search notes"
                    placeholder="Search your thoughts…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button
                      aria-label="Clear search"
                      onClick={() => setSearch("")}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <select
                  aria-label="Filter by tag"
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                >
                  <option value="">All tags</option>
                  {allTags.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <select
                  aria-label="Sort notes"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as typeof sort)}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="title">Title A–Z</option>
                </select>
              </div>
            )}
            {!loaded ? (
              <div className="empty-state">Making a little space…</div>
            ) : visible.length ? (
              <div className={layout === "grid" ? "notes-grid" : "notes-list"}>
                {layout === "list" && (
                  <div className="list-labels">
                    <span>THOUGHT</span>
                    <span>BUCKET</span>
                    <span>LAST UPDATED</span>
                    <span />
                  </div>
                )}
                {visible.map((note) => {
                  const b = BUCKETS.find((b) => b.id === note.bucket)!;
                  const Icon = icons[b.icon];
                  return (
                    <button
                      className={`note-row ${note.completedAt ? "is-complete" : ""}`}
                      key={note.id}
                      onClick={() => setSelected(note.id)}
                    >
                      <div className="note-summary">
                        <span className={`note-row-icon ${b.color}`}>
                          {note.completedAt ? (
                            <CheckCircle2 size={17} />
                          ) : (
                            <Icon size={17} />
                          )}
                        </span>
                        <div>
                          <strong>{note.title || "Untitled thought"}</strong>
                          <p>
                            {note.plainText ||
                              "A new thought, ready to take shape."}
                          </p>
                          {layout === "grid" && (
                            <div className="note-card-tags">
                              {note.tags.map((t) => (
                                <span className="tag" key={t}>
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <span className={`bucket-pill ${b.color}`}>
                        <span className="tiny-dot" />
                        {b.name}
                      </span>
                      <time dateTime={note.updatedAt}>
                        {new Date(note.updatedAt).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric" },
                        )}
                      </time>
                      <ChevronRight className="note-row-chevron" size={16} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">
                <span className="empty-orbit">
                  <Orbit size={32} strokeWidth={1} />
                </span>
                <h3>
                  {search || tagFilter
                    ? "No thoughts found"
                    : view === "completed"
                      ? "Small steps add up"
                      : "A little open space"}
                </h3>
                <p>
                  {search || tagFilter
                    ? "Try a different word or tag."
                    : view === "completed"
                      ? "Completed notes will land here."
                      : "Capture a thought above, or start with a fresh note."}
                </p>
                {!search && !tagFilter && view !== "completed" && (
                  <button
                    className="secondary-button"
                    onClick={newNote}
                    disabled={loadError}
                  >
                    <Plus size={15} />
                    Add your first note
                  </button>
                )}
              </div>
            )}
          </section>
          <footer className="workspace-footer">
            <span>
              <Orbit size={15} />A place for your thoughts. Space for your life.
            </span>
            <span>
              {activeNotes.length} thoughts in orbit
              <span className="footer-star">✧</span>
            </span>
          </footer>
        </main>
      </div>
      {currentNote && (
        <NoteEditor
          key={currentNote.id}
          note={currentNote}
          onUpdate={updateNote}
          onClose={() => setSelected(null)}
          onDelete={() => {
            setNotes((n) => n.filter((item) => item.id !== selected));
            setSelected(null);
            setToast("Note deleted");
          }}
          storageError={storageError}
        />
      )}
      {searchOpen && (
        <SearchDialog
          inputRef={searchRef}
          value={search}
          onChange={setSearch}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {guideOpen && <GuideDialog onClose={() => setGuideOpen(false)} />}
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={14} />
          </span>
          {toast}
        </div>
      )}
    </div>
  );
}
