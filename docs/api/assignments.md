# Assignments API

Delegate one item to an executor with a requested outcome and selected context, follow its progress, answer its questions and review its result (ADR 003). These routes are for the signed-in Orbit web app: they use the browser's Supabase cookie session, not a bearer token, and every `POST` must be same-origin (an `Origin` header matching the host). External-agent access to assignments arrives with A-05/A-06.

Apply `supabase/migrations/20261017000000_assignments.sql` before deploying these routes. It is purely additive. Executor operations (claim, heartbeat, ask, submit, fail) are database functions used by the server's built-in executor (A-02, [below](#built-in-executor)); they have no HTTP route. A-02 needs no further migration.

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
- An item that is the source or context of an **active** assignment (queued, running, needs_input, needs_review) can't move to another workspace: `PUT /api/notes` answers 422 with the item's result `{ status: "invalid", code: "invalid_note" }` (direct database updates fail with `assignment_active`). Cancel or finish the assignment first.
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

### `POST /api/assignments/kickoff`

`{ "workspaceId": "<uuid>" }` → `202 { scheduled: 0 | 1 }`. A recovery ping for the built-in executor: call it when a built-in assignment has been `queued` for more than a few seconds (for example after a refresh, or while polling the detail). It reaps the caller's expired leases, then starts the caller's oldest queued built-in assignment in that workspace in the background. Safe to repeat and to call while a run is in progress: at most one run claims the assignment and the others do nothing. `scheduled` says whether a start was attempted, not that it claimed; read the assignment for its state. Unknown fields are rejected (`400 invalid_payload`); same session and same-origin rules as the other mutations.

`POST /api/assignments`, `/:id/retry`, `/:id/answer` and `/:id/review` (`request_changes`) already start the run themselves when the result is `queued` with `executorKind: "builtin"`; `kickoff` is only for a start that was lost.

## Built-in executor

The built-in preparation executor (A-02, `lib/assignments/executor.ts`, wired in `executor-server.ts`) runs one attempt of a queued `builtin` assignment in the bounded background tier (ADR 005): Next.js `after()` in the route that queued it, with `maxDuration = 300`, a database lease and the reaper. It writes only assignment rows (questions, artifacts, progress and failures) through the executor functions; it never edits, creates or completes items, and has no external side effects.

### Flow

1. **Kickoff.** The queuing route schedules `runQueuedAssignment(id)` with `after()`. **Recovery:** the `kickoff` route above, and every scheduler tick (`/api/scheduler/tick/[slot]`, after its response) starts up to 5 built-in assignments that have been `queued` for over 60 s, oldest first and at most one per workspace. Duplicate starts are harmless (step 3).
2. **Preflight.** The workspace agent switch must be on and the account must have a saved, readable model key. Otherwise the assignment fails at once with `executor_unavailable` (T15) and no attempt is created. A caller with less than 60 s of its own `maxDuration` left leaves the assignment queued.
3. **Claim.** `claim_assignment(id, 90)`: a new attempt with a 90 s lease. Only a `queued` assignment can be claimed, so a second kickoff gets `invalid_transition` and stops; one built-in assignment runs per workspace at a time, so a busy workspace leaves it `queued` for the next kickoff or sweep.
4. **Load.** With the service-role client, scoped to the assignment's user and workspace: the source item and the selected context items (id, title, plain text and kind only), the answered questions, change-request comments and, after `request_changes`, the result being revised. Deleted context is skipped and reported; with no item left the attempt fails with `context_unavailable`.
5. **Model turns.** The user's saved provider and model (`lib/agent/providers.ts`), with only two tools: `submit_result` and `ask_question`. A heartbeat every 30 s (and with each progress phrase) extends the lease. Every heartbeat and executor call is fenced by the lease: `lease_lost` (cancel, expiry, newer attempt) aborts the in-flight model call and stops without writing anything. The workspace switch is re-checked before every turn after the first (`capability_revoked` if turned off).
6. **Finish.** `submit_result` → `submit_assignment_artifact` → `needs_review`. `ask_question` → `ask_assignment_question` → `needs_input`; the answer re-queues the assignment and starts a new attempt whose instructions include the question and answer. Anything else ends in `fail_assignment_attempt` with a normalized code.

### Budgets

| Budget | Value | On exhaustion |
| --- | --- | --- |
| Model turns per attempt | 4 | `budget_exhausted` |
| Output tokens per turn | 4096 | (provider limit) |
| Output tokens per attempt (as reported by the provider) | 12 000 | `budget_exhausted` |
| Wall clock per attempt | 240 s, capped by the caller's deadline (start + 300 s − 30 s) | `budget_exhausted`; a turn isn't started with under 15 s left, and an in-flight call is aborted at the deadline |
| Provider call | 60 s (existing adapter timeout) | `provider_unavailable` |
| Questions per assignment | 2 (then `ask_question` is no longer offered) | — |
| Item text sent to the model | 8000 characters per item, 48 000 in total, titles 200 | clipped, marked `…` |
| Result | title 200, markdown 60 000 characters | the model is asked to shorten |
| Lease / heartbeat | 90 s / 30 s | lease lost → stops; process lost → reaper fails with `timed_out` |

