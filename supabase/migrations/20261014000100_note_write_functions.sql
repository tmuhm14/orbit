-- Revision-checked note writes, atomic agent changes with their audit rows,
-- and safe agent undo (ADR 002 §2, §4, §5). Supabase JS cannot run a
-- multi-statement transaction, so each of these runs as one function call.
-- All are security definer with an empty search path; user-facing ones scope
-- every row to auth.uid(), agent ones take the user and workspace from the
-- agent run row, never from arguments.

-- Helpers, callable only from the functions below. -------------------------

-- The client-visible columns of a note, as returned in a conflict.
create function public.note_json(n public.notes) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', n.id, 'workspace_id', n.workspace_id, 'title', n.title,
    'content', n.content, 'plain_text', n.plain_text, 'bucket', n.bucket,
    'tags', to_jsonb(n.tags), 'source', n.source, 'origin', n.origin,
    'created_at', n.created_at, 'updated_at', n.updated_at,
    'completed_at', n.completed_at, 'due_date', n.due_date,
    'revision', n.revision)
$$;

-- Columns an agent change can touch, and so the only ones undo restores.
create function public.agent_restorable(p_values jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from jsonb_each(coalesce(p_values, '{}'::jsonb))
  where key = any (array['title', 'bucket', 'tags', 'completed_at', 'content',
                         'plain_text', 'triage_status'])
$$;

-- Restorable keys of p_values whose value differs from the note's current
-- value. Values are compared after casting to the column types, so
-- timestamp formatting differences do not count as changes.
create function public.note_fields_differ(n public.notes, p_values jsonb)
returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(key order by key), '{}'::text[])
  from jsonb_object_keys(public.agent_restorable(p_values)) as key
  where to_jsonb(jsonb_populate_record(n, jsonb_build_object(key, p_values -> key))) -> key
        is distinct from to_jsonb(n) -> key
$$;

