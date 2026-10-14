"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { BUCKETS, createNote, textDoc, type BucketId, type Note } from "@/lib/notes";

/**
 * Quick-capture draft state. Lives in `Workspace` so the draft survives view
 * changes and so the ⌘J shortcut and navigation can reach it.
 */
export function useQuickCapture({
  setNotes,
  workspaceId,
  onToast,
}: {
  setNotes: Dispatch<SetStateAction<Note[]>>;
  workspaceId: string;
  onToast: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [bucket, setBucket] = useState<BucketId>("inbox");
  const ref = useRef<HTMLTextAreaElement>(null);
  function submit() {
    if (!text.trim()) {
      ref.current?.focus();
      return;
    }
    const [title, ...body] = text.trim().split("\n");
    const note = {
      ...createNote(title, bucket, workspaceId),
      content: textDoc(body.join("\n")),
      plainText: body.join("\n"),
    };
    setNotes((n) => [note, ...n]);
    setText("");
    onToast(`Captured in ${BUCKETS.find((b) => b.id === bucket)?.name}`);
  }
  return {
    text,
    setText,
    bucket,
    setBucket,
    ref,
    submit,
    focus: () => ref.current?.focus(),
  };
}

export type QuickCaptureState = ReturnType<typeof useQuickCapture>;
