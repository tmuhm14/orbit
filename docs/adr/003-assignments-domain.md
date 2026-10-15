# 003 — Assignments: delegated outcome work, separate from organizing runs

- **Status:** Accepted — approved by Tony, 2026-10-13
- **Date:** 2026-10-13
- **Ticket:** O-01 (contract for A-01; consumed by A-02, U-04, U-05, A-04, A-06)
- **Deciders:** Tony (Solutions Architect)
- **Related:** ADR 001 (items, composite ownership key), ADR 002 (revisions), ADR 004 (capabilities), ADR 005 (runtime)

## Context

The only agent work today is the **organizing agent** (`supabase/migrations/20261010000000_agent.sql`, `lib/agent/`):

- `agent_runs` — one row per triage/organize pass over a workspace: `trigger in ('capture', 'manual')`, `mode in ('triage', 'organize')`, `status in ('running', 'done', 'failed')`, `summary`, `error`. Started by `POST /api/agent/runs` or `triageCaptures()` after Slack/email capture, executed with `after()`.
- `agent_actions` — the item changes a run made, with `before`/`after` for undo.
- `runAgent()` (`lib/agent/agent.ts`) is a bounded tool loop (16 steps, 60 writes) with tools `list_notes`, `get_note`, `update_note`, `create_note`. The system prompt already treats note content as untrusted.
- A "timed out" run is detected lazily: `GET /api/agent/runs` marks runs older than `RUN_TIMEOUT_MS` (6 min) as failed. There are no questions, results, reviews, retries, leases or cancellation.

The plan's first-release workflow needs something different: the user delegates *one task* with a requested outcome and selected context; the executor may ask a question; it produces a result that the user reviews; an accepted result can be saved as linked documentation. The original task is **not** completed automatically.

Organizing runs are workspace housekeeping and mutate items directly. Assignments produce *proposed* artifacts and do not mutate items in the first release. Their lifecycles differ (organizing runs have no `needs_input` or `needs_review`), so stretching `agent_runs` would weaken both.

## Decision

### 1. Tables (migration `20261017000000_assignments.sql`, A-01)

All tables carry `user_id` and `workspace_id` with composite FKs to `workspaces (id, user_id)`, and reference items through `notes_id_workspace_user_key` (ADR 001), so an assignment, its source task and its context are guaranteed to share one owner and workspace. RLS: owner `select` on every table; **no direct insert/update/delete** for `authenticated`. All writes go through functions (§5).

