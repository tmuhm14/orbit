"use client";

import { ArrowUp, Plus } from "lucide-react";
import { BUCKETS, type BucketId } from "@/lib/notes";
import { useWorkspaceShell } from "./workspace-shell-context";

export function QuickCapture() {
  const { capture, loaded, loadError } = useWorkspaceShell();
  return (
    <section className="capture-box capture-compact" aria-label="Quick capture">
      <div className="capture-main">
        <Plus size={21} />
        <textarea
          ref={capture.ref}
          rows={1}
          value={capture.text}
          onChange={(e) => capture.setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              capture.submit();
            }
          }}
          placeholder="What's on your mind?"
          aria-label="Quick capture"
          disabled={!loaded || loadError}
        />
        <button
          aria-label="Capture note"
          className="capture-submit"
          onClick={capture.submit}
          disabled={!capture.text.trim() || !loaded || loadError}
        >
          <ArrowUp size={18} />
        </button>
      </div>
      <div className="capture-bottom">
        <span>No need to sort it out. Just get it out.</span>
        <div>
          <span className="capture-destination">
            Save to{" "}
            <select
              aria-label="Capture bucket"
              value={capture.bucket}
              onChange={(e) => capture.setBucket(e.target.value as BucketId)}
            >
              {BUCKETS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </span>
          <span className="capture-shortcut">
            <kbd>↵</kbd> to capture
          </span>
        </div>
      </div>
    </section>
  );
}
