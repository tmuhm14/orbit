-- Item kinds and validated project links, with nested projects (ADR 001 §2,
-- §3, §3a). Purely additive and safe to apply while the previous app version
-- is live:
-- - new columns have defaults (kind = 'note', project_id = null), so every
--   existing row and every writer that omits them is unchanged;
-- - replaced functions keep their signatures, and payloads without kind or
--   project_id behave exactly as before;
-- - delete_note(uuid, bigint, boolean) is left as it is; the new four-argument
--   delete_note adds unlinkChildren.
-- Nothing reclassifies existing rows. Trigger and function errors are fixed
-- codes and never include titles or content.

-- Kinds. ---------------------------------------------------------------------

alter table public.notes
  add column kind text not null default 'note'
    constraint notes_kind_check
    check (kind in ('note', 'task', 'project', 'document', 'followup'));
create index notes_workspace_kind_idx on public.notes (workspace_id, kind);

-- Project links. -------------------------------------------------------------

-- Target for the composite foreign key that keeps a link inside one owner and
-- workspace.
alter table public.notes
  add constraint notes_id_workspace_user_key unique (id, workspace_id, user_id);

-- One parent project per item. Moving a linked child to another workspace
-- fails the foreign key; moving a project that still has linked items fails
-- on update restrict. Deleting a project detaches its direct children (the
-- delete function moves them up instead).
alter table public.notes
  add column project_id uuid,
  add constraint notes_project_not_self check (project_id is null or project_id <> id),
  add constraint notes_project_fk foreign key (project_id, workspace_id, user_id)
    references public.notes (id, workspace_id, user_id)
    on update restrict
    on delete set null (project_id);
create index notes_project_idx on public.notes (project_id) where project_id is not null;

-- Maximum length of a chain of nested projects: a root project plus four
-- levels of sub-projects. Items that are not projects can attach at any level.
create function public.project_max_depth() returns integer
language sql immutable set search_path = '' as $$ select 5 $$;
revoke execute on function public.project_max_depth() from public, anon;
grant execute on function public.project_max_depth() to authenticated, service_role;

-- Enforces what the foreign key cannot (ADR 001 §3). Raises check_violation
-- with a fixed code as the message:
--   invalid_project_link      target is missing, not a project, or the item itself
--   project_cycle             the new parent is the project itself or below it
--   project_depth_exceeded    the project chain would be longer than 5
--   project_has_linked_items  a project with linked items stops being a project
-- Re-parenting a project takes a per-workspace advisory lock, so two
-- concurrent re-parentings cannot each pass the check and form a cycle.
create function public.notes_validate_project_link() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_max integer := public.project_max_depth();
  v_kind text;
  v_cycle boolean;
  v_up integer;
  v_height integer;
begin
  if tg_op = 'UPDATE' and old.kind = 'project' and new.kind <> 'project'
     and exists (select 1 from public.notes c
                 where c.project_id = old.id and c.user_id = old.user_id) then
    raise exception 'project_has_linked_items' using errcode = '23514';
  end if;
  if new.project_id is null then
    return new;
  end if;
  if new.project_id = new.id then
    raise exception 'invalid_project_link' using errcode = '23514';
  end if;
  select p.kind into v_kind from public.notes p
    where p.id = new.project_id and p.workspace_id = new.workspace_id
      and p.user_id = new.user_id;
  if not found or v_kind <> 'project' then
    raise exception 'invalid_project_link' using errcode = '23514';
  end if;
  -- Only projects can be parents, so only a project's position in the tree
  -- can form a cycle or change the depth.
  if new.kind = 'project' and (tg_op = 'INSERT'
      or new.project_id is distinct from old.project_id
      or old.kind <> 'project') then
    perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0));
    -- Walk up from the new parent, bounded by the max depth.
    with recursive ancestors (id, parent, depth) as (
      select p.id, p.project_id, 1 from public.notes p
        where p.id = new.project_id and p.workspace_id = new.workspace_id
          and p.user_id = new.user_id
      union all
      select p.id, p.project_id, a.depth + 1
        from public.notes p join ancestors a on p.id = a.parent
        where p.workspace_id = new.workspace_id and p.user_id = new.user_id
          and a.depth <= v_max
    )
    select coalesce(bool_or(a.id = new.id), false), count(*)
      into v_cycle, v_up from ancestors a;
    if v_cycle then
      raise exception 'project_cycle' using errcode = '23514';
    end if;
    -- Height of the project's own sub-project subtree, which moves with it.
    with recursive below (id, depth) as (
      select c.id, 1 from public.notes c
        where c.project_id = new.id and c.kind = 'project'
          and c.workspace_id = new.workspace_id and c.user_id = new.user_id
      union all
      select c.id, b.depth + 1
        from public.notes c join below b on c.project_id = b.id
        where c.kind = 'project' and c.workspace_id = new.workspace_id
          and c.user_id = new.user_id and b.depth <= v_max
    )
    select coalesce(max(b.depth), 0) into v_height from below b;
    if v_up + 1 + v_height > v_max then
      raise exception 'project_depth_exceeded' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.notes_validate_project_link() from public, anon, authenticated;