```sql
create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  source_note_id uuid,                                   -- the task being delegated; null only after the task is deleted
  requested_outcome text not null
    check (char_length(btrim(requested_outcome)) between 1 and 4000),   -- the only text that grants intent
  executor_kind text not null default 'builtin' check (executor_kind in ('builtin', 'external')),
  executor_id uuid,                                      -- agent client id (ADR 004 / A-05); null for builtin
  capabilities text[] not null default '{workspace.read,assignment.execute}',
  context_scope text not null default 'selected' check (context_scope in ('selected')),
  state text not null default 'queued' check (state in
    ('queued', 'running', 'needs_input', 'needs_review', 'completed', 'failed', 'canceled')),
  revision bigint not null default 1,                    -- same contract as ADR 002
  current_attempt_id uuid,
  max_attempts smallint not null default 1 check (max_attempts between 1 and 5),
  error_code text,                                       -- normalized (§4); null unless failed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (id, workspace_id, user_id),                    -- target for child-table composite FKs
  constraint assignments_workspace_fk foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id) on delete cascade,
  constraint assignments_source_fk foreign key (source_note_id, workspace_id, user_id)
    references public.notes (id, workspace_id, user_id) on update restrict on delete set null (source_note_id)
);

create table public.assignment_context_items (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  user_id uuid not null, workspace_id uuid not null,
  note_id uuid,                                          -- null after the item is deleted
  revision_at_selection bigint not null,                 -- what the user selected
  -- Both FKs share workspace_id/user_id, so context must live in the assignment's workspace.
  constraint assignment_context_assignment_fk foreign key (assignment_id, workspace_id, user_id)
    references public.assignments (id, workspace_id, user_id) on delete cascade,
  constraint assignment_context_note_fk foreign key (note_id, workspace_id, user_id)
    references public.notes (id, workspace_id, user_id) on update restrict on delete set null (note_id)
);
create unique index assignment_context_unique on public.assignment_context_items (assignment_id, note_id)
  where note_id is not null;

create table public.assignment_attempts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  user_id uuid not null,
  attempt_number smallint not null,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'waiting', 'failed', 'canceled', 'expired')),
  lease_token uuid not null default gen_random_uuid(),   -- fencing token; never logged
  lease_expires_at timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  provider text, model text,                             -- builtin executor only
  usage jsonb,                                           -- token/step counts, no content
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (assignment_id, attempt_number)
);
create unique index assignment_one_running_attempt
  on public.assignment_attempts (assignment_id) where status = 'running';

create table public.assignment_events (                  -- append-only
  id bigint generated always as identity primary key,
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  attempt_id uuid references public.assignment_attempts (id) on delete set null,
  user_id uuid not null,
  type text not null check (type in ('state_changed', 'progress', 'question_asked', 'question_answered',
    'artifact_submitted', 'review_decided', 'cancel_requested', 'context_unavailable')),
  actor text not null check (actor in ('user', 'executor', 'system')),
  from_state text, to_state text,
  payload jsonb not null default '{}' check (pg_column_size(payload) <= 8192),  -- ids, codes, short progress text
  created_at timestamptz not null default now()
);

create table public.assignment_questions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  attempt_id uuid not null references public.assignment_attempts (id),
  user_id uuid not null,
  prompt text not null check (char_length(prompt) <= 2000),
  answer text check (char_length(answer) <= 4000),              -- user-authored, grants intent
  asked_at timestamptz not null default now(),
  answered_at timestamptz
);
create unique index assignment_one_open_question
  on public.assignment_questions (assignment_id) where answered_at is null;

create table public.assignment_artifacts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  attempt_id uuid not null references public.assignment_attempts (id),
  user_id uuid not null,
  kind text not null check (kind in ('draft', 'summary')),
  title text not null check (char_length(title) <= 200),
  content jsonb not null,                                       -- Tiptap doc, same limits as notes
  plain_text text not null default '',
  source_note_ids uuid[] not null default '{}',                 -- context items the executor cited
  saved_note_id uuid,                                           -- document item created from it (§6)
  superseded_at timestamptz,                                    -- set when a newer artifact replaces it
  created_at timestamptz not null default now()
);

create table public.assignment_reviews (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  artifact_id uuid not null references public.assignment_artifacts (id),
  user_id uuid not null,
  decision text not null check (decision in ('accept', 'request_changes', 'reject')),
  comment text check (char_length(comment) <= 4000),            -- user-authored, grants intent
  decided_at timestamptz not null default now()
);

create table public.assignment_transitions (               -- reference data, seeded below
  from_state text not null, to_state text not null,
  actor text not null check (actor in ('user', 'executor', 'system')),
  primary key (from_state, to_state, actor)
);
```

Appending is enforced: `assignment_events` has no update/delete grants, and a trigger rejects `update`/`delete` even for `service_role`, except for the `on delete cascade` from an assignment or account. `assignments` has a `before update of state` trigger that rejects any `(old.state, new.state, actor)` not in `assignment_transitions` (actor passed through a transaction-local setting by the functions in §5).

### 2. States and transition table

States: `queued`, `running`, `needs_input`, `needs_review`, `completed`, `failed`, `canceled`. Terminal: `completed`, `canceled`. `failed` is terminal unless the user retries.

| # | From | To | Actor | Trigger | Side effects (same transaction) |
| --- | --- | --- | --- | --- | --- |
| T1 | `queued` | `running` | executor | Claim | New attempt (`running`, lease), `current_attempt_id` set |
| T2 | `queued` | `canceled` | user | Cancel | `finished_at` |
| T3 | `running` | `needs_input` | executor | Ask question | Open `assignment_questions` row; attempt → `waiting` |
| T4 | `running` | `needs_review` | executor | Submit result | `assignment_artifacts` row; earlier artifacts `superseded_at`; attempt → `succeeded` |
| T5 | `running` | `failed` | executor | Error or budget exhausted | Attempt → `failed`, normalized `error_code` |
| T6 | `running` | `failed` | system | Lease expired and attempts exhausted | Attempt → `expired`, `error_code = 'timed_out'` |
| T7 | `running` | `queued` | system | Lease expired with attempts remaining (A-04 only) | Attempt → `expired` |
| T8 | `running` | `canceled` | user | Cancel | Attempt → `canceled`; lease revoked immediately (fencing) |
| T9 | `needs_input` | `queued` | user | Answer question | Question answered; new attempt on next claim |
| T10 | `needs_input` | `canceled` | user | Cancel | Open question closed unanswered |
| T11 | `needs_review` | `completed` | user | Accept | `assignment_reviews` (`accept`) |
| T12 | `needs_review` | `queued` | user | Request changes | `assignment_reviews` (`request_changes`, comment required) |
| T13 | `needs_review` | `canceled` | user | Reject | `assignment_reviews` (`reject`) |
| T14 | `failed` | `queued` | user | Retry | `error_code` cleared; `max_attempts` budget resets |
| T15 | `queued` | `failed` | system | Executor unavailable (key removed, agent disabled, capability revoked) | `error_code` |
| T16 | `needs_input` / `needs_review` | `failed` | system | Capability revoked (ADR 004) | `error_code = 'capability_revoked'` |

