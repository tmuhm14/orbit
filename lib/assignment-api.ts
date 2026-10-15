// TODO(U-05 backend): switch to assignmentsClient once merged. The backend
// adds saveDocument(id, body), availability(workspaceId) and
// list({ sourceNoteId }) to lib/assignments/client.ts; until then this thin
// adapter calls the agreed routes directly with the same shapes, so the UI
// compiles and runs against either server. Failures throw the client's
// AssignmentApiError, so errorCodeOf() and the friendly copy keep working.
// Bodies are never logged.
import { AssignmentApiError } from "./assignments/client.ts";
import type { AssignmentState } from "./assignments/transitions.ts";
import type { Assignment, AssignmentErrorBody, AssignmentErrorCode } from "./assignments/types.ts";
import type { Note } from "./notes.ts";
import { parseAvailability, type Availability, type SaveDocumentBody } from "./agents-view.ts";

/** Extra fields the save-document errors carry. */
export type SaveDocumentErrorBody = AssignmentErrorBody & { noteId?: string };

type Fetch = typeof fetch;

async function call<T>(fetcher: Fetch, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, {
      ...init,
      credentials: "same-origin",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
  } catch {
    throw new AssignmentApiError(0, "network_error", "Could not reach Orbit");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = body as AssignmentErrorBody | null;
    if (error && typeof error.code === "string" && typeof error.error === "string")
      // New codes (already_saved, project_*) ride on the same error type.
      throw new AssignmentApiError(response.status, error.code as AssignmentErrorCode, error.error, error);
    throw new AssignmentApiError(response.status, "unexpected_response", "Unexpected response");
  }
  if (body === null) throw new AssignmentApiError(response.status, "unexpected_response", "Unexpected response");
  return body as T;
}

export type ListOptions = {
  sourceNoteId?: string;
  states?: readonly AssignmentState[];
  limit?: number;
};

export function assignmentApi(fetcher: Fetch = (...args) => fetch(...args)) {
  return {
    /** `GET /api/assignments`, newest first. `sourceNoteId` narrows to one item. */
    list: (workspaceId: string, options: ListOptions = {}) => {
      const query = new URLSearchParams({ workspaceId });
      if (options.sourceNoteId) query.set("sourceNoteId", options.sourceNoteId);
      if (options.states?.length) query.set("state", options.states.join(","));
      if (options.limit) query.set("limit", String(options.limit));
      return call<{ assignments: Assignment[] }>(fetcher, `/api/assignments?${query}`).then(
        (r) => r.assignments,
      );
    },

    /** Whether delegation can go ahead in this space; null when the server doesn't say. */
    availability: (workspaceId: string): Promise<Availability | null> =>
      call<unknown>(fetcher, `/api/assignments/availability?${new URLSearchParams({ workspaceId })}`).then(
        parseAvailability,
      ),

    /** Saves an accepted result as a Reference document: 201 `{ note, assignment }`. */
    saveDocument: (id: string, body: SaveDocumentBody) =>
      call<{ note: Note; assignment: Assignment }>(
        fetcher,
        `/api/assignments/${encodeURIComponent(id)}/save-document`,
        { method: "POST", body: JSON.stringify(body) },
      ),
  };
}

export type AssignmentApi = ReturnType<typeof assignmentApi>;

/** The existing note an `already_saved` error points at, if any. */
export function savedNoteIdOf(error: unknown): string | null {
  if (!(error instanceof AssignmentApiError)) return null;
  const noteId = (error.body as SaveDocumentErrorBody | null)?.noteId;
  return typeof noteId === "string" && noteId ? noteId : null;
}
