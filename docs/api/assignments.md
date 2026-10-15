# Assignments API

Delegate one item to an executor with a requested outcome and selected context, follow its progress, answer its questions and review its result (ADR 003). These routes are for the signed-in Orbit web app: they use the browser's Supabase cookie session, not a bearer token, and every `POST` must be same-origin (an `Origin` header matching the host). External-agent access to assignments arrives with A-05/A-06.

Apply `supabase/migrations/20261017000000_assignments.sql` before deploying these routes. It is purely additive. Executor operations (claim, heartbeat, ask, submit, fail) are database functions for the server's built-in executor (A-02) and have no HTTP route yet.

The OpenAPI description is under `/api/assignments` in `openapi.json` (security `cookieSession`).

## Lifecycle

States: `queued`, `running`, `needs_input`, `needs_review`, `completed`, `failed`, `canceled`. `completed` and `canceled` are terminal; `failed` is terminal unless the user retries. The database enforces this table; `lib/assignments/transitions.ts` mirrors it for UI hints.

| # | From | To | Actor | How |
| --- | --- | --- | --- | --- |
| T1 | queued | running | executor | claim |
| T2 | queued | canceled | user | `POST /:id/cancel` |
| T3 | running | needs_input | executor | ask a question |
| T4 | running | needs_review | executor | submit a result |
| T5 | running | failed | executor | give up with a normalized code |
| T6 | running | failed | system | lease expired (`timed_out`) |
| T7 | running | queued | system | lease expired with attempts left (not used before A-04) |
| T8 | running | canceled | user | `POST /:id/cancel` |
| T9 | needs_input | queued | user | `POST /:id/answer` |
| T10 | needs_input | canceled | user | `POST /:id/cancel` |
| T11 | needs_review | completed | user | `POST /:id/review` `accept` |
| T12 | needs_review | queued | user | `POST /:id/review` `request_changes` |
| T13 | needs_review | canceled | user | `POST /:id/review` `reject` |
| T14 | failed | queued | user | `POST /:id/retry` |
| T15 | queued | failed | system | executor unavailable (`executor_unavailable`) |
| T16 | needs_input, needs_review | failed | system | capability revoked |

Rules:

- Any item kind can be delegated. An item has at most one assignment in `queued`, `running`, `needs_input` or `needs_review`.
- **Accepting never completes the source item.** Marking it done is a separate, ordinary item edit.
- Cancel takes effect at once. A running attempt loses its lease in the same transaction, so the executor can't write anything afterwards. A result waiting for review is declined with `reject` rather than cancel, so the decision is recorded.
- Before durable execution, a lease that expires without a heartbeat ends in `failed` with `timed_out`. The list and detail routes reap the caller's expired leases first; the scheduler tick reaps everyone's once a day (slot 04). Queued built-in work in a workspace whose agent switch is off, or with no saved model key, fails with `executor_unavailable`; retry once the agent is available again.
- Artifacts (results) are kept after accept, reject or cancel. Only the newest one can be reviewed.
- Every state change bumps `revision` and appends a `state_changed` event. Mutations take `expectedRevision` and fail with `revision_conflict` if it is stale.

## Intent and context

- The **requested outcome**, **question answers** and **request-changes comments** are written by the user and are the only instructions an executor may act on (`assignmentIntent()` in `lib/assignments/client.ts`).
- The source item and the selected context items are captured content. They are stored with `contentRole: "untrusted_data"` and are data, never instructions. The same applies to executor-written text (questions, progress, artifacts): render it as untrusted.
- Context is only what the user selected: up to **20** distinct items from the assignment's workspace, not including the source item. The revision of each item at selection time is kept. A deleted item stays in the list with `noteId: null`.
- An item that is the source or context of an **active** assignment (queued, running, needs_input, needs_review) can't move to another workspace: `PUT /api/notes` answers 422 with the item's result `{ status: "invalid", code: "assignment_active" }` (direct database updates fail with the message `assignment_active`). Cancel or finish the assignment first.
- Moving an item used only by **finished** assignments (completed, failed, canceled) succeeds. Those assignments detach from it: `sourceNoteId` or the context item's `noteId` becomes `null`, everything else (outcome, context position and revision, attempts, events, questions, artifacts, reviews) is kept, and an `item_detached` event (`payload: { noteId, role: "source" | "context" }`) is appended. Deleting an item is allowed either way and detaches it the same way, without the event.

## Routes

All responses are `Cache-Control: private, no-store`. Ids are UUIDs.

### `POST /api/assignments`

```json
{ "workspaceId": "<uuid>", "sourceNoteId": "<uuid>", "requestedOutcome": "Draft a reply to the vendor",
  "contextNoteIds": ["<uuid>"], "executor": "builtin" }
```

