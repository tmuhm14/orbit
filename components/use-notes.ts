"use client";

import { useEffect, useState } from "react";
import { noteRepository, type Note } from "@/lib/notes";

// Owns loading and saving an account's notes. The storage backend lives in
// noteRepository; the workspace only sees note state and error flags.
export function useNotes(userId: string) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  useEffect(() => {
    try {
      setNotes(noteRepository.load(userId));
      setLegacyAvailable(noteRepository.hasLegacyNotes(userId));
    } catch {
      setLoadError(true);
      setStorageError(true);
    }
    setLoaded(true);
  }, [userId]);
  useEffect(() => {
    if (!loaded || loadError) return;
    try {
      noteRepository.save(userId, notes);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [notes, loaded, loadError, userId]);
  /** Returns false when the legacy notes could not be read. */
  function importLegacy(): boolean {
    try {
      setNotes(noteRepository.importLegacy(userId, notes));
      setLegacyAvailable(false);
      return true;
    } catch {
      return false;
    }
  }
  return {
    notes,
    setNotes,
    loaded,
    loadError,
    storageError,
    legacyAvailable,
    dismissLegacy: () => setLegacyAvailable(false),
    importLegacy,
  };
}
