"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CLIENT_HEADER,
  MIN_CLIENT_HEADER,
  NOTES_CLIENT_VERSION,
  applySaveResults,
  browserNotes,
  createNote,
  mergeServerNotes,
  noteDrafts,
  pendingWrites,
  type ConflictInfo,
  type Note,
  type NoteWrite,
  type SaveResponse,
  type SyncedEntry,
} from "@/lib/notes";

const SAVE_DELAY = 800;
const POLL_INTERVAL = 30_000;

/**
 * A note changed elsewhere while this browser also changed it (ADR 002 §6).
 * Its local edits are kept (in memory and in browser storage) and are not
 * sent again until the user picks how to resolve it.
 */
export type NoteConflict = ConflictInfo & {
  /**
   * This browser's current copy, including edits made since the conflict;
   * null when it was deleted here.
   */
  local: Note | null;
  detectedAt: string;
};

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

/** A write whose 4xx body carries results. Throws only on network or 5xx. */
async function write(path: string, init: RequestInit) {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      "Content-Type": "application/json",
      [CLIENT_HEADER]: String(NOTES_CLIENT_VERSION),
    },
  });
  const body = await response.json().catch(() => null);
  if (response.status >= 500 || !body)
    throw new Error(`${init.method} ${path}: ${response.status}`);
  return {
    status: response.status,
    body,
    minClient: Number(response.headers.get(MIN_CLIENT_HEADER)) || 0,
  };
}