Everything else is rejected, including any transition out of `completed` or `canceled`, and self-transitions. Every accepted transition appends a `state_changed` event and bumps `assignments.revision`.

Rules that apply across transitions:

- **Completion of the source task is never automatic.** T11 does not touch `notes.completed_at`; the UI offers "Mark task done" as a separate, ordinary revisioned write.
- **Cancellation is immediate and fenced.** T8 revokes the attempt lease. Any later executor call with the old `lease_token` gets `lease_lost` and writes nothing, so a still-running built-in loop cannot submit after cancel.
- **Interim behavior before A-04 (durable runtime).** `max_attempts = 1`, no T7; a lease that expires without a heartbeat goes to `failed` with `timed_out` (T6) through a reaper that runs on reads (the pattern used in `GET /api/agent/runs`) and on the scheduler tick. This satisfies "a timed-out execution must surface failure rather than appear to work forever."
- **Lease and heartbeat.** The interim built-in executor uses a 90 s lease and a 30 s heartbeat, under the route's `maxDuration = 300`. **Decided by Tony, 2026-10-14.**
- **Any item kind may be delegated** (`note`, `task`, `project`, `document`, `followup`), not only tasks and follow-ups. **Decided by Tony, 2026-10-14.**
- **At most one non-terminal assignment per source item** (partial unique index on `source_note_id where state in ('queued', 'running', 'needs_input', 'needs_review')`); parallel assignments on one item are not allowed. **Decided by Tony, 2026-10-14.**
- **Workspace moves of referenced items.** Moving an item to another workspace is refused only while it is the source or a context item of a non-terminal assignment (`queued`, `running`, `needs_input`, `needs_review`); a `before update of workspace_id` trigger on `notes` raises `assignment_active`, which `save_notes` reports as the per-item code `assignment_active` (mapped in `note_link_error` by migration `20261018000100_note_assignment_active_code.sql`). Finished assignments (`completed`, `failed`, `canceled`) don't block the move: the same trigger first detaches them, setting `source_note_id` or the context row's `note_id` to null and appending an `item_detached` event, while the assignment keeps its history, artifacts, stored outcome and context rows. The composite keys stay `on update restrict` as a backstop. **Decided by Tony, 2026-10-14.**
- **Reject maps to `canceled`** (T13) with a recorded `reject` review, so "the user declined the result" is never confused with "the system failed". **Decided by Tony, 2026-10-14.**
- **Per-workspace concurrency** for the built-in executor: one `running` attempt per workspace, mirroring the existing `409 "The agent is already working here"` check for organizing runs.

### 3. Attempts, events, artifacts, reviews

- **Attempts** are execution tries. Assignment `state` is the user-facing lifecycle; attempt `status` is execution bookkeeping. A `needs_input` answer or `request_changes` creates a *new* attempt on the next claim; prior attempts and their artifacts are retained.
- **Events** are the progress timeline for U-04/U-05 and the audit trail. Payloads hold ids, codes and short executor progress strings (≤ 280 chars, treated as untrusted when rendered). They never hold prompts, model transcripts or note bodies.
- **Artifacts** hold the prepared draft or summary. Only the latest non-superseded artifact can be reviewed; reviewing a superseded one returns `artifact_superseded`. Artifacts are **kept forever** after accept, reject or cancel; there is no purge (they go only with their assignment, workspace or account). **Decided by Tony, 2026-10-14.**
- **Reviews** record each decision with the artifact it judged. `request_changes` requires a comment; that comment and question answers are user-authored instructions and join `requested_outcome` as the only intent the executor may act on.

### 4. Error contract

