-- Assignments: delegated outcome work, separate from organizing runs (ADR 003,
-- A-01). Purely additive: new tables, indexes, triggers on the new tables and
-- new functions only. No existing table, column, policy or function changes,
-- so it is safe to apply while the previous app version is live; nothing
-- reads these tables until the assignment routes ship.
--
-- Consequences for existing writers (no code change, enforced by foreign
-- keys on the new tables): an item that is the source or a selected context
-- item of any assignment cannot move to another workspace (save_notes returns
-- its per-item `invalid_note` result), because the composite keys are
-- `on update restrict` (ADR 003 §1). Deleting such an item is allowed; the
-- reference becomes null and the assignment is kept.
--
-- Rules:
-- - Every row carries user_id and workspace_id, tied by composite foreign keys
--   to its assignment, which is tied to its workspace and source item; context
--   items are tied to the same workspace and user. Cross-account and
--   cross-workspace references are impossible, not just unchecked.
-- - Owners read their own rows (RLS). Nobody writes the tables directly: all
--   writes go through the security-definer functions below. User-facing
--   functions are granted to authenticated and scope every row to auth.uid();
--   executor and system functions are service_role only.
-- - assignments.state changes only along a row of assignment_transitions, for
--   the actor the calling function declares (a transaction-local setting).
--   Every accepted transition bumps revision and appends a state_changed event.
-- - assignment_events is append-only, even for service_role; rows go only
--   with their assignment (cascade).
-- - The executor's lease token fences every executor write: after cancel,
--   expiry or a newer attempt, an old token gets `lease_lost` and writes
--   nothing. Lease tokens are never readable by browsers.
-- - Intent vs data: requested_outcome, question answers and request_changes
--   comments are user-authored and are the only intent an executor may act on.
--   The source item and selected context items are captured content, stored
--   with content_role = 'untrusted_data', and are data, never instructions.
-- - Errors and results are fixed codes; nothing here puts outcomes, questions,
--   answers, artifact bodies or item content into an error message.
--
-- Decisions (Tony, 2026-10-14): any item kind may be delegated; at most one
-- non-terminal assignment per source item; reject ends in canceled with a
-- reject review; artifacts are kept (no purge); interim lease 90 s with a 30 s
-- heartbeat (constants in lib/assignments). Before durable execution (A-04)
-- an expired lease ends in failed/timed_out (T6); T7 is in the table but no
-- function performs it yet.

-- Reference data: the approved transition table (ADR 003 §2). ---------------

create table public.assignment_transitions (
  from_state text not null,
  to_state text not null,
  actor text not null check (actor in ('user', 'executor', 'system')),
  code text not null check (code ~ '^T[0-9]{1,2}$'),
  primary key (from_state, to_state, actor)
);
insert into public.assignment_transitions (code, from_state, to_state, actor) values
  ('T1',  'queued',       'running',      'executor'),
  ('T2',  'queued',       'canceled',     'user'),
  ('T3',  'running',      'needs_input',  'executor'),
  ('T4',  'running',      'needs_review', 'executor'),
  ('T5',  'running',      'failed',       'executor'),
  ('T6',  'running',      'failed',       'system'),
  ('T7',  'running',      'queued',       'system'),
  ('T8',  'running',      'canceled',     'user'),
  ('T9',  'needs_input',  'queued',       'user'),
  ('T10', 'needs_input',  'canceled',     'user'),
  ('T11', 'needs_review', 'completed',    'user'),
  ('T12', 'needs_review', 'queued',       'user'),
  ('T13', 'needs_review', 'canceled',     'user'),
  ('T14', 'failed',       'queued',       'user'),
  ('T15', 'queued',       'failed',       'system'),
  ('T16', 'needs_input',  'failed',       'system'),
  ('T16', 'needs_review', 'failed',       'system');

-- Tables. --------------------------------------------------------------------

-- One delegated outcome. source_note_id is null only after the item is
-- deleted. Any item kind may be delegated. state is the user-facing
-- lifecycle; error_code is set exactly when state is failed.
create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  source_note_id uuid,
  requested_outcome text not null
    constraint assignments_requested_outcome_check
    check (char_length(btrim(requested_outcome)) between 1 and 4000),
  executor_kind text not null default 'builtin'
    check (executor_kind in ('builtin', 'external')),
  executor_id uuid,
  capabilities text[] not null default '{workspace.read,assignment.execute}'
    constraint assignments_capabilities_check
    check (cardinality(capabilities) between 1 and 5
           and capabilities <@ array['workspace.read', 'item.write', 'assignment.execute',
                                     'external.read', 'external.write']),
  context_scope text not null default 'selected' check (context_scope in ('selected')),
  state text not null default 'queued'
    constraint assignments_state_check
    check (state in ('queued', 'running', 'needs_input', 'needs_review',
                     'completed', 'failed', 'canceled')),
  revision bigint not null default 1,
  current_attempt_id uuid,
  max_attempts smallint not null default 1 check (max_attempts between 1 and 5),
  error_code text
    constraint assignments_error_code_check
    check (error_code in ('provider_auth', 'provider_rate_limited', 'provider_unavailable',
                          'budget_exhausted', 'timed_out', 'context_unavailable',
                          'capability_revoked', 'executor_unavailable', 'internal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (id, workspace_id, user_id),
  constraint assignments_failed_has_code check ((state = 'failed') = (error_code is not null)),
  constraint assignments_builtin_has_no_executor check (executor_kind = 'external' or executor_id is null),
  constraint assignments_workspace_fk foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id) on delete cascade,
  constraint assignments_source_fk foreign key (source_note_id, workspace_id, user_id)
    references public.notes (id, workspace_id, user_id)
    on update restrict on delete set null (source_note_id)
);
-- At most one non-terminal (queued, running, needs_input, needs_review)
-- assignment per source item. failed is excluded: a failed assignment can be
-- retried only while no other one is active.
create unique index assignments_one_active_per_source on public.assignments (source_note_id)
  where state in ('queued', 'running', 'needs_input', 'needs_review');
