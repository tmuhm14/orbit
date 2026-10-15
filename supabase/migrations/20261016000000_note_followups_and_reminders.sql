-- Follow-up metadata on items and a separate reminder contract (ADR 001 §4,
-- D-03). Purely additive and safe to apply while the previous app version is
-- live:
-- - the three follow-up columns are nullable with no default, so existing
--   rows and every writer that omits them are unchanged (adding them does not
--   fire the revision trigger, so no revision or updated_at moves);
-- - note_reminders is a new table nothing reads yet;
-- - replaced functions keep their signatures, and payloads without the new
--   fields behave exactly as before. note_json() gains three keys, which
--   older readers ignore.
-- No dispatch, delivery or recurrence here (D-04). Function and trigger
-- errors are fixed codes and never include titles, content or follow-up text.

-- Follow-up fields. ------------------------------------------------------------

-- waiting_on: who the item is waiting on (free text, not an account).
-- waiting_for: what is expected from them. next_check_on: a calendar date,
-- never converted to an instant. Allowed on any kind; changing kind keeps
-- them. Single-line text without control characters (C0, DEL, C1); the app
-- trims and sends null for empty values.
alter table public.notes
  add column waiting_on text
    constraint notes_waiting_on_check
    check (char_length(waiting_on) between 1 and 200
           and waiting_on !~ '[\x01-\x1f\x7f-\x9f]'),
  add column waiting_for text
    constraint notes_waiting_for_check
    check (char_length(waiting_for) between 1 and 2000
           and waiting_for !~ '[\x01-\x1f\x7f-\x9f]'),
  add column next_check_on date
    constraint notes_next_check_on_check
    check (next_check_on is null
           or next_check_on between date '0001-01-01' and date '9999-12-31');
create index notes_next_check_idx on public.notes (user_id, next_check_on)
  where next_check_on is not null and completed_at is null;

-- Revisions track the follow-up columns (ADR 002 §1). Same function as D-02
-- with waiting_on, waiting_for and next_check_on added to the tracked list.
create or replace function public.notes_manage_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
    new.updated_at := now();
    return new;
  end if;
  if (new.title, new.content, new.plain_text, new.bucket, new.tags,
      new.completed_at, new.due_date, new.workspace_id, new.kind, new.project_id,
      new.waiting_on, new.waiting_for, new.next_check_on)
     is distinct from
     (old.title, old.content, old.plain_text, old.bucket, old.tags,
      old.completed_at, old.due_date, old.workspace_id, old.kind, old.project_id,
      old.waiting_on, old.waiting_for, old.next_check_on) then
    new.revision := old.revision + 1;
    new.updated_at := now();
  else
    new.revision := old.revision;
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;

-- Helpers (same signatures as D-02). ----------------------------------------

create or replace function public.note_json(n public.notes) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', n.id, 'workspace_id', n.workspace_id, 'title', n.title,
    'content', n.content, 'plain_text', n.plain_text, 'bucket', n.bucket,
    'tags', to_jsonb(n.tags), 'source', n.source, 'origin', n.origin,
    'created_at', n.created_at, 'updated_at', n.updated_at,
    'completed_at', n.completed_at, 'due_date', n.due_date,
    'revision', n.revision, 'kind', n.kind, 'project_id', n.project_id,
    'waiting_on', n.waiting_on, 'waiting_for', n.waiting_for,
    'next_check_on', n.next_check_on)
$$;

