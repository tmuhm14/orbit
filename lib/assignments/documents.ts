import "server-only";
import { json } from "@/lib/supabase/route-auth";
import { fromRow, type NoteRow } from "@/lib/notes-db";
import { assignmentError, assignmentResultResponse, fromAssignmentRow } from "./server";
import type { AssignmentAvailability } from "./types";

// U-05: saving an accepted result as a document item, and whether the
// built-in executor can run. Messages are fixed; nothing here logs or echoes
// titles, content or key material.

type SaveRaw = {
  status?: string;
  note?: NoteRow;
  assignment?: Record<string, unknown>;
  noteId?: string;
  code?: string;
};

const LINK_CODES = new Set(["invalid_project_link", "project_cycle", "project_depth_exceeded"]);

/**
 * The response for a save_assignment_artifact_as_note() result, or null for
 * an unexpected one (the caller answers save_failed). 201 `{ note, assignment }`
 * with the note in the `GET /api/notes` shape.
 */
export function saveDocumentResponse(raw: unknown): Response | null {
  const result = raw as SaveRaw | null;
  if (!result || typeof result !== "object" || typeof result.status !== "string") return null;
  switch (result.status) {
    case "created":
      if (!result.note || !result.assignment) return null;
      return json({ note: fromRow(result.note), assignment: fromAssignmentRow(result.assignment) }, 201);
    case "already_saved":
      return typeof result.noteId === "string"
        ? assignmentError("already_saved", { noteId: result.noteId })
        : null;
    case "invalid":
      return LINK_CODES.has(String(result.code))
        ? assignmentError(result.code as "invalid_project_link")
        : null;
    case "not_found":
    case "invalid_payload":
    case "conflict":
    case "invalid_transition":
    case "artifact_superseded":
      return assignmentResultResponse(raw);
    default:
      return null;
  }
}

/**
 * Availability from what the server read: the workspace switch, then whether
 * a model key is saved (`settings` null: none), then whether it decrypts.
 */
export function assignmentAvailability(
  agentEnabled: boolean,
  settings: { apiKey: string | null } | null,
): AssignmentAvailability {
  if (!agentEnabled) return { available: false, reason: "agent_disabled" };
  if (!settings) return { available: false, reason: "no_key" };
  if (!settings.apiKey) return { available: false, reason: "key_unreadable" };
  return { available: true };
}