Routes return `{ error: string, code: string, ... }`. `error` is generic.

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `invalid_payload` | Shape or limits |
| 404 | `not_found` | Assignment, task or context item doesn't exist **or belongs to another account/workspace** (no 403 to avoid revealing existence) |
| 409 | `revision_conflict` | `expectedRevision` mismatch; body includes `currentRevision`, `state` |
| 409 | `invalid_transition` | Not in the transition table; body `{ from, to, allowed: string[] }` |
| 409 | `active_assignment_exists` | A non-terminal assignment already exists for the task |
| 409 | `executor_busy` | Workspace concurrency limit |
| 409 | `lease_lost` | Executor call with an expired, revoked or superseded lease |
| 409 | `artifact_superseded` | Review of a non-latest artifact |
| 422 | `invalid_context` | Context item not in the assignment's workspace (any kind of source item may be delegated, decided by Tony, 2026-10-14) |
| 403 | `capability_denied` | Requested capability not allowed for the executor (ADR 004) |
| 403 | `agent_disabled` | `workspaces.agent_enabled = false` or no usable model key (reuses `createRun()` checks) |

Normalized failure codes stored in `error_code` and shown to the user: `provider_auth`, `provider_rate_limited`, `provider_unavailable`, `budget_exhausted`, `timed_out`, `context_unavailable`, `capability_revoked`, `executor_unavailable`, `internal`. Raw provider messages are never stored or shown; `ProviderError` from `lib/agent/providers.ts` maps to a code.

Item-side effects: a workspace move of an item used by a non-terminal assignment is refused (§2, decided by Tony, 2026-10-14), surfaced by `PUT /api/notes` as the per-item code `assignment_active`. `DELETE /api/notes/:id` on a source task with a non-terminal assignment returning `409 has_active_assignment` is not implemented yet (it needs a notes-route change); today the delete succeeds and the assignment detaches. Deleting a context item is allowed; the executor records `context_unavailable` and continues with the rest, or fails if none remain.

### 5. Functions and routes

Functions (`security definer`, `search_path = ''`):

| Function | Granted to | Transitions |
| --- | --- | --- |
| `create_assignment(p_workspace_id, p_source_note_id, p_requested_outcome, p_context_note_ids uuid[], p_executor_kind, p_capabilities text[])` | `authenticated` | Insert in `queued` |
| `transition_assignment(p_id, p_expected_revision, p_to_state, p_payload jsonb)` | `authenticated` | T2, T8, T10, T14 |
| `answer_assignment_question(p_id, p_expected_revision, p_question_id, p_answer)` | `authenticated` | T9 |
| `review_assignment_artifact(p_id, p_expected_revision, p_artifact_id, p_decision, p_comment)` | `authenticated` | T11–T13 |
| `claim_assignment(p_id, p_lease_seconds)` → `{ attemptId, leaseToken }` | `service_role` | T1 |
| `heartbeat_assignment(p_attempt_id, p_lease_token, p_progress text)` | `service_role` | Extends lease; optional `progress` event |
| `ask_assignment_question(p_attempt_id, p_lease_token, p_prompt)` | `service_role` | T3 |
| `submit_assignment_artifact(p_attempt_id, p_lease_token, p_artifact jsonb)` | `service_role` | T4 |
| `fail_assignment_attempt(p_attempt_id, p_lease_token, p_error_code)` | `service_role` | T5 |
| `reap_assignment_leases()` | `service_role` | T6, T7, T15 |

Routes (A-01; executor-facing HTTP for external agents is A-06):

- `POST /api/assignments` → 201 `{ assignment }`
- `GET /api/assignments?workspaceId=&state=` → list (no artifact content)
- `GET /api/assignments/:id` → assignment, attempts, events, open question, latest artifact, reviews
- `POST /api/assignments/:id/cancel` `{ expectedRevision }`
- `POST /api/assignments/:id/retry` `{ expectedRevision }`
- `POST /api/assignments/:id/answer` `{ expectedRevision, questionId, answer }`
- `POST /api/assignments/:id/review` `{ expectedRevision, artifactId, decision, comment? }`
- `POST /api/assignments/:id/artifacts/:artifactId/save` `{ projectId? }` → creates the document item (§6)

All use `routeUser(request, { mutating: true })` from `lib/supabase/route-auth.ts` for writes.

### 6. Saving a result as linked documentation

After `accept`, the user can save the artifact as an item: `kind = 'document'`, `bucket = 'reference'`, `project_id` = the source task's `project_id` (or a chosen project in the same workspace), created through `save_notes` with `expectedRevision: null` (ADR 002). It is a user write, not an agent action, so it has no `agent_actions` row; `assignment_artifacts.saved_note_id` and an event record the link. Saving is separate from accepting so a user can accept without filing.

### 7. Relation to organizing runs

