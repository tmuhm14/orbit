"use client";

import type { RefObject } from "react";
import { Search, X } from "lucide-react";

export function SearchDialog({
  inputRef,
  value,
  onChange,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop search-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search workspace"
      >
        <Search size={22} />
        <input
          ref={inputRef}
          placeholder="Find a thought, tag, or idea…"
          value={value}
          aria-label="Search workspace"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onClose();
            if (e.key === "Tab") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <button
          className="icon-button"
          aria-label="Close search"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <div className="search-help">
          Search across all your buckets{" "}
          <span>
            <kbd>↵</kbd> to see results <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
