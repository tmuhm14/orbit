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
- The organizing agent (`lib/agent/agent.ts`) gains read-only visibility of `kind` in `AgentNoteSummary` in D-02. Whether `update_note` may change `kind` or `project_id` is an open question; until decided it may not.

### 3. Project links: one parent project per item, enforced in the database

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

The composite FK follows the pattern already used for `workspace_id` and `agent_runs`, and makes cross-user and cross-workspace links impossible at the database level, whatever the writer. `on delete set null (project_id)` (PostgreSQL 15+ column list) clears only the link, never `workspace_id`/`user_id`.

A `before insert or update of project_id, kind` trigger, `notes_validate_project_link()` (`security invoker`, `search_path = ''`), enforces what an FK cannot:

| Rule | Rejection code |
| --- | --- |
| Target row has `kind = 'project'` | `invalid_project_link` |
| An item of kind `project` may not itself have a `project_id` (no nesting in v1) | `invalid_project_link` |
| An item may not stop being `kind = 'project'` while other items link to it | `project_has_linked_items` |

The trigger raises `check_violation` (SQLSTATE `23514`) with the code as the message; the API maps it (see Error contract). Messages never include titles or content.

**Relationship changes**

- Link / relink: set `project_id` with the expected revision of the *child* only. Linking does not change the project's revision.
- Unlink: set `project_id = null`.
- **Cross-workspace moves of linked items are rejected** in v1. Moving a child that still has `project_id` fails the composite FK; moving a project that still has children fails `on update restrict`. The API returns `422 linked_item_move` and the UI asks the user to unlink first. Same rule for items referenced by an active assignment (ADR 003).
- **Deleting a project** that has linked items: `DELETE /api/notes/:id` returns `409 project_has_linked_items` with a count. The client confirms and repeats with `unlinkChildren=true`; the delete function then clears `project_id` on each child (bumping each child's revision, ADR 002) and deletes the project in one transaction. The `on delete set null (project_id)` FK action is the backstop for any other delete path.
- **Archive:** there is no archive state. A completed project (`completed_at` set) is the archive equivalent; linked items keep their link. A dedicated archive flag is an open question.
- Agent undo of an agent-created project that has since gained children is a conflict, not a delete (ADR 002).

A many-to-many `item_links` table (backlinks, "related to", document ↔ project) is deferred to K-01 and will be additive to this column, not a replacement.

### 4. Follow-ups (D-03): who / what / next check, date-only

```sql
alter table public.notes
  add column waiting_on text check (char_length(waiting_on) <= 200),        -- @phi (person names)
  add column waiting_for text check (char_length(waiting_for) <= 2000),     -- @phi (expected deliverable)
  add column next_check_on date
    check (next_check_on is null or next_check_on between date '0001-01-01' and date '9999-12-31');
create index notes_next_check_idx on public.notes (user_id, next_check_on)
  where next_check_on is not null and completed_at is null;
```

- Fields are allowed on any kind (a `task` in `waiting` can carry them); the editor shows them for `followup` items and the `waiting` bucket. Changing `kind` does not clear them.
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
| `lib/agent/server.ts` agent `NoteRow` select | Read `kind`, `project_id`; agent tools stay as-is unless the open question is resolved. |
| `components/workspace.tsx` `exportNotes()` | Export `version: 2` including the new fields. There is no import-from-export path today; if one is added, it must accept versions 1 and 2. |

### 6. Migration sequence

Naming follows the existing `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql` convention (latest: `20261013000000_note_due_dates.sql`). Filenames are assigned now so agents do not collide; if a date slips, keep the order and bump the timestamp.

| Order | File | Ticket | Contents |
| --- | --- | --- | --- |
| 1 | `20261014000000_note_revisions.sql` | D-01 | ADR 002 |
| 2 | `20261014000100_note_write_functions.sql` | D-01 | ADR 002 |
| 3 | `20261015000000_note_kinds_and_project_links.sql` | D-02 | §2, §3: `kind`, `notes_id_workspace_user_key`, `project_id` + FK + trigger; `create or replace` the ADR 002 save/delete functions to accept `kind`, `project_id`, `unlinkChildren`; `@phi` column comments (below) |
| 4 | `20261016000000_note_followups_and_reminders.sql` | D-03 | §4: follow-up columns, `note_reminders` + RLS (owner select/insert/update/delete mirroring `notes`), revision trigger for reminders; `create or replace` save function for follow-up fields |
| 5 | `20261017000000_assignments.sql` | A-01 | ADR 003 |
| 6 | `20261021000000_note_write_enforcement.sql` | D-01 phase C | ADR 002 rollout; applied only after the rollout gate |

Every step is additive: new nullable or defaulted columns, new constraints that existing rows satisfy (all existing rows have `kind = 'note'` and `project_id = null`), new tables. The previous app version keeps reading and writing after each migration. No destructive down-migrations; rollback is a code rollback that leaves the new columns unused.

### 7. Error contract additions

Existing note routes return `{ error: string }`. Responses gain an optional machine-readable `code`; `error` stays a short, generic, user-safe sentence.

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `invalid_payload` | Shape/limits fail `isSavableNote()` (existing behavior; whole batch rejected) |
| 422 | `invalid_project_link` | Target missing, not a project, other workspace/user, self-link, or nested project |
| 422 | `linked_item_move` | Workspace change on a linked child or a project with children |
| 409 | `project_has_linked_items` | Delete without `unlinkChildren=true`, or kind change away from `project` |

In batch `PUT /api/notes`, relationship failures are per-item results (ADR 002 response shape), not whole-batch failures.

### 8. PHI handling

- PHI-capable columns get `comment on column ... is '@phi'` in migration 3, the SQL equivalent of the repository's Drizzle `// @phi` rule: `title`, `content`, `plain_text`, `tags`, `origin`, `source_ref` (email message ids), and in migration 4 `waiting_on`, `waiting_for`. `kind`, `bucket`, `project_id`, dates and revisions are not PHI by themselves.
- Relationship errors and logs carry item IDs only, never titles. Trigger messages are fixed codes.
- `waiting_on` may hold a patient's or member's name in a work workspace. It is sent to a model provider only under the same `workspaces.agent_enabled` gate as other note text (`20261010000000_agent.sql`).

## Consequences

- Legacy rows, captures and old clients keep working unchanged at every step; new semantics are opt-in per item.
- Project membership is guaranteed by the database for every writer, including the service-role admin client used by capture and the agent.
- One project per item is a real limitation; many-to-many relations wait for K-01.
- Cross-workspace moves of linked items now need an explicit unlink, which is a UX change that U-02 must handle.
- D-02 must update every serialization site listed in §5 together, and add tests for: legacy note without new fields round-trips unchanged; missing `kind` on update does not reset it; cross-workspace link, self-link, link to a non-project and nested project are all rejected; project delete with children is blocked without `unlinkChildren`.
- `ON DELETE SET NULL (column)` needs PostgreSQL 15 or newer on the Supabase project (verify before D-02).

## Alternatives considered

- **New `items` table with a data copy or a view over `notes`.** Requires dual-writes or a cutover across every writer (browser, Slack, email, agent, v1 API) at once. Rejected by the plan's "no simultaneous rename and rewrite" constraint.
- **Derive kind from bucket.** Simple, but conflates "what it is" with "where it is in GTD"; moving a task to Someday would change its type. Rejected.
- **Bulk reclassify existing rows by bucket.** Silent and lossy (a `projects` bucket row might be a note about a project). Rejected in favor of suggestions.
- **`item_links` join table now.** More general, but the cross-workspace rule needs composite FKs on both ends and the UI only needs one parent. Deferred to K-01.
- **Validate links only in the API.** The admin client used by capture and the agent bypasses RLS, so a database constraint is the only check every writer hits. Rejected.
- **Store reminder time as a timestamp column on `notes`.** Mixes date-only and instant semantics on one row and complicates D-04 dispatch. Rejected.

## Open questions

1. **Agent writes to `kind` / `project_id`.** May the organizing agent set them (and so suggest projects/tasks during triage)? Default proposed: no in D-02, revisit after U-02. *Decider: Tony. Blocks: D-02 agent tool scope.*
2. **Nested projects / sub-projects.** Proposed: not in v1. *Decider: Tony/product.*
3. **Archive state for projects** beyond `completed_at`. *Decider: product. Blocks: project deletion UX in U-03.*
4. **Follow-up fields only on `kind = 'followup'`?** Proposed: allowed on any kind. *Decider: product.*
5. **Should Waltz (work) workspaces be in HIPAA scope at all**, i.e. may they hold PHI? This sets whether `@phi` columns need access auditing (ADR 004) now or later. *Decider: Tony + compliance.*
6. **Supabase Postgres version** supports `ON DELETE SET NULL (column)` — confirm, otherwise use a trigger. *Owner: Lead before D-02.*
