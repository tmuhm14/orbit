import { routeUser, json } from "@/lib/supabase/route-auth";
import { isUuid } from "@/lib/notes";
import { deleteResponse, parseExpectedRevision } from "@/lib/notes-db";
import {
  notesMinClient,
  notesRevisionEnforcement,
  recordLegacyWrite,
} from "@/lib/server-config";

/**
 * Deletes one of the user's notes if it is still at ?expectedRevision=n
 * (ADR 002 §3). Without a revision it is a legacy delete, refused in enforce.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const expected = parseExpectedRevision(
    new URL(request.url).searchParams.get("expectedRevision"),
  );
  if (!isUuid(id) || expected === "invalid")
    return json({ error: "Invalid request", code: "invalid_payload" }, 400);
  const enforcement = notesRevisionEnforcement();
  const legacy = expected === undefined;
  recordLegacyWrite({
    writer: "W2",
    route: "DELETE /api/notes/:id",
    count: legacy ? 1 : 0,
    outcome: enforcement === "enforce" ? "rejected" : "accepted",
  });
  const { data, error } = await auth.supabase.rpc("delete_note", {
    p_id: id,
    p_expected_revision: expected ?? null,
    p_require_revision: enforcement === "enforce",
  });
  const result = error
    ? null
    : deleteResponse(data, id, { includeCurrent: true, legacy });
  if (!result)
    return json({ error: "Could not delete note", code: "delete_failed" }, 500);
  const response = json(result.body, result.status);
  response.headers.set("X-Orbit-Min-Client", String(notesMinClient()));
  return response;
}
