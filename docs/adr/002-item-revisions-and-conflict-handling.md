# 002 — Server-managed item revisions, conflict handling and safe agent undo

- **Status:** Proposed — awaiting Tony's approval
- **Date:** 2026-10-13
- **Ticket:** O-01 (contract for D-01; consumed by D-02, D-03, A-01, A-06, K-01)
- **Deciders:** Tony (Solutions Architect)
- **Related:** ADR 001 (item fields), ADR 003 (assignments reuse the revision contract), ADR 005 (runtime)

## Context

Orbit has no concurrency control. The writers to `public.notes` today:

| # | Writer | Code path | How it writes |
| --- | --- | --- | --- |
| W1 | Browser autosave | `components/use-notes.ts` `flush()` → `PUT /api/notes` (`app/api/notes/route.ts`) | Batch `upsert` of whole notes via the user's RLS client. `updated_at` is **client-supplied** (`toRow()` in `lib/notes-db.ts`). |
| W2 | Browser delete | `flush()` → `DELETE /api/notes/[id]` (`app/api/notes/[id]/route.ts`) | Unconditional delete. |
| W3 | Browser-storage import | `importBrowserNotes()` in `use-notes.ts` → `PUT /api/notes` | Same upsert; can overwrite a server row with the same id. |
| W4 | Slack capture | `app/api/slack/interact/route.ts` | Admin-client `upsert(..., ignoreDuplicates)` on `(user_id, source_ref)`: insert-only. |
| W5 | Email capture | `app/api/email/inbound/route.ts` | Same as W4. |
| W6 | Organizing agent | `supabaseAgentStore()` in `lib/agent/server.ts` | Reads a row, computes changes in TypeScript, `update`s the note, then **separately** inserts `agent_actions`. `create` inserts a note, then separately inserts the action. |
| W7 | Triage bookkeeping | `executeRun()` in `lib/agent/server.ts` | Bulk `update({ triage_status: "done" })` on captures the agent looked at. |
| W8 | Agent undo | `app/api/agent/actions/[id]/undo/route.ts` | Restores `before` values unconditionally, or **deletes** an agent-created note even if the user edited it since; then marks `undone_at` in a separate call. |
| W9 | External API / MCP | `POST /api/v1/notes` (`app/api/v1/notes/route.ts`), used by `orbit_capture_note` in `scripts/orbit-mcp.mjs` | Insert-only via the caller's Supabase JWT. Not idempotent (docs tell agents not to retry). |
| W10 | Direct PostgREST | Any holder of a user session + publishable key | RLS policies on `notes` allow the owner to insert/update/delete directly, bypassing the routes. |
| — | Scheduled reports | `lib/scheduled/server.ts`, `app/api/scheduler/tick/[slot]/route.ts` | Write `scheduled_task_runs` only. **No note writes today.** |
| — | Export | `exportNotes()` in `components/workspace.tsx` | Read-only. |