-- Runs after notes_fill_workspace (triggers fire in name order), so the
-- workspace is known. Workspace moves of linked items are left to the
-- composite foreign key.
create trigger notes_validate_project_link
  before insert or update of project_id, kind on public.notes
  for each row execute function public.notes_validate_project_link();

-- Revisions track the new user-visible columns (ADR 002 §1). Same function,
-- with kind and project_id added to the tracked list.
create or replace function public.notes_manage_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
    new.updated_at := now();
    return new;
  end if;
  if (new.title, new.content, new.plain_text, new.bucket, new.tags,
      new.completed_at, new.due_date, new.workspace_id, new.kind, new.project_id)
     is distinct from
     (old.title, old.content, old.plain_text, old.bucket, old.tags,
      old.completed_at, old.due_date, old.workspace_id, old.kind, old.project_id) then
    new.revision := old.revision + 1;
    new.updated_at := now();
  else
    new.revision := old.revision;
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;

-- Project tree reads, with the caller's permissions (row-level security
-- applies), scoped to the root's user and workspace and bounded by the max
-- depth. ------------------------------------------------------------------

-- Everything under a project: direct contents at depth 1, items in
-- sub-projects deeper.
create function public.project_descendants(p_project_id uuid)
returns table (id uuid, depth integer)
language sql stable security invoker set search_path = '' as $$
  with recursive root as (
    select r.id, r.workspace_id, r.user_id from public.notes r
    where r.id = p_project_id and r.kind = 'project'
      and r.user_id = coalesce((select auth.uid()), r.user_id)
  ), tree (id, kind, depth) as (
    select n.id, n.kind, 1 from public.notes n join root r
      on n.project_id = r.id and n.workspace_id = r.workspace_id and n.user_id = r.user_id
    union all
    select n.id, n.kind, t.depth + 1 from public.notes n
      join tree t on n.project_id = t.id
      join root r on n.workspace_id = r.workspace_id and n.user_id = r.user_id
    where t.kind = 'project' and t.depth < public.project_max_depth()
  )
  select t.id, t.depth from tree t
$$;

-- The projects above an item: its direct project at depth 1, then upwards.
create function public.project_ancestors(p_item_id uuid)
returns table (id uuid, depth integer)
language sql stable security invoker set search_path = '' as $$
  with recursive item as (
    select i.id, i.project_id, i.workspace_id, i.user_id from public.notes i
    where i.id = p_item_id and i.user_id = coalesce((select auth.uid()), i.user_id)
  ), up (id, parent, depth) as (
    select p.id, p.project_id, 1 from public.notes p join item i
      on p.id = i.project_id and p.workspace_id = i.workspace_id and p.user_id = i.user_id
    union all
    select p.id, p.project_id, u.depth + 1 from public.notes p
      join up u on p.id = u.parent
      join item i on p.workspace_id = i.workspace_id and p.user_id = i.user_id
    where u.depth < public.project_max_depth()
  )
  select u.id, u.depth from up u
$$;

revoke execute on function public.project_descendants(uuid) from public, anon;
grant execute on function public.project_descendants(uuid) to authenticated, service_role;
revoke execute on function public.project_ancestors(uuid) from public, anon;
grant execute on function public.project_ancestors(uuid) to authenticated, service_role;

-- Helpers (same signatures as D-01). ----------------------------------------

-- Relationship error code from a constraint failure, or null for any other.
create function public.note_link_error(p_message text, p_constraint text)
returns text
language sql immutable set search_path = '' as $$
  select case
    when p_message in ('invalid_project_link', 'project_cycle',
                       'project_depth_exceeded', 'project_has_linked_items')
      then p_message
    when p_constraint = 'notes_project_not_self' then 'invalid_project_link'
    when p_constraint = 'notes_project_fk' then 'linked_item_move'
  end
$$;
revoke execute on function public.note_link_error(text, text) from public, anon, authenticated, service_role;

create or replace function public.note_json(n public.notes) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', n.id, 'workspace_id', n.workspace_id, 'title', n.title,
    'content', n.content, 'plain_text', n.plain_text, 'bucket', n.bucket,
    'tags', to_jsonb(n.tags), 'source', n.source, 'origin', n.origin,
    'created_at', n.created_at, 'updated_at', n.updated_at,
    'completed_at', n.completed_at, 'due_date', n.due_date,
    'revision', n.revision, 'kind', n.kind, 'project_id', n.project_id)
$$;

