import { routeUser, json } from "@/lib/supabase/route-auth";
import { isAssignmentUuid } from "@/lib/assignments/validation";
import {
  ARTIFACT_COLUMNS,
  ASSIGNMENT_COLUMNS,
  ATTEMPT_COLUMNS,
  CONTEXT_COLUMNS,
  DETAIL_ARTIFACT_LIMIT,
  DETAIL_EVENT_LIMIT,
  EVENT_COLUMNS,
  QUESTION_COLUMNS,
  REVIEW_COLUMNS,
  assignmentError,
  authFailure,
  fromArtifactRow,
  fromAssignmentRow,
  fromAttemptRow,
  fromContextRow,
  fromEventRow,
  fromQuestionRow,
  fromReviewRow,
} from "@/lib/assignments/server";

type Rows = Record<string, unknown>[];

/**
 * One of the user's assignments with its context, attempts (never lease
 * tokens), events, questions, artifacts (newest first) and reviews.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await routeUser(request);
  if ("error" in auth) return authFailure(auth.error);
  const { id } = await params;
  if (!isAssignmentUuid(id)) return assignmentError("invalid_payload");
  const db = auth.supabase;
  await db.rpc("reap_own_assignment_leases").then(
    () => undefined,
    () => undefined,
  );
  const { data: row, error } = await db
    .from("assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .maybeSingle<Record<string, unknown>>();
  if (error) return assignmentError("load_failed");
  if (!row) return assignmentError("not_found");
  const children = (table: string, columns: string) =>
    db.from(table).select(columns).eq("assignment_id", id).eq("user_id", auth.user.id);
  const [context, attempts, events, questions, artifacts, reviews] = await Promise.all([
    children("assignment_context_items", CONTEXT_COLUMNS).order("position").returns<Rows>(),
    children("assignment_attempts", ATTEMPT_COLUMNS).order("attempt_number").returns<Rows>(),
    children("assignment_events", EVENT_COLUMNS)
      .order("id")
      .limit(DETAIL_EVENT_LIMIT)
      .returns<Rows>(),
    children("assignment_questions", QUESTION_COLUMNS).order("asked_at").returns<Rows>(),
    children("assignment_artifacts", ARTIFACT_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(DETAIL_ARTIFACT_LIMIT)
      .returns<Rows>(),
    children("assignment_reviews", REVIEW_COLUMNS).order("decided_at").returns<Rows>(),
  ]);
  if ([context, attempts, events, questions, artifacts, reviews].some((r) => r.error || !r.data))
    return assignmentError("load_failed");
  return json({
    assignment: fromAssignmentRow(row),
    context: context.data!.map(fromContextRow),
    attempts: attempts.data!.map(fromAttemptRow),
    events: events.data!.map(fromEventRow),
    questions: questions.data!.map(fromQuestionRow),
    artifacts: artifacts.data!.map(fromArtifactRow),
    reviews: reviews.data!.map(fromReviewRow),
  });
}
