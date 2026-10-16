"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  LayoutGrid,
  List,
  Orbit,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { BUCKETS, type BucketId, type Note } from "@/lib/notes";
import { matchesText } from "@/lib/note-search";
import { bucketIcons, useWorkspaceShell, type View } from "./workspace-shell-context";

type Sort = "newest" | "oldest" | "title";

function visibleNotes(
  notes: Note[],
  { view, search, tagFilter, sort }: { view: View; search: string; tagFilter: string; sort: Sort },
) {
  return notes
    .filter((n) => {
      const matchesView = search
        ? view === "all" ? !n.completedAt : true
        : view === "overview" || view === "all"
          ? !n.completedAt
          : view === "completed"
            ? !!n.completedAt
            : n.bucket === view && !n.completedAt;
      return (
        matchesView && matchesText(n, search) && (!tagFilter || n.tags.includes(tagFilter))
      );
    })
    .sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "oldest"
          ? a.updatedAt.localeCompare(b.updatedAt)
          : b.updatedAt.localeCompare(a.updatedAt),
    );
}

/** Note list for Home, bucket, All items (drag-to-move groups), Completed and search. */
export function NotesSection() {
  const {
    workspaceNotes,
    loaded,
    loadError,
    view,
    search,
    setSearch,
    tagFilter,
    setTagFilter,
    openNote,
    newNote,
    items: { moveNoteToBucket },
    conflictIds,
  } = useWorkspaceShell();
  const changedBadge = (id: string) =>
    conflictIds.has(id) && (
      <span className="conflict-badge" title="Changed somewhere else. Open it to choose a version.">
        <AlertTriangle size={11} aria-hidden="true" />
        Changed elsewhere
      </span>
    );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<Sort>("newest");
  const [layout, setLayout] = useState<"list" | "grid">("list");
  const [draggedNoteId, setDraggedNoteId] = useState<string | null>(null);
  const [dropBucket, setDropBucket] = useState<BucketId | null>(null);
  const allTags = [...new Set(workspaceNotes.flatMap((n) => n.tags))].sort();
  const visible = visibleNotes(workspaceNotes, { view, search, tagFilter, sort });
  return (
    <section className="notes-section">
      <div className="section-heading">
        <h2>
          {search
            ? "Search results"
            : view === "overview"
              ? "Recent thoughts"
              : view === "all"
                ? "All items"
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
          {view !== "all" && <div className="view-toggle">
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
          </div>}
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
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title A–Z</option>
          </select>
        </div>
      )}
      {!loaded ? (
        <div className="empty-state">Making a little space…</div>
      ) : view === "all" ? (
        <div className="bucket-groups">
          {BUCKETS.map((b) => {
            const Icon = bucketIcons[b.icon];
            const groupNotes = visible.filter((note) => note.bucket === b.id);
            return (
              <section
                key={b.id}
                className={`bucket-group ${b.color} ${dropBucket === b.id ? "is-drop-target" : ""}`}
                aria-label={`${b.name} bucket`}
                onDragOver={(event) => {
                  if (!draggedNoteId) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (dropBucket !== b.id) setDropBucket(b.id);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node))
                    setDropBucket(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggedNoteId) moveNoteToBucket(draggedNoteId, b.id);
                  setDraggedNoteId(null);
                  setDropBucket(null);
                }}
              >
                <div className="bucket-group-heading">
                  <span className="bucket-group-icon"><Icon size={17} /></span>
                  <h3>{b.name}</h3>
                  <span className="bucket-group-count">{groupNotes.length}</span>
                </div>
                <div className="bucket-group-rows">
                  {groupNotes.length ? groupNotes.map((note) => (
                    <div
                      className={`bucket-group-row ${draggedNoteId === note.id ? "is-dragging" : ""}`}
                      key={note.id}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", note.id);
                        setDraggedNoteId(note.id);
                      }}
                      onDragEnd={() => {
                        setDraggedNoteId(null);
                        setDropBucket(null);
                      }}
                    >
                      <span className="bucket-group-grip" aria-hidden="true">⋮⋮</span>
                      <button className="bucket-group-open" onClick={() => openNote(note.id)}>
                        <strong>{note.title || "Untitled thought"}{changedBadge(note.id)}</strong>
                        <span>{note.plainText || "A new thought, ready to take shape."}</span>
                      </button>
                      <select
                        aria-label={`Move ${note.title || "Untitled thought"} to bucket`}
                        value={note.bucket}
                        onChange={(event) => moveNoteToBucket(note.id, event.target.value as BucketId)}
                      >
                        {BUCKETS.map((destination) => (
                          <option key={destination.id} value={destination.id}>{destination.name}</option>
                        ))}
                      </select>
                    </div>
                  )) : <p className="bucket-group-empty">{search || tagFilter ? "No matching items" : "Drop an item here"}</p>}
                </div>
              </section>
            );
          })}
        </div>
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
            const Icon = bucketIcons[b.icon];
            return (
              <button
                className={`note-row ${note.completedAt ? "is-complete" : ""}`}
                key={note.id}
                onClick={() => openNote(note.id)}
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
                    <strong>{note.title || "Untitled thought"}{changedBadge(note.id)}</strong>
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
  );
}