create or replace function public.agent_restorable(p_values jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from jsonb_each(coalesce(p_values, '{}'::jsonb))
  where key = any (array['title', 'bucket', 'tags', 'completed_at', 'content',
                         'plain_text', 'triage_status', 'kind', 'project_id'])
$$;

-- Browser saves (W1, W3). Same signature and behavior as D-01; items may now
-- also carry kind and project_id. A key that is absent leaves the column
-- unchanged on update and uses the default on insert, so older clients can
-- never reset them. Relationship failures are per-item `invalid` results with
-- their code. A workspace change of a linked item is refused before writing.
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
              then (v_item ->> 'project_id')::uuid else project_id end
          where id = v_id
          returning * into v_saved;
        else
          v_project := (v_item ->> 'project_id')::uuid;
          insert into public.notes (id, user_id, workspace_id, title, content,
            plain_text, bucket, tags, created_at, completed_at, due_date, kind,
            project_id)
          values (v_id, v_uid, (v_item ->> 'workspace_id')::uuid,
            v_item ->> 'title', v_item -> 'content', v_item ->> 'plain_text',
            v_item ->> 'bucket',
            array(select jsonb_array_elements_text(v_item -> 'tags')),
            coalesce((v_item ->> 'created_at')::timestamptz, now()),
            (v_item ->> 'completed_at')::timestamptz,
            (v_item ->> 'due_date')::date,
            coalesce(v_item ->> 'kind', 'note'),
            v_project)
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

-- Browser delete (W2) with unlinkChildren (ADR 001 §3). A project with linked
-- items is refused with their direct count unless p_unlink_children, which in
-- the same transaction moves each direct child up to the deleted project's
-- parent (or to no project), bumping its revision, and then deletes. Deeper
-- descendants keep their parents. The three-argument delete_note from D-01 is
-- unchanged; the foreign key detaches children for that and any other path.
create function public.delete_note(p_id uuid, p_expected_revision bigint,
  p_require_revision boolean, p_unlink_children boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.notes;
  v_children integer;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_expected_revision is null and coalesce(p_require_revision, false) then
    return jsonb_build_object('status', 'precondition_required');
  end if;
  select * into v_row from public.notes
    where id = p_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_expected_revision is not null and v_row.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict',
      'currentRevision', v_row.revision, 'current', public.note_json(v_row));
  end if;
  select count(*) into v_children from public.notes
    where project_id = v_row.id and user_id = v_uid;
  if v_children > 0 then
    if not coalesce(p_unlink_children, false) then
      return jsonb_build_object('status', 'project_has_linked_items',
        'count', v_children, 'currentRevision', v_row.revision,
        'current', public.note_json(v_row));
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_row.workspace_id::text, 0));
    update public.notes set project_id = v_row.project_id
      where project_id = v_row.id and user_id = v_uid;
  end if;
  delete from public.notes where id = v_row.id;
  return jsonb_build_object('status', 'deleted', 'id', v_row.id,
    'unlinked', v_children);
end $$;

revoke execute on function public.delete_note(uuid, bigint, boolean, boolean) from public, anon;
grant execute on function public.delete_note(uuid, bigint, boolean, boolean) to authenticated;

-- Organizing agent (W6). Same signatures as D-01; payloads without kind or
-- project_id behave exactly as before. ----------------------------------------

-- As in D-01, plus kind and project_id (ADR 001 §3a):
-- - kind may change only on a capture this run is triaging (pending, or
--   pending when this run first changed it) or a note this run created;
--   otherwise `kind_not_allowed` and nothing is written;
-- - a relationship failure returns `invalid` with its code and writes
--   nothing. Other constraint failures still raise, as before.
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
      kind = v_new.kind, project_id = v_new.project_id
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

-- As in D-01; p_note may also carry kind (default note) and project_id, which
-- are recorded in the action only when given. A relationship failure returns
-- `invalid` with its code and writes nothing.
create or replace function public.agent_create_note(p_run_id uuid, p_note jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.agent_runs;
  v_saved public.notes;
  v_action uuid;
  v_after jsonb;
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
      plain_text, bucket, tags, kind, project_id)
    values (gen_random_uuid(), v_run.user_id, v_run.workspace_id,
      p_note ->> 'title', p_note -> 'content',
      coalesce(p_note ->> 'plain_text', ''), p_note ->> 'bucket',
      array(select jsonb_array_elements_text(coalesce(p_note -> 'tags', '[]'::jsonb))),
      coalesce(p_note ->> 'kind', 'note'), (p_note ->> 'project_id')::uuid)
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
  if p_note ? 'kind' then
    v_after := v_after || jsonb_build_object('kind', v_saved.kind);
  end if;
  if p_note ? 'project_id' then
    v_after := v_after || jsonb_build_object('project_id', v_saved.project_id);
  end if;
  insert into public.agent_actions (run_id, user_id, note_id, kind, before,
    after, reason, revision_before, revision_after)
  values (v_run.id, v_run.user_id, v_saved.id, 'create', null, v_after,
    nullif(p_reason, ''), null, v_saved.revision)
  returning id into v_action;
  return jsonb_build_object('status', 'created', 'id', v_saved.id,
    'revision', v_saved.revision, 'actionId', v_action);
end $$;

-- Agent undo (W8). Same signature and results as D-01, plus:
-- - a created project that now has linked items is not deleted
--   (`project_has_linked_items`);
-- - restoring kind or project_id that would now break the project rules
--   (cycle, depth, a missing or changed project, a project with linked items)
--   returns `undo_conflict` with those fields and a `reason`, writing nothing.
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
        kind = v_new.kind, project_id = v_new.project_id
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
