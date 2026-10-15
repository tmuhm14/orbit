"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CLIENT_HEADER,
  MIN_CLIENT_HEADER,
  NOTES_CLIENT_VERSION,
  applySaveResults,
  followupError,
  normalizeFollowup,
  browserNotes,
  createNote,
  draftPlan,
  exportDocument,
  hasUnsavedChanges,
  itemKind,
  mergeServerNotes,
  noteDrafts,
  pendingWrites,
  projectChildren,
  projectLinkError,
  projectsIn,
  restoreDrafts,
  settleIdenticalConflicts,
  withRestored,
  type ConflictInfo,
  type Followup,
  type FollowupError,
  type ItemKind,
  type ItemErrorCode,
  type LinkErrorCode,
  type Note,
  type NoteWrite,
  type SaveResponse,
  type SyncedEntry,
} from "@/lib/notes";
import {
  REMINDER_ERROR_CODES,
  isActiveReminder,
  parseReminderTime,
  type Reminder,
  type ReminderErrorCode,
  type ReminderTime,
} from "@/lib/reminders";

const SAVE_DELAY = 800;
const REMINDER_CODES = new Set<string>(REMINDER_ERROR_CODES);
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

/**
 * A kind, project or workspace change the server refused (ADR 001 §7), or a
 * workspace move refused while an open assignment uses the item
 * (assignment_active, ADR 003 §2). The local edit is kept but not resent
 * until the note changes again.
 */
export type ItemError = { id: string; code: ItemErrorCode };
/** A project delete refused because items still link to it. */
export type BlockedDelete = { id: string; count: number };

/**
 * Outcome of a reminder call. Codes are ReminderErrorCode (see
 * REMINDER_ERROR_MESSAGES in lib/reminders for user-facing text), or
 * "unavailable" when the server could not be reached or failed.
 * reminder_exists carries the item's waiting reminder; revision_conflict
 * carries the current copy.
 */
