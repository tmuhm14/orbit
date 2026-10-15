-- A distinct per-item code for workspace moves refused by an open assignment
-- (ADR 003 §2). The notes_detach_finished_assignments trigger raises
-- check_violation `assignment_active`; until now note_link_error() returned
-- null for it, so save_notes reported the generic `invalid_note`. It now
-- returns `assignment_active`, and save_notes reports that code instead.
--
-- Additive and backward compatible: same signature, and the same result for
-- every input that used to map to a code (the new branch comes last, so it
-- only replaces a null). Current clients map codes they don't know to
-- `invalid_note`, so they behave exactly as before. The agent functions that
-- also call note_link_error() never change workspace_id, so the trigger
-- (`before update of workspace_id`) cannot raise there.
create or replace function public.note_link_error(p_message text, p_constraint text)
returns text
language sql immutable set search_path = '' as $$
  select case
    when p_message in ('invalid_project_link', 'project_cycle',
                       'project_depth_exceeded', 'project_has_linked_items')
      then p_message
    when p_constraint = 'notes_project_not_self' then 'invalid_project_link'
    when p_constraint = 'notes_project_fk' then 'linked_item_move'
    -- New, and last, so it only replaces what used to be null.
    when p_message = 'assignment_active' then 'assignment_active'
  end
$$;
revoke execute on function public.note_link_error(text, text) from public, anon, authenticated, service_role;
