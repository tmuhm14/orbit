"use client";

import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]';

/**
 * Focus handling for a dialog stacked above the note editor: focus moves in
 * (the `[data-autofocus]` element, else the first control), Tab stays inside,
 * Escape closes only this dialog, and focus returns to where it was.
 */
export function useModalDialog(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const target =
      root?.querySelector<HTMLElement>("[data-autofocus]") ?? root?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      if (prior?.isConnected) prior.focus();
    };
  }, [ref]);
  return function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      // Not the editor underneath (React events bubble through portals).
      event.stopPropagation();
      if (!event.defaultPrevented) onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    // Keep Tab in this dialog; the editor's own trap only acts on its edges.
    event.stopPropagation();
    const elements = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
      (el) => !el.closest("[hidden]") && el.tabIndex !== -1,
    );
    if (!elements.length) return;
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}