-- The follow-up columns join the restorable whitelist, so agent changes to
-- them are audited and undone like any other.
create or replace function public.agent_restorable(p_values jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from jsonb_each(coalesce(p_values, '{}'::jsonb))
  where key = any (array['title', 'bucket', 'tags', 'completed_at', 'content',
                         'plain_text', 'triage_status', 'kind', 'project_id',
                         'waiting_on', 'waiting_for', 'next_check_on'])
$$;

-- Browser saves (W1, W3). Same signature and behavior as D-02; items may now
-- also carry waiting_on, waiting_for and next_check_on. As with due_date, an
-- absent key leaves the column unchanged on update and null on insert, so
-- older clients can never clear them. A value that breaks a column rule is a
-- per-item `invalid_note` result.
create or replace function public.save_notes(p_notes jsonb, p_require_revision boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_item jsonb;
  v_id uuid;
  v_has_expected boolean;
  v_expected bigint;
  v_row public.notes;
  v_exists boolean;
  v_saved public.notes;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_project uuid;
  v_message text;
  v_constraint text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if jsonb_typeof(p_notes) is distinct from 'array' then
    raise exception 'p_notes must be an array' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_notes) loop
    v_id := null;
    v_expected := null;
    begin
      v_id := (v_item ->> 'id')::uuid;
      v_has_expected := v_item ? 'expected_revision';
      v_expected := (v_item ->> 'expected_revision')::bigint;
      select * into v_row from public.notes where id = v_id for update;
      v_exists := found;
      if v_exists and v_row.user_id <> v_uid then
        v_result := jsonb_build_object('id', v_id, 'status', 'invalid', 'code', 'not_found');
      elsif not v_has_expected and coalesce(p_require_revision, false) then
        v_result := jsonb_build_object('id', v_id, 'status', 'precondition_required');
      elsif v_has_expected and (
        (v_expected is null and v_exists)
        or (v_expected is not null and (not v_exists or v_row.revision <> v_expected))
      ) then
        v_result := jsonb_build_object(
          'id', v_id, 'status', 'conflict', 'expectedRevision', v_expected,
          'currentRevision', case when v_exists then v_row.revision end,
          'current', case when v_exists then public.note_json(v_row) end);
      elsif v_exists
        and (v_item ->> 'workspace_id')::uuid is distinct from v_row.workspace_id
        and ((case when v_item ? 'project_id'
                then (v_item ->> 'project_id')::uuid else v_row.project_id end) is not null
             or exists (select 1 from public.notes c
                        where c.project_id = v_row.id and c.user_id = v_uid)) then
        -- Linked items move between workspaces only after an unlink (v1).
        v_result := jsonb_build_object('id', v_id, 'status', 'invalid', 'code', 'linked_item_move');
      else
        if v_exists then
          update public.notes set
            workspace_id = (v_item ->> 'workspace_id')::uuid,
            title = v_item ->> 'title',
            content = v_item -> 'content',
            plain_text = v_item ->> 'plain_text',
            bucket = v_item ->> 'bucket',
            tags = array(select jsonb_array_elements_text(v_item -> 'tags')),
            completed_at = (v_item ->> 'completed_at')::timestamptz,
            due_date = case when v_item ? 'due_date'
              then (v_item ->> 'due_date')::date else due_date end,
            kind = case when v_item ? 'kind'
              then coalesce(v_item ->> 'kind', kind) else kind end,
            project_id = case when v_item ? 'project_id'
              then (v_item ->> 'project_id')::uuid else project_id end,
            waiting_on = case when v_item ? 'waiting_on'
              then v_item ->> 'waiting_on' else waiting_on end,
            waiting_for = case when v_item ? 'waiting_for'
              then v_item ->> 'waiting_for' else waiting_for end,
            next_check_on = case when v_item ? 'next_check_on'
              then (v_item ->> 'next_check_on')::date else next_check_on end
          where id = v_id
          returning * into v_saved;
        else
          v_project := (v_item ->> 'project_id')::uuid;
          insert into public.notes (id, user_id, workspace_id, title, content,
            plain_text, bucket, tags, created_at, completed_at, due_date, kind,
            project_id, waiting_on, waiting_for, next_check_on)
          values (v_id, v_uid, (v_item ->> 'workspace_id')::uuid,
            v_item ->> 'title', v_item -> 'content', v_item ->> 'plain_text',
            v_item ->> 'bucket',
            array(select jsonb_array_elements_text(v_item -> 'tags')),
            coalesce((v_item ->> 'created_at')::timestamptz, now()),
            (v_item ->> 'completed_at')::timestamptz,
            (v_item ->> 'due_date')::date,
            coalesce(v_item ->> 'kind', 'note'),
            v_project,
            v_item ->> 'waiting_on',
            v_item ->> 'waiting_for',
            (v_item ->> 'next_check_on')::date)
          returning * into v_saved;
        end if;
        v_result := jsonb_build_object('id', v_id, 'status', 'saved',
          'revision', v_saved.revision, 'updatedAt', v_saved.updated_at);
      end if;
    exception
      when unique_violation then
        -- Another writer created this id between our read and insert.
        select * into v_row from public.notes where id = v_id;
        if found and v_row.user_id = v_uid then
          v_result := jsonb_build_object(
            'id', v_id, 'status', 'conflict', 'expectedRevision', v_expected,
            'currentRevision', v_row.revision, 'current', public.note_json(v_row));
        else
          v_result := jsonb_build_object('id', v_id, 'status', 'invalid', 'code', 'not_found');
        end if;
      when integrity_constraint_violation or data_exception then
        get stacked diagnostics v_message = message_text, v_constraint = constraint_name;
        v_result := jsonb_build_object('id', v_id, 'status', 'invalid', 'code',
          coalesce(public.note_link_error(v_message, v_constraint), 'invalid_note'));
    end;
    v_results := v_results || jsonb_build_array(v_result);
  end loop;
  return v_results;
end $$;

-- Organizing agent (W6). Same signatures and behavior as D-02; payloads
-- without follow-up fields behave exactly as before. ---------------------------

-- As in D-02; the follow-up columns are restorable, so p_after may set them
-- and they are recorded in before/after like any other change.
create or replace function public.agent_apply_note_change(p_run_id uuid, p_note_id uuid,
  p_expected_revision bigint, p_after jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.agent_runs;
  v_row public.notes;
  v_new public.notes;
  v_values jsonb := public.agent_restorable(p_after);
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_key text;
  v_revision bigint;
  v_action uuid;
  v_message text;
  v_constraint text;
  v_code text;
begin
  select * into v_run from public.agent_runs where id = p_run_id for share;
  if not found or v_run.status <> 'running' then
    return jsonb_build_object('status', 'run_not_active');
  end if;
  select * into v_row from public.notes
    where id = p_note_id and user_id = v_run.user_id
      and workspace_id = v_run.workspace_id
    for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_expected_revision is null or v_row.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'currentRevision', v_row.revision);
  end if;
  v_new := jsonb_populate_record(v_row, v_values);
  foreach v_key in array public.note_fields_differ(v_row, v_values) loop
    v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_row) -> v_key);
    v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_new) -> v_key);
  end loop;
  if v_after = '{}'::jsonb then
    return jsonb_build_object('status', 'unchanged', 'revision', v_row.revision);
  end if;
  if v_after ? 'kind' and v_row.triage_status <> 'pending'
     and not exists (
       select 1 from public.agent_actions a
       where a.run_id = v_run.id and a.note_id = v_row.id
         and (a.kind = 'create' or a.before ->> 'triage_status' = 'pending')) then
    return jsonb_build_object('status', 'kind_not_allowed');
  end if;
  begin
    update public.notes set
      title = v_new.title, bucket = v_new.bucket, tags = v_new.tags,
      completed_at = v_new.completed_at, content = v_new.content,
      plain_text = v_new.plain_text, triage_status = v_new.triage_status,
      kind = v_new.kind, project_id = v_new.project_id,
      waiting_on = v_new.waiting_on, waiting_for = v_new.waiting_for,
      next_check_on = v_new.next_check_on
    where id = v_row.id
    returning revision into v_revision;
  exception when integrity_constraint_violation then
    get stacked diagnostics v_message = message_text, v_constraint = constraint_name;
    v_code := public.note_link_error(v_message, v_constraint);
    if v_code is null then
      raise;
    end if;
    return jsonb_build_object('status', 'invalid', 'code', v_code);
  end;
  insert into public.agent_actions (run_id, user_id, note_id, kind, before,
    after, reason, revision_before, revision_after)
  values (v_run.id, v_run.user_id, v_row.id, 'update', v_before, v_after,
    nullif(p_reason, ''), v_row.revision, v_revision)
  returning id into v_action;
  return jsonb_build_object('status', 'applied', 'revision', v_revision, 'actionId', v_action);
