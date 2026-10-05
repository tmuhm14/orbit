"use client";

import { Sparkles, X } from "lucide-react";

const steps = [
  ["Capture", "Collect loose thoughts, commitments, and ideas in your Inbox."],
  ["Clarify", "Ask: is there an action here? Name the next concrete step."],
  [
    "Organize",
    "Use Next actions for doable steps, Projects for bigger outcomes, and Waiting for for anything delegated. Save ideas in Someday / maybe and useful information in Reference.",
  ],
  [
    "Reflect",
    "Review every bucket. Update what has changed, delete what no longer matters, and check each project has a next action.",
  ],
  [
    "Engage",
    "Choose a next action that fits your time, energy, and priorities.",
  ],
];

export function GuideDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="guide-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-title"
      >
        <button
          autoFocus
          className="icon-button guide-close"
          onKeyDown={(e) => {
            if (e.key === "Tab") e.preventDefault();
          }}
          aria-label="Close guide"
          onClick={onClose}
        >
          <X size={21} />
        </button>
        <Sparkles className="purple" size={30} />
        <div className="eyebrow">A SMALL RESET</div>
        <h2 id="guide-title">Make room for what matters.</h2>
        <p>
          Getting Things Done starts with a trusted place to put what is on your
          mind. Come back to these steps each week.
        </p>
        <ol>
          {steps.map(([title, body], i) => (
            <li key={title}>
              <span>{i + 1}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="guide-tip">
          Try <kbd>⌘ / Ctrl K</kbd> to search, <kbd>⌘ / Ctrl J</kbd> to capture,
          and <kbd>/</kbd> inside a note.
        </div>
      </div>
    </div>
  );
}
