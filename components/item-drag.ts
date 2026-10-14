"use client";

import { useRef, useState, useSyncExternalStore, type DragEvent, type PointerEvent } from "react";
import type { BucketId, Note } from "@/lib/notes";
import { useWorkspaceShell } from "./workspace-shell-context";

const FINE_POINTER = "(pointer: fine)";

function subscribeFinePointer(onChange: () => void) {
  const query = window.matchMedia(FINE_POINTER);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True on a mouse/trackpad. Drag-to-move is a desktop enhancement only. */
export function useFinePointer() {
  return useSyncExternalStore(
    subscribeFinePointer,
    () => window.matchMedia(FINE_POINTER).matches,
    () => false,
  );
}

/**
 * Props that make a Home row draggable onto bucket targets. Uses the same
 * `text/plain` note id as the All items board. Drags that start on the row's
 * actions button are ignored so the button behaves like a button.
 */
export function useDraggableItem() {
  const { items } = useWorkspaceShell();
  const fine = useFinePointer();
  const fromControl = useRef(false);
  return (note: Note) => {
    if (!fine) return {};
    const isDragging = items.dragging?.id === note.id;
    return {
      draggable: true,
      "data-dragging": isDragging || undefined,
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        fromControl.current = !!(event.target as Element).closest("[data-no-drag]");
      },
      onDragStart: (event: DragEvent<HTMLElement>) => {
        if (fromControl.current) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", note.id);
        items.setDragging({ id: note.id, bucket: note.bucket });
      },
      onDragEnd: () => items.setDragging(null),
    };
  };
}

/**
 * Drop-target props for bucket buttons (Home chips, sidebar nav). Only accepts
 * a Home row drag, and never the note's current bucket.
 */
export function useBucketDropTargets() {
  const { items } = useWorkspaceShell();
  const [over, setOver] = useState<BucketId | null>(null);
  const { dragging } = items;
  const accepts = (bucket: BucketId) => !!dragging && dragging.bucket !== bucket;
  return (bucket: BucketId) => ({
    "data-drop-target": (accepts(bucket) && over === bucket) || undefined,
    "data-drop-available": accepts(bucket) || undefined,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!accepts(bucket)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (over !== bucket) setOver(bucket);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      setOver(null);
      if (!dragging || !accepts(bucket)) return;
      event.preventDefault();
      const id = event.dataTransfer.getData("text/plain") || dragging.id;
      if (id === dragging.id) items.moveNoteToBucket(id, bucket);
      items.setDragging(null);
    },
  });
}
