"use client";

import { useEffect, useEffectEvent } from "react";

/**
 * Global workspace shortcuts: ⌘/Ctrl+K search, ⌘/Ctrl+J quick capture and
 * Escape to dismiss overlays. Ignored while a note is open in the editor.
 */
export function useWorkspaceShortcuts({
  disabled,
  onSearch,
  onCapture,
  onEscape,
}: {
  disabled: boolean;
  onSearch: () => void;
  onCapture: () => void;
  onEscape: () => void;
}) {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (disabled) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      onSearch();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
      event.preventDefault();
      onCapture();
    }
    if (event.key === "Escape") onEscape();
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
}
