"use client";

import { useMemo } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { safeArtifactDoc } from "@/lib/agents-view";

/**
 * A result, read-only, as it will look as a document. The executor-written
 * Tiptap content is reduced to the contract's schema first (no links,
 * images or HTML) and rendered by Tiptap, never as raw HTML. Content that
 * isn't a usable document falls back to the plain text.
 */
export function ArtifactPreview({
  content,
  plainText,
  label,
}: {
  content: unknown;
  plainText: string;
  label: string;
}) {
  const doc = useMemo(() => safeArtifactDoc(content), [content]);
  if (!doc) return <PlainArtifact text={plainText} label={label} />;
  return <RichArtifact doc={doc} label={label} />;
}

function PlainArtifact({ text, label }: { text: string; label: string }) {
  return (
    <div className="assignment-artifact assignment-untrusted" tabIndex={0} role="region" aria-label={label}>
      {text || "The result is empty."}
    </div>
  );
}

function RichArtifact({ doc, label }: { doc: NonNullable<ReturnType<typeof safeArtifactDoc>>; label: string }) {
  const editor = useEditor(
    {
      editable: false,
      immediatelyRender: false,
      // The safe schema has no links or underline; leave them out entirely.
      extensions: [
        StarterKit.configure({ link: false, underline: false, dropcursor: false, gapcursor: false, trailingNode: false }),
        TaskList,
        TaskItem.configure({ nested: true, onReadOnlyChecked: () => false }),
      ],
      content: doc,
      editorProps: {
        attributes: { class: "note-prose artifact-prose", "aria-readonly": "true" },
      },
    },
    [doc],
  );
  return (
    <div className="assignment-artifact artifact-preview" tabIndex={0} role="region" aria-label={label}>
      {editor ? <EditorContent editor={editor} /> : <span className="assignment-muted">Preparing the preview…</span>}
    </div>
  );
}
