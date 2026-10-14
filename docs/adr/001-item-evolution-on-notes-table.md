# 001 — Evolve the `notes` table into typed, linkable items

- **Status:** Proposed — awaiting Tony's approval
- **Date:** 2026-10-13
- **Ticket:** O-01 (decides the contract for D-02 and D-03; depends on ADR 002 for D-01)
- **Deciders:** Tony (Solutions Architect)
- **Related:** `docs/implementation-plan.md` → "Foundation contracts / Items and relationships"; ADR 002 (revisions); ADR 003 (assignments reference items)

## Context

Everything a user captures is a row in `public.notes`
(`supabase/migrations/20261005000000_notes_and_slack.sql`), later extended by:

| Migration | Adds |
| --- | --- |
| `20261006000000_workspaces.sql` | `workspace_id` with composite FK `(workspace_id, user_id) → workspaces (id, user_id)`; `fill_workspace_id()` trigger for writers that omit a workspace |
| `20261008000000_email_capture.sql` | `source` may be `email` |
| `20261009000000_default_workspace.sql` | `fill_workspace_id()` prefers the default workspace |
| `20261013000000_note_due_dates.sql` | `due_date date` (calendar date, no time zone) |

Current shape that must keep working:

- `id uuid` is client-generated (`createNote()` in `lib/notes.ts`, Slack/email capture builders in `lib/slack.ts` / `lib/email.ts`, `crypto.randomUUID()` in the agent store). IDs are stable and referenced by `agent_actions.note_id` without a foreign key so history outlives the note.
- `bucket` (`inbox | next | projects | waiting | someday | reference`, `BUCKETS` in `lib/notes.ts`) is the only organizing dimension. "Project" and "Waiting for" exist only as buckets; nothing links a next action to its project.
- Provenance: `source` (`web | slack | email`), `source_ref` (unique per user — dedupes Slack/email retries via `upsert(..., { onConflict: "user_id,source_ref", ignoreDuplicates: true })`), `origin jsonb` (Slack channel/permalink or email from/subject/message id).
- Rich content: Tiptap JSON in `content`, mirrored to `plain_text` for search and the agent.
- Serialization lives in three places that must change together: `Note` / `isNote()` / `createNote()` in `lib/notes.ts`; `NOTE_COLUMNS` / `fromRow()` / `toRow()` / `isSavableNote()` in `lib/notes-db.ts`; and the v1 API projection in `app/api/v1/notes/route.ts` (database field names). `app/orbit-page.tsx` server-renders the list with `NOTE_COLUMNS`.
- `toRow()` already uses the additive-compatibility idiom we will reuse: `due_date` is written only when `note.dueDate !== undefined`, so an older client that never sends the field cannot clear it.
- `isNote()` accepts objects with extra keys, so older clients tolerate new response fields; and clients spread notes (`{ ...note, bucket }` in `components/workspace.tsx`), so unknown fields round-trip back to the server unchanged.
- Legacy browser data (`STORAGE_KEY = "orbit.notes.v1"`, `browserNotes.pending()`, `importBrowserNotes()` in `components/use-notes.ts`) and the JSON export (`exportNotes()` in `components/workspace.tsx`, file `version: 1`) carry notes without any new fields.
- A user can move a note to another workspace today: `components/note-editor.tsx` calls `onUpdate({ workspaceId })`, and `PUT /api/notes` upserts the new `workspace_id`.

The product needs task / project / document / follow-up semantics and project links (plan, Wave 1) without a rewrite, a table rename, or silently reclassifying existing data.

## Decision

### 1. Keep `public.notes` and its IDs; extend additively

No rename, no new item table, no ID changes. "Item" is the domain term in docs and new code; the table, `Note` type, routes (`/api/notes`, `/api/v1/notes`) and localStorage keys keep their names. A rename, if ever wanted, is a separate later ADR.

### 2. Add `kind`, independent of `bucket`

```sql
alter table public.notes
  add column kind text not null default 'note'
    check (kind in ('note', 'task', 'project', 'document', 'followup'));
create index notes_workspace_kind_idx on public.notes (workspace_id, kind);
```

