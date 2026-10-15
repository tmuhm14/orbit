import type { AssignmentState } from "./transitions";
import type {
  Assignment,
  AssignmentDetail,
  AssignmentErrorBody,
  AssignmentErrorCode,
  CreateAssignmentInput,
  ReviewDecision,
} from "./types";

// Typed browser client for /api/assignments (same-origin, cookie session).
// Failures throw AssignmentApiError with the route's status and code; the
// message is the route's fixed text, never request content.

export class AssignmentApiError extends Error {
  readonly status: number;
  readonly code: AssignmentErrorCode | "network_error" | "unexpected_response";
  readonly body: AssignmentErrorBody | null;
  constructor(
    status: number,
    code: AssignmentApiError["code"],
    message: string,
    body: AssignmentErrorBody | null = null,
  ) {
    super(message);
    this.name = "AssignmentApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

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
      throw new AssignmentApiError(response.status, error.code, error.error, error);
    throw new AssignmentApiError(response.status, "unexpected_response", "Unexpected response");
  }
  if (body === null) throw new AssignmentApiError(response.status, "unexpected_response", "Unexpected response");
  return body as T;
}

const post = <T>(fetcher: Fetch, path: string, body: unknown) =>
  call<T>(fetcher, path, { method: "POST", body: JSON.stringify(body) });
const at = (id: string, action = "") =>
  `/api/assignments/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

export function assignmentsClient(fetcher: Fetch = (...args) => fetch(...args)) {
  return {
    create: (input: CreateAssignmentInput) =>
      post<{ assignment: Assignment }>(fetcher, "/api/assignments", input).then((r) => r.assignment),

    list: (workspaceId: string, options: { states?: AssignmentState[]; limit?: number } = {}) => {
      const query = new URLSearchParams({ workspaceId });
      if (options.states?.length) query.set("state", options.states.join(","));
      if (options.limit) query.set("limit", String(options.limit));
      return call<{ assignments: Assignment[] }>(fetcher, `/api/assignments?${query}`).then(
        (r) => r.assignments,
      );
    },

    get: (id: string) => call<AssignmentDetail>(fetcher, at(id)),

    cancel: (id: string, expectedRevision: number) =>
      post<{ assignment: Assignment }>(fetcher, at(id, "cancel"), { expectedRevision }).then(
        (r) => r.assignment,
      ),

    retry: (id: string, expectedRevision: number) =>
      post<{ assignment: Assignment }>(fetcher, at(id, "retry"), { expectedRevision }).then(
        (r) => r.assignment,
      ),

    answer: (id: string, expectedRevision: number, questionId: string, answer: string) =>
      post<{ assignment: Assignment }>(fetcher, at(id, "answer"), {
        expectedRevision,
        questionId,
        answer,
      }).then((r) => r.assignment),

    review: (
      id: string,
      expectedRevision: number,
      artifactId: string,
      decision: ReviewDecision,
      comment?: string,
    ) =>
      post<{ assignment: Assignment; reviewId: string }>(fetcher, at(id, "review"), {
        expectedRevision,
        artifactId,
        decision,
        ...(comment === undefined ? {} : { comment }),
      }),
  };
}

export type AssignmentsClient = ReturnType<typeof assignmentsClient>;

/**
 * The only instructions an executor may act on, oldest first: the requested
 * outcome, then answers and change requests. Item content is never intent.
 */
export function assignmentIntent(detail: Pick<AssignmentDetail, "assignment" | "questions" | "reviews">) {
  const answers = detail.questions
    .filter((q) => q.answer !== null && q.answeredAt !== null)
    .map((q) => ({ kind: "answer" as const, text: q.answer as string, at: q.answeredAt as string }));
  const changes = detail.reviews
    .filter((r) => r.decision === "request_changes" && r.comment)
    .map((r) => ({ kind: "change_request" as const, text: r.comment as string, at: r.decidedAt }));
  return [
    { kind: "outcome" as const, text: detail.assignment.requestedOutcome, at: detail.assignment.createdAt },
    ...[...answers, ...changes].sort((a, b) => a.at.localeCompare(b.at)),
  ];
}
