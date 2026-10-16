"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { BookOpen, Plus, Search, X } from "lucide-react";
import { libraryItems, libraryTags } from "@/lib/library-view";
import { LIBRARY_QUERY_MAX, libraryHref, parseLibraryParams } from "@/lib/workspace-routes";
import { ItemRow, WorkEmpty, WorkHeader } from "./work-rows";
import { useWorkspaceShell } from "./workspace-shell-context";

/** Tags shown as chips before "more" would be needed; the rest stay reachable by search. */
const TAG_CHIPS_MAX = 24;

/**
 * Library (`/library`): notes and documents worth keeping, most recently
 * updated first, filtered by `?tag=` (chips) and `?q=` (the workspace's
 * text search). Each row shows where it came from and opens in the editor
 * or at its full page.
 */
export function LibraryPage() {
  const { notes, workspaceId, loadError, createItem } = useWorkspaceShell();
  const params = parseLibraryParams(useSearchParams());
  const searchId = useId();
  // Typing updates the URL in place (no history entry per keystroke, no
  // server round trip); back/forward and links bring a new value in here.
  const [query, setQuery] = useState(params.q);
  useEffect(() => setQuery(params.q), [params.q]);
  const tags = useMemo(() => libraryTags(notes, workspaceId), [notes, workspaceId]);
  const items = useMemo(
    () => libraryItems(notes, workspaceId, { tag: params.tag, q: query }),
    [notes, workspaceId, params.tag, query],
  );
  const total = useMemo(() => libraryItems(notes, workspaceId, { tag: null, q: "" }).length, [notes, workspaceId]);
  const filtered = !!(params.tag || query.trim());
  function search(value: string) {
    const next = value.slice(0, LIBRARY_QUERY_MAX);
    setQuery(next);
    window.history.replaceState(null, "", libraryHref({ tag: params.tag, q: next }));
  }
  // A tag from the URL that nothing carries any more still shows, so it can be cleared.
  const chips = tags.slice(0, TAG_CHIPS_MAX);
  if (params.tag && !chips.some((t) => t.tag === params.tag)) chips.push({ tag: params.tag, count: 0 });

  return (
    <main className="work-page library-page">
      <WorkHeader
        icon={<BookOpen size={22} />}
        eyebrow="KNOWLEDGE WORTH RETAINING"
        title="Library"
        description="Notes, documents and saved agent results, most recently updated first."
        actions={
          <button
            type="button"
            className="primary-button small"
            disabled={loadError}
            onClick={() => createItem({ kind: "note", bucket: "reference" })}
          >
            <Plus size={15} aria-hidden="true" /> New note
          </button>
        }
      />
      <div className="work-toolbar library-toolbar">
        <div className="inline-search library-search" role="search">
          <Search size={15} aria-hidden="true" />
          <label htmlFor={searchId} className="sr-only">
            Search the Library
          </label>
          <input
            id={searchId}
            type="search"
            placeholder="Search titles, text and tags…"
            value={query}
            maxLength={LIBRARY_QUERY_MAX}
            onChange={(e) => search(e.target.value)}
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => search("")}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        {chips.length > 0 && (
          <nav className="work-filters tag-filters" aria-label="Filter by tag">
            <ul>
              <li>
                <Link
                  href={libraryHref({ q: query })}
                  scroll={false}
                  className={`work-filter ${!params.tag ? "is-selected" : ""}`}
                  aria-current={!params.tag ? "page" : undefined}
                >
                  All
                </Link>
              </li>
              {chips.map(({ tag, count }) => {
                const selected = params.tag === tag;
                return (
                  <li key={tag}>
                    <Link
                      href={libraryHref({ tag: selected ? null : tag, q: query })}
                      scroll={false}
                      className={`work-filter ${selected ? "is-selected" : ""}`}
                      aria-current={selected ? "page" : undefined}
                    >
                      #{tag}
                      <span className="work-count" aria-label={`, ${count} items`}>{count}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>
      <p className="sr-only" role="status">
        {loadError ? "" : `${items.length} ${items.length === 1 ? "item" : "items"}`}
      </p>
      {loadError ? (
        <p className="work-state" role="alert">The Library couldn’t be loaded. Reload the page to try again.</p>
      ) : !total ? (
        <WorkEmpty
          title="Your Library is empty"
          body="Notes you keep, documents and agent results you save land here. Captures stay in the Inbox until you clarify them."
        />
      ) : !items.length ? (
        <WorkEmpty
          title="Nothing matches"
          body={params.tag ? `No items tagged #${params.tag}${query.trim() ? " match that search" : ""}.` : "Try a different word."}
        >
          {filtered && (
            <Link className="secondary-button" href="/library" onClick={() => setQuery("")}>
              Clear filters
            </Link>
          )}
        </WorkEmpty>
      ) : (
        <section className="work-section" aria-labelledby="library-list-heading">
          <h2 id="library-list-heading" className="work-section-title">
            {filtered ? "Matching items" : "Recently updated"}
            <span className="work-count">{items.length}</span>
          </h2>
          <ul className="work-list">
            {items.map((n) => (
              <ItemRow key={n.id} note={n} showProject />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
