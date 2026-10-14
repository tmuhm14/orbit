"use client";

import { CheckCircle2, List, Orbit, Search } from "lucide-react";
import { BUCKETS } from "@/lib/notes";
import { HomeBucketLinks, HomeDueItems, HomeHeader, HomeList } from "./home-view";
import { NotesSection } from "./notes-section";
import { QuickCapture } from "./quick-capture";
import { bucketIcons, useWorkspaceShell } from "./workspace-shell-context";

/** Main content for the notes route: Home, bucket, All items, Completed and search views. */
export function WorkspaceMain({
  browserNoteCount,
  onDismissBrowserNotes,
  onImportBrowserNotes,
}: {
  browserNoteCount: number;
  onDismissBrowserNotes: () => void;
  onImportBrowserNotes: () => void;
}) {
  const { view, search, loadError, storageError, activeNotes, exportNotes } =
    useWorkspaceShell();
  const home = view === "overview" && !search;
  const notices = (
    <>
      {browserNoteCount > 0 && !loadError && (
        <div className="legacy-import">
          <p>
            {browserNoteCount === 1
              ? "1 note is saved only in this browser. Move it into your account so it syncs everywhere."
              : `${browserNoteCount} notes are saved only in this browser. Move them into your account so they sync everywhere.`}
          </p>
          <div>
            <button className="text-button" onClick={onDismissBrowserNotes}>
              Not now
            </button>
            <button
              className="secondary-button"
              onClick={onImportBrowserNotes}
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
    </>
  );
  const footer = (
    <footer className="workspace-footer">
      <span>
        <Orbit size={15} />A place for your thoughts. Space for your life.
      </span>
      <span>
        {activeNotes.length} thoughts in orbit
        <span className="footer-star">✧</span>
      </span>
    </footer>
  );
  if (home) {
    // On narrow screens .home-primary dissolves so its children and the due
    // panel share one column, ordered capture → inbox → due → next → waiting.
    return (
      <main className="home-focus">
        <div className="home-primary">
          <div className="home-notices">{notices}</div>
          <HomeHeader />
          <div className="home-capture">
            <QuickCapture />
          </div>
          <div className="home-inbox">
            <HomeList kind="inbox" />
          </div>
          <div className="home-lists">
            <HomeList kind="next" />
            <HomeList kind="waiting" />
          </div>
          <HomeBucketLinks />
          {footer}
        </div>
        <div className="home-due">
          <HomeDueItems />
        </div>
      </main>
    );
  }
  return (
    <main>
      <div className="home-primary">
        {notices}
        <PageHeading />
        {!search && view !== "completed" && <QuickCapture />}
        <NotesSection />
        {footer}
      </div>
    </main>
  );
}

function PageHeading() {
  const { view, search } = useWorkspaceShell();
  const bucket = BUCKETS.find((b) => b.id === view);
  return (
    <section className="page-heading">
      <div className={`heading-icon ${bucket?.color || "purple"}`}>
        {bucket ? (
          (() => {
            const Icon = bucketIcons[bucket.icon];
            return <Icon size={25} />;
          })()
        ) : search ? (
          <Search size={25} />
        ) : view === "all" ? (
          <List size={25} />
        ) : (
          <CheckCircle2 size={25} />
        )}
      </div>
      <div>
        <div className="eyebrow">
          {search ? "ACROSS YOUR WORKSPACE" : "A PLACE FOR EVERYTHING"}
        </div>
        <h1>
          {search
            ? "Find a thought"
            : bucket?.name || (view === "all" ? "All items" : "Completed")}
        </h1>
        <p>
          {search
            ? `Results for “${search}”`
            : bucket?.hint ||
              (view === "all"
                ? "All your active thoughts, grouped by bucket. Drag to move them."
                : "A little evidence of how far you have come.")}
        </p>
      </div>
    </section>
  );
}