end $$;

-- As in D-02; p_note may also carry waiting_on, waiting_for and
-- next_check_on, recorded in the action only when given.
create or replace function public.agent_create_note(p_run_id uuid, p_note jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.agent_runs;
  v_saved public.notes;
  v_action uuid;
  v_after jsonb;
  v_key text;
  v_message text;
  v_constraint text;
  v_code text;
begin
  select * into v_run from public.agent_runs where id = p_run_id for share;
  if not found or v_run.status <> 'running' then
    return jsonb_build_object('status', 'run_not_active');
  end if;
  begin
    insert into public.notes (id, user_id, workspace_id, title, content,
      plain_text, bucket, tags, kind, project_id, waiting_on, waiting_for,
      next_check_on)
    values (gen_random_uuid(), v_run.user_id, v_run.workspace_id,
      p_note ->> 'title', p_note -> 'content',
      coalesce(p_note ->> 'plain_text', ''), p_note ->> 'bucket',
      array(select jsonb_array_elements_text(coalesce(p_note -> 'tags', '[]'::jsonb))),
      coalesce(p_note ->> 'kind', 'note'), (p_note ->> 'project_id')::uuid,
      p_note ->> 'waiting_on', p_note ->> 'waiting_for',
      (p_note ->> 'next_check_on')::date)
    returning * into v_saved;
  exception when integrity_constraint_violation then
    get stacked diagnostics v_message = message_text, v_constraint = constraint_name;
    v_code := public.note_link_error(v_message, v_constraint);
    if v_code is null then
      raise;
    end if;
    return jsonb_build_object('status', 'invalid', 'code', v_code);
  end;
  v_after := jsonb_build_object('title', v_saved.title, 'content', v_saved.content,
    'plain_text', v_saved.plain_text, 'bucket', v_saved.bucket,
    'tags', to_jsonb(v_saved.tags));
  foreach v_key in array array['kind', 'project_id', 'waiting_on', 'waiting_for',
                               'next_check_on'] loop
    if p_note ? v_key then
      v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_saved) -> v_key);
    end if;
  end loop;
  insert into public.agent_actions (run_id, user_id, note_id, kind, before,
    after, reason, revision_before, revision_after)
  values (v_run.id, v_run.user_id, v_saved.id, 'create', null, v_after,
    nullif(p_reason, ''), null, v_saved.revision)
  returning id into v_action;
  return jsonb_build_object('status', 'created', 'id', v_saved.id,
    'revision', v_saved.revision, 'actionId', v_action);