create index assignments_workspace_idx on public.assignments (workspace_id, created_at desc);
create index assignments_user_state_idx on public.assignments (user_id, state);

-- The items the user explicitly selected, in the assignment's workspace (the
-- shared workspace_id/user_id in both keys guarantees it). At most 20 per
-- assignment (create_assignment). Their content is data, never instructions.
create table public.assignment_context_items (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  user_id uuid not null,
  workspace_id uuid not null,
  note_id uuid,
  position smallint not null check (position between 1 and 20),
  revision_at_selection bigint not null,
  content_role text not null default 'untrusted_data'
    check (content_role = 'untrusted_data'),
  created_at timestamptz not null default now(),
  unique (assignment_id, position),
  constraint assignment_context_assignment_fk foreign key (assignment_id, workspace_id, user_id)
    references public.assignments (id, workspace_id, user_id) on delete cascade,
  constraint assignment_context_note_fk foreign key (note_id, workspace_id, user_id)
    references public.notes (id, workspace_id, user_id)
    on update restrict on delete set null (note_id)
);
create unique index assignment_context_unique on public.assignment_context_items (assignment_id, note_id)
  where note_id is not null;
create index assignment_context_note_idx on public.assignment_context_items (note_id)
  where note_id is not null;

-- Execution tries. lease_token is a fencing credential: never logged, never
-- selectable by authenticated (column grants below).
create table public.assignment_attempts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  user_id uuid not null,
  workspace_id uuid not null,
  attempt_number smallint not null check (attempt_number >= 1),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'waiting', 'failed', 'canceled', 'expired')),
  lease_token uuid not null default gen_random_uuid(),
  lease_seconds integer not null check (lease_seconds between 15 and 600),
  lease_expires_at timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  provider text check (char_length(provider) <= 50),
  model text check (char_length(model) <= 100),
  usage jsonb check (usage is null or pg_column_size(usage) <= 2048),
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (assignment_id, attempt_number),
  unique (id, assignment_id),
  constraint assignment_attempts_assignment_fk foreign key (assignment_id, workspace_id, user_id)
    references public.assignments (id, workspace_id, user_id) on delete cascade
);
create unique index assignment_one_running_attempt
  on public.assignment_attempts (assignment_id) where status = 'running';
create index assignment_attempts_lease_idx on public.assignment_attempts (lease_expires_at)
  where status = 'running';

-- Append-only timeline and audit trail. Payloads hold ids, codes and short
-- executor progress text (<= 280 characters, untrusted when rendered); never
-- prompts, answers, model transcripts or item bodies.
create table public.assignment_events (
  id bigint generated always as identity primary key,
  assignment_id uuid not null,
  attempt_id uuid,
  user_id uuid not null,
  workspace_id uuid not null,
  type text not null check (type in ('state_changed', 'progress', 'question_asked',
    'question_answered', 'artifact_submitted', 'review_decided', 'cancel_requested',
    'context_unavailable')),
  actor text not null check (actor in ('user', 'executor', 'system')),
  from_state text,
  to_state text,
  payload jsonb not null default '{}'
    check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192),
  created_at timestamptz not null default now(),
  constraint assignment_events_assignment_fk foreign key (assignment_id, workspace_id, user_id)
    references public.assignments (id, workspace_id, user_id) on delete cascade,
  constraint assignment_events_attempt_fk foreign key (attempt_id, assignment_id)
    references public.assignment_attempts (id, assignment_id) on delete set null (attempt_id)
);
create index assignment_events_assignment_idx on public.assignment_events (assignment_id, id);

-- Executor questions. answer is user-authored intent. A question is open
-- until answered, or closed unanswered when the assignment is canceled or
-- failed; at most one open question per assignment.
create table public.assignment_questions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  attempt_id uuid not null,
  user_id uuid not null,
  workspace_id uuid not null,
  prompt text not null check (char_length(btrim(prompt)) between 1 and 2000),
  answer text check (char_length(btrim(answer)) between 1 and 4000),
  asked_at timestamptz not null default now(),
  answered_at timestamptz,
  closed_at timestamptz,
  constraint assignment_questions_answered_check check ((answer is null) = (answered_at is null)),
  constraint assignment_questions_assignment_fk foreign key (assignment_id, workspace_id, user_id)
    references public.assignments (id, workspace_id, user_id) on delete cascade,
  constraint assignment_questions_attempt_fk foreign key (attempt_id, assignment_id)
    references public.assignment_attempts (id, assignment_id) on delete cascade
);
create unique index assignment_one_open_question on public.assignment_questions (assignment_id)
  where answered_at is null and closed_at is null;

-- Prepared drafts and summaries. Kept for the life of the assignment,
-- including after reject or cancel (no purge). Only the latest
-- non-superseded artifact can be reviewed.
create table public.assignment_artifacts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  attempt_id uuid not null,
  user_id uuid not null,
  workspace_id uuid not null,
  kind text not null check (kind in ('draft', 'summary')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  content jsonb not null
    check (jsonb_typeof(content) = 'object' and pg_column_size(content) <= 524288),
  plain_text text not null default '' check (char_length(plain_text) <= 100000),
  source_note_ids uuid[] not null default '{}' check (cardinality(source_note_ids) <= 21),
  saved_note_id uuid references public.notes (id) on delete set null,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, assignment_id),
  constraint assignment_artifacts_assignment_fk foreign key (assignment_id, workspace_id, user_id)
    references public.assignments (id, workspace_id, user_id) on delete cascade,
  constraint assignment_artifacts_attempt_fk foreign key (attempt_id, assignment_id)
    references public.assignment_attempts (id, assignment_id) on delete cascade
);
create unique index assignment_one_current_artifact on public.assignment_artifacts (assignment_id)
  where superseded_at is null;

