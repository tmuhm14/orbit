"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { BUCKETS, createNote, textDoc, type BucketId, type Note } from "@/lib/notes";

/** How long capture feedback stays active; covers the longest capture animation. */
const CAPTURE_FEEDBACK_MS = 1200;

/**
 * The most recent quick capture. `seq` increases on every capture so repeated
 * captures restart their animation. Only `submit()` sets it, never loading or
 * refreshing notes, so feedback always reflects a real capture.
 */
export type CaptureFeedback = { id: string; seq: number };

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
  const [feedback, setFeedback] = useState<CaptureFeedback | null>(null);
  const seq = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Clear feedback shortly after each capture so a later remount (changing
  // views, reloading) never replays it.
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), CAPTURE_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [feedback]);
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
    seq.current += 1;
    setFeedback({ id: note.id, seq: seq.current });
    onToast(`Captured in ${BUCKETS.find((b) => b.id === bucket)?.name}`);
  }
  return {
    text,
    setText,
    bucket,
    setBucket,
    ref,
    submit,
    /** Set briefly after a capture; `null` otherwise. */
    feedback,
    focus: () => ref.current?.focus(),
  };
}

export type QuickCaptureState = ReturnType<typeof useQuickCapture>;
