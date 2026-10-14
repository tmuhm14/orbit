"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { BUCKETS, type BucketId, type Note } from "@/lib/notes";
import {
  canCompleteNote,
  canMoveNote,
  completeNoteInList,
  moveNoteInList,
} from "@/lib/item-actions";

/** How long a moved item keeps its arrival class; covers the arrival animation. */
const ARRIVAL_MS = 1200;

/** The Home row currently being dragged, if any. */
export type DraggedItem = { id: string; bucket: BucketId };

/**
 * Shared move and complete actions for items. Every writer goes through
 * `setNotes` from `useNotes`, so revisions and conflict handling still apply.
 * Toasts never include the note title.
 */
export function useItemActions({
  notes,
  setNotes,
  workspaceId,
  showToast,
}: {
  notes: Note[];
  setNotes: Dispatch<SetStateAction<Note[]>>;
  workspaceId: string;
  showToast: (message: string) => void;
}) {
  const [dragging, setDragging] = useState<DraggedItem | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  // Clear shortly after a move so a later remount never replays the arrival.
  useEffect(() => {
    if (!arrived) return;
    const timer = setTimeout(() => setArrived(null), ARRIVAL_MS);
    return () => clearTimeout(timer);
  }, [arrived]);
  function moveNoteToBucket(noteId: string, destination: BucketId) {
    if (!canMoveNote(notes, noteId, workspaceId, destination)) return false;
    setNotes((current) =>
      moveNoteInList(current, noteId, workspaceId, destination, new Date().toISOString()),
    );
    setArrived(noteId);
    showToast(`Moved to ${BUCKETS.find((b) => b.id === destination)?.name}`);
    return true;
  }
  function completeNote(noteId: string) {
    if (!canCompleteNote(notes, noteId, workspaceId)) return false;
    setNotes((current) => completeNoteInList(current, noteId, workspaceId, new Date().toISOString()));
    showToast("Note completed");
    return true;
  }
  return { moveNoteToBucket, completeNote, dragging, setDragging, arrived };
}

export type ItemActions = ReturnType<typeof useItemActions>;