end $$;

-- Agent undo (W8). Same signature and results as D-02; restores the
-- follow-up columns too, with the same revision and value checks.
create or replace function public.undo_agent_action(p_action_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_action public.agent_actions;
  v_row public.notes;
  v_exists boolean;
  v_fields text[];
  v_new public.notes;
  v_revision bigint;
  v_message text;
  v_constraint text;
  v_code text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_action from public.agent_actions
    where id = p_action_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_action.undone_at is not null then
    return jsonb_build_object('status', 'already_undone');
  end if;
  if v_action.created_at < now() - interval '90 days' or v_action.after is null then
    return jsonb_build_object('status', 'undo_expired');
  end if;
  select * into v_row from public.notes
    where id = v_action.note_id and user_id = v_uid for update;
  v_exists := found;

  if v_action.kind = 'create' then
    if not v_exists then
      update public.agent_actions set undone_at = now(), undone_by = v_uid
        where id = v_action.id;
      return jsonb_build_object('status', 'undone', 'undone', v_action.id,
        'alreadyDeleted', true);
    end if;
    if (v_action.revision_after is not null and v_row.revision <> v_action.revision_after)
       or (v_action.revision_after is null
           and cardinality(public.note_fields_differ(v_row, v_action.after)) > 0) then
      return jsonb_build_object('status', 'edited_since_created');
    end if;
    -- Linking an item to a project does not change the project's revision.
    if exists (select 1 from public.notes c
               where c.project_id = v_row.id and c.user_id = v_uid) then
      return jsonb_build_object('status', 'project_has_linked_items');
    end if;
    delete from public.notes where id = v_row.id;
    v_revision := null;
  else
    if not v_exists then
      return jsonb_build_object('status', 'note_deleted');
    end if;
    if v_action.before is null then
      return jsonb_build_object('status', 'undo_expired');
    end if;
    -- Untouched since the change: restore everything. Otherwise restore only
    -- if every value the agent set is still there, so other edits survive.
    if v_action.revision_after is null or v_row.revision <> v_action.revision_after then
      v_fields := public.note_fields_differ(v_row, v_action.after);
      if cardinality(v_fields) > 0 then
        return jsonb_build_object('status', 'undo_conflict', 'fields', to_jsonb(v_fields));
      end if;
    end if;
    v_new := jsonb_populate_record(v_row, public.agent_restorable(v_action.before));
    begin
      update public.notes set
        title = v_new.title, bucket = v_new.bucket, tags = v_new.tags,
        completed_at = v_new.completed_at, content = v_new.content,
        plain_text = v_new.plain_text, triage_status = v_new.triage_status,
        kind = v_new.kind, project_id = v_new.project_id,
        waiting_on = v_new.waiting_on, waiting_for = v_new.waiting_for,
        next_check_on = v_new.next_check_on
      where id = v_row.id
      returning revision into v_revision;
    exception when integrity_constraint_violation then
      get stacked diagnostics v_message = message_text, v_constraint = constraint_name;
      v_code := public.note_link_error(v_message, v_constraint);
      if v_code is null then
        raise;
      end if;
      select coalesce(array_agg(key order by key), '{}'::text[]) into v_fields
        from jsonb_object_keys(public.agent_restorable(v_action.before)) as key
        where key in ('kind', 'project_id');
      return jsonb_build_object('status', 'undo_conflict',
        'fields', to_jsonb(v_fields), 'reason', v_code);
    end;
  end if;
  update public.agent_actions set undone_at = now(), undone_by = v_uid
    where id = v_action.id;
  return jsonb_build_object('status', 'undone', 'undone', v_action.id,
    'revision', v_revision);
end $$;

-- Reminders. ---------------------------------------------------------------------

-- Whether p_zone is a time zone name in the server's tz database (IANA names
-- and their links; abbreviations such as CST and POSIX strings are not).
create function public.is_time_zone(p_zone text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(char_length(p_zone) between 1 and 64, false)
    and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_zone)
