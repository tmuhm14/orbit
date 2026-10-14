import { integrationUser, reply } from "@/lib/integrations/auth";
import { captureInput, uuid } from "@/lib/integrations/validation";
import { createNote, textDoc } from "@/lib/notes";
import { toRow } from "@/lib/notes-db";

async function allowed(auth: Exclude<Awaited<ReturnType<typeof integrationUser>>, { error: Response }>, id: string) {
  const { data, error } = await auth.supabase.from("workspaces").select("id")
    .eq("id", id).eq("user_id", auth.user.id).eq("agent_enabled", true).maybeSingle();
  return error ? reply({ error: "Could not verify workspace access" }, 500) :
    !data ? reply({ error: "Workspace unavailable or agent access disabled" }, 403) : null;
}

export async function GET(request: Request) {
  const auth = await integrationUser(request);
  if ("error" in auth) return auth.error;
  const query = new URL(request.url).searchParams;
  const workspaceId = query.get("workspaceId") ?? "";
  const limit = Number(query.get("limit") ?? 50);
  const offset = Number(query.get("offset") ?? 0);
  if (!uuid.test(workspaceId) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
    !Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
    return reply({ error: "Provide workspaceId, limit (1–100), and offset (0–100000)" }, 400);
  const denied = await allowed(auth, workspaceId);
  if (denied) return denied;
  const { data, error } = await auth.supabase.from("notes")
    .select("id,workspace_id,title,plain_text,bucket,tags,created_at,updated_at,completed_at,revision")
    .eq("user_id", auth.user.id).eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false }).order("id").range(offset, offset + limit - 1);
  if (error) return reply({ error: "Could not load notes" }, 500);
  return reply({ notes: data, offset, limit });
}

export async function POST(request: Request) {
  const auth = await integrationUser(request);
  if ("error" in auth) return auth.error;
  // Bound the body before parsing; content-length is not trusted.
  const reader = request.body?.getReader();
  if (!reader) return reply({ error: "JSON body required" }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 250000) { await reader.cancel(); return reply({ error: "Body too large" }, 413); }
    chunks.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return reply({ error: "Invalid JSON" }, 400); }
  if (!captureInput(body)) return reply({ error: "Provide workspaceId, title (1–2000 characters), and text (up to 50000 characters)" }, 400);
  const denied = await allowed(auth, body.workspaceId);
  if (denied) return denied;
  const note = createNote(body.title.trim(), "inbox", body.workspaceId);
  note.plainText = body.text;
  note.content = textDoc(body.text);
  // Create-only: a fresh id, and the revision trigger starts every insert at 1.
  // Before direct writes are revoked (ADR 002 phase C′) this moves to
  // save_notes() with expected_revision null.
  const { error } = await auth.supabase.from("notes").insert(toRow(note, auth.user.id));
  if (error) return reply({ error: "Could not capture note" }, 500);
  return reply({ id: note.id, workspaceId: note.workspaceId, bucket: note.bucket, revision: 1 }, 201);
}