-- Review decisions, each with the artifact it judged. comment is
-- user-authored intent; required for request_changes.
create table public.assignment_reviews (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  artifact_id uuid not null,
  user_id uuid not null,
  workspace_id uuid not null,
  decision text not null check (decision in ('accept', 'request_changes', 'reject')),
  comment text check (char_length(btrim(comment)) between 1 and 4000),
  decided_at timestamptz not null default now(),
  constraint assignment_reviews_comment_required
    check (decision <> 'request_changes' or comment is not null),
  constraint assignment_reviews_assignment_fk foreign key (assignment_id, workspace_id, user_id)
    references public.assignments (id, workspace_id, user_id) on delete cascade,
  constraint assignment_reviews_artifact_fk foreign key (artifact_id, assignment_id)
    references public.assignment_artifacts (id, assignment_id) on delete cascade
);
create index assignment_reviews_assignment_idx on public.assignment_reviews (assignment_id, decided_at);

-- Access: owner-only reads, no direct writes for anyone. ----------------------

alter table public.assignment_transitions enable row level security;
alter table public.assignments enable row level security;
alter table public.assignment_context_items enable row level security;
alter table public.assignment_attempts enable row level security;
alter table public.assignment_events enable row level security;
alter table public.assignment_questions enable row level security;
alter table public.assignment_artifacts enable row level security;
alter table public.assignment_reviews enable row level security;

create policy "Signed-in users read the transition table" on public.assignment_transitions
  for select to authenticated using (true);
create policy "Users read their own assignments" on public.assignments
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own assignment context" on public.assignment_context_items
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own assignment attempts" on public.assignment_attempts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own assignment events" on public.assignment_events
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own assignment questions" on public.assignment_questions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own assignment artifacts" on public.assignment_artifacts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own assignment reviews" on public.assignment_reviews
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.assignment_transitions, public.assignments,
  public.assignment_context_items, public.assignment_attempts, public.assignment_events,
  public.assignment_questions, public.assignment_artifacts, public.assignment_reviews
  from public, anon, authenticated, service_role;
grant select on public.assignment_transitions, public.assignments,
  public.assignment_context_items, public.assignment_events, public.assignment_questions,
  public.assignment_artifacts, public.assignment_reviews
  to authenticated, service_role;
-- Every attempt column except lease_token.
grant select (id, assignment_id, user_id, workspace_id, attempt_number, status,
  lease_seconds, lease_expires_at, heartbeat_at, provider, model, usage, error_code,
  started_at, finished_at)
  on public.assignment_attempts to authenticated;
grant select on public.assignment_attempts to service_role;

-- Guards. ----------------------------------------------------------------------

-- Every write to assignments: inserts start queued at revision 1; updates may
-- change state only along assignment_transitions for the declared actor
-- (orbit.assignment_actor, set by assignment_move()), and may otherwise only
-- detach a deleted source item. Each update bumps revision. Raises
-- check_violation with a fixed code: invalid_transition, assignment_immutable.
create function public.assignments_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_actor text := nullif(current_setting('orbit.assignment_actor', true), '');
begin
  if tg_op = 'INSERT' then
    new.state := 'queued';
    new.error_code := null;
    new.revision := 1;
    new.current_attempt_id := null;
    new.created_at := now();
    new.updated_at := now();
    new.state_changed_at := now();
    new.finished_at := null;
    return new;
  end if;
  if (new.id, new.user_id, new.workspace_id, new.requested_outcome, new.executor_kind,
      new.executor_id, new.capabilities, new.context_scope, new.max_attempts, new.created_at)
     is distinct from
     (old.id, old.user_id, old.workspace_id, old.requested_outcome, old.executor_kind,
      old.executor_id, old.capabilities, old.context_scope, old.max_attempts, old.created_at)
     or (new.source_note_id is distinct from old.source_note_id and new.source_note_id is not null) then
    raise exception 'assignment_immutable' using errcode = '23514';
  end if;
  if new.state is distinct from old.state then
    if v_actor is null or not exists (
      select 1 from public.assignment_transitions t
      where t.from_state = old.state and t.to_state = new.state and t.actor = v_actor) then
      raise exception 'invalid_transition' using errcode = '23514';
    end if;
    new.state_changed_at := now();
    new.finished_at := case when new.state in ('completed', 'canceled', 'failed') then now() end;
  elsif (new.error_code, new.current_attempt_id, new.state_changed_at, new.finished_at)
        is distinct from
        (old.error_code, old.current_attempt_id, old.state_changed_at, old.finished_at) then
    raise exception 'assignment_immutable' using errcode = '23514';
  end if;
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.assignments_guard() from public, anon, authenticated, service_role;
create trigger assignments_guard before insert or update on public.assignments
  for each row execute function public.assignments_guard();

-- Appends the state_changed event for every accepted transition, with the
-- actor that made it.
create function public.assignments_record_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.assignment_events (assignment_id, attempt_id, user_id, workspace_id,
    type, actor, from_state, to_state, payload)
  values (new.id, new.current_attempt_id, new.user_id, new.workspace_id, 'state_changed',
    current_setting('orbit.assignment_actor', true), old.state, new.state,
    jsonb_strip_nulls(jsonb_build_object('revision', new.revision, 'errorCode', new.error_code)));
  return null;
end $$;
revoke execute on function public.assignments_record_transition() from public, anon, authenticated, service_role;
create trigger assignments_record_transition after update on public.assignments
  for each row when (old.state is distinct from new.state)
  execute function public.assignments_record_transition();

-- Events are never updated or deleted, by any role, except when their
-- assignment is deleted (cascade from the assignment, its workspace or the
-- account): by then the assignment row is gone.
create function public.assignment_events_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'assignment_events_append_only' using errcode = '42501';
  end if;
  if exists (select 1 from public.assignments a where a.id = old.assignment_id) then
    raise exception 'assignment_events_append_only' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
