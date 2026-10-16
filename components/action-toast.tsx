"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, Check, Info, Sparkles, X } from "lucide-react";
import { actionFeedback } from "@/lib/action-feedback";
import type { ToastAction } from "./workspace-shell-context";

export type ActionNotification = { id: number; message: string; action?: ToastAction };

/** Timers belong to each notification; identical actions get a fresh lifetime. */
export function ActionToast({ toast, onDismiss }: {
  toast: ActionNotification;
  onDismiss: () => void;
}) {
  const feedback = actionFeedback(toast.message);
  const Icon = { capture: Sparkles, complete: Check, move: ArrowRight, saved: Check, info: Info }[feedback.kind];
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(toast.action ? 8000 : 4500);
  const dismiss = useRef(onDismiss);
  useEffect(() => { dismiss.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    if (hovered || focused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss.current(), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [hovered, focused]);
  return (
    <div className={`toast action-toast is-${feedback.kind} ${toast.action ? "has-action" : ""}`}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <span className="action-toast-icon" aria-hidden="true">
        <Icon size={18} />
        {feedback.kind === "complete" && <span className="toast-sparks">{Array.from({ length: 8 }, (_, i) => <i key={i} style={{ "--spark-angle": `${i * 45}deg` } as CSSProperties} />)}</span>}
      </span>
      <div className="action-toast-copy" role="status" aria-live="polite" aria-atomic="true">
        <strong>{toast.message}</strong>
        {feedback.caption && <small>{feedback.caption}</small>}
      </div>
      {toast.action && <button type="button" className="toast-action" onClick={() => { onDismiss(); toast.action?.onAction(); }}>{toast.action.label}</button>}
      <button type="button" className="toast-dismiss" aria-label="Dismiss notification" onClick={onDismiss}><X size={15} /></button>
    </div>
  );
}
