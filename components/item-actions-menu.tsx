"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Ellipsis, SquareArrowOutUpRight } from "lucide-react";
import type { BucketId, Note } from "@/lib/notes";
import { menuIndex, menuPlacement, moveTargets } from "@/lib/item-actions";
import { bucketIcons, useWorkspaceShell } from "./workspace-shell-context";

/**
 * After an action removes the row, keep keyboard focus nearby: the next or
 * previous row, else the section heading.
 */
function focusAfter(button: HTMLButtonElement) {
  const row = button.closest("li");
  const neighbor = row?.nextElementSibling ?? row?.previousElementSibling;
  const scope = button.closest("section, aside");
  requestAnimationFrame(() => {
    if (button.isConnected) {
      button.focus();
      return;
    }
    const next = neighbor?.isConnected ? neighbor.querySelector<HTMLElement>("button") : null;
    if (next) {
      next.focus();
      return;
    }
    const heading = scope?.isConnected ? scope.querySelector<HTMLElement>("h2, h3") : null;
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  });
}

/**
 * "⋯" quick-actions menu for one item: move to another bucket, complete, open.
 * Follows the WAI-ARIA menu button pattern. The menu is portalled to the body
 * with fixed, viewport-clamped placement so cards and scroll areas can't clip it.
 */
export function ItemActionsMenu({ note, className = "" }: { note: Note; className?: string }) {
  const { items, openNote } = useWorkspaceShell();
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const buttonId = `${id}-button`;
  const menuId = `${id}-menu`;
  const title = note.title || "Untitled thought";
  const targets = moveTargets(note.bucket);
  const count = targets.length + 2;

  useLayoutEffect(() => {
    if (!open) return;
    function position() {
      const menu = menuRef.current;
      const anchor = buttonRef.current?.getBoundingClientRect();
      if (!menu || !anchor) return;
      menu.style.maxHeight = "";
      const place = menuPlacement(
        anchor,
        { width: menu.offsetWidth, height: menu.scrollHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      menu.style.top = `${place.top}px`;
      menu.style.left = `${place.left}px`;
      menu.style.width = `${place.width}px`;
      menu.style.maxHeight = `${place.maxHeight}px`;
      menu.dataset.placement = place.placement;
      menu.style.visibility = "visible";
    }
    position();
    itemRefs.current[initialFocus]?.focus({ preventScroll: true });
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open, initialFocus]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function show(index: number) {
    setInitialFocus(index);
    setOpen(true);
  }
  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }
  function run(action: () => void) {
    const button = buttonRef.current;
    setOpen(false);
    action();
    if (button) focusAfter(button);
  }

  function onButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show(event.key === "ArrowDown" ? 0 : count - 1);
    }
  }
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    const current = itemRefs.current.findIndex((item) => item === document.activeElement);
    const next = menuIndex(current, count, event.key);
    if (next === null) return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
  }

  const itemProps = (index: number) => ({
    ref: (node: HTMLButtonElement | null) => {
      itemRefs.current[index] = node;
    },
    role: "menuitem",
    tabIndex: -1,
    type: "button" as const,
    className: "item-menu-item",
  });

  return (
    <>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className={`item-actions-button ${className}`}
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-no-drag
        onClick={() => (open ? close(false) : show(0))}
        onKeyDown={onButtonKeyDown}
      >
        <Ellipsis size={16} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="item-menu"
            role="menu"
            aria-labelledby={buttonId}
            style={{ visibility: "hidden" }}
            onKeyDown={onMenuKeyDown}
          >
            <div role="group" aria-labelledby={`${id}-move`}>
              <div id={`${id}-move`} className="item-menu-label">
                Move to
              </div>
              {targets.map((bucket, index) => {
                const Icon = bucketIcons[bucket.icon];
                return (
                  <button
                    key={bucket.id}
                    {...itemProps(index)}
                    onClick={() => run(() => items.moveNoteToBucket(note.id, bucket.id as BucketId))}
                  >
                    <Icon className={`item-menu-icon ${bucket.color}`} size={15} aria-hidden="true" />
                    {bucket.name}
                  </button>
                );
              })}
            </div>
            <div role="separator" className="item-menu-separator" />
            <button {...itemProps(targets.length)} onClick={() => run(() => items.completeNote(note.id))}>
              <Check className="item-menu-icon" size={15} aria-hidden="true" />
              Mark complete
            </button>
            <button
              {...itemProps(targets.length + 1)}
              onClick={() => {
                setOpen(false);
                openNote(note.id);
              }}
            >
              <SquareArrowOutUpRight className="item-menu-icon" size={15} aria-hidden="true" />
              Open
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