- Every existing row becomes `note`. **No data migration reclassifies rows.**
- `bucket` keeps its GTD meaning (where it sits in the workflow); `kind` says what it is. Any combination is valid (a `task` can sit in `someday`; a `document` in `reference`).
- Conversion suggestions are computed in the app, not stored: `next → task`, `projects → project`, `waiting → followup`, `reference → document`; `inbox` and `someday` get no suggestion. Accepting a suggestion is an ordinary revisioned update (ADR 002). Moving a bucket never changes `kind`, and changing `kind` never changes `bucket`.
- Capture writers (Slack, email, `POST /api/v1/notes`, MCP `orbit_capture_note`) do not send `kind`; the column default makes captures `note`.
- The organizing agent may set `kind` and `project_id` (see §3a). **Decided by Tony, 2026-10-13.**

### 3. Project links: one parent project per item, nested projects allowed, enforced in the database

```sql
-- Target for composite FKs that tie a link to the same owner and workspace.
alter table public.notes
  add constraint notes_id_workspace_user_key unique (id, workspace_id, user_id);

alter table public.notes
  add column project_id uuid,
  add constraint notes_project_not_self check (project_id is null or project_id <> id),
  add constraint notes_project_fk foreign key (project_id, workspace_id, user_id)
    references public.notes (id, workspace_id, user_id)
    on update restrict
    on delete set null (project_id);
create index notes_project_idx on public.notes (project_id) where project_id is not null;
```

The composite FK follows the pattern already used for `workspace_id` and `agent_runs`, and makes cross-user and cross-workspace links impossible at the database level, whatever the writer. `on delete set null (project_id)` (PostgreSQL 15+ column list; available, see Consequences) clears only the link, never `workspace_id`/`user_id`.

A `before insert or update of project_id, kind` trigger, `notes_validate_project_link()` (`security invoker`, `search_path = ''`), enforces what an FK cannot:

| Rule | Rejection code |
| --- | --- |
| Target row has `kind = 'project'` (same user and workspace is guaranteed by the composite FK) | `invalid_project_link` |
| No self-link (also the `notes_project_not_self` check) | `invalid_project_link` |
| **No cycles:** the new parent must not be the item itself or any of its descendants | `project_cycle` |
| **Max depth:** a chain of nested projects is at most **5 levels** (a root project plus 4 levels of sub-projects); non-project items can attach to a project at any level | `project_depth_exceeded` |
| An item may not stop being `kind = 'project'` while other items link to it | `project_has_linked_items` |

The trigger raises `check_violation` (SQLSTATE `23514`) with the code as the message; the API maps it (see Error contract). Messages never include titles or content.

**Nested projects.** **Decided by Tony, 2026-10-13.** A project may have a parent project. Only `kind = 'project'` rows can be parents, so cycles and depth only concern projects.

