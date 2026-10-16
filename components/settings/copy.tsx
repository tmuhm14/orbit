"use client";

import { useEffect, useId, useState } from "react";
import { Check, Copy } from "lucide-react";

/** Copies `text`; shows a check for a moment and reports through a toast. */
export function CopyButton({ text, label, onToast, onCopied, className = "icon-button", showLabel = false }: {
  text: string;
  /** Accessible name, for example "Copy the curl example". */
  label: string;
  onToast: (message: string) => void;
  onCopied?: () => void;
  className?: string;
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={`${className} settings-copy${copied ? " is-copied" : ""}`}
      aria-label={showLabel ? undefined : label}
      title={label}
      onClick={() => void navigator.clipboard.writeText(text).then(
        () => { setCopied(true); onCopied?.(); onToast("Copied"); },
        () => onToast("Couldn’t copy. Select the text and copy it instead."),
      )}
    >
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      {showLabel && <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}

/** A labelled code block with a copy button. */
export function CodeBlock({ code, label, language, onToast }: {
  code: string; label: string; language?: string; onToast: (message: string) => void;
}) {
  const id = useId();
  return (
    <figure className="settings-code" aria-labelledby={`${id}-label`}>
      <figcaption>
        <span id={`${id}-label`}>{label}</span>
        {language && <small>{language}</small>}
        <CopyButton text={code} label={`Copy ${label.toLowerCase()}`} onToast={onToast} />
      </figcaption>
      <pre tabIndex={0}><code>{code}</code></pre>
    </figure>
  );
}