$$;

-- The instant a wall-clock date and time in p_zone happens, under the zone's
-- current rules (ADR 001 §4):
-- - a time that happens once maps to that instant;
-- - an ambiguous time (fall-back overlap) maps to its first occurrence;
-- - a nonexistent time (spring-forward gap) maps to the first valid instant
--   after it, which is the moment the clocks jump (02:30 → 03:00 in Chicago).
-- Assumes zone offset changes are more than a day apart, as they are in
-- every current zone. lib/reminders.ts implements the same rules with Intl.
create function public.reminder_fire_at(p_date date, p_time time, p_zone text)
returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_local timestamp := p_date + p_time;
  v_probe timestamptz := v_local at time zone 'UTC';
  v_earlier timestamptz := v_probe - interval '1 day';
  v_later timestamptz := v_probe + interval '1 day';
  -- The zone's offset a day before and a day after the wall-clock time.
  v_first timestamptz := (v_local - ((v_earlier at time zone p_zone)
    - (v_earlier at time zone 'UTC'))) at time zone 'UTC';
  v_second timestamptz := (v_local - ((v_later at time zone p_zone)
    - (v_later at time zone 'UTC'))) at time zone 'UTC';
  v_first_ok boolean := (v_first at time zone p_zone) = v_local;
  v_second_ok boolean := (v_second at time zone p_zone) = v_local;
  v_lo bigint;
  v_hi bigint;
  v_mid bigint;
begin
  if v_first_ok and v_second_ok then
    return least(v_first, v_second);
  elsif v_first_ok then
    return v_first;
  elsif v_second_ok then
    return v_second;
  end if;
  -- In a gap: the first whole second whose local time is at or after it.
  v_lo := floor(extract(epoch from least(v_first, v_second)))::bigint;
  v_hi := ceil(extract(epoch from greatest(v_first, v_second)))::bigint;
  while v_hi - v_lo > 1 loop
    v_mid := (v_lo + v_hi) / 2;
    if (to_timestamp(v_mid) at time zone p_zone) >= v_local then
      v_hi := v_mid;
    else
      v_lo := v_mid;
    end if;
  end loop;
  return to_timestamp(v_hi);
end $$;

revoke execute on function public.is_time_zone(text) from public, anon;
grant execute on function public.is_time_zone(text) to authenticated, service_role;
revoke execute on function public.reminder_fire_at(date, time, text) from public, anon;
grant execute on function public.reminder_fire_at(date, time, text) to authenticated, service_role;

