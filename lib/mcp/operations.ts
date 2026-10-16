import "server-only";
import { allowed, authorize, type IntegrationAuth } from "@/lib/integrations/auth";
import { captureInput, uuid } from "@/lib/integrations/validation";
import { grantedWorkspaces } from "@/lib/grants/server";
import { createNote, isItemKind, textDoc } from "@/lib/notes";
import { toRow } from "@/lib/notes-db";

/**
 * The hosted MCP tools' operations (ADR 008). They run in-process, not as
 * HTTP calls to /api/v1, and use the same server functions /api/v1 does:
 * authorize() and allowed() for the grant check, kill switch, audit row and
 * denial log; captureInput() for capture validation; createNote(), textDoc()
 * and toRow() for the insert. The queries and results are the same as
 * app/api/v1 (lib/mcp/operations.test.mjs runs both against the same data).
 * Only API keys and OAuth connections reach here, so every query runs with
 * the server role, filtered to the principal's user and authorized space.
 */

/** Database field names, as /api/v1/notes returns them. */
export const V1_NOTE_COLUMNS =
  "id,workspace_id,title,plain_text,bucket,tags,created_at,updated_at,completed_at,revision,kind,project_id,waiting_on,waiting_for,next_check_on";

export type ToolOutcome = { result: Record<string, unknown> } | { error: string };

/** A safe tool error from authorize()'s denial: the code and what to do, nothing else. */
async function denial(response: Response): Promise<ToolOutcome> {
  const body = (await response.json().catch(() => ({}))) as { code?: string; capability?: string };
  if (body.code === "agent_disabled")
    return { error: "agent_disabled: agent access is off for that workspace (or it doesn't exist). The user can turn it on in Orbit → Settings → Model & agent." };
  if (body.code === "capability_denied")
    return { error: `capability_denied: this connection has no ${body.capability === "item.write" ? "Capture" : "Read"} access in that workspace. The user can grant it in Orbit → Settings → Agents & API keys.` };
  return { error: "Orbit could not verify workspace access. Try again later." };
}

export async function listWorkspaces(auth: IntegrationAuth): Promise<ToolOutcome> {
  const granted = auth.principal.type === "agent_client" ? grantedWorkspaces(auth.principal.grants) : null;
  if (granted && granted.size === 0) {
    await allowed(auth, "workspace.list", null);
    return { result: { workspaces: [] } };
  }
  let query = auth.db.from("workspaces").select("id,name,color")
    .eq("user_id", auth.userId).eq("agent_enabled", true);
  if (granted) query = query.in("id", [...granted.keys()]);
  const { data, error } = await query.order("position");
  if (error) return { error: "Could not load workspaces" };
  await allowed(auth, "workspace.list", null);
  const rows = (data ?? []) as { id: string; name: string; color: string | null }[];
  return {
    result: {
      workspaces: rows.map((w) => ({ ...w,
        capabilities: granted ? [...new Set(granted.get(w.id) ?? [])].sort() : ["item.write", "workspace.read"] })),
    },
  };
}

export async function listNotes(auth: IntegrationAuth, args: Record<string, unknown>): Promise<ToolOutcome> {
  const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : "";
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const kind = args.kind ?? null;
  if (!uuid.test(workspaceId) || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100 ||
    !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 100000 || (kind !== null && !isItemKind(kind)))
    return { error: "Provide workspaceId, limit (1–100), offset (0–100000), and optionally a valid kind" };
  const denied = await authorize(auth, "workspace.read", workspaceId, "item.read");
  if (denied) return denial(denied);
  let select = auth.db.from("notes").select(V1_NOTE_COLUMNS)
    .eq("user_id", auth.userId).eq("workspace_id", workspaceId);
  if (kind) select = select.eq("kind", kind);
  const from = offset as number;
  const { data, error } = await select
    .order("updated_at", { ascending: false }).order("id").range(from, from + (limit as number) - 1);
  if (error) return { error: "Could not load notes" };
  await allowed(auth, "item.read", workspaceId);
  return { result: { notes: data, offset, limit } };
}

export async function captureNote(auth: IntegrationAuth, args: Record<string, unknown>): Promise<ToolOutcome> {
  const body = { workspaceId: args.workspaceId, title: args.title, text: args.text };
  if (!captureInput(body)) return { error: "Provide workspaceId, title (1–2000 characters), and text (up to 50000 characters)" };
  const denied = await authorize(auth, "item.write", body.workspaceId, "item.create");
  if (denied) return denial(denied);
  const note = createNote(body.title.trim(), "inbox", body.workspaceId);
  note.plainText = body.text;
  note.content = textDoc(body.text);
  // As /api/v1: create-only, a fresh id, revision 1, no kind, project or
  // follow-up fields, and user_id always the principal's.
  const {
    kind: _kind,
    project_id: _project,
    waiting_on: _waitingOn,
    waiting_for: _waitingFor,
    next_check_on: _nextCheckOn,
    ...row
  } = toRow(note, auth.userId);
  const { error } = await auth.db.from("notes").insert(row);
  if (error) return { error: "Could not capture note. Do not retry automatically; check the Inbox first." };
  await allowed(auth, "item.create", note.workspaceId, note.id);
  return { result: { id: note.id, workspaceId: note.workspaceId, bucket: note.bucket, revision: 1 } };
}

/** Runs one tool for an authenticated principal. */
export function runOrbitTool(auth: IntegrationAuth, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  switch (name) {
    case "orbit_list_workspaces": return listWorkspaces(auth);
    case "orbit_list_notes": return listNotes(auth, args);
    case "orbit_capture_note": return captureNote(auth, args);
    default: return Promise.resolve({ error: "Unknown tool" });
  }
}
