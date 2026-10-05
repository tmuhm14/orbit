"use client";

import { useEffect, useRef, useState } from "react";
import { browserNotes, type Note } from "@/lib/notes";

const SAVE_DELAY = 800;
const POLL_INTERVAL = 30_000;

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok)
    throw new Error(`${init?.method || "GET"} ${path}: ${response.status}`);
  return response.json();
}

// Owns an account's notes. The server renders the initial list; edits are
// saved in batches after a short pause, and the list is refreshed on focus
// and on an interval so notes captured elsewhere (Slack) show up.
export function useNotes(userId: string, initialNotes: Note[] | null) {
  const [notes, setNotes] = useState<Note[]>(initialNotes ?? []);
  const [storageError, setStorageError] = useState(initialNotes === null);
  const [browserPending, setBrowserPending] = useState<Note[]>([]);
  const loadError = initialNotes === null;
  // updatedAt of each note as the server last confirmed it. A note whose
  // updatedAt differs locally has unsaved edits; a missing id was deleted here.
  const synced = useRef(
    new Map((initialNotes ?? []).map((n) => [n.id, n.updatedAt])),
  );
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const saving = useRef(false);

  function pendingChanges() {
    const current = notesRef.current;
    const ids = new Set(current.map((n) => n.id));
    return {
      changed: current.filter((n) => synced.current.get(n.id) !== n.updatedAt),
      deleted: [...synced.current.keys()].filter((id) => !ids.has(id)),
    };
  }

  async function flush(keepalive = false) {
    if (saving.current || loadError) return;
    const { changed, deleted } = pendingChanges();
    if (!changed.length && !deleted.length) return;
    let failed = false;
    saving.current = true;
    try {
      if (changed.length)
        await api("/api/notes", {
          method: "PUT",
          body: JSON.stringify({ notes: changed }),
          keepalive,
        });
      changed.forEach((n) => synced.current.set(n.id, n.updatedAt));
      for (const id of deleted) {
        await api(`/api/notes/${id}`, { method: "DELETE", keepalive });
        synced.current.delete(id);
      }
      setStorageError(false);
    } catch {
      failed = true;
      setStorageError(true);
    } finally {
      saving.current = false;
    }
    // Edits made while this save was in flight. After a failure, the next
    // refresh retries instead of looping.
    const rest = pendingChanges();
    if (!failed && (rest.changed.length || rest.deleted.length))
      setTimeout(() => void flush(), SAVE_DELAY);
  }

  async function refresh() {
    if (loadError) return;
    await flush();
    try {
      const { notes: server }: { notes: Note[] } = await api("/api/notes");
      const serverIds = new Set(server.map((n) => n.id));
      setNotes((local) => {
        const dirty = (n: Note) => synced.current.get(n.id) !== n.updatedAt;
        const localById = new Map(local.map((n) => [n.id, n]));
        const next: Note[] = [];
        for (const remote of server) {
          const mine = localById.get(remote.id);
          if (mine && dirty(mine)) next.push(mine);
          else if (mine || !synced.current.has(remote.id)) {
            // Unchanged here: take the server copy (it may be newer).
            next.push(remote);
            synced.current.set(remote.id, remote.updatedAt);
          }
          // Otherwise it was deleted here and the delete is still pending.
        }
        // Keep local notes the server hasn't seen yet; drop clean ones it deleted.
        for (const mine of local)
          if (
            !serverIds.has(mine.id) &&
            (!synced.current.has(mine.id) || dirty(mine))
          )
            next.push(mine);
        for (const id of [...synced.current.keys()])
          if (!serverIds.has(id) && !next.some((n) => n.id === id))
            synced.current.delete(id);
        return next;
      });
    } catch {
      /* Keep working offline; the next refresh will retry. */
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => void flush(), SAVE_DELAY);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  useEffect(() => {
    try {
      setBrowserPending(browserNotes.pending(userId));
    } catch {
      /* Unreadable browser notes stay where they are. */
    }
    function onVisible() {
      if (document.hidden) void flush(true);
      else void refresh();
    }
    const interval = setInterval(() => void refresh(), POLL_INTERVAL);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  /** Moves notes kept only in this browser into the account. */
  async function importBrowserNotes(): Promise<boolean> {
    const ids = new Set(notesRef.current.map((n) => n.id));
    const incoming = browserPending.filter((n) => !ids.has(n.id));
    try {
      if (incoming.length)
        await api("/api/notes", {
          method: "PUT",
          body: JSON.stringify({ notes: incoming }),
        });
      incoming.forEach((n) => synced.current.set(n.id, n.updatedAt));
      browserNotes.markUploaded(userId);
      setNotes((current) => [...incoming, ...current]);
      setBrowserPending([]);
      return true;
    } catch {
      return false;
    }
  }

  return {
    notes,
    setNotes,
    loaded: true,
    loadError,
    storageError,
    browserNoteCount: browserPending.length,
    dismissBrowserNotes: () => setBrowserPending([]),
    importBrowserNotes,
  };
}