-- A timed reminder for an item. The wall-clock fields (local_date,
-- local_time, timezone) are the source of truth; fire_at is derived from them
-- on every write and is never taken from a writer. A reminder belongs to the
-- same user and workspace as its item (composite key), follows the item to
-- another workspace, and is deleted with it. It has its own revision; editing
-- a reminder never changes the item's revision.
-- status: scheduled (waiting to fire), snoozed (postponed to a new time,
-- still waiting), fired (D-04 marks this), canceled. At most one waiting
-- (scheduled or snoozed) reminder per item.
create table public.note_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  note_id uuid not null,
  local_date date not null
    constraint note_reminders_local_date_check
    check (local_date between date '0001-01-01' and date '9999-12-31'),
  local_time time not null,
  timezone text not null
    constraint note_reminders_timezone_check
    check (char_length(timezone) between 1 and 64),
  fire_at timestamptz not null,
  status text not null default 'scheduled'
    constraint note_reminders_status_check
    check (status in ('scheduled', 'fired', 'snoozed', 'canceled')),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint note_reminders_note_fk foreign key (note_id, workspace_id, user_id)
    references public.notes (id, workspace_id, user_id)
    on update cascade on delete cascade
);
create unique index note_reminders_one_active
  on public.note_reminders (note_id) where status in ('scheduled', 'snoozed');
create index note_reminders_due_idx on public.note_reminders (fire_at)
  where status in ('scheduled', 'snoozed');
create index note_reminders_note_idx on public.note_reminders (note_id, created_at desc);

alter table public.note_reminders enable row level security;
create policy "Users read their own reminders" on public.note_reminders
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own reminders" on public.note_reminders
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change their own reminders" on public.note_reminders
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users delete their own reminders" on public.note_reminders
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Every writer: validates the zone, fills the workspace from the item when
-- omitted, derives fire_at, and manages revision and timestamps. The item and
-- owner of a reminder never change (the workspace follows the item).
-- Raises check_violation with a fixed code:
--   invalid_timezone   the zone is not in the tz database
--   reminder_moved     an update changes note_id or user_id
create function public.note_reminders_prepare() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.note_id, new.user_id) is distinct from (old.note_id, old.user_id) then
    raise exception 'reminder_moved' using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' or new.timezone is distinct from old.timezone)
     and not public.is_time_zone(new.timezone) then
    raise exception 'invalid_timezone' using errcode = '23514';
  end if;
  if new.workspace_id is null then
    select n.workspace_id into new.workspace_id from public.notes n
      where n.id = new.note_id and n.user_id = new.user_id;
  end if;
  new.fire_at := public.reminder_fire_at(new.local_date, new.local_time, new.timezone);
  if tg_op = 'INSERT' then
    new.revision := 1;
    new.created_at := now();
    new.updated_at := now();
  elsif (new.local_date, new.local_time, new.timezone, new.status)
        is distinct from (old.local_date, old.local_time, old.timezone, old.status) then
    new.revision := old.revision + 1;
    new.updated_at := now();
  else
    new.revision := old.revision;
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;
revoke execute on function public.note_reminders_prepare() from public, anon, authenticated;

create trigger note_reminders_prepare before insert or update on public.note_reminders
  for each row execute function public.note_reminders_prepare();

-- The client-visible columns of a reminder.
create function public.reminder_json(r public.note_reminders) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'note_id', r.note_id, 'workspace_id', r.workspace_id,
    'local_date', r.local_date, 'local_time', to_char(r.local_time, 'HH24:MI'),
    'timezone', r.timezone, 'fire_at', r.fire_at, 'status', r.status,
    'revision', r.revision, 'created_at', r.created_at, 'updated_at', r.updated_at)
$$;
revoke execute on function public.reminder_json(public.note_reminders) from public, anon, authenticated, service_role;

