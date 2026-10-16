import { allowed, authorize, integrationAuth, reply } from "@/lib/integrations/auth";
import { captureInput, uuid } from "@/lib/integrations/validation";
import { createNote, isItemKind, textDoc } from "@/lib/notes";
import { toRow } from "@/lib/notes-db";

/** Database field names; additive, so this stays /api/v1. */
const V1_COLUMNS =
  "id,workspace_id,title,plain_text,bucket,tags,created_at,updated_at,completed_at,revision,kind,project_id,waiting_on,waiting_for,next_check_on";

/** Reading notes needs workspace.read in that workspace (ADR 004). */
export async function GET(request: Request) {
  const auth = await integrationAuth(request, "item.read");
  if ("error" in auth) return auth.error;
  const query = new URL(request.url).searchParams;
  const workspaceId = query.get("workspaceId") ?? "";
  const limit = Number(query.get("limit") ?? 50);
  const offset = Number(query.get("offset") ?? 0);
  const kind = query.get("kind");
  if (!uuid.test(workspaceId) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
    !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || (kind !== null && !isItemKind(kind)))
    return reply({ error: "Provide workspaceId, limit (1–100), offset (0–100000), and optionally a valid kind" }, 400, auth.headers);
  const denied = await authorize(auth, "workspace.read", workspaceId, "item.read");
  if (denied) return denied;
  let select = auth.db.from("notes").select(V1_COLUMNS)
    .eq("user_id", auth.userId).eq("workspace_id", workspaceId);
  if (kind) select = select.eq("kind", kind);
  const { data, error } = await select
    .order("updated_at", { ascending: false }).order("id").range(offset, offset + limit - 1);
  if (error) return reply({ error: "Could not load notes" }, 500, auth.headers);
  await allowed(auth, "item.read", workspaceId);
  return reply({ notes: data, offset, limit }, 200, auth.headers);
}

/** Capture needs item.write {create} in that workspace. */
export async function POST(request: Request) {
  const auth = await integrationAuth(request, "item.create");
  if ("error" in auth) return auth.error;
  // Bound the body before parsing; content-length is not trusted.
  const reader = request.body?.getReader();
  if (!reader) return reply({ error: "JSON body required" }, 400, auth.headers);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 250000) { await reader.cancel(); return reply({ error: "Body too large" }, 413, auth.headers); }
    chunks.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return reply({ error: "Invalid JSON" }, 400, auth.headers); }
  if (!captureInput(body)) return reply({ error: "Provide workspaceId, title (1–2000 characters), and text (up to 50000 characters)" }, 400, auth.headers);
  const denied = await authorize(auth, "item.write", body.workspaceId, "item.create");
  if (denied) return denied;
  const note = createNote(body.title.trim(), "inbox", body.workspaceId);
  note.plainText = body.text;
  note.content = textDoc(body.text);
  // Create-only: a fresh id, and the revision trigger starts every insert at 1.
  // Before direct writes are revoked (ADR 002 phase C′) this moves to
  // save_notes() with expected_revision null. Captures never send kind or
  // project_id; the column defaults make them unlinked notes (ADR 001 §2).
  // Nor follow-up fields: a capture starts without one (ADR 001 §4).
  // user_id is always the authenticated user's: for API keys the insert runs
  // with the server role, and the workspace foreign key ties it to that user.
  const {
    kind: _kind,
    project_id: _project,
    waiting_on: _waitingOn,
    waiting_for: _waitingFor,
    next_check_on: _nextCheckOn,
    ...row
  } = toRow(note, auth.userId);
  const { error } = await auth.db.from("notes").insert(row);
  if (error) return reply({ error: "Could not capture note" }, 500, auth.headers);
  await allowed(auth, "item.create", note.workspaceId, note.id);
  return reply({ id: note.id, workspaceId: note.workspaceId, bucket: note.bucket, revision: 1 }, 201, auth.headers);
}