export type ReminderResult =
  | { ok: true; reminder: Reminder }
  | {
      ok: false;
      code: ReminderErrorCode | "unavailable";
      reminder?: Reminder;
      current?: Reminder;
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
  const reloadRequiredRef = useRef(false);
  // Refused link changes: id → code and the updatedAt that was refused.
  const [rejectedMap, setRejectedMap] = useState<
    ReadonlyMap<string, { code: ItemErrorCode; updatedAt: string }>
  >(new Map());
  const rejectedRef = useRef(rejectedMap);
  rejectedRef.current = rejectedMap;
  const [blockedDeletes, setBlockedDeletes] = useState<BlockedDelete[]>([]);
  // Reminders loaded so far, by item id (newest first). Not part of autosave:
  // each reminder change is its own revision-checked request.
  const [reminderMap, setReminderMap] = useState<ReadonlyMap<string, Reminder[]>>(
    new Map(),
  );
  // Project deletes the user confirmed: linked items move up to its parent.
  const unlinkOnDelete = useRef(new Set<string>());
  // Restored drafts not shown yet (id → their updatedAt); see draftPlan().
  const restoring = useRef(new Map<string, string>());
  // Notes with an unsaved-edits draft in browser storage.
  const unsavedStored = useRef(new Set<string>());
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
    if (minClient > NOTES_CLIENT_VERSION) {
      reloadRequiredRef.current = true;
      setReloadRequired(true);
    }
  }

  /** Records conflicts and keeps each local copy as a persisted draft. */
  function addConflicts(all: ConflictInfo[]) {
    // Edits kept from before a reload that the server already has.
    const { conflicts: found, settled } = settleIdenticalConflicts(
      all,
      notesRef.current,
      unsavedStored.current,
    );
    for (const { id, entry } of settled) synced.current.set(id, entry);
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

  function persistDraft(local: Note, baseRevision: number | null, unsaved = false) {
    try {
      noteDrafts.save(userId, {
        local,
        baseRevision,
        savedAt: new Date().toISOString(),
        ...(unsaved ? { unsaved: true as const } : {}),
      });
    } catch {
      /* The draft is still kept in memory for this tab. */
    }
  }

  function removeDraft(id: string) {
    try {
      noteDrafts.remove(userId, id);
    } catch {
      /* Nothing to clean up. */
    }
  }

  /**
   * Brings browser-storage drafts in line with `list`: conflicted copies are
   * kept current, unsaved edits are kept when `persistUnsaved` (or while a
   * draft for them exists), and drafts of saved notes are removed. Restored
   * drafts the list doesn't show yet are left alone (see draftPlan()).
   */
  function syncDrafts(list: Note[], persistUnsaved = reloadRequiredRef.current) {
    const plan = draftPlan({
      notes: list,
      synced: synced.current,
      conflicts: conflictsRef.current,
      held: heldWrites(),
      unsavedStored: unsavedStored.current,
      restoring: restoring.current,
      persistUnsaved,
    });
    restoring.current = plan.restoring;
    for (const draft of plan.conflictDrafts) persistDraft(draft.local, draft.baseRevision);
    for (const draft of plan.unsaved) persistDraft(draft.local, draft.baseRevision, true);
    for (const id of plan.remove) removeDraft(id);
    unsavedStored.current = plan.stored;
  }

  function dropConflict(id: string) {
    const next = new Map(conflictsRef.current);
    next.delete(id);
    conflictsRef.current = next;
    setConflictMap(next);
    removeDraft(id);
  }

  function setRejected(
    update: (map: Map<string, { code: ItemErrorCode; updatedAt: string }>) => void,
  ) {
    const next = new Map(rejectedRef.current);
    update(next);
    rejectedRef.current = next;
    setRejectedMap(next);
  }
  const heldWrites = () =>
    new Map([...rejectedRef.current].map(([id, r]) => [id, r.updatedAt]));

  async function flush(keepalive = false) {
    if (saving.current || loadError) return;
    const conflicted = new Set(conflictsRef.current.keys());
    const { changed, deleted } = pendingWrites(
      notesRef.current,
      synced.current,
      conflicted,
      heldWrites(),
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
        const savedIds = results.filter((r) => r.status === "saved").map((r) => r.id);
        if (applied.rejected.length || savedIds.some((id) => rejectedRef.current.has(id)))
          setRejected((map) => {
            for (const id of savedIds) map.delete(id);
            for (const r of applied.rejected)
              map.set(r.id, { code: r.code, updatedAt: r.updatedAt });
          });
        if (applied.failed) failed = true;
      }
      let unlinked = false;
      for (const { id, expectedRevision } of deleted) {
        const params = new URLSearchParams();
        if (expectedRevision !== null)
          params.set("expectedRevision", String(expectedRevision));
        const unlink = unlinkOnDelete.current.has(id);
        if (unlink) params.set("unlinkChildren", "true");
        const search = params.toString();
        const query = search ? `?${search}` : "";
        const { status, body, minClient } = await write(
          `/api/notes/${id}${query}`,
          { method: "DELETE", keepalive },
        );
        checkClient(minClient);
        if (status === 200 || status === 404) {
          synced.current.delete(id);
          unlinkOnDelete.current.delete(id);
          if (unlink) unlinked = true;
        } else if (
          status === 409 &&
          body.code === "project_has_linked_items" &&
          body.current
        ) {
          // Items still link to it: restore it until the user confirms.
          const current = body.current as Note;
          synced.current.set(id, {
            revision: current.revision ?? null,
            updatedAt: current.updatedAt,
          });
          unlinkOnDelete.current.delete(id);
          setNotes((list) =>
            list.some((n) => n.id === id) ? list : [current, ...list],
          );
          setBlockedDeletes((list) => [
            ...list.filter((b) => b.id !== id),
            { id, count: Number(body.count) || 0 },
          ]);
        } else if (status === 409 && body.code === "revision_conflict" && body.current) {
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
      // Linked items moved up on the server; pick up their new revisions.
      if (unlinked) setTimeout(() => void refresh(), 0);
    } catch {
      failed = true;
      setStorageError(true);
    } finally {
      saving.current = false;
    }
    // Drafts of notes saved just now go; unsaved ones stay current.
    syncDrafts(notesRef.current);
    // Edits made while this save was in flight. After a failure, the next
    // refresh retries instead of looping.
    const rest = pendingWrites(
      notesRef.current,
      synced.current,
      new Set(conflictsRef.current.keys()),
      heldWrites(),
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
    // Keep persisted drafts current with edits made after a conflict (and,
    // once a reload is required, with every unsaved edit). Skips restored
    // drafts this list doesn't show yet: under StrictMode this effect runs
    // again with the server copies after the mount effect restored them.
    syncDrafts(notes);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  useEffect(() => {
    // The server needs a newer client: keep unsaved edits for after the reload.
    if (reloadRequired) syncDrafts(notesRef.current, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadRequired]);

  useEffect(() => {
    try {
      setBrowserPending(browserNotes.pending(userId));
    } catch {
      /* Unreadable browser notes stay where they are. */
    }
    // Drafts kept from an earlier visit: conflicts stay unresolved; unsaved
    // edits are saved as usual unless the note changed elsewhere meanwhile.
    // Computed from the server-rendered list and applied by id, so running
    // this twice (StrictMode) restores the same drafts once.
    try {
      const drafts = noteDrafts.load(userId);
      if (drafts.length) {
        const result = restoreDrafts(notesRef.current, drafts, { unsaved: !loadError });
        for (const id of result.drop) removeDraft(id);
        if (result.apply.length) {
          restoring.current = new Map([
            ...restoring.current,
            ...result.apply.map((n): [string, string] => [n.id, n.updatedAt]),
          ]);
          setNotes((list) => withRestored(list, result.apply));
        }
        unsavedStored.current = new Set([...unsavedStored.current, ...result.unsaved]);
        if (result.conflicts.length) {
          const restored = new Map(conflictsRef.current);
          for (const conflict of result.conflicts) restored.set(conflict.id, conflict);
          conflictsRef.current = restored;
          setConflictMap(restored);
        }
      }
    } catch {
      /* Unreadable drafts stay where they are. */
    }
    function onVisible() {
      if (document.hidden) void flush(true);
      else void refresh();
    }
    function onBeforeUnload(event: BeforeUnloadEvent) {
      // Keep unsaved edits in case the last save doesn't finish, and warn.
      syncDrafts(notesRef.current, true);
      if (
        hasUnsavedChanges(
          notesRef.current,
          synced.current,
          new Set(conflictsRef.current.keys()),
          heldWrites(),
        )
      )
        event.preventDefault();
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
      kind: itemKind(local),
      projectId: local.projectId ?? null,
      waitingOn: local.waitingOn ?? null,
      waitingFor: local.waitingFor ?? null,
      nextCheckOn: local.nextCheckOn ?? null,
    };
    takeTheirs(id);
    setNotes((list) => [copy, ...list]);
    return copy.id;
  }

  // --- Kinds and project links (ADR 001; U-02 builds the UI on these) -------

  /** Applies an edit to one note as a local change, saved with the next flush. */
  function editNote(id: string, patch: Partial<Note>) {
    const updatedAt = new Date().toISOString();
    setNotes((list) =>
      list.map((n) => (n.id === id ? { ...n, ...patch, updatedAt } : n)),
    );
  }

  /**
   * Changes what an item is. Returns a code instead of changing anything
   * when the database would refuse it (a project that still has linked
   * items, or a linked note that would make the project chain too deep).
   * Never changes the bucket.
   */
  function setKind(id: string, kind: ItemKind): LinkErrorCode | null {
    const note = notesRef.current.find((n) => n.id === id);
    if (!note) return null;
    const error = projectLinkError(notesRef.current, id, note.projectId ?? null, kind);
    if (error) return error;
    editNote(id, { kind });
    return null;
  }

  /**
   * Links an item to a project in the same workspace, or unlinks it with
   * null. Returns a code instead of changing anything when the link would be
   * refused (not a project, other workspace, self, cycle, depth).
   */
  function setProject(id: string, projectId: string | null): LinkErrorCode | null {
    const error = projectLinkError(notesRef.current, id, projectId);
    if (error) return error;
    editNote(id, { projectId });
    return null;
  }

  /**
   * Deletes a note. A project with linked items is refused by the server and
   * restored here (see blockedDeletes) unless unlinkChildren, which moves its
   * direct items up to its parent project (or to no project).
   */
  function deleteNote(id: string, { unlinkChildren = false } = {}) {
    if (unlinkChildren) unlinkOnDelete.current.add(id);
    setBlockedDeletes((list) => list.filter((b) => b.id !== id));
    setNotes((list) => list.filter((n) => n.id !== id));
  }

  /**
   * Drops a refused change and goes back to the saved copy. (Editing the note
   * again, for example picking another project, also clears the error once
   * that save succeeds.)
   */
  function revertItemChange(id: string) {
    const local = notesRef.current.find((n) => n.id === id);
    setRejected((map) => void map.delete(id));
    if (!local) return;
    // Never saved: keep the new note, without the refused link.
    if (!synced.current.has(id)) return editNote(id, { projectId: null });
    // Clean, with an unknown revision: the next refresh adopts the server copy.
    synced.current.set(id, { revision: null, updatedAt: local.updatedAt });
    void refresh();
  }

  // --- Follow-ups and reminders (ADR 001 §4; U-02 builds the UI on these) ---

  /**
   * Sets any of an item's follow-up fields, on any kind. Text is trimmed and
   * an empty value (or null) clears the field. Returns an error (code
   * invalid_payload and the field) instead of changing anything when a value
   * would be refused: waitingOn over 200 or waitingFor over 2000 characters,
   * control characters (line breaks included), or a nextCheckOn that is not
   * a YYYY-MM-DD date. Saved with the next autosave like any other edit.
   */
  function setFollowup(id: string, followup: Partial<Followup>): FollowupError | null {
    const error = followupError(followup);
    if (error) return error;
    const note = notesRef.current.find((n) => n.id === id);
    if (!note) return null;
    const patch = normalizeFollowup(followup);
    const changed = (Object.keys(patch) as (keyof Followup)[]).some(
      (key) => (note[key] ?? null) !== patch[key],
    );
    if (changed) editNote(id, patch);
    return null;
  }

  function storeReminder(reminder: Reminder) {
    setReminderMap((map) => {
      const next = new Map(map);
      const list = next.get(reminder.noteId) ?? [];
      next.set(reminder.noteId, [
        reminder,
        ...list.filter((r) => r.id !== reminder.id),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      return next;
    });
  }

  /** Maps a reminder response, keeping the local list current. */
  function reminderResult(status: number, body: Record<string, unknown>): ReminderResult {
    const reminder = body.reminder as Reminder | undefined;
    if ((status === 200 || status === 201) && reminder) {
      storeReminder(reminder);
      return { ok: true, reminder };
    }
    const current = body.current as Reminder | undefined;
    if (current) storeReminder(current);
    if (reminder) storeReminder(reminder);
    const code = typeof body.code === "string" ? body.code : "";
    return {
      ok: false,
      code: REMINDER_CODES.has(code) ? (code as ReminderErrorCode) : "unavailable",
      ...(reminder ? { reminder } : {}),
      ...(current ? { current } : {}),
    };
  }

  async function reminderWrite(path: string, method: string, payload: unknown): Promise<ReminderResult> {
    try {
      const { status, body, minClient } = await write(path, {
        method,
        body: JSON.stringify(payload),
      });
      checkClient(minClient);
      return reminderResult(status, body);
    } catch {
      return { ok: false, code: "unavailable" };
    }
  }

  /** Loads an item's reminders (newest first) into remindersFor(). */
  async function loadReminders(
    noteId: string,
  ): Promise<{ ok: true; reminders: Reminder[] } | { ok: false; code: ReminderErrorCode | "unavailable" }> {
    try {
      const response = await fetch(`/api/notes/${noteId}/reminders`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (response.ok && Array.isArray(body?.reminders)) {
        const reminders = body.reminders as Reminder[];
        setReminderMap((map) => new Map(map).set(noteId, reminders));
        return { ok: true, reminders };
      }
      return {
        ok: false,
        code: response.status === 404 ? "not_found" : response.status === 400 ? "invalid_payload" : "unavailable",
      };
    } catch {
      return { ok: false, code: "unavailable" };
    }
  }

  /**
   * Adds a reminder at a wall-clock date and time in an IANA zone (use
   * defaultTimeZone() from lib/reminders for the browser's). An item that
   * has not been saved yet is saved first. One waiting reminder per item.
   */
  async function createReminder(noteId: string, time: ReminderTime): Promise<ReminderResult> {
    const parsed = parseReminderTime(time);
    if (!parsed.ok) return { ok: false, code: parsed.code };
    if (!synced.current.has(noteId)) await flush();
    if (!synced.current.has(noteId)) return { ok: false, code: "unavailable" };
    return reminderWrite(`/api/notes/${noteId}/reminders`, "POST", parsed.value);
  }

  function changeReminder(
    reminder: Pick<Reminder, "id" | "noteId" | "revision">,
    action: "update" | "snooze" | "cancel",
    time: Partial<ReminderTime> = {},
  ): Promise<ReminderResult> {
    const parsed = parseReminderTime(time, { partial: true });
    if (!parsed.ok) return Promise.resolve({ ok: false, code: parsed.code });
    if (action !== "cancel" && !Object.keys(parsed.value).length)
      return Promise.resolve({ ok: false, code: "invalid_payload" });
    return reminderWrite(
      `/api/notes/${reminder.noteId}/reminders/${reminder.id}`,
      "PATCH",
      {
        action,
        expectedRevision: reminder.revision,
        ...(action === "cancel" ? {} : parsed.value),
      },
    );
  }

  const itemErrors = useMemo(
    () => [...rejectedMap].map(([id, r]): ItemError => ({ id, code: r.code })),
    [rejectedMap],
  );

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
    /**
     * The server needs a newer client; saving resumes after a reload.
     * Unsaved edits are kept in browser storage and restored after it.
     */
    reloadRequired,
    // Kinds and project links (ADR 001 §2–3). Codes are LinkErrorCode; use
    // LINK_ERROR_MESSAGES from lib/notes for user-facing text.
    setKind,
    setProject,
    deleteNote,
    /** Projects in a workspace, by title. */
    projectsFor: (workspaceId: string) => projectsIn(notes, workspaceId),
    /** Items linked directly to a project. */
    childrenOf: (projectId: string) => projectChildren(notes, projectId),
    /** Whether a link would be accepted; null when it would. */
    linkErrorFor: (id: string, projectId: string | null, kind?: ItemKind) =>
      projectLinkError(notes, id, projectId, kind),
    /**
     * Changes the server refused (ItemErrorCode: link codes, or
     * assignment_active for a workspace move an open assignment blocks);
     * kept locally, not resent. LINK_ERROR_MESSAGES has text for each.
     */
    itemErrors,
    itemErrorFor: (id: string) => itemErrors.find((e) => e.id === id) ?? null,
    revertItemChange,
    /** Project deletes refused because items link to them (restored here). */
    blockedDeletes,
    dismissBlockedDelete: (id: string) =>
      setBlockedDeletes((list) => list.filter((b) => b.id !== id)),
    /** The JSON backup (version 2, with kind and projectId). */
    exportData: () => exportDocument(notesRef.current),
    // Follow-ups (ADR 001 §4). Errors are FollowupError (400 invalid_payload).
    setFollowup,
    // Reminders. Every change states the reminder's revision (pass the
    // reminder as last loaded); a conflict returns code revision_conflict
    // with the current copy, which is also stored here.
    loadReminders,
    /** Reminders loaded for an item, newest first (empty until loaded). */
    remindersFor: (noteId: string) => reminderMap.get(noteId) ?? [],
    /** The item's waiting (scheduled or snoozed) reminder, if loaded. */
    activeReminderFor: (noteId: string) =>
      (reminderMap.get(noteId) ?? []).find(isActiveReminder) ?? null,
    createReminder,
    /** New wall-clock fields; absent ones keep their value. */
    updateReminder: (reminder: Reminder, time: Partial<ReminderTime>) =>
      changeReminder(reminder, "update", time),
    /** Postpones to a new wall-clock time; the reminder becomes snoozed. */
    snoozeReminder: (reminder: Reminder, time: Partial<ReminderTime>) =>
      changeReminder(reminder, "snooze", time),
    /** Cancels it; canceled reminders stay in the list as history. */
    cancelReminder: (reminder: Reminder) => changeReminder(reminder, "cancel"),
  };
}