`requestedOutcome` is trimmed, 1–4000 characters. `contextNoteIds` is optional (default `[]`). `executor` is optional and must be `"builtin"`. Unknown fields are rejected. The workspace must have the agent switch on and the account a saved model key. → `201 { assignment }` in `queued`.

### `GET /api/assignments?workspaceId=<uuid>[&state=queued,running][&limit=50]`

→ `{ assignments: Assignment[] }`, newest first, no artifact content. `state` is a comma-separated list of states; `limit` is 1–100.

### `GET /api/assignments/:id`

→ `{ assignment, context, attempts, events, questions, artifacts, reviews }`: context in selection order; attempts by number (no lease tokens); up to 500 events, oldest first; questions oldest first; up to 20 artifacts, newest first, with content; reviews oldest first.

### `POST /api/assignments/:id/cancel` and `POST /api/assignments/:id/retry`

`{ "expectedRevision": 3 }` → `{ assignment }`.

### `POST /api/assignments/:id/answer`

`{ "expectedRevision": 3, "questionId": "<uuid>", "answer": "Use the formal tone" }` (1–4000 characters) → `{ assignment }` in `queued`.

### `POST /api/assignments/:id/review`

`{ "expectedRevision": 5, "artifactId": "<uuid>", "decision": "accept" | "request_changes" | "reject", "comment": "Shorter, please" }`. `comment` (up to 4000 characters) is required for `request_changes`. → `{ assignment, reviewId }`.

## Shapes

```ts
Assignment = { id, workspaceId, sourceNoteId: string | null, requestedOutcome, executorKind: "builtin" | "external",
  capabilities: string[], state, revision, currentAttemptId: string | null, maxAttempts, errorCode: string | null,
  createdAt, updatedAt, stateChangedAt, finishedAt: string | null }
ContextItem = { noteId: string | null, position, revisionAtSelection, contentRole: "untrusted_data" }
Attempt = { id, attemptNumber, status: "running" | "succeeded" | "waiting" | "failed" | "canceled" | "expired",
  leaseExpiresAt, heartbeatAt, provider, model, errorCode, startedAt, finishedAt }
Event = { id: string, attemptId, type, actor: "user" | "executor" | "system", fromState, toState, payload, createdAt }
Question = { id, attemptId, prompt, answer, askedAt, answeredAt, closedAt }
Artifact = { id, attemptId, kind: "draft" | "summary", title, content /* Tiptap doc */, plainText, sourceNoteIds,
  savedNoteId, supersededAt, createdAt }
Review = { id, artifactId, decision, comment, decidedAt }
```

Event types: `state_changed`, `progress` (`payload.text`, up to 280 characters of executor text), `question_asked`, `question_answered`, `artifact_submitted`, `review_decided`, `cancel_requested`, `context_unavailable`, `item_detached`. Payloads hold ids, codes and progress text only.

`errorCode` on a failed assignment is one of `provider_auth`, `provider_rate_limited`, `provider_unavailable`, `budget_exhausted`, `timed_out`, `context_unavailable`, `capability_revoked`, `executor_unavailable`, `internal`.

## Errors

Every error body is `{ error, code }`. `error` is a fixed message that never contains outcomes, questions, answers, comments, results or item content.

| HTTP | `code` | When | Extra fields |
| --- | --- | --- | --- |
| 400 | `invalid_payload` | Shape, limits, bad id or JSON | |
| 401 | `unauthenticated` | No session | |
| 403 | `forbidden_origin` | Mutation without a same-origin `Origin` header | |
| 403 | `capability_denied` | Executor or capability outside the current policy | |
| 403 | `agent_disabled` | Agent switch off for the workspace, or no saved model key | |
| 404 | `not_found` | Assignment, item, question, artifact or workspace doesn't exist **or isn't yours** | |
| 409 | `revision_conflict` | `expectedRevision` is stale | `currentRevision`, `state` |
| 409 | `invalid_transition` | Not allowed from the current state | `from`, `to`, `allowed` (targets the table allows for the user from `from`) |
| 409 | `active_assignment_exists` | The item already has an active assignment (create, retry) | `assignmentId` |
| 409 | `artifact_superseded` | Reviewing a result that a newer one replaced | |
| 413 | `payload_too_large` | Body over 32 KiB | |
| 422 | `invalid_context` | A context id isn't one of your items in the workspace, or is the source item | |
| 500 | `load_failed` / `save_failed` | Storage error | |
| 503 | `not_configured` | Server auth not configured | |

`unauthenticated`, `forbidden_origin`, `not_configured`, `payload_too_large`, `load_failed` and `save_failed` are additions to ADR 003 §4: the first three replace the code-less bodies of the shared session check so every error has a code, and the others follow the existing note routes. `executor_busy` and `lease_lost` are executor-side results with no route in A-01.