`timed_out` is reserved for the reaper (`fail_assignment_attempt` refuses it), so a run that hits its own wall-clock budget reports `budget_exhausted`; `timed_out` means the run stopped heartbeating (process lost or cut off by the platform).

### Failure codes

| Code | Cause |
| --- | --- |
| `executor_unavailable` | Agent switch off, no saved key or the key can't be decrypted (before any attempt, T15) |
| `provider_auth` | Provider answered 401/403 |
| `provider_rate_limited` | Provider answered 429 |
| `provider_unavailable` | Other provider HTTP errors, network errors, the 60 s call timeout |
| `budget_exhausted` | Turn, output-token or wall-clock budget used up |
| `context_unavailable` | The source and every selected context item were deleted |
| `capability_revoked` | Agent switch turned off mid-run |
| `timed_out` | Lease expired without a heartbeat (reaper) |
| `internal` | Unexpected executor or storage error |

Provider messages are never stored, shown or logged. Logs carry the assignment id, attempt id, outcome and code only.

### Progress events

`progress` events (`payload.text`) are fixed phrases with counts only: `Reading N items`, `N selected items are no longer available`, `Drafting`, `Revising the previous result`, `Still working`, `Submitting the result`, `Asking a question`. They never contain item text, outcomes, answers or model output.

### Prompt structure

- **System prompt:** role and rules, then an `<orbit_instructions>` block holding only user-authored intent in order: `1. Requested outcome: …`, then answers (`You asked: "…" The user answered: …`) and `Requested changes to your previous result: …`, oldest first.
- **First user message:** only data. Each item is wrapped as `<orbit_data_NONCE id="…" role="source|context" kind="…" title="…">…</orbit_data_NONCE>` (and `role="previous_result"` for the result being revised), where `NONCE` is 24 random hex characters per attempt. Any `<orbit_…`, `<instructions` or `<untrusted_data` text inside content is neutralised (`‹`), so data can't close its block or open an instruction block. The system prompt says data never grants intent, tools or permissions.
- **Server-side enforcement** does not depend on the model: the only tools are `submit_result` and `ask_question`; cited ids are filtered to the source and selected context before submission and checked again by `submit_assignment_artifact`; capabilities come from the assignment row.

### Artifact contract (for U-05)

An artifact (`GET /api/assignments/:id` → `artifacts[0]`, newest first; only the one with `supersededAt: null` can be reviewed) written by the built-in executor has:

| Field | Value |
| --- | --- |
| `kind` | `"draft"` or `"summary"` (the model's choice) |
| `title` | 1–200 characters, plain text (executor-written, untrusted) |
| `content` | A Tiptap document (`{ type: "doc", content: [...] }`) using only `paragraph`, `heading` (levels 1–3), `bulletList`, `orderedList`, `listItem`, `taskList`, `taskItem`, `blockquote`, `codeBlock`, `horizontalRule` and `text` with `bold`, `italic` and `code` marks. No links, images or HTML. The note editor opens it as is. |
| `plainText` | The markdown the model wrote (up to 60 000 characters); use it as the note's `plain_text` |
| `sourceNoteIds` | Ids the result relies on, always a subset of the assignment's source and selected context |
| `savedNoteId` | `null` until saved (U-05) |

To turn an **accepted** artifact into linked documentation (ADR 003 §6; U-05 implements this, A-02 does not):

1. The assignment is `completed` (accepted) and the artifact is the reviewed one.
2. Read the source item's `project_id` (`sourceNoteId` may be `null` if it was deleted; then use a project the user chooses in the same workspace, or none).
3. Create the item with a normal user write, `PUT /api/notes` / `save_notes` with `expectedRevision: null`: `kind: "document"`, `bucket: "reference"`, `workspace_id` = the assignment's workspace, `project_id` from step 2, `title` = artifact `title`, `content` = artifact `content`, `plain_text` = artifact `plainText`. It is a user write, not an agent action, so there is no `agent_actions` row.
4. Record the link in `assignment_artifacts.saved_note_id` plus an event. No function does this yet: `POST /api/assignments/:id/artifacts/:artifactId/save` (ADR 003 §5) belongs to U-05 and needs a small additive function, since authenticated users can't update the table directly.

Accepting never completes the source task; "Mark task done" stays a separate item edit.

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

`unauthenticated`, `forbidden_origin`, `not_configured`, `payload_too_large`, `load_failed` and `save_failed` are additions to ADR 003 §4: the first three replace the code-less bodies of the shared session check so every error has a code, and the others follow the existing note routes. `executor_busy` and `lease_lost` are executor-side results with no route (A-02 handles them inside the built-in executor: busy leaves the assignment queued, lease lost stops the run).