- `agent_runs` / `agent_actions` stay as they are for triage and organize. No migration of existing rows. No shared state machine.
- The built-in preparation executor (A-02) reuses the **provider layer** (`createProvider()`, `ProviderError`, `loadAgentSettings()`, the encrypted key in `agent_settings`) and the `workspaces.agent_enabled` gate, but **not** `runAgent()`'s write tools. Its tools are read-only over the selected context items (by id, scoped to `assignment_context_items`) plus `ask_question` and `submit_result`. It cannot list the workspace, create or update items, or reach anything external.
- The Agents page (U-05) shows both histories side by side; they are distinct record types.
- If organizing runs later need questions/review, they can become assignments of a new executor type; this ADR does not require it.

### 8. Untrusted content and data hygiene

- Captured material (context items, Slack/email text) is data, never instructions. The executor system prompt follows `agentSystemPrompt()`'s rule, and **server checks enforce scope independently of model output**: tool handlers accept only ids in `assignment_context_items` for this assignment, and capabilities are read from the assignment row, never from model output.
- Only `requested_outcome`, question answers and `request_changes` comments (all user-authored) grant intent.
- Context is sent to the model provider only for explicitly selected items, under `agent_enabled` (minimum-necessary context). **Decided by Tony, 2026-10-13:** there is no HIPAA blocker to sending selected context to the user's BYO-key provider in any workspace, Waltz included, because Orbit holds no PHI. It remains opt-in through the user's selection and the workspace switch.
- Never log `requested_outcome`, questions, answers, artifacts, review comments or model output. Logs carry assignment/attempt ids, state and `error_code` only. `lease_token` is a credential and is never logged or returned to browsers.
- External-agent reads of artifacts are recorded in the grant audit trail (ADR 004).

## Implementation notes (A-02, 2026-10-15)

These record how the built-in preparation executor implements this decision; they don't change it. Details and constants are in `docs/api/assignments.md` ("Built-in executor").

- **No migration.** A-02 uses only the A-01 executor functions. Attempt `provider`, `model` and `usage` stay null because no executor function sets them; recording them would need a small additive function (follow-up).
- **Tools** (§7): `submit_result` and `ask_question` only. The executor gets the source and selected context as data up front instead of a read tool, which is the same scope (ids from `assignment_context_items` plus the source) with fewer model turns.
- **Codes** (§4): an attempt that uses up its own wall-clock budget fails with `budget_exhausted`, because `fail_assignment_attempt` reserves `timed_out` for the reaper (T6). `timed_out` therefore means "stopped heartbeating". A missing or unreadable key and a disabled workspace fail before claiming with `executor_unavailable` (T15) rather than `agent_disabled`, which is a route code, not a stored failure code. The kill switch is re-checked before each model turn after the first and maps to `capability_revoked` (T5).
- **Context** (§4, §8): deleted context items are skipped with a content-free progress event (`N selected items are no longer available`) rather than a `context_unavailable` event, because no service-role function appends that event type; with no item left the attempt fails with `context_unavailable`.
- **Recovery** (ADR 005 tier 2): besides `after()` in the queuing routes, `POST /api/assignments/kickoff` (client ping) and every scheduler tick restart queued built-in work whose kickoff was lost. `claim_assignment`'s queued-only guard and per-workspace limit make duplicate starts no-ops.
- **Artifacts** (§6): content is a Tiptap document converted from the model's markdown (safe subset, no links or HTML) and `plain_text` holds the markdown. Saving as a document item stays with U-05.

## Consequences

- One clear lifecycle drives U-04/U-05 and survives refresh (state is in Postgres).
- The executor can't "complete" work behind the user's back, can't mutate items, and can't outlive a cancel.
- Eight new tables and ten functions; A-01 needs database tests for every row of the transition table (allowed and a sample of rejected), cross-account/cross-workspace context rejection, fencing after cancel, lease expiry → `failed`, and one-active-assignment enforcement.
- Depends on D-02's `notes_id_workspace_user_key` and `kind`; A-01 must not merge before D-02.

## Alternatives considered

- **Extend `agent_runs` with new statuses.** Mixes workspace housekeeping that mutates items with reviewed, single-task delegation; undo semantics differ. Rejected.
- **State only, no attempts table.** Loses retry/lease history and makes fencing awkward. Rejected.
- **Events as the source of truth (event sourcing).** Strong audit, but heavy for the first release and harder to query for Home. Rejected; state row plus append-only events instead.
- **Questions and reviews as events only.** Possible, but a table with a unique "one open question" index makes the invariant enforceable. Rejected.
- **Reject → `failed`.** Conflates "the system failed" with "the user declined the result". Rejected: reject → `canceled` with a `reject` review (decided by Tony, 2026-10-14).

## Open questions

None. The five open questions (allowed source kinds, one active assignment per item, reject → `canceled`, artifact retention, lease and heartbeat) were decided by Tony on 2026-10-14 and are recorded in §2 and §3.