revoke execute on function public.assignment_events_append_only() from public, anon, authenticated, service_role;
create trigger assignment_events_append_only before update or delete on public.assignment_events
  for each row execute function public.assignment_events_append_only();
create trigger assignment_events_no_truncate before truncate on public.assignment_events
  for each statement execute function public.assignment_events_append_only();

-- Helpers, callable only from the functions below. -----------------------------

-- The client-visible columns of an assignment.
create function public.assignment_json(a public.assignments) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'workspace_id', a.workspace_id, 'source_note_id', a.source_note_id,
    'requested_outcome', a.requested_outcome, 'executor_kind', a.executor_kind,
    'capabilities', to_jsonb(a.capabilities), 'context_scope', a.context_scope,
    'state', a.state, 'revision', a.revision, 'current_attempt_id', a.current_attempt_id,
    'max_attempts', a.max_attempts, 'error_code', a.error_code,
    'created_at', a.created_at, 'updated_at', a.updated_at,
    'state_changed_at', a.state_changed_at, 'finished_at', a.finished_at)
$$;
revoke execute on function public.assignment_json(public.assignments) from public, anon, authenticated, service_role;

-- Target states the transition table allows from p_from for p_actor.
create function public.assignment_allowed(p_from text, p_actor text) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(t.to_state order by t.to_state), '{}'::text[])
  from public.assignment_transitions t
  where t.from_state = p_from and t.actor = p_actor
$$;
revoke execute on function public.assignment_allowed(text, text) from public, anon, authenticated, service_role;

create function public.assignment_invalid_transition(p_from text, p_to text, p_actor text)
returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('status', 'invalid_transition', 'from', p_from, 'to', p_to,
    'allowed', to_jsonb(public.assignment_allowed(p_from, p_actor)))
$$;
revoke execute on function public.assignment_invalid_transition(text, text, text) from public, anon, authenticated, service_role;

-- The one way state changes: declares the actor for the guard trigger,
-- updates, and clears the declaration. The trigger rejects anything not in
-- the transition table. p_attempt, when given, becomes current_attempt_id.
create function public.assignment_move(p_id uuid, p_to text, p_actor text,
  p_error_code text default null, p_attempt uuid default null)
returns public.assignments
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.assignments;
begin
  perform set_config('orbit.assignment_actor', p_actor, true);
  update public.assignments set state = p_to, error_code = p_error_code,
    current_attempt_id = coalesce(p_attempt, current_attempt_id)
  where id = p_id
  returning * into v_row;
  perform set_config('orbit.assignment_actor', '', true);
  return v_row;
end $$;
revoke execute on function public.assignment_move(uuid, text, text, text, uuid) from public, anon, authenticated, service_role;

create function public.assignment_event(a public.assignments, p_type text, p_actor text,
  p_payload jsonb default '{}', p_attempt uuid default null)
returns void
language sql security definer set search_path = '' as $$
  insert into public.assignment_events (assignment_id, attempt_id, user_id, workspace_id,
    type, actor, payload)
  values (a.id, p_attempt, a.user_id, a.workspace_id, p_type, p_actor, coalesce(p_payload, '{}'))
$$;
revoke execute on function public.assignment_event(public.assignments, text, text, jsonb, uuid) from public, anon, authenticated, service_role;

-- Whether the built-in executor can run in a workspace today (the ADR 004 §4
-- static policy, same checks as createRun()): the workspace switch is on and
-- the account has a saved model key.
create function public.assignment_builtin_available(p_workspace_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspaces w
                 where w.id = p_workspace_id and w.user_id = p_user_id and w.agent_enabled)
     and exists (select 1 from public.agent_settings s where s.user_id = p_user_id)
$$;
revoke execute on function public.assignment_builtin_available(uuid, uuid) from public, anon, authenticated, service_role;

-- Locks and checks an executor's lease: the attempt must be the assignment's
-- current, running attempt, the token must match and the lease must not have
-- expired. Locks the assignment before the attempt (the order cancel uses).
-- Returns the assignment, or null for lease_lost.
create function public.assignment_lease(p_attempt_id uuid, p_lease_token uuid)
returns public.assignments
language plpgsql security definer set search_path = '' as $$
declare
  v_assignment_id uuid;
  v_row public.assignments;
  v_attempt public.assignment_attempts;
begin
  select t.assignment_id into v_assignment_id from public.assignment_attempts t
    where t.id = p_attempt_id;
  if not found or p_lease_token is null then
    return null;
  end if;
  select * into v_row from public.assignments where id = v_assignment_id for update;
  select * into v_attempt from public.assignment_attempts where id = p_attempt_id for update;
  if v_row.state <> 'running' or v_row.current_attempt_id is distinct from v_attempt.id
     or v_attempt.status <> 'running' or v_attempt.lease_token <> p_lease_token
     or v_attempt.lease_expires_at <= now() then
    return null;
  end if;
  return v_row;
end $$;
revoke execute on function public.assignment_lease(uuid, uuid) from public, anon, authenticated, service_role;

