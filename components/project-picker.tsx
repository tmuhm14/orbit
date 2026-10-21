"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import type { Note } from "@/lib/notes";
import {
  projectOptions,
  projectPathLabel,
  type ProjectOption,
} from "@/lib/item-properties";

type Option = Omit<ProjectOption, "id"> & { id: string | null; create?: boolean };
const NONE: Option = { id: null, title: "None", parents: "", error: null };
const CREATE_ID = "create-project";

/**
 * Searchable project picker (ARIA 1.2 combobox with a listbox popup). Lists
 * projects in the item's workspace with their nesting path, plus "None".
 * Choosing an option that would be refused still calls onSelect so the
 * caller can show why (setProject returns the code without changing data).
 * With onCreate, a search that names no existing project offers to create
 * one with that name.
 */
export function ProjectPicker({
  id,
  notes,
  item,
  onSelect,
  onCreate,
  describedBy,
  invalid,
}: {
  id: string;
  notes: Note[];
  item: Note;
  onSelect: (projectId: string | null) => void;
  /** Creates a project named `title` and links the item to it. */
  onCreate?: (title: string) => void;
  describedBy?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = `${id}-list`;
  const options = useMemo<Option[]>(() => {
    const projects = projectOptions(notes, item, query);
    const name = query.trim();
    const q = name.toLowerCase();
    const list = !q || "none".includes(q) ? [NONE, ...projects] : projects;
    if (!onCreate || !q || projects.some((p) => p.title.trim().toLowerCase() === q)) return list;
    return [...list, { id: CREATE_ID, title: name, parents: "", error: null, create: true }];
  }, [notes, item, query, onCreate]);
  const current = item.projectId
    ? projectPathLabel(notes, item.projectId) || "A project that isn’t loaded"
    : "None";
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  useLayoutEffect(() => {
    if (!open) return;
    const option = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    option?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function openList() {
    if (open) return;
    setQuery("");
    const selected = options.findIndex((o) => o.id === (item.projectId ?? null));
    setActive(Math.max(0, selected));
    setOpen(true);
  }
  function choose(option: Option) {
    setOpen(false);
    setQuery("");
    if (option.create) onCreate?.(option.title);
    else if (option.id !== (item.projectId ?? null)) onSelect(option.id);
  }

  return (
    <div className={`project-picker ${open ? "is-open" : ""}`}>
      <div className={`project-picker-field ${invalid ? "is-invalid" : ""}`}>
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && options.length ? `${listId}-${activeIndex}` : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          spellCheck={false}
          value={open ? query : current}
          placeholder={open ? (onCreate ? "Search or create a project…" : "Search projects…") : undefined}
          onClick={openList}
          onChange={(e) => {
            if (!open) setOpen(true);
            setQuery(e.target.value);
            setActive(0);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!open) return openList();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((activeIndex + step + options.length) % (options.length || 1));
            } else if (e.key === "Home" && open) {
              e.preventDefault();
              setActive(0);
            } else if (e.key === "End" && open) {
              e.preventDefault();
              setActive(Math.max(0, options.length - 1));
            } else if (e.key === "Enter" && open) {
              e.preventDefault();
              if (options[activeIndex]) choose(options[activeIndex]);
            } else if (e.key === "Escape" && open) {
              // Close the list, not the editor.
              e.stopPropagation();
              setOpen(false);
              setQuery("");
            }
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          className="project-picker-toggle"
          aria-label={open ? "Close project list" : "Show projects"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) setOpen(false);
            else {
              openList();
              document.getElementById(id)?.focus();
            }
          }}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Projects"
        className="project-picker-list"
        hidden={!open}
      >
        {options.length ? (
          options.map((option, index) => {
            const chosen = !option.create && option.id === (item.projectId ?? null);
            return (
              <li
                key={option.id ?? "none"}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                aria-checked={chosen}
                className={`project-option ${index === activeIndex ? "is-active" : ""} ${option.error ? "is-refused" : ""} ${option.create ? "is-create" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => index !== activeIndex && setActive(index)}
                onClick={() => choose(option)}
              >
                <span className="project-option-check" aria-hidden="true">
                  {chosen && <Check size={13} />}
                  {option.create && <Plus size={13} />}
                </span>
                <span className="project-option-text">
                  <strong>{option.create ? `Create “${option.title}”` : option.title}</strong>
                  {option.create ? (
                    <small>New top-level project</small>
                  ) : option.id === null ? (
                    <small>Not part of a project</small>
                  ) : option.parents ? (
                    <small>in {option.parents}</small>
                  ) : (
                    <small>Top level</small>
                  )}
                  {option.error === "project_cycle" && (
                    <small className="project-option-why">Inside this project</small>
                  )}
                  {option.error === "project_depth_exceeded" && (
                    <small className="project-option-why">Too deeply nested</small>
                  )}
                </span>
              </li>
            );
          })
        ) : (
          <li className="project-option-empty" role="presentation">
            No projects match “{query.trim()}”.
          </li>
        )}
      </ul>
    </div>
  );
}