- **Cycle check.** When `project_id` changes (or is set on insert) for a row of kind `project`, the trigger walks *up* from the new parent with a recursive CTE (`with recursive ancestors as (...)`), filtered to the same `workspace_id` and `user_id` and capped at the max depth. If the walk reaches `new.id`, it raises `project_cycle`. Non-project items can't be parents, so their links need no cycle check.
- **Depth check.** In the same statement, depth = (ancestors of the new parent + 1) + (height of the moving project's own sub-project subtree, from a recursive walk *down*). Over 5 raises `project_depth_exceeded`. 5 levels is enough for "area → outcome → workstream → sub-outcome → piece" and keeps every recursive query small and bounded. Changing the limit is a one-line trigger change plus a migration.
- **Concurrency.** Two concurrent re-parentings could each pass the check and together form a cycle under read committed. When a project row's `project_id` changes, the trigger first takes `pg_advisory_xact_lock(hashtextextended(workspace_id::text, 0))`, which serializes project re-parenting per workspace. Ordinary item links don't take the lock.
- **Project-detail queries.** "Direct contents" is `where project_id = :id` (uses `notes_project_idx`). Roll-ups ("include sub-projects", counts on Home/Projects) and breadcrumbs use two `security invoker` SQL functions added in migration 3, so RLS still applies: `project_descendants(p_project_id uuid)` returns `(id, depth)` and `project_ancestors(p_item_id uuid)` returns `(id, depth)`. Both are recursive CTEs scoped to the caller's user and workspace and bounded by the max depth.
- **Completion** of a parent project does not complete its children or sub-projects.

**Relationship changes**

- Link / relink: set `project_id` with the expected revision of the *child* only. Linking does not change the project's revision.
- Unlink: set `project_id = null`.
- Relinking a project to a different parent runs the cycle and depth checks. The whole subtree moves with it, because descendants keep their own `project_id`.
- **Unlink** of a sub-project (`project_id = null`) makes it a root project that keeps its own subtree.
- **Cross-workspace moves of linked items are rejected** in v1, at any depth. Moving a child that still has `project_id` fails the composite FK; moving a project that still has children or sub-projects fails `on update restrict`. The API returns `422 linked_item_move` and the UI asks the user to unlink first. Moving a whole subtree between workspaces is a later feature. Same rule for items referenced by an active assignment (ADR 003).
- **Deleting a project** that has linked items or sub-projects: `DELETE /api/notes/:id` returns `409 project_has_linked_items` with the count of *direct* children. The client confirms and repeats with `unlinkChildren=true`. In one transaction, the delete function then moves each direct child up to the deleted project's parent (or to no project if it was a root), bumping each child's revision (ADR 002), and deletes the project. Deeper descendants keep their own parents, so the rest of the tree stays intact; moving up can only reduce depth and can't create a cycle. The `on delete set null (project_id)` FK action is the backstop for any other delete path (it detaches direct children rather than moving them up).
- **Archive:** there is no archive state. A completed project (`completed_at` set) is the archive equivalent; linked items keep their link. A dedicated archive flag is an open question that does not block D-02.
- Agent undo of an agent-created project that has since gained children is a conflict, not a delete (ADR 002).

### 3a. Agent writes to `kind` and `project_id`

**Decided by Tony, 2026-10-13.** The organizing agent may set `kind` and `project_id`. This is a **D-02 dependency for the Agents owner** (`lib/agent/`) and must land with the D-02 schema:

- **Tools** (`AGENT_TOOLS` in `lib/agent/agent.ts`): `update_note` and `create_note` gain optional `kind` (enum) and `project_id` (UUID, or `null` to unlink). `list_notes` gains a `kind` filter and returns `kind` and `projectId`. `executeTool()` validates the enum and UUID shape and counts these changes against the existing write budget.
- **Same write path as every agent edit:** the changes go through `agent_apply_note_change` / `agent_create_note` (ADR 002), with revision preconditions, atomic `agent_actions` audit, and safe undo. `kind` and `project_id` join the restorable column whitelist.
- **No cross-workspace links:** the store resolves `project_id` only within its run's workspace (`supabaseAgentStore()` filters on `user_id` and `workspace_id`). The tool returns `Project not found` otherwise, and the composite FK plus trigger reject it anyway. Cycle and depth errors come back to the model as short tool errors with no content.
- **No silent bulk reclassification:** the server, not the prompt, lets the agent change `kind` directly only on (a) captures it is triaging (`triage_status = 'pending'`) and (b) notes it creates in the same run. For any other existing note, `update_note` with `kind` returns `{ error: "Suggest this kind change in your summary instead" }`. The agent lists those as suggestions in its run summary, and the user applies them. `project_id` may be set on any note in the workspace, within the write budget.
- **Undo:** restoring an old `project_id` can hit a cycle or depth limit if the tree changed since. The undo function then returns `409 undo_conflict` with `fields: ["project_id"]` and `reason: "project_cycle" | "project_depth_exceeded"`, and writes nothing.
- The system prompt (`agentSystemPrompt()`) explains kinds and the suggestion rule. The prompt is guidance only; enforcement is in the store.

A many-to-many `item_links` table (backlinks, "related to", document ↔ project) is deferred to K-01 and will be additive to this column, not a replacement.

### 4. Follow-ups (D-03): who / what / next check, date-only

```sql
alter table public.notes
  add column waiting_on text check (char_length(waiting_on) <= 200),        -- free-text person name
  add column waiting_for text check (char_length(waiting_for) <= 2000),     -- expected deliverable
  add column next_check_on date
    check (next_check_on is null or next_check_on between date '0001-01-01' and date '9999-12-31');
create index notes_next_check_idx on public.notes (user_id, next_check_on)
  where next_check_on is not null and completed_at is null;
```

- Fields are allowed on any kind (decided by Tony, 2026-10-13; a `task` in `waiting` can carry them); the editor shows them for `followup` items and the `waiting` bucket. Changing `kind` does not clear them.
- `next_check_on` and `due_date` are calendar dates (validated by `isDueDate()` in `lib/notes.ts`); never converted to instants.
- `waiting_on` is descriptive text, not an account reference. It grants nothing and does not create sharing (plan: single-user workspaces).

**Timed reminders are a separate table**, so date-only fields never acquire hidden time-zone semantics:

```sql
create table public.note_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  note_id uuid not null,
  local_date date not null,          -- the wall-clock date the user picked
  local_time time not null,          -- the wall-clock time the user picked
  timezone text not null,            -- IANA zone, validated server-side with Intl like scheduled_tasks.timezone
  fire_at timestamptz not null,      -- server-computed from the three fields above
  status text not null default 'scheduled'
    check (status in ('scheduled', 'fired', 'snoozed', 'canceled')),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint note_reminders_note_fk foreign key (note_id, workspace_id, user_id)
    references public.notes (id, workspace_id, user_id) on delete cascade
);
create unique index note_reminders_one_active
  on public.note_reminders (note_id) where status = 'scheduled';
create index note_reminders_due_idx on public.note_reminders (fire_at) where status = 'scheduled';
```

- The wall-clock fields are the source of truth; `fire_at` is derived on write and recomputed if zone rules change. A nonexistent local time (spring-forward gap) fires at the first valid instant after it; an ambiguous one (fall-back) fires at the first occurrence. These rules are tested in D-03 with `America/Chicago`, reusing the helpers in `lib/scheduled/schedule.ts` (`localParts`, `localMidnightUtc`).
- D-03 stores and validates reminders only. Dispatch, snooze semantics and recurrence belong to D-04 and the durable runtime (ADR 005).
- A reminder has its own revision; editing a reminder does not bump the note's revision.

### 5. Serialization and validation changes (D-02 / D-03)

| Location | Change |
| --- | --- |
| `lib/notes.ts` `Note` | Add optional `kind?: ItemKind`, `projectId?: string \| null`, `waitingOn?`, `waitingFor?`, `nextCheckOn?`, plus `revision?: number` (ADR 002). Optional so legacy localStorage and v1 export data stay valid. |
| `lib/notes.ts` `isNote()` | Accept absence of every new field; validate when present. |
| `lib/notes-db.ts` `NOTE_COLUMNS`, `NoteRow`, `fromRow()` | Add the new columns. |
| `lib/notes-db.ts` `toRow()` / save function input | Include each new field only when `!== undefined` (the `dueDate` idiom), so an older client's omission means "unchanged". |
| `lib/notes-db.ts` `isSavableNote()` | Validate kind enum, `projectId` UUID or null, length limits, `isDueDate(nextCheckOn)`. Relationship validity is left to the database (single source of truth). |
| `app/api/v1/notes/route.ts` GET + `docs/api/openapi.json` + `docs/api/agents.md` | Add `kind`, `project_id`, `revision` (and D-03 fields) to the projection. Additive, so stays `/api/v1`. |
| `lib/agent/server.ts`, `lib/agent/agent.ts` | Read `kind`, `project_id`; tool and store changes per §3a (Agents owner, D-02 dependency). |
| `components/workspace.tsx` `exportNotes()` | Export `version: 2` including the new fields. There is no import-from-export path today; if one is added, it must accept versions 1 and 2. |

### 6. Migration sequence

Naming follows the existing `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql` convention (latest: `20261013000000_note_due_dates.sql`). Filenames are assigned now so agents do not collide; if a date slips, keep the order and bump the timestamp.

| Order | File | Ticket | Contents |
| --- | --- | --- | --- |
| 1 | `20261014000000_note_revisions.sql` | D-01 | ADR 002 |
| 2 | `20261014000100_note_write_functions.sql` | D-01 | ADR 002 |
| 3 | `20261015000000_note_kinds_and_project_links.sql` | D-02 | §2, §3: `kind`, `notes_id_workspace_user_key`, `project_id` + FK + trigger; `create or replace` the ADR 002 save/delete functions to accept `kind`, `project_id`, `unlinkChildren`; extend the agent functions' restorable whitelist; `project_descendants()` / `project_ancestors()` |
| 4 | `20261016000000_note_followups_and_reminders.sql` | D-03 | §4: follow-up columns, `note_reminders` + RLS (owner select/insert/update/delete mirroring `notes`), revision trigger for reminders; `create or replace` save function for follow-up fields |
| 5 | `20261017000000_assignments.sql` | A-01 | ADR 003 |
| 6 | `20261021000000_note_write_enforcement.sql` | D-01 phase C | ADR 002 rollout; applied only after the rollout gate |

Every step is additive: new nullable or defaulted columns, new constraints that existing rows satisfy (all existing rows have `kind = 'note'` and `project_id = null`), new tables. The previous app version keeps reading and writing after each migration. No destructive down-migrations; rollback is a code rollback that leaves the new columns unused.

### 7. Error contract additions

Existing note routes return `{ error: string }`. Responses gain an optional machine-readable `code`; `error` stays a short, generic, user-safe sentence.

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `invalid_payload` | Shape/limits fail `isSavableNote()` (existing behavior; whole batch rejected) |
| 422 | `invalid_project_link` | Target missing, not a project, other workspace/user, or self-link |
| 422 | `project_cycle` | New parent is the item itself or one of its descendants |
| 422 | `project_depth_exceeded` | The project chain would exceed 5 levels |
| 422 | `linked_item_move` | Workspace change on a linked child or a project with children |
| 409 | `project_has_linked_items` | Delete without `unlinkChildren=true`, or kind change away from `project` |

In batch `PUT /api/notes`, relationship failures are per-item results (ADR 002 response shape), not whole-batch failures.

### 8. Data scope and logging hygiene

- **Decided by Tony, 2026-10-13:** Orbit will never contain HIPAA/PHI data, Waltz workspaces included. HIPAA compliance scope does not apply to Orbit, and no `@phi` column annotations are added.
- Hygiene rules still apply: relationship errors and logs carry item IDs only, never titles or bodies. Trigger messages are fixed codes.
- `waiting_on` / `waiting_for` are free text sent to a model provider only under the same `workspaces.agent_enabled` gate as other note text (`20261010000000_agent.sql`), and only when an agent actually needs them (minimum-necessary context).

## Consequences

- Legacy rows, captures and old clients keep working unchanged at every step; new semantics are opt-in per item.
- Project membership is guaranteed by the database for every writer, including the service-role admin client used by capture and the agent.
- One parent project per item is a real limitation; many-to-many relations wait for K-01. Nested-project roll-ups cost bounded recursive queries (max depth 5).
- Cross-workspace moves of linked items now need an explicit unlink, which is a UX change that U-02 must handle.
- D-02 must update every serialization site listed in §5 together, and add tests for: legacy note without new fields round-trips unchanged; missing `kind` on update does not reset it; cross-workspace link, self-link and link to a non-project are rejected; nested projects up to 5 levels are accepted and a 6th level is rejected (`project_depth_exceeded`), including when moving a project that has its own subtree; **cycles are rejected** for a two-node cycle (A→B→A) and a longer one (A→B→C→A), plus a concurrency test where two transactions re-parent projects toward each other and only one succeeds; project delete with children is blocked without `unlinkChildren`, and with it, direct children move up to the grandparent and deeper descendants are unchanged; agent `kind` changes on non-pending existing notes are refused; agent cross-workspace `project_id` is refused; undo of an agent `project_id` change that would now form a cycle returns `undo_conflict`.
- `ON DELETE SET NULL (column)` needs PostgreSQL 15 or newer. **Verified by lead, 2026-10-13: server_version 17.11.**

## Alternatives considered

- **New `items` table with a data copy or a view over `notes`.** Requires dual-writes or a cutover across every writer (browser, Slack, email, agent, v1 API) at once. Rejected by the plan's "no simultaneous rename and rewrite" constraint.
- **Derive kind from bucket.** Simple, but conflates "what it is" with "where it is in GTD"; moving a task to Someday would change its type. Rejected.
- **Bulk reclassify existing rows by bucket.** Silent and lossy (a `projects` bucket row might be a note about a project). Rejected in favor of suggestions.
- **`item_links` join table now.** More general, but the cross-workspace rule needs composite FKs on both ends and the UI only needs one parent. Deferred to K-01.
- **Validate links only in the API.** The admin client used by capture and the agent bypasses RLS, so a database constraint is the only check every writer hits. Rejected.
- **Store reminder time as a timestamp column on `notes`.** Mixes date-only and instant semantics on one row and complicates D-04 dispatch. Rejected.

## Open questions

1. **Archive state for projects** beyond `completed_at`. **Does not block D-02.** *Decider: product. Blocks: project deletion UX in U-03.*
2. **Max nesting depth of 5** is proposed here; confirm or change. *Decider: Tony. Does not block D-02 (a single trigger constant).*

Resolved 2026-10-13: agent writes to `kind`/`project_id` (§3a), nested projects (§3) and follow-up fields on any kind (§4), each decided by Tony; Postgres version verified by lead (server_version 17.11).
