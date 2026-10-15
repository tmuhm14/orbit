-- Saving an accepted assignment result as a linked document item (ADR 003
-- §6, U-05). Purely additive and safe to apply while the previous app version
-- is live:
-- - one new function, save_assignment_artifact_as_note(), granted to
--   authenticated; no existing function, trigger, policy or grant changes;
-- - the assignment_events type check gains 'artifact_saved' (a strict
--   superset, so every row and every insert that passed before still passes);
-- - one new index on assignment_artifacts (saved_note_id), so deleting a
--   note doesn't scan artifacts for the existing `on delete set null` key.
-- assignment_artifacts.saved_note_id already exists (A-01) with a foreign
-- key to notes (id) on delete set null; it is reused as is. Nothing wrote it
-- before this migration, so every existing row is null.
--
-- Rules:
-- - The note is a user write (no agent_actions row): kind 'document', bucket
--   'reference', the assignment's workspace and owner, the artifact's
--   content and plain text, source 'web' (the provenance column's allowed
--   set is unchanged, so current clients still accept the row) and
--   origin { kind: 'assignment', assignmentId, artifactId }.
-- - Ownership is checked against auth.uid(): another account's assignment
--   looks exactly like a missing one. The note goes through the normal
--   triggers (workspace fill, revision 1, project link validation).
-- - The link is the artifact's saved_note_id plus an append-only
--   `artifact_saved` event (actor user). Saving does not change the
--   assignment row, its state or its revision.
-- - Messages are fixed codes; nothing puts titles or content into an error.

alter table public.assignment_events drop constraint assignment_events_type_check;
alter table public.assignment_events add constraint assignment_events_type_check
  check (type in ('state_changed', 'progress', 'question_asked', 'question_answered',
    'artifact_submitted', 'review_decided', 'cancel_requested', 'context_unavailable',
    'item_detached', 'artifact_saved'));

create index assignment_artifacts_saved_note_idx on public.assignment_artifacts (saved_note_id)
  where saved_note_id is not null;

-- Creates the document item for the accepted artifact of a completed
-- assignment, in one transaction. p_options (an object; unknown keys are
-- ignored):
--   title       optional override, trimmed, 1–200 characters; default the
--               artifact title
--   project_id  present: that project (null = none); absent: the source item
--               itself if it is a project, else the source item's project,
--               else none (also none when the source item was deleted)
-- Results:
--   created { note, assignment, artifactId }
--   not_found                no such assignment or artifact for this user
--   invalid_payload          argument shape or limits
--   conflict { currentRevision, state }      p_expected_revision is stale
--   invalid_transition { from, to: 'completed', allowed }   not completed
--   artifact_superseded      not the accepted, current artifact
--   already_saved { noteId } this artifact already has a saved document
--   invalid { code }         the project link was refused: invalid_project_link,
--                            project_cycle, project_depth_exceeded
create function public.save_assignment_artifact_as_note(p_id uuid, p_expected_revision bigint,
  p_artifact_id uuid, p_options jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_options jsonb := coalesce(p_options, '{}'::jsonb);
  v_row public.assignments;
  v_artifact public.assignment_artifacts;
  v_source public.notes;
  v_title text;
  v_project uuid;
  v_note public.notes;
  v_message text;
  v_constraint text;
  v_code text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_id is null or p_expected_revision is null or p_artifact_id is null
     or jsonb_typeof(v_options) <> 'object'
     or coalesce(jsonb_typeof(v_options -> 'title'), 'string') <> 'string'
     or coalesce(jsonb_typeof(v_options -> 'project_id'), 'null') not in ('string', 'null') then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  if v_options ? 'title' then
    v_title := btrim(v_options ->> 'title');
    if char_length(v_title) not between 1 and 200 then
      return jsonb_build_object('status', 'invalid_payload');
    end if;
  end if;
  if v_options ? 'project_id' then
    begin
      v_project := (v_options ->> 'project_id')::uuid;
    exception when data_exception then
      return jsonb_build_object('status', 'invalid_payload');
    end;
  end if;
  -- Serializes saves of the same assignment, so a double submit can't create
  -- two documents.
  select * into v_row from public.assignments where id = p_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'currentRevision', v_row.revision,
      'state', v_row.state);
  end if;
  if v_row.state <> 'completed' then
    return public.assignment_invalid_transition(v_row.state, 'completed', 'user');
  end if;
  select * into v_artifact from public.assignment_artifacts
    where id = p_artifact_id and assignment_id = v_row.id and user_id = v_uid
    for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_artifact.superseded_at is not null
     or not exists (select 1 from public.assignment_reviews r
                    where r.assignment_id = v_row.id and r.artifact_id = v_artifact.id
                      and r.decision = 'accept') then
    return jsonb_build_object('status', 'artifact_superseded');
  end if;
  if v_artifact.saved_note_id is not null then
    return jsonb_build_object('status', 'already_saved', 'noteId', v_artifact.saved_note_id);
  end if;
  if not (v_options ? 'project_id') and v_row.source_note_id is not null then
    select * into v_source from public.notes
      where id = v_row.source_note_id and user_id = v_uid and workspace_id = v_row.workspace_id;
    if found then
      v_project := case when v_source.kind = 'project' then v_source.id else v_source.project_id end;
    end if;
  end if;
  begin
    insert into public.notes (id, user_id, workspace_id, title, content, plain_text, bucket,
      tags, source, origin, kind, project_id)
    values (gen_random_uuid(), v_uid, v_row.workspace_id, coalesce(v_title, v_artifact.title),
      v_artifact.content, v_artifact.plain_text, 'reference', '{}', 'web',
      jsonb_build_object('kind', 'assignment', 'assignmentId', v_row.id,
                         'artifactId', v_artifact.id),
      'document', v_project)
    returning * into v_note;
  exception when integrity_constraint_violation then
    get stacked diagnostics v_message = message_text, v_constraint = constraint_name;
    v_code := public.note_link_error(v_message, v_constraint);
    if v_code in ('invalid_project_link', 'project_cycle', 'project_depth_exceeded') then
      return jsonb_build_object('status', 'invalid', 'code', v_code);
    elsif v_code is not null then
      return jsonb_build_object('status', 'invalid', 'code', 'invalid_project_link');
    end if;
    raise;
  end;
  update public.assignment_artifacts set saved_note_id = v_note.id where id = v_artifact.id;
  perform public.assignment_event(v_row, 'artifact_saved', 'user',
    jsonb_build_object('artifactId', v_artifact.id, 'noteId', v_note.id), v_artifact.attempt_id);
  return jsonb_build_object('status', 'created', 'note', public.note_json(v_note),
    'assignment', public.assignment_json(v_row), 'artifactId', v_artifact.id);
end $$;

revoke execute on function public.save_assignment_artifact_as_note(uuid, bigint, uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.save_assignment_artifact_as_note(uuid, bigint, uuid, jsonb)
  to authenticated;
