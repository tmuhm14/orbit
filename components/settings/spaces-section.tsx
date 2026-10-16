"use client";

import { useState } from "react";
import { Bot, Pencil, Plus, Star } from "lucide-react";
import { WORKSPACE_COLORS, workspaceColor, type Workspace, type WorkspaceColor } from "@/lib/notes";
import { isDirty } from "@/lib/settings-sections";
import { FormDialog } from "../side-panel";

const COLORS = Object.keys(WORKSPACE_COLORS) as WorkspaceColor[];
const colorName = (color: string) => color[0].toUpperCase() + color.slice(1);

export const SpaceDot = ({ color }: { color: WorkspaceColor }) => (
  <span className="settings-space-dot" style={{ background: WORKSPACE_COLORS[color].accent }} aria-hidden="true" />
);

/** Name (and, when editing, color) for one space. */
function SpaceDialog({ space, workspaces, onSave, onClose }: {
  /** Absent: a new space. */
  space?: Workspace;
  workspaces: Workspace[];
  onSave: (name: string, color: WorkspaceColor) => Promise<void>;
  onClose: () => void;
}) {
  const initial = { name: space?.name ?? "", color: space ? workspaceColor(workspaces, space.id) : ("purple" as WorkspaceColor) };
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState<WorkspaceColor>(initial.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = isDirty(initial, { name, color });
  return (
    <FormDialog
      title={space ? `Edit “${space.name}”` : "New space"}
      description={space ? "Rename it or give it a new color." : "A space keeps its own notes, inbox address and agent setting."}
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      submitLabel={space ? "Save" : "Create space"}
      busyLabel={space ? "Saving…" : "Creating…"}
      submitDisabled={!name.trim() || (!!space && !isDirty(initial, { name: name.trim(), color }))}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim()) return;
        setBusy(true); setError("");
        try { await onSave(name.trim(), color); }
        catch (failure) {
          setError(failure instanceof Error ? failure.message : "Couldn’t save the space");
          setBusy(false);
        }
      }}
    >
      <div className="settings-fields">
        <label className="settings-field">
          Name
          <input data-autofocus value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required placeholder="e.g. Work" />
        </label>
        {space && (
          <fieldset className="settings-swatches">
            <legend>Color</legend>
            <div>
              {COLORS.map((c) => (
                <label key={c} className={`settings-swatch${color === c ? " is-selected" : ""}`} title={colorName(c)}>
                  <input type="radio" name="space-color" value={c} checked={color === c} onChange={() => setColor(c)} />
                  <SpaceDot color={c} />
                  <span>{colorName(c)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </FormDialog>
  );
}

export function SpacesSection({ workspaces, onCreate, onRename, onRecolor, onSetDefault, onToast }: {
  workspaces: Workspace[];
  onCreate: (name: string) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onRecolor: (id: string, color: string) => Promise<unknown>;
  onSetDefault: (id: string) => Promise<unknown>;
  onToast: (message: string) => void;
}) {
  const [editing, setEditing] = useState<Workspace | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  async function makeDefault(space: Workspace) {
    setBusyId(space.id);
    try { await onSetDefault(space.id); onToast(`${space.name} now opens first`); }
    catch { onToast("Couldn’t change the default space"); }
    finally { setBusyId(null); }
  }
  return (
    <section className="settings-card" aria-labelledby="spaces-list">
      <div className="settings-card-heading has-action">
        <div>
          <h2 id="spaces-list">Your spaces</h2>
          <p>Each new session opens your default space.</p>
        </div>
        <button type="button" className="secondary-button" aria-haspopup="dialog" onClick={() => setEditing("new")}>
          <Plus size={14} aria-hidden="true" /> New space
        </button>
      </div>
      <ul className="settings-list">
        {workspaces.map((space) => (
          <li key={space.id} className="settings-row">
            <div className="settings-row-main">
              <strong><SpaceDot color={workspaceColor(workspaces, space.id)} /> {space.name}</strong>
              <span className="settings-row-meta">
                {space.isDefault && <span className="settings-badge is-accent"><Star size={11} fill="currentColor" aria-hidden="true" /> Default</span>}
                <span className={`settings-badge${space.agentEnabled ? " is-on" : ""}`}><Bot size={11} aria-hidden="true" /> Agent {space.agentEnabled ? "on" : "off"}</span>
              </span>
            </div>
            <div className="settings-row-actions">
              {!space.isDefault && (
                <button type="button" className="text-button" disabled={busyId === space.id} onClick={() => void makeDefault(space)}>
                  Make default<span className="sr-only">: {space.name}</span>
                </button>
              )}
              <button type="button" className="text-button" aria-haspopup="dialog" onClick={() => setEditing(space)}>
                <Pencil size={13} aria-hidden="true" /> Edit<span className="sr-only"> {space.name}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>
      {editing && (
        <SpaceDialog
          space={editing === "new" ? undefined : editing}
          workspaces={workspaces}
          onClose={() => setEditing(null)}
          onSave={async (name, color) => {
            if (editing === "new") {
              await onCreate(name);
              onToast(`Created ${name}`);
            } else {
              const before = workspaceColor(workspaces, editing.id);
              if (name !== editing.name) await onRename(editing.id, name);
              if (color !== before) await onRecolor(editing.id, color);
              onToast("Space updated");
            }
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}
