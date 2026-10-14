import { BUCKETS, type BucketId, type Note } from "./notes.ts";

/** Buckets a note can be moved to: every bucket except the one it is in. */
export function moveTargets(current: BucketId) {
  return BUCKETS.filter((bucket) => bucket.id !== current);
}

/**
 * Whether moving `noteId` to `destination` changes anything. Completed notes,
 * notes in another workspace and same-bucket moves are no-ops.
 */
export function canMoveNote(notes: Note[], noteId: string, workspaceId: string, destination: BucketId) {
  return notes.some(
    (note) =>
      note.id === noteId &&
      note.workspaceId === workspaceId &&
      !note.completedAt &&
      note.bucket !== destination,
  );
}

/** Notes with `noteId` moved to `destination`. Only `bucket` and `updatedAt` change. */
export function moveNoteInList(notes: Note[], noteId: string, workspaceId: string, destination: BucketId, now: string) {
  return notes.map((note) =>
    note.id === noteId &&
    note.workspaceId === workspaceId &&
    !note.completedAt &&
    note.bucket !== destination
      ? { ...note, bucket: destination, updatedAt: now }
      : note,
  );
}

/** Whether `noteId` is an open note in this workspace that can be completed. */
export function canCompleteNote(notes: Note[], noteId: string, workspaceId: string) {
  return notes.some((note) => note.id === noteId && note.workspaceId === workspaceId && !note.completedAt);
}

/** Notes with `noteId` marked complete. Only `completedAt` and `updatedAt` change. */
export function completeNoteInList(notes: Note[], noteId: string, workspaceId: string, now: string) {
  return notes.map((note) =>
    note.id === noteId && note.workspaceId === workspaceId && !note.completedAt
      ? { ...note, completedAt: now, updatedAt: now }
      : note,
  );
}

/**
 * Next focused index in a menu of `count` items for a key press, following the
 * WAI-ARIA menu pattern (arrows wrap; Home/End jump). Returns null for other keys.
 */
export function menuIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Fixed-position placement for a popup menu anchored to a button, kept inside
 * the viewport. Right-aligns to the anchor, and flips above it when there isn't
 * room below.
 */
export function menuPlacement(
  anchor: { top: number; bottom: number; left: number; right: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  { gap = 4, margin = 8 } = {},
) {
  const width = Math.min(menu.width, viewport.width - margin * 2);
  const left = Math.max(margin, Math.min(anchor.right - width, viewport.width - width - margin));
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const placeAbove = menu.height > below && above > below;
  const maxHeight = Math.max(0, placeAbove ? above : below);
  const height = Math.min(menu.height, maxHeight);
  const top = placeAbove ? anchor.top - gap - height : anchor.bottom + gap;
  return { top: Math.max(margin, top), left, width, maxHeight, placement: placeAbove ? "above" : "below" } as const;
}
