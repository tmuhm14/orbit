import { routeUser } from "@/lib/supabase/route-auth";
import { isAssignmentUuid, parseSaveDocument } from "@/lib/assignments/validation";
import { assignmentError, authFailure, readJsonBody } from "@/lib/assignments/server";
import { saveDocumentResponse } from "@/lib/assignments/documents";

/**
 * Saves the accepted result of a completed assignment as a document item
 * (ADR 003 §6) in one transaction: kind document, bucket reference, the
 * assignment's workspace, the artifact's title (or `title`), content and
 * plain text, and a project (`projectId`, or by default the source item if
 * it is a project, else the source item's project). Records the link on the
 * artifact and an `artifact_saved` event; the assignment's revision is
 * unchanged. Saving twice answers 409 `already_saved` with the first noteId.
 * Body `{ expectedRevision, artifactId, projectId?, title? }` →
 * 201 `{ note, assignment }`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return authFailure(auth.error);
  const { id } = await params;
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const parsed = parseSaveDocument(read.body);
  if (!isAssignmentUuid(id) || !parsed.ok) return assignmentError("invalid_payload");
  const { expectedRevision, artifactId, projectId, title } = parsed.value;
  const { data, error } = await auth.supabase.rpc("save_assignment_artifact_as_note", {
    p_id: id,
    p_expected_revision: expectedRevision,
    p_artifact_id: artifactId,
    p_options: {
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      ...(title !== undefined ? { title } : {}),
    },
  });
  return (error ? null : saveDocumentResponse(data)) ?? assignmentError("save_failed");
}
