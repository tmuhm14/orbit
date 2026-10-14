"use client";

import { ArrowUpRight, Feather, Orbit, Sparkles, Zap } from "lucide-react";
import { BUCKETS } from "@/lib/notes";
import { DueItems } from "./due-items";
import { bucketIcons, useWorkspaceShell } from "./workspace-shell-context";

/** Home ("My space") hero shown above quick capture. */
export function HomeWelcome() {
  return (
    <section className="welcome-section welcome-compact">
      <div className="welcome-copy">
        <div className="eyebrow">
          <span />
          LESS NOISE. MORE SPACE.
        </div>
        <h1>
          A little space for a <span>clearer mind.</span>
        </h1>
        <p>Capture the thought. Find its place. Let it go.</p>
      </div>
      <div className="orbital-art" aria-hidden="true">
        <div className="orbit-track track-one" />
        <div className="orbit-track track-two" />
        <div className="orbit-track track-three" />
        <div className="orbit-glow" />
        <div className="orbit-core">
          <Orbit size={45} strokeWidth={0.75} />
        </div>
        <div className="orbital-node node-one">
          <Zap size={16} />
        </div>
        <div className="orbital-node node-two">
          <Feather size={16} />
        </div>
        <div className="orbital-node node-three">
          <Sparkles size={14} />
        </div>
        <i className="star star-one" />
        <i className="star star-two" />
        <i className="star star-three" />
      </div>
    </section>
  );
}

/** Home bucket grid shown below quick capture. */
export function HomeBuckets() {
  const { loaded, bucketCount, navigate, openGuide } = useWorkspaceShell();
  return (
    <section className="buckets-section">
      <div className="section-heading">
        <h2>
          Your buckets <span>A place for everything</span>
        </h2>
        <button className="text-button" onClick={openGuide}>
          How it works <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="bucket-grid">
        {BUCKETS.map((b, i) => {
          const Icon = bucketIcons[b.icon];
          return (
            <button
              key={b.id}
              className={`bucket-card ${b.color}`}
              style={{ animationDelay: `${i * 45}ms` }}
              onClick={() => navigate(b.id)}
            >
              <div className="bucket-card-top">
                <span className="bucket-icon">
                  <Icon size={20} strokeWidth={1.6} />
                </span>
                <span className="bucket-number">
                  {loaded ? bucketCount(b.id).toString().padStart(2, "0") : "–"}
                </span>
              </div>
              <div className="bucket-card-title">
                <h3>{b.name}</h3>
                <ArrowUpRight size={16} />
              </div>
              <p>{b.description}</p>
              <span className="bucket-bottom-line" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Home side panel listing due items for the current workspace. */
export function HomeDueItems() {
  const { notes, workspaceId, loadError, setNotes, openNote, showToast } =
    useWorkspaceShell();
  return (
    <DueItems
      notes={notes}
      workspaceId={workspaceId}
      unavailable={loadError}
      onOpen={openNote}
      onComplete={(id) => {
        const now = new Date().toISOString();
        setNotes(current => current.map(note => note.id === id && note.workspaceId === workspaceId ? { ...note, completedAt: now, updatedAt: now } : note));
        showToast("Note completed");
      }}
    />
  );
}