-- Closes an open question unanswered (cancel, system failure).
create function public.assignment_close_question(p_assignment_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.assignment_questions set closed_at = now()
  where assignment_id = p_assignment_id and answered_at is null and closed_at is null
$$;
revoke execute on function public.assignment_close_question(uuid) from public, anon, authenticated, service_role;

-- User functions (authenticated). ---------------------------------------------
-- Results (status) shared by these functions:
--   not_found                no such assignment / item for this user (another
--                            account's rows look exactly like missing ones)
--   invalid_payload          argument shape or limits
--   conflict { currentRevision, state }   p_expected_revision is stale
--   invalid_transition { from, to, allowed }   not allowed from this state

-- Delegates p_source_note_id (any kind) with a user-authored outcome and up
-- to 20 explicitly selected context items from the same workspace. Results:
--   created { assignment }
--   not_found                source item not in this user's p_workspace_id
--   invalid_payload          outcome empty or > 4000, > 20 or duplicate ids
--   invalid_context          a context id is not one of this user's items in
--                            the workspace (missing, other account or other
--                            workspace look alike), or is the source item
--   capability_denied        executor or capabilities outside the static
--                            policy (builtin: workspace.read, assignment.execute)
--   agent_disabled           workspace switch off, or no saved model key
--   active_assignment_exists { assignmentId }   the item already has one
create function public.create_assignment(p_workspace_id uuid, p_source_note_id uuid,
  p_requested_outcome text, p_context_note_ids uuid[], p_executor_kind text,
  p_capabilities text[])
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_context uuid[] := coalesce(p_context_note_ids, '{}'::uuid[]);
  v_caps text[];
  v_source public.notes;
  v_row public.assignments;
  v_found integer;
  v_existing uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_requested_outcome is null or char_length(btrim(p_requested_outcome)) not between 1 and 4000
     or cardinality(v_context) > 20 or array_position(v_context, null) is not null
     or (select count(distinct c) from unnest(v_context) c) <> cardinality(v_context)
     or p_executor_kind is null or p_executor_kind not in ('builtin', 'external')
     or (p_capabilities is not null and (cardinality(p_capabilities) = 0
         or array_position(p_capabilities, null) is not null)) then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  select * into v_source from public.notes
    where id = p_source_note_id and user_id = v_uid and workspace_id = p_workspace_id
    for share;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select count(*) into v_found from public.notes n
    where n.id = any (v_context) and n.user_id = v_uid and n.workspace_id = p_workspace_id;
  if v_found <> cardinality(v_context) or v_source.id = any (v_context) then
    return jsonb_build_object('status', 'invalid_context');
  end if;
  v_caps := array(select distinct c from unnest(coalesce(p_capabilities,
    array['workspace.read', 'assignment.execute'])) c order by c);
  -- External executors need grants (A-05); none can be granted yet.
  if p_executor_kind <> 'builtin'
     or not (v_caps <@ array['workspace.read', 'assignment.execute']) then
    return jsonb_build_object('status', 'capability_denied');
  end if;
  if not public.assignment_builtin_available(p_workspace_id, v_uid) then
    return jsonb_build_object('status', 'agent_disabled');
  end if;
  select a.id into v_existing from public.assignments a
    where a.source_note_id = v_source.id
      and a.state in ('queued', 'running', 'needs_input', 'needs_review');
  if found then
    return jsonb_build_object('status', 'active_assignment_exists', 'assignmentId', v_existing);
  end if;
  begin
    insert into public.assignments (user_id, workspace_id, source_note_id, requested_outcome,
      executor_kind, capabilities)
    values (v_uid, p_workspace_id, v_source.id, p_requested_outcome, p_executor_kind, v_caps)
    returning * into v_row;
  exception when unique_violation then
    select a.id into v_existing from public.assignments a
      where a.source_note_id = v_source.id
        and a.state in ('queued', 'running', 'needs_input', 'needs_review');
    return jsonb_build_object('status', 'active_assignment_exists', 'assignmentId', v_existing);
  end;
  insert into public.assignment_context_items (assignment_id, user_id, workspace_id, note_id,
    position, revision_at_selection)
  select v_row.id, v_uid, p_workspace_id, n.id, c.position, n.revision
  from unnest(v_context) with ordinality as c (id, position)
  join public.notes n on n.id = c.id;
  insert into public.assignment_events (assignment_id, user_id, workspace_id, type, actor,
    to_state, payload)
  values (v_row.id, v_uid, p_workspace_id, 'state_changed', 'user', 'queued',
    jsonb_build_object('revision', 1, 'contextCount', cardinality(v_context)));
  return jsonb_build_object('status', 'created', 'assignment', public.assignment_json(v_row));
end $$;

-- User transitions that need no other input: cancel (T2, T8, T10) and retry
-- of a failed assignment (T14). A result waiting for review is declined
-- through review_assignment_artifact (reject, T13), never a bare cancel. p_payload is reserved and must be null or an
-- object. Cancel is immediate: a running attempt is canceled and its lease
-- revoked in this transaction, so the executor's next call gets lease_lost.
-- Results: saved { assignment }, not_found, invalid_payload, conflict,
-- invalid_transition, active_assignment_exists { assignmentId } (retry while
-- another assignment for the item is active).
create function public.transition_assignment(p_id uuid, p_expected_revision bigint,
  p_to_state text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.assignments;
  v_existing uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_to_state is null or p_to_state not in ('canceled', 'queued')
     or p_expected_revision is null
     or (p_payload is not null and jsonb_typeof(p_payload) <> 'object') then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  select * into v_row from public.assignments where id = p_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'currentRevision', v_row.revision,
      'state', v_row.state);
  end if;
  -- queued from needs_input / needs_review is an answer or a review, and
  -- canceled from needs_review is a reject review (T13), so it is recorded.
  if (p_to_state = 'queued' and v_row.state <> 'failed')
     or (p_to_state = 'canceled' and v_row.state = 'needs_review')
     or not (p_to_state = any (public.assignment_allowed(v_row.state, 'user'))) then
    return public.assignment_invalid_transition(v_row.state, p_to_state, 'user');
  end if;
  if p_to_state = 'canceled' then
    if v_row.state = 'running' then
      update public.assignment_attempts set status = 'canceled', finished_at = now(),
        lease_expires_at = now()
      where id = v_row.current_attempt_id and status = 'running';
    end if;
    perform public.assignment_close_question(v_row.id);
    perform public.assignment_event(v_row, 'cancel_requested', 'user', '{}', v_row.current_attempt_id);
    v_row := public.assignment_move(v_row.id, 'canceled', 'user');
  else
    begin
      v_row := public.assignment_move(v_row.id, 'queued', 'user');
    exception when unique_violation then
      select a.id into v_existing from public.assignments a
        where a.source_note_id = v_row.source_note_id
          and a.state in ('queued', 'running', 'needs_input', 'needs_review');
      return jsonb_build_object('status', 'active_assignment_exists', 'assignmentId', v_existing);
    end;
  end if;
  return jsonb_build_object('status', 'saved', 'assignment', public.assignment_json(v_row));
end $$;

-- Answers the open question (T9); the next claim starts a new attempt.
-- Results: saved { assignment }, not_found (also a question that is not this
-- assignment's open question), invalid_payload (answer empty or > 4000),
-- conflict, invalid_transition.
create function public.answer_assignment_question(p_id uuid, p_expected_revision bigint,
  p_question_id uuid, p_answer text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.assignments;
  v_question uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_expected_revision is null or p_question_id is null or p_answer is null
     or char_length(btrim(p_answer)) not between 1 and 4000 then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  select * into v_row from public.assignments where id = p_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'currentRevision', v_row.revision,
      'state', v_row.state);
  end if;
  if v_row.state <> 'needs_input' then
    return public.assignment_invalid_transition(v_row.state, 'queued', 'user');
  end if;
  update public.assignment_questions set answer = p_answer, answered_at = now()
  where id = p_question_id and assignment_id = v_row.id
    and answered_at is null and closed_at is null
  returning id into v_question;
  if v_question is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  perform public.assignment_event(v_row, 'question_answered', 'user',
    jsonb_build_object('questionId', v_question), v_row.current_attempt_id);
  v_row := public.assignment_move(v_row.id, 'queued', 'user');
  return jsonb_build_object('status', 'saved', 'assignment', public.assignment_json(v_row));
end $$;

-- Reviews the latest artifact: accept → completed (T11), request_changes →
-- queued (T12, comment required), reject → canceled (T13). Accepting never
-- changes the source item; completing it is a separate, ordinary item write.
-- Results: saved { assignment, reviewId }, not_found (also an artifact of
-- another assignment), invalid_payload, conflict, invalid_transition,
-- artifact_superseded (a newer artifact exists).
create function public.review_assignment_artifact(p_id uuid, p_expected_revision bigint,
  p_artifact_id uuid, p_decision text, p_comment text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.assignments;
  v_artifact public.assignment_artifacts;
  v_to text;
  v_review uuid;
  v_comment text := nullif(btrim(p_comment), '');
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_to := case p_decision when 'accept' then 'completed' when 'request_changes' then 'queued'
                          when 'reject' then 'canceled' end;
  if v_to is null or p_expected_revision is null or p_artifact_id is null
     or char_length(v_comment) > 4000
     or (p_decision = 'request_changes' and v_comment is null) then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  select * into v_row from public.assignments where id = p_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'currentRevision', v_row.revision,
      'state', v_row.state);
  end if;
  if v_row.state <> 'needs_review' then
    return public.assignment_invalid_transition(v_row.state, v_to, 'user');
  end if;
  select * into v_artifact from public.assignment_artifacts
    where id = p_artifact_id and assignment_id = v_row.id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_artifact.superseded_at is not null then
    return jsonb_build_object('status', 'artifact_superseded');
  end if;
  insert into public.assignment_reviews (assignment_id, artifact_id, user_id, workspace_id,
    decision, comment)
  values (v_row.id, v_artifact.id, v_uid, v_row.workspace_id, p_decision,
    v_comment)
  returning id into v_review;
  perform public.assignment_event(v_row, 'review_decided', 'user',
    jsonb_build_object('decision', p_decision, 'reviewId', v_review, 'artifactId', v_artifact.id),
    v_artifact.attempt_id);
  v_row := public.assignment_move(v_row.id, v_to, 'user');
  return jsonb_build_object('status', 'saved', 'assignment', public.assignment_json(v_row),
    'reviewId', v_review);
end $$;

-- Executor functions (service_role). --------------------------------------------
-- Every call after claim carries the attempt id and its lease token. Any
-- mismatch, expiry, cancel or newer attempt is `lease_lost` and writes nothing.

-- T1: starts a new attempt with a lease (default 90 s, 15–600). One running
-- assignment per workspace for the built-in executor. Results:
--   claimed { attemptId, leaseToken, leaseExpiresAt, attemptNumber }
--   not_found, invalid_payload, invalid_transition (not queued),
--   agent_disabled (static policy fails; the assignment stays queued until
--   the reaper or the executor fails it with T15), executor_busy
create function public.claim_assignment(p_id uuid, p_lease_seconds integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.assignments;
  v_seconds integer := coalesce(p_lease_seconds, 90);
  v_attempt public.assignment_attempts;
begin
  if v_seconds not between 15 and 600 then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  select * into v_row from public.assignments where id = p_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- Serializes claims within a workspace, then locks the assignment.
  perform 1 from public.workspaces where id = v_row.workspace_id for update;
  select * into v_row from public.assignments where id = p_id for update;
  if v_row.state <> 'queued' then
    return public.assignment_invalid_transition(v_row.state, 'running', 'executor');
  end if;
  if v_row.executor_kind = 'builtin'
     and not public.assignment_builtin_available(v_row.workspace_id, v_row.user_id) then
    return jsonb_build_object('status', 'agent_disabled');
  end if;
  if exists (select 1 from public.assignments a
             where a.workspace_id = v_row.workspace_id and a.state = 'running'
               and a.executor_kind = v_row.executor_kind and a.id <> v_row.id) then
    return jsonb_build_object('status', 'executor_busy');
  end if;
  insert into public.assignment_attempts (assignment_id, user_id, workspace_id, attempt_number,
    lease_seconds, lease_expires_at)
  values (v_row.id, v_row.user_id, v_row.workspace_id,
    coalesce((select max(t.attempt_number) from public.assignment_attempts t
              where t.assignment_id = v_row.id), 0) + 1,
    v_seconds, now() + make_interval(secs => v_seconds))
  returning * into v_attempt;
  perform public.assignment_move(v_row.id, 'running', 'executor', null, v_attempt.id);
  return jsonb_build_object('status', 'claimed', 'attemptId', v_attempt.id,
    'leaseToken', v_attempt.lease_token, 'leaseExpiresAt', v_attempt.lease_expires_at,
    'attemptNumber', v_attempt.attempt_number);
end $$;

-- Extends the lease by its length; with p_progress (<= 280 characters,
-- untrusted) also appends a progress event. Results: ok { leaseExpiresAt },
-- invalid_payload, lease_lost.
create function public.heartbeat_assignment(p_attempt_id uuid, p_lease_token uuid,
  p_progress text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.assignments;
  v_progress text := nullif(btrim(p_progress), '');
  v_expires timestamptz;
begin
  if char_length(v_progress) > 280 then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  v_row := public.assignment_lease(p_attempt_id, p_lease_token);
  if v_row.id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  update public.assignment_attempts
    set heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => lease_seconds)
  where id = p_attempt_id
  returning lease_expires_at into v_expires;
  if v_progress is not null then
    perform public.assignment_event(v_row, 'progress', 'executor',
      jsonb_build_object('text', v_progress), p_attempt_id);
  end if;
  return jsonb_build_object('status', 'ok', 'leaseExpiresAt', v_expires);
end $$;

-- T3: asks the user one question (<= 2000 characters); the attempt ends
-- waiting. Results: asked { questionId }, invalid_payload, lease_lost.
create function public.ask_assignment_question(p_attempt_id uuid, p_lease_token uuid,
  p_prompt text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.assignments;
  v_question uuid;
begin
  if p_prompt is null or char_length(btrim(p_prompt)) not between 1 and 2000 then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  v_row := public.assignment_lease(p_attempt_id, p_lease_token);
  if v_row.id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  insert into public.assignment_questions (assignment_id, attempt_id, user_id, workspace_id, prompt)
  values (v_row.id, p_attempt_id, v_row.user_id, v_row.workspace_id, p_prompt)
  returning id into v_question;
  update public.assignment_attempts set status = 'waiting', finished_at = now()
  where id = p_attempt_id;
  perform public.assignment_event(v_row, 'question_asked', 'executor',
    jsonb_build_object('questionId', v_question), p_attempt_id);
  perform public.assignment_move(v_row.id, 'needs_input', 'executor');
  return jsonb_build_object('status', 'asked', 'questionId', v_question);
end $$;

-- T4: submits the result for review and supersedes earlier artifacts.
-- p_artifact: { kind: draft|summary, title (1–200), content (Tiptap doc
-- object), plain_text?, source_note_ids? }. Cited ids must be the source
-- item or selected context items of this assignment, whatever the model
-- says. Results: submitted { artifactId }, invalid_payload, invalid_context,
-- lease_lost.
create function public.submit_assignment_artifact(p_attempt_id uuid, p_lease_token uuid,
  p_artifact jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.assignments;
  v_cited uuid[];
  v_artifact uuid;
begin
  if jsonb_typeof(p_artifact) is distinct from 'object'
     or jsonb_typeof(p_artifact -> 'content') is distinct from 'object'
     or jsonb_typeof(p_artifact -> 'title') is distinct from 'string'
     or coalesce(jsonb_typeof(p_artifact -> 'plain_text'), 'string') <> 'string'
     or coalesce(jsonb_typeof(p_artifact -> 'source_note_ids'), 'array') <> 'array'
     or p_artifact ->> 'kind' is null or p_artifact ->> 'kind' not in ('draft', 'summary')
     or char_length(btrim(p_artifact ->> 'title')) not between 1 and 200 then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  begin
    v_cited := array(select distinct value::uuid
      from jsonb_array_elements_text(coalesce(p_artifact -> 'source_note_ids', '[]')));
  exception when data_exception then
    return jsonb_build_object('status', 'invalid_payload');
  end;
  v_row := public.assignment_lease(p_attempt_id, p_lease_token);
  if v_row.id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  if exists (select 1 from unnest(v_cited) c
             where c is distinct from v_row.source_note_id
               and not exists (select 1 from public.assignment_context_items x
                               where x.assignment_id = v_row.id and x.note_id = c)) then
    return jsonb_build_object('status', 'invalid_context');
  end if;
  begin
    update public.assignment_artifacts set superseded_at = now()
    where assignment_id = v_row.id and superseded_at is null;
    insert into public.assignment_artifacts (assignment_id, attempt_id, user_id, workspace_id,
      kind, title, content, plain_text, source_note_ids)
    values (v_row.id, p_attempt_id, v_row.user_id, v_row.workspace_id, p_artifact ->> 'kind',
      p_artifact ->> 'title', p_artifact -> 'content', coalesce(p_artifact ->> 'plain_text', ''),
      v_cited)
    returning id into v_artifact;
  exception when check_violation then
    -- Size limits. The supersede rolls back with the insert; the lease and
    -- state are unchanged, so the executor may submit a smaller result.
    return jsonb_build_object('status', 'invalid_payload');
  end;
  update public.assignment_attempts set status = 'succeeded', finished_at = now()
  where id = p_attempt_id;
  perform public.assignment_event(v_row, 'artifact_submitted', 'executor',
    jsonb_build_object('artifactId', v_artifact), p_attempt_id);
  perform public.assignment_move(v_row.id, 'needs_review', 'executor');
  return jsonb_build_object('status', 'submitted', 'artifactId', v_artifact);
end $$;

-- T5: the executor gives up with a normalized code (never a raw provider
-- message). timed_out is reserved for the reaper. Results: saved,
-- invalid_payload, lease_lost.
create function public.fail_assignment_attempt(p_attempt_id uuid, p_lease_token uuid,
  p_error_code text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.assignments;
begin
  if p_error_code is null or p_error_code not in ('provider_auth', 'provider_rate_limited',
     'provider_unavailable', 'budget_exhausted', 'context_unavailable', 'capability_revoked',
     'executor_unavailable', 'internal') then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  v_row := public.assignment_lease(p_attempt_id, p_lease_token);
  if v_row.id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  update public.assignment_attempts set status = 'failed', error_code = p_error_code,
    finished_at = now()
  where id = p_attempt_id;
  perform public.assignment_move(v_row.id, 'failed', 'executor', p_error_code);
  return jsonb_build_object('status', 'saved');
end $$;

-- System failures outside a lease: T15 (queued, the executor is unavailable)
-- and T16 (needs_input / needs_review, a capability was revoked). Running
-- assignments fail through their lease (T5) or the reaper (T6). An open
-- question is closed unanswered. Results: saved { assignment }, not_found,
-- invalid_payload, invalid_transition.
create function public.fail_assignment_system(p_id uuid, p_error_code text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.assignments;
begin
  if p_error_code is null or p_error_code not in ('executor_unavailable', 'capability_revoked',
     'context_unavailable', 'internal') then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  select * into v_row from public.assignments where id = p_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.state = 'running'
     or not ('failed' = any (public.assignment_allowed(v_row.state, 'system'))) then
    return public.assignment_invalid_transition(v_row.state, 'failed', 'system');
  end if;
  perform public.assignment_close_question(v_row.id);
  v_row := public.assignment_move(v_row.id, 'failed', 'system', p_error_code);
  return jsonb_build_object('status', 'saved', 'assignment', public.assignment_json(v_row));
end $$;

-- Reaper. ------------------------------------------------------------------------

-- Ends expired leases as failed/timed_out (T6; before A-04 there are no
-- automatic retries, so no T7) and fails queued built-in assignments whose
-- executor is unavailable, workspace switch off or no model key, with
-- executor_unavailable (T15). p_user_id null reaps every account. Rows locked
-- by a concurrent writer are skipped and picked up next time. Returns
-- { timedOut, unavailable } counts.
create function public.assignment_reap(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_attempt uuid;
  v_timed_out integer := 0;
  v_unavailable integer := 0;
begin
  for v_id, v_attempt in
    select a.id, t.id from public.assignments a
    join public.assignment_attempts t on t.id = a.current_attempt_id
    where a.state = 'running' and t.status = 'running' and t.lease_expires_at <= now()
      and (p_user_id is null or a.user_id = p_user_id)
    for update of a, t skip locked
  loop
    update public.assignment_attempts set status = 'expired', error_code = 'timed_out',
      finished_at = now()
    where id = v_attempt;
    perform public.assignment_move(v_id, 'failed', 'system', 'timed_out');
    v_timed_out := v_timed_out + 1;
  end loop;
  for v_id in
    select a.id from public.assignments a
    where a.state = 'queued' and a.executor_kind = 'builtin'
      and (p_user_id is null or a.user_id = p_user_id)
      and not public.assignment_builtin_available(a.workspace_id, a.user_id)
    for update of a skip locked
  loop
    perform public.assignment_move(v_id, 'failed', 'system', 'executor_unavailable');
    v_unavailable := v_unavailable + 1;
  end loop;
  return jsonb_build_object('timedOut', v_timed_out, 'unavailable', v_unavailable);
end $$;
revoke execute on function public.assignment_reap(uuid) from public, anon, authenticated, service_role;

-- Scheduler tick: every account.
create function public.reap_assignment_leases() returns jsonb
language sql security definer set search_path = '' as $$
  select public.assignment_reap(null)
$$;

-- On reads: only the caller's assignments.
create function public.reap_own_assignment_leases() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  return public.assignment_reap(v_uid);
end $$;

-- Grants. -------------------------------------------------------------------------

revoke execute on function public.create_assignment(uuid, uuid, text, uuid[], text, text[]) from public, anon, service_role;
grant execute on function public.create_assignment(uuid, uuid, text, uuid[], text, text[]) to authenticated;
revoke execute on function public.transition_assignment(uuid, bigint, text, jsonb) from public, anon, service_role;
grant execute on function public.transition_assignment(uuid, bigint, text, jsonb) to authenticated;
revoke execute on function public.answer_assignment_question(uuid, bigint, uuid, text) from public, anon, service_role;
grant execute on function public.answer_assignment_question(uuid, bigint, uuid, text) to authenticated;
revoke execute on function public.review_assignment_artifact(uuid, bigint, uuid, text, text) from public, anon, service_role;
grant execute on function public.review_assignment_artifact(uuid, bigint, uuid, text, text) to authenticated;
revoke execute on function public.reap_own_assignment_leases() from public, anon, service_role;
grant execute on function public.reap_own_assignment_leases() to authenticated;

revoke execute on function public.claim_assignment(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_assignment(uuid, integer) to service_role;
revoke execute on function public.heartbeat_assignment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.heartbeat_assignment(uuid, uuid, text) to service_role;
revoke execute on function public.ask_assignment_question(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ask_assignment_question(uuid, uuid, text) to service_role;
revoke execute on function public.submit_assignment_artifact(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.submit_assignment_artifact(uuid, uuid, jsonb) to service_role;
revoke execute on function public.fail_assignment_attempt(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_assignment_attempt(uuid, uuid, text) to service_role;
revoke execute on function public.fail_assignment_system(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_assignment_system(uuid, text) to service_role;
revoke execute on function public.reap_assignment_leases() from public, anon, authenticated;
grant execute on function public.reap_assignment_leases() to service_role;