-- Creates a waiting reminder on one of the caller's items. Results (status):
--   created { reminder }
--   not_found                  no such item for this user
--   invalid_timezone
--   reminder_in_past           the wall-clock time has already happened
--   reminder_exists { reminder }  the item already has a waiting reminder
create function public.create_note_reminder(p_note_id uuid, p_local_date date,
  p_local_time time, p_timezone text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_note public.notes;
  v_row public.note_reminders;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_note from public.notes where id = p_note_id and user_id = v_uid;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not public.is_time_zone(p_timezone) then
    return jsonb_build_object('status', 'invalid_timezone');
  end if;
  if p_local_date is null or p_local_time is null
     or public.reminder_fire_at(p_local_date, p_local_time, p_timezone) <= now() then
    return jsonb_build_object('status', 'reminder_in_past');
  end if;
  select * into v_row from public.note_reminders
    where note_id = v_note.id and user_id = v_uid and status in ('scheduled', 'snoozed');
  if found then
    return jsonb_build_object('status', 'reminder_exists', 'reminder', public.reminder_json(v_row));
  end if;
  begin
    insert into public.note_reminders (user_id, workspace_id, note_id, local_date,
      local_time, timezone, fire_at)
    values (v_uid, v_note.workspace_id, v_note.id, p_local_date, p_local_time,
      p_timezone, now())
    returning * into v_row;
  exception when unique_violation then
    -- Another writer added one between our check and insert.
    select * into v_row from public.note_reminders
      where note_id = v_note.id and user_id = v_uid and status in ('scheduled', 'snoozed');
    return jsonb_build_object('status', 'reminder_exists', 'reminder', public.reminder_json(v_row));
  end;
  return jsonb_build_object('status', 'created', 'reminder', public.reminder_json(v_row));
end $$;

-- Changes one of the caller's reminders at p_expected_revision. p_action:
--   update   new wall-clock fields (null keeps each); becomes scheduled
--   snooze   postpone to new wall-clock fields; becomes snoozed
--   cancel   becomes canceled (kept as history); other arguments ignored
-- Results (status): saved { reminder }, not_found, precondition_required
-- (no expected revision), conflict { currentRevision, current },
-- reminder_closed (already canceled), invalid_action, invalid_timezone,
-- reminder_in_past, reminder_exists { reminder } (another waiting reminder).
create function public.change_note_reminder(p_id uuid, p_expected_revision bigint,
  p_action text, p_local_date date, p_local_time time, p_timezone text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.note_reminders;
  v_saved public.note_reminders;
  v_date date;
  v_time time;
  v_zone text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('update', 'snooze', 'cancel') then
    return jsonb_build_object('status', 'invalid_action');
  end if;
  select * into v_row from public.note_reminders
    where id = p_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_expected_revision is null then
    return jsonb_build_object('status', 'precondition_required');
  end if;
  if v_row.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'currentRevision', v_row.revision,
      'current', public.reminder_json(v_row));
  end if;
  if v_row.status = 'canceled' then
    return jsonb_build_object('status', 'reminder_closed');
  end if;
  if p_action = 'cancel' then
    update public.note_reminders set status = 'canceled' where id = v_row.id
      returning * into v_saved;
    return jsonb_build_object('status', 'saved', 'reminder', public.reminder_json(v_saved));
  end if;
  v_date := coalesce(p_local_date, v_row.local_date);
  v_time := coalesce(p_local_time, v_row.local_time);
  v_zone := coalesce(p_timezone, v_row.timezone);
  if not public.is_time_zone(v_zone) then
    return jsonb_build_object('status', 'invalid_timezone');
  end if;
  if public.reminder_fire_at(v_date, v_time, v_zone) <= now() then
    return jsonb_build_object('status', 'reminder_in_past');
  end if;
  begin
    update public.note_reminders set local_date = v_date, local_time = v_time,
      timezone = v_zone,
      status = case when p_action = 'snooze' then 'snoozed' else 'scheduled' end
    where id = v_row.id
    returning * into v_saved;
  exception when unique_violation then
    select * into v_saved from public.note_reminders
      where note_id = v_row.note_id and user_id = v_uid
        and status in ('scheduled', 'snoozed');
    return jsonb_build_object('status', 'reminder_exists', 'reminder', public.reminder_json(v_saved));
  end;
  return jsonb_build_object('status', 'saved', 'reminder', public.reminder_json(v_saved));
end $$;

revoke execute on function public.create_note_reminder(uuid, date, time, text) from public, anon;
grant execute on function public.create_note_reminder(uuid, date, time, text) to authenticated;
revoke execute on function public.change_note_reminder(uuid, bigint, text, date, time, text) from public, anon;
grant execute on function public.change_note_reminder(uuid, bigint, text, date, time, text) to authenticated;