revoke execute on function public.note_json(public.notes) from public, anon, authenticated, service_role;
revoke execute on function public.agent_restorable(jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.note_fields_differ(public.notes, jsonb) from public, anon, authenticated, service_role;

-- Browser saves (W1, W3). ---------------------------------------------------

-- Creates or updates a batch of the caller's notes. Each item is
-- { id, workspace_id, title, content, plain_text, bucket, tags, created_at,
--   completed_at, due_date?, expected_revision? } where expected_revision is
-- an integer (apply only at that revision), null (create-only), or absent
-- (legacy last-writer-wins, refused when p_require_revision). Server-owned
-- columns in the input are ignored. Each item is atomic on its own; a failed
-- item never aborts the rest. Returns one result per item, in order.
create function public.save_notes(p_notes jsonb, p_require_revision boolean)
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
              then (v_item ->> 'due_date')::date else due_date end
          where id = v_id
          returning * into v_saved;
        else
          insert into public.notes (id, user_id, workspace_id, title, content,
            plain_text, bucket, tags, created_at, completed_at, due_date)
          values (v_id, v_uid, (v_item ->> 'workspace_id')::uuid,
            v_item ->> 'title', v_item -> 'content', v_item ->> 'plain_text',
            v_item ->> 'bucket',
            array(select jsonb_array_elements_text(v_item -> 'tags')),
            coalesce((v_item ->> 'created_at')::timestamptz, now()),
            (v_item ->> 'completed_at')::timestamptz,
            (v_item ->> 'due_date')::date)
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
        v_result := jsonb_build_object('id', v_id, 'status', 'invalid', 'code', 'invalid_note');
    end;
    v_results := v_results || jsonb_build_array(v_result);
  end loop;
  return v_results;
end $$;

-- Browser delete (W2). A null p_expected_revision is a legacy delete,
-- refused when p_require_revision.
create function public.delete_note(p_id uuid, p_expected_revision bigint, p_require_revision boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.notes;
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
  delete from public.notes where id = v_row.id;
  return jsonb_build_object('status', 'deleted', 'id', v_row.id);
end $$;

revoke execute on function public.save_notes(jsonb, boolean) from public, anon;
grant execute on function public.save_notes(jsonb, boolean) to authenticated;
revoke execute on function public.delete_note(uuid, bigint, boolean) from public, anon;
grant execute on function public.delete_note(uuid, bigint, boolean) to authenticated;

-- Organizing agent (W6). Service role only. --------------------------------

-- Applies an agent change and records it in agent_actions in one
-- transaction. Writes nothing unless the note is still at the revision the
-- agent read. p_after is filtered to the restorable columns; unchanged values
-- are dropped, and before values come from the locked row.
create function public.agent_apply_note_change(p_run_id uuid, p_note_id uuid,
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
  update public.notes set
    title = v_new.title, bucket = v_new.bucket, tags = v_new.tags,
    completed_at = v_new.completed_at, content = v_new.content,
    plain_text = v_new.plain_text, triage_status = v_new.triage_status
  where id = v_row.id
  returning revision into v_revision;
  insert into public.agent_actions (run_id, user_id, note_id, kind, before,
    after, reason, revision_before, revision_after)
  values (v_run.id, v_run.user_id, v_row.id, 'update', v_before, v_after,
    nullif(p_reason, ''), v_row.revision, v_revision)
  returning id into v_action;
  return jsonb_build_object('status', 'applied', 'revision', v_revision, 'actionId', v_action);
end $$;

-- Creates a note for an agent run and records the create action in one
-- transaction. p_note: { title, content, plain_text, bucket, tags }.
create function public.agent_create_note(p_run_id uuid, p_note jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.agent_runs;
  v_saved public.notes;
  v_action uuid;
begin
  select * into v_run from public.agent_runs where id = p_run_id for share;
  if not found or v_run.status <> 'running' then
    return jsonb_build_object('status', 'run_not_active');
  end if;
  insert into public.notes (id, user_id, workspace_id, title, content,
    plain_text, bucket, tags)
  values (gen_random_uuid(), v_run.user_id, v_run.workspace_id,
    p_note ->> 'title', p_note -> 'content',
    coalesce(p_note ->> 'plain_text', ''), p_note ->> 'bucket',
    array(select jsonb_array_elements_text(coalesce(p_note -> 'tags', '[]'::jsonb))))
  returning * into v_saved;
  insert into public.agent_actions (run_id, user_id, note_id, kind, before,
    after, reason, revision_before, revision_after)
  values (v_run.id, v_run.user_id, v_saved.id, 'create', null,
    jsonb_build_object('title', v_saved.title, 'content', v_saved.content,
      'plain_text', v_saved.plain_text, 'bucket', v_saved.bucket,
      'tags', to_jsonb(v_saved.tags)),
    nullif(p_reason, ''), null, v_saved.revision)
  returning id into v_action;
  return jsonb_build_object('status', 'created', 'id', v_saved.id,
    'revision', v_saved.revision, 'actionId', v_action);
end $$;

revoke execute on function public.agent_apply_note_change(uuid, uuid, bigint, jsonb, text) from public, anon, authenticated;
grant execute on function public.agent_apply_note_change(uuid, uuid, bigint, jsonb, text) to service_role;
revoke execute on function public.agent_create_note(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.agent_create_note(uuid, jsonb, text) to service_role;

-- Agent undo (W8). -----------------------------------------------------------

-- Reverts one of the caller's agent changes without erasing later edits:
-- an update is restored only while every value it set is still in place, and
-- a created note is deleted only while nobody has changed it. Actions older
-- than the 90-day retention window cannot be undone.
create function public.undo_agent_action(p_action_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_action public.agent_actions;
  v_row public.notes;
  v_exists boolean;
  v_fields text[];
  v_new public.notes;
  v_revision bigint;
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
    -- D-02 adds the project_has_linked_items check here (ADR 001).
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
    update public.notes set
      title = v_new.title, bucket = v_new.bucket, tags = v_new.tags,
      completed_at = v_new.completed_at, content = v_new.content,
      plain_text = v_new.plain_text, triage_status = v_new.triage_status
    where id = v_row.id
    returning revision into v_revision;
  end if;
  update public.agent_actions set undone_at = now(), undone_by = v_uid
    where id = v_action.id;
  return jsonb_build_object('status', 'undone', 'undone', v_action.id,
    'revision', v_revision);
end $$;

revoke execute on function public.undo_agent_action(uuid) from public, anon;
grant execute on function public.undo_agent_action(uuid) to authenticated;

-- Retention. ---------------------------------------------------------------

-- Agent action values are copies of note content; keep them 90 days, the same
-- as the undo window. The row stays as history without the values. Returns
-- the number of actions purged. Run daily from the scheduler tick.
create function public.purge_agent_action_values() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update public.agent_actions set before = null, after = null
  where created_at < now() - interval '90 days'
    and (before is not null or after is not null);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on function public.purge_agent_action_values() from public, anon, authenticated;
grant execute on function public.purge_agent_action_values() to service_role;
