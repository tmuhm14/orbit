-- Server-managed note revisions (ADR 002 §1). Every writer, including direct
-- PostgREST updates, moves the revision when a user-visible column changes,
-- so later writers can detect that their copy is stale.

-- Existing rows start at revision 1.
alter table public.notes add column revision bigint not null default 1;

-- Agent audit rows record which revision they were based on and produced, so
-- undo can tell whether a person edited the note since. Null for actions
-- recorded before this migration. before/after are purged after 90 days
-- (purge_agent_action_values in the next migration), so after may be null.
alter table public.agent_actions
  add column revision_before bigint,
  add column revision_after bigint,
  add column undone_by uuid references auth.users (id) on delete set null;
alter table public.agent_actions alter column after drop not null;

-- Inserts start at revision 1. Updates bump the revision only when a tracked
-- column changes; a writer can never set revision or updated_at itself.
-- Tracked: title, content, plain_text, bucket, tags, completed_at, due_date,
-- workspace_id. Later migrations that add user-visible columns (kind and
-- project_id in D-02; waiting_on, waiting_for, next_check_on in D-03) must
-- `create or replace` this function to track them.
-- Not tracked: triage_status (agent bookkeeping must not conflict with a
-- person typing in a fresh capture) and the server-owned origin, source and
-- source_ref.
create function public.notes_manage_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
    new.updated_at := now();
    return new;
  end if;
  if (new.title, new.content, new.plain_text, new.bucket, new.tags,
      new.completed_at, new.due_date, new.workspace_id)
     is distinct from
     (old.title, old.content, old.plain_text, old.bucket, old.tags,
      old.completed_at, old.due_date, old.workspace_id) then
    new.revision := old.revision + 1;
    new.updated_at := now();
  else
    new.revision := old.revision;
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;
revoke execute on function public.notes_manage_revision() from public, anon, authenticated;

create trigger notes_manage_revision before insert or update on public.notes
  for each row execute function public.notes_manage_revision();