// Owns an account's notes. The server renders the initial list; edits are
// saved in batches after a short pause, and the list is refreshed on focus
// and on an interval so notes captured elsewhere (Slack) show up. Every save
// states the revision it was based on, so edits made elsewhere are never
// silently overwritten; those become conflicts for the user to resolve.
export function useNotes(userId: string, initialNotes: Note[] | null) {
  const [notes, setNotes] = useState<Note[]>(initialNotes ?? []);
  const [storageError, setStorageError] = useState(initialNotes === null);
  const [browserPending, setBrowserPending] = useState<Note[]>([]);
  const [conflictMap, setConflictMap] = useState<
    ReadonlyMap<string, ConflictInfo & { detectedAt: string }>
  >(new Map());
  const [deleteConflictIds, setDeleteConflictIds] = useState<string[]>([]);
  const [reloadRequired, setReloadRequired] = useState(false);
  const loadError = initialNotes === null;
  // What the server last confirmed for each note: its revision and the local
  // updatedAt that was saved. A note whose updatedAt differs locally has
  // unsaved edits; a missing id was deleted here.
  const synced = useRef(
    new Map<string, SyncedEntry>(
      (initialNotes ?? []).map((n) => [
        n.id,
        { revision: n.revision ?? null, updatedAt: n.updatedAt },
      ]),
    ),
  );
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const conflictsRef = useRef(conflictMap);
  conflictsRef.current = conflictMap;
  const saving = useRef(false);

  function checkClient(minClient: number) {
    if (minClient > NOTES_CLIENT_VERSION) setReloadRequired(true);
  }

  /** Records conflicts and keeps each local copy as a persisted draft. */
  function addConflicts(found: ConflictInfo[]) {
    if (!found.length) return;
    const now = new Date().toISOString();
    const next = new Map(conflictsRef.current);
    for (const conflict of found) {
      const existing = next.get(conflict.id);
      next.set(conflict.id, {
        ...conflict,
        // Keep the revision the local edits were originally based on.
        baseRevision: existing ? existing.baseRevision : conflict.baseRevision,
        detectedAt: existing?.detectedAt ?? now,
      });
      const local = notesRef.current.find((n) => n.id === conflict.id);
      if (local) persistDraft(local, next.get(conflict.id)!.baseRevision);
    }
    conflictsRef.current = next;
    setConflictMap(next);
  }

  function persistDraft(local: Note, baseRevision: number | null) {
    try {
      noteDrafts.save(userId, {
        local,
        baseRevision,
        savedAt: new Date().toISOString(),
      });
    } catch {
      /* The draft is still kept in memory for this tab. */
    }
  }

  function dropConflict(id: string) {
    const next = new Map(conflictsRef.current);
    next.delete(id);
    conflictsRef.current = next;
    setConflictMap(next);
    try {
      noteDrafts.remove(userId, id);
    } catch {
      /* Nothing to clean up. */
    }
  }

  async function flush(keepalive = false) {
    if (saving.current || loadError) return;
    const conflicted = new Set(conflictsRef.current.keys());
    const { changed, deleted } = pendingWrites(
      notesRef.current,
      synced.current,
      conflicted,
    );
    if (!changed.length && !deleted.length) return;
    let failed = false;
    saving.current = true;
    try {
      if (changed.length) {
        const { body, minClient } = await write("/api/notes", {
          method: "PUT",
          body: JSON.stringify({ notes: changed }),
          keepalive,
        });
        checkClient(minClient);
        const results = (body as Partial<SaveResponse>).results;
        if (!Array.isArray(results)) throw new Error("PUT /api/notes");
        const applied = applySaveResults(synced.current, changed, results);
        synced.current = applied.synced;
        addConflicts(applied.conflicts);
        if (applied.failed) failed = true;
      }
      for (const { id, expectedRevision } of deleted) {
        const query =
          expectedRevision === null ? "" : `?expectedRevision=${expectedRevision}`;
        const { status, body, minClient } = await write(
          `/api/notes/${id}${query}`,
          { method: "DELETE", keepalive },
        );
        checkClient(minClient);
        if (status === 200 || status === 404) synced.current.delete(id);
        else if (status === 409 && body.code === "revision_conflict" && body.current) {
          // Changed elsewhere: restore it here instead of deleting.
          const current = body.current as Note;
          synced.current.set(id, {
            revision: current.revision ?? null,
            updatedAt: current.updatedAt,
          });
          setNotes((list) =>
            list.some((n) => n.id === id) ? list : [current, ...list],
          );
          setDeleteConflictIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
        } else failed = true;
      }
      setStorageError(failed);
    } catch {
      failed = true;
      setStorageError(true);
    } finally {
      saving.current = false;
    }
    // Edits made while this save was in flight. After a failure, the next
    // refresh retries instead of looping.
    const rest = pendingWrites(
      notesRef.current,
      synced.current,
      new Set(conflictsRef.current.keys()),
    );
    if (!failed && (rest.changed.length || rest.deleted.length))
      setTimeout(() => void flush(), SAVE_DELAY);
  }

  async function refresh() {
    if (loadError) return;
    await flush();
    try {
      const { notes: server }: { notes: Note[] } = await api("/api/notes");
      // Decide from a snapshot: React may run this updater more than once,
      // so it must not read state that it also writes.
      const known = new Map(synced.current);
      const conflicted = new Set(conflictsRef.current.keys());
      const merged = mergeServerNotes(notesRef.current, server, known, conflicted);
      setNotes((local) => {
        const next = mergeServerNotes(local, server, known, conflicted);
        synced.current = next.synced;
        return next.notes;
      });
      addConflicts(merged.conflicts);
    } catch {
      /* Keep working offline; the next refresh will retry. */
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => void flush(), SAVE_DELAY);
    // Keep persisted drafts current with edits made after a conflict.
    for (const [id, conflict] of conflictsRef.current) {
      const local = notes.find((n) => n.id === id);
      if (local) persistDraft(local, conflict.baseRevision);
    }
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  useEffect(() => {
    try {
      setBrowserPending(browserNotes.pending(userId));
    } catch {
      /* Unreadable browser notes stay where they are. */
    }
    // Drafts kept from an earlier visit are unresolved conflicts.
    try {
      const drafts = noteDrafts.load(userId);
      if (drafts.length) {
        const server = new Map(notesRef.current.map((n) => [n.id, n]));
        const drafted = new Map(drafts.map((d) => [d.local.id, d.local]));
        setNotes((list) => [
          ...list.map((n) => drafted.get(n.id) ?? n),
          ...drafts.filter((d) => !server.has(d.local.id)).map((d) => d.local),
        ]);
        const restored = new Map(conflictsRef.current);
        for (const draft of drafts) {
          const copy = server.get(draft.local.id) ?? null;
          restored.set(draft.local.id, {
            id: draft.local.id,
            baseRevision: draft.baseRevision,
            currentRevision: copy?.revision ?? null,
            server: copy,
            detectedAt: draft.savedAt,
          });
        }
        conflictsRef.current = restored;
        setConflictMap(restored);
      }
    } catch {
      /* Unreadable drafts stay where they are. */
    }
    function onVisible() {
      if (document.hidden) void flush(true);
      else void refresh();
    }
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (conflictsRef.current.size) event.preventDefault();
    }
    const interval = setInterval(() => void refresh(), POLL_INTERVAL);
    window.addEventListener("focus", onVisible);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  /** Moves notes kept only in this browser into the account (create-only). */
  async function importBrowserNotes(workspaceId: string): Promise<boolean> {
    const ids = new Set(notesRef.current.map((n) => n.id));
    const incoming: NoteWrite[] = browserPending
      .filter((n) => !ids.has(n.id))
      .map((n) => ({ ...n, workspaceId, expectedRevision: null }));
    try {
      let uploaded = incoming;
      if (incoming.length) {
        const { body, minClient } = await write("/api/notes", {
          method: "PUT",
          body: JSON.stringify({ notes: incoming }),
        });
        checkClient(minClient);
        const results = (body as Partial<SaveResponse>).results;
        if (!Array.isArray(results)) return false;
        const applied = applySaveResults(synced.current, incoming, results);
        // An id that already exists was uploaded before; skip it.
        if (applied.failed) return false;
        synced.current = applied.synced;
        const saved = new Set(
          results.filter((r) => r.status === "saved").map((r) => r.id),
        );
        uploaded = incoming.filter((n) => saved.has(n.id));
      }
      browserNotes.markUploaded(userId);
      setNotes((current) => [
        ...uploaded.map(({ expectedRevision: _expected, ...note }) => note),
        ...current,
      ]);
      setBrowserPending([]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Keep mine: save the local copy over the version saved elsewhere (or
   * recreate it if it was deleted there; delete it if it was deleted here).
   */
  function keepMine(id: string) {
    const conflict = conflictsRef.current.get(id);
    if (!conflict) return;
    if (conflict.currentRevision === null) synced.current.delete(id);
    else
      synced.current.set(id, {
        revision: conflict.currentRevision,
        // Differs from the local copy, so it is sent on the next save.
        updatedAt: conflict.server?.updatedAt ?? "",
      });
    dropConflict(id);
    void flush();
  }

  /** Use theirs: replace the local copy with the version saved elsewhere. */
  function takeTheirs(id: string) {
    const conflict = conflictsRef.current.get(id);
    if (!conflict) return;
    const server = conflict.server;
    if (server)
      synced.current.set(id, {
        revision: server.revision ?? conflict.currentRevision,
        updatedAt: server.updatedAt,
      });
    else synced.current.delete(id);
    setNotes((list) =>
      server
        ? list.some((n) => n.id === id)
          ? list.map((n) => (n.id === id ? server : n))
          : [server, ...list]
        : list.filter((n) => n.id !== id),
    );
    dropConflict(id);
  }

  /** Save mine as a copy: keep the local edits as a new note, use theirs here. */
  function saveMineAsCopy(id: string): string | null {
    const local = notesRef.current.find((n) => n.id === id);
    if (!local || !conflictsRef.current.has(id)) return null;
    const copy: Note = {
      ...createNote(local.title, local.bucket, local.workspaceId),
      content: local.content,
      plainText: local.plainText,
      tags: local.tags,
      completedAt: local.completedAt,
      dueDate: local.dueDate ?? null,
    };
    takeTheirs(id);
    setNotes((list) => [copy, ...list]);
    return copy.id;
  }

  const conflicts = useMemo(
    () =>
      [...conflictMap.values()].map(
        (conflict): NoteConflict => ({
          ...conflict,
          local: notes.find((n) => n.id === conflict.id) ?? null,
        }),
      ),
    [conflictMap, notes],
  );

  return {
    notes,
    setNotes,
    loaded: true,
    loadError,
    storageError,
    browserNoteCount: browserPending.length,
    dismissBrowserNotes: () => setBrowserPending([]),
    importBrowserNotes,
    refresh,
    /** Unresolved conflicts (U-02 shows these). Not resent until resolved. */
    conflicts,
    conflictFor: (id: string) => conflicts.find((c) => c.id === id) ?? null,
    keepMine,
    takeTheirs,
    saveMineAsCopy,
    /** Notes restored because they changed elsewhere before a delete. */
    deleteConflictIds,
    dismissDeleteConflicts: () => setDeleteConflictIds([]),
    /** The server needs a newer client; saving resumes after a reload. */
    reloadRequired,
  };
}