Consequences today: two tabs or devices editing the same note silently last-writer-wins (the client's `mergeServerNotes()` in `lib/notes.ts` keeps local dirty edits and overwrites the server on the next flush); the agent can overwrite an edit made between its read and its write; an agent change can be applied without its audit row (or vice versa) if the second call fails; undo can erase later human edits or delete a note the user has since rewritten. O-03 recorded the absence of tests for all of these.

Supabase JS cannot run a multi-statement transaction from the app, so atomicity requires Postgres functions called with `.rpc()`. The repo already uses this pattern: `set_default_workspace()` and `regenerate_inbox_token()` are `security definer`, `set search_path = ''`, check `auth.uid()`, and grant execute only to `authenticated`.

## Decision

### 1. Server-managed revision

Migration `20261014000000_note_revisions.sql`:

```sql
alter table public.notes add column revision bigint not null default 1;   -- existing rows start at 1

alter table public.agent_actions
  add column revision_before bigint,   -- null for actions recorded before this migration
  add column revision_after bigint,
  add column undone_by uuid references auth.users (id) on delete set null;
```

Trigger `notes_manage_revision()` (`before insert or update`, `search_path = ''`):

- **Insert:** forces `revision = 1` and `updated_at = now()`.
- **Update:** if any *tracked* column changed (`is distinct from`), sets `revision = old.revision + 1` and `updated_at = now()`; otherwise forces `revision = old.revision`. A writer can never set `revision` directly.
- Tracked columns: `title, content, plain_text, bucket, tags, completed_at, due_date, workspace_id`, plus `kind, project_id` (ADR 001, D-02) and `waiting_on, waiting_for, next_check_on` (D-03). Each later migration that adds a user-visible column must `create or replace` this trigger function to track it.
- **Not tracked:** `triage_status` (W7 bookkeeping must not create conflicts for a user who is typing in a fresh capture), `origin`, `source`, `source_ref` (server-owned).

`updated_at` becomes server-managed. Old clients tolerate this: after a save they mark `synced[id] = local updatedAt`; on the next refresh the server's value differs, the local copy is clean, and `mergeServerNotes()` adopts the server row.

### 2. Expected-revision preconditions

Every update and delete states the revision it was based on:

| Value of `expectedRevision` | Meaning |
| --- | --- |
| integer `n` | Apply only if the current revision is `n` |
| `null` | Create-only: apply only if no row with this id exists (used by W1 for new notes and by W3 import) |
| absent | Legacy write: allowed only while enforcement is `off` or `warn` (see Rollout) |

Migration `20261014000100_note_write_functions.sql` adds (all `security definer`, `set search_path = ''`, ownership via `auth.uid()` unless stated):

| Function | Granted to | Purpose |
| --- | --- | --- |
| `save_notes(p_notes jsonb, p_require_revision boolean) returns jsonb` | `authenticated` | Batch create/update. Per item: `select ... for update`; compare; write; return per-item result. Each item runs in its own `begin ... exception` block, so a constraint failure on one item becomes an `invalid` result without aborting the others. Server-owned columns (`source`, `source_ref`, `origin`, `triage_status`, `revision`, `updated_at`, `user_id`) are ignored from input. An id owned by another user returns `not_found`. |
| `delete_note(p_id uuid, p_expected_revision bigint, p_require_revision boolean) returns jsonb` | `authenticated` | Conditional delete. D-02 adds `p_unlink_children boolean` (ADR 001). |
| `agent_apply_note_change(p_run_id uuid, p_note_id uuid, p_expected_revision bigint, p_after jsonb, p_reason text) returns jsonb` | `service_role` only | W6 update + audit in one transaction (§4). |
| `agent_create_note(p_run_id uuid, p_note jsonb, p_reason text) returns jsonb` | `service_role` only | W6 create + audit in one transaction. |
| `undo_agent_action(p_action_id uuid) returns jsonb` | `authenticated` | W8 safe undo (§5). |

`p_require_revision` is passed by the route from a typed server config value (see Rollout), never from the client. Routes keep validating payloads with `isSavableNote()` before calling the function.

### 3. Conflict response shape

All error bodies keep `{ error: string }` and add `code`. `error` is generic and never contains note titles or content.

**`PUT /api/notes`** request: `{ notes: Array<Note & { expectedRevision?: number | null }> }` (max 500, unchanged).

Per-item result:

```ts
type SaveResult =
  | { id: string; status: "saved"; revision: number; updatedAt: string }
  | { id: string; status: "conflict"; expectedRevision: number | null;
      currentRevision: number | null;   // null: deleted elsewhere
      current: Note | null }            // server copy, for the owner's merge UI
  | { id: string; status: "precondition_required" }
  | { id: string; status: "invalid"; code: "invalid_project_link" | "linked_item_move" | "not_found" };
```

Response status, by precedence over the items: any `conflict` → **409** `revision_conflict`; else any `precondition_required` → **428** `precondition_required`; else any `invalid` → **422** (item code); else **200**. Body always: `{ error?, code?, saved: number, results: SaveResult[] }` (`saved` is kept for old clients). Writes are atomic per item, not per batch: a 409 can still contain `saved` items, and the client must apply those results. 400 `invalid_payload` (malformed batch, nothing written) is unchanged.

**`DELETE /api/notes/:id?expectedRevision=n`**:

| Status | Body | Client action |
| --- | --- | --- |
| 200 | `{ deleted: id }` | Done |
| 404 | `{ code: "not_found" }` | Treat as already deleted |
| 409 | `{ code: "revision_conflict", currentRevision, current }` | Restore the note locally: "This note was changed elsewhere and was not deleted." |
| 409 | `{ code: "project_has_linked_items", count }` | Confirm, retry with `unlinkChildren=true` (ADR 001) |
| 428 | `{ code: "precondition_required" }` | Old client; see Rollout |

`current` (the full note) is returned only to the owner's browser session on `/api/notes`, which is the same data `GET /api/notes` already returns to that user. External APIs (`/api/v1`, MCP) return only `id` and `currentRevision` on conflict (minimum necessary).

### 4. Atomic agent mutation and audit

`supabaseAgentStore()` (`lib/agent/server.ts`) keeps its `AgentStore` interface (`lib/agent/agent.ts`) but its writes become RPCs:

- `list()` / `get()` also select `revision` and remember it in a run-scoped `seen: Map<noteId, revision>`. Revisions are **not** shown to the model.
- `update()` still reads the row and computes `after` values in TypeScript (including `appendText` against the read content), then calls `agent_apply_note_change(runId, id, revisionRead, after, reason)`. The function:
  1. Loads the run, requires `status = 'running'`, and takes `user_id` / `workspace_id` **from the run row** (never from arguments).
  2. Locks the note with `for update`, scoped to that user and workspace; missing → `not_found`.
  3. If `revision <> p_expected_revision` → returns `{ status: "conflict" }` and writes nothing.
  4. Filters `p_after` to the restorable column whitelist (today's `RESTORABLE` list in the undo route, moved into the function), computes `before` from the locked row, updates the note (trigger bumps revision), and inserts `agent_actions` with `before`, `after`, `revision_before`, `revision_after` — all in one transaction.
- On `conflict` the store re-reads once and recomputes; a second conflict returns the tool result `{ error: "That note just changed. Read it again before changing it." }` to the model (no content in the message).
- `create()` calls `agent_create_note`, which inserts the note (`revision = 1`) and its `create` action in one transaction.
- W7 (`triage_status` bulk update) is unchanged; it does not bump revisions.
- `executeRun()` error logging stays as today: run id and error type only.

### 5. Safe undo

`undo_agent_action(p_action_id)` replaces the body of the undo route. It locks the action (`user_id = auth.uid()`) and the note, then:

| Case | Condition | Result |
| --- | --- | --- |
| Already undone | `undone_at is not null` | 409 `already_undone` |
| Update, untouched since | `note.revision = action.revision_after` | Restore every `before` value; 200 |
| Update, later edits elsewhere | Every column in `action.after` still equals its `after` value | Restore only those columns; other edits survive; 200 |
| Update, a changed column was edited since | Any `after` column now differs | 409 `undo_conflict` with `fields: string[]` (column names only); nothing written |
| Update, note gone | No row | 404 `note_deleted` |
| Create, untouched | `note.revision = action.revision_after` and no items link to it | Delete; 200 |
| Create, edited since | Revision moved | 409 `edited_since_created`. Never deleted silently; the UI offers "Keep it" or an explicit user delete with the current expected revision (W2 path). |
| Create, project with linked items | Children exist | 409 `project_has_linked_items` |
| Create, note already gone | No row | Mark undone; 200 `{ undone, alreadyDeleted: true }` |
| Legacy action (`revision_after is null`) | Recorded before migration | Use the value-comparison rows above only |

Success sets `undone_at`, `undone_by` in the same transaction and returns `{ undone: id, revision }`. A restore is a normal tracked update, so it bumps the revision and any open browser sees it as a remote change.

### 6. Browser client and draft retention (D-01 client half; UI in U-02)

`components/use-notes.ts`:

- `synced` becomes `Map<id, { revision: number; updatedAt: string }>`. Local dirtiness is still detected by `updatedAt`; `expectedRevision` is the synced revision, or `null` for ids the server has never confirmed.
- On `saved` results, record the returned revision. On `conflict`, move the item to a `conflicts` map `{ local, server }`, **stop auto-resending it** (prevents a retry loop), and surface it.
- `mergeServerNotes()` detects conflicts early: a dirty local note whose server revision is higher than its synced base becomes a conflict without waiting for a failed save.
- Recovery choices (U-02): **Keep mine** (resend with `expectedRevision = currentRevision`), **Use theirs** (replace local), **Save mine as a copy** (new id, create-only, durable in the account).
- Drafts are retained in memory for the tab and **persisted to browser storage** so a reload or crash does not lose them. **Decided by Tony, 2026-10-13** (Orbit holds no HIPAA/PHI data). Key: `orbit.drafts.v1:<userId>:<noteId>` in `localStorage`, following the existing `orbit.notes.v1` naming. Each entry holds `{ local, baseRevision, savedAt }`. It is removed when the conflict is resolved, and D-01 also clears these keys on sign-out. A `beforeunload` warning still shows while conflicts are unresolved. "Save mine as a copy" stays available as the cross-device recovery path.

### 7. Rollout for old clients and every writer

Enforcement is controlled by one typed server config value, `notesRevisionEnforcement: "off" | "warn" | "enforce"`, read through a server config module (per repository rules, not `process.env` in route code). The env var name (`NOTES_REVISION_ENFORCEMENT`) is set in Vercel project settings.

| Phase | Gate | Behavior |
| --- | --- | --- |
| **A — schema** | Migrations 1–2 applied, D-01 server deployed, enforcement `off` | Trigger manages revision/`updated_at` for every writer, including W10. W6/W8 move to the RPCs immediately (no client dependency). `PUT/DELETE /api/notes` go through `save_notes`/`delete_note`; absent `expectedRevision` = last-writer-wins as today. Responses add `revision` and `results`; old clients ignore them. |
| **B — new client** | D-01 client shipped, enforcement `warn` | New clients send `expectedRevision` and an `X-Orbit-Client` build header. Legacy writes still succeed; the route increments a counter (route + outcome only, no ids or content). Responses carry `X-Orbit-Min-Client`; outdated new clients show "Reload to keep saving". |
| **C — enforce** | Legacy-write counter at zero for 7 consecutive days and at least 14 days after B (open question 1) | Enforcement `enforce`: absent `expectedRevision` → 428. An old tab's `api()` throws, `flush()` sets `storageError`, and its edits stay in memory and are retried every 30 s until the user reloads. Unsaved edits in that tab are lost on reload, which is why phase B must be long enough. |
| **C′ — lock down** | Phase C stable; W9 migrated | Migration `20261021000000_note_write_enforcement.sql`: `revoke insert, update, delete on public.notes from authenticated` (select stays). All writes go through the functions or server routes. Closes W10. |

Per-writer plan:

| Writer | Phase A change | Precondition |
| --- | --- | --- |
| W1 autosave | Route calls `save_notes`; client sends revisions from phase B | Required in C |
| W2 delete | Route calls `delete_note`; client sends `expectedRevision` from B | Required in C |
| W3 import | Sends `expectedRevision: null`; an id that already exists returns `conflict`, which the import treats as "already uploaded" and skips | Create-only |
| W4/W5 Slack, email | No change: inserts get `revision = 1`; `ignoreDuplicates` never updates | Insert-only; dedupe by `source_ref` |
| W6 agent | RPCs from phase A | Always (run-scoped `seen` revision) |
| W7 triage flag | No change | Untracked column |
| W8 undo | `undo_agent_action` from phase A | Always (revision and value checks) |
| W9 v1 capture / MCP | Phase A: returns `revision: 1` (additive, documented in `docs/api/openapi.json` and `docs/api/agents.md`). Before C′: switch the insert to `save_notes` with `expectedRevision: null`, because direct DML is revoked. Idempotency keys come with A-06. Any future v1 update or delete endpoint requires `expectedRevision` from day one (no legacy mode). | Create-only |
| W10 direct PostgREST | Revision always bumps (trigger), so later writers detect it | Closed in C′ |
| Scheduled reports | None today. A future "save report as note" uses `save_notes` create-only. | Create-only |
| Assignments (ADR 003) | Saving an artifact as a document is a user create through `save_notes` | Create-only |

### 8. Logging and data hygiene

- Conflict and undo errors carry ids, revisions and column names only. No titles, content, `origin` or reasons in error messages or logs.
- The legacy-write counter and conflict metrics record counts per route and outcome only.
- `agent_actions.before/after` already store copies of note content. This ADR does not widen that; retention for that history is an open question.
- The `current` copy in a 409 goes only to the owning session, matching what that session can already `GET` (minimum necessary for external callers, §3).

## Consequences

- Two simultaneous writers can no longer silently overwrite each other once phase C is on (D-01 done criterion). Before that, the trigger still guarantees that every change moves the revision, so detection works for new clients from phase B.
- Agent changes and their audit are all-or-nothing; undo never erases later human edits or silently deletes an edited item.
- Batch saves are no longer all-or-nothing in practice (per-item), which the new client must handle.
- More logic lives in SQL functions, which need database integration tests against a disposable Supabase instance: concurrent saves, delete vs. edit, agent vs. human race, every undo row in §5, legacy-mode acceptance and enforce-mode 428, and revoked direct DML.
- The service-role-only agent functions keep the existing "admin client, explicit user/workspace filter" model, but the scope now comes from `agent_runs` inside the transaction.

## Alternatives considered

- **Compare on `updated_at`.** It is client-supplied today, has millisecond normalization quirks (see `iso()` in `lib/notes-db.ts`), and clocks differ across devices. Rejected in favor of an integer revision.
- **Conditional `update ... where revision = n` through PostgREST** instead of functions. Works for single rows, but not for upsert batches, create-only semantics, or atomic agent audit. Rejected.
- **`If-Match` / ETag headers with 412.** Idiomatic HTTP, but the batch PUT needs per-item revisions in the body anyway. One body/query convention and one 409 `revision_conflict` code keep a single client path. Can be added as an alias later.
- **Field-level merge (CRDT/OT) on content.** Collaborative editing is explicitly out of scope; too heavy for the first release.
- **Store conflicted drafts server-side (`note_drafts` table).** Durable and multi-device, but it adds another content copy and a lifecycle to manage. Deferred; browser storage plus "Save mine as a copy" cover recovery.
- **Enforce immediately.** Would break open tabs mid-edit with no recovery. Rejected for the phased rollout.

## Open questions

1. **Phase B → C gate.** Proposed: at least 14 days and 7 days of zero legacy writes. *Decider: Tony.*
2. **Retention of `agent_actions.before/after`** (content copies). Proposed: keep for undo for 30 days, then null the values but keep the row. *Decider: Tony.*
3. **Telemetry sink** for the legacy-write counter (Vercel logs vs. a table). *Owner: Lead.*
4. **Does the agent retry once on conflict, or report immediately?** Proposed: one re-read. *Owner: Agents.*
