-- Separate workspaces (e.g. Personal and Waltz) inside one Orbit account.
-- Every note belongs to one workspace, and each linked Slack workspace sends
-- its captures to one Orbit workspace.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  -- Target for composite foreign keys, which tie a row's workspace to the
  -- same owner at the database level.
  unique (id, user_id)
);

create index workspaces_user_idx on public.workspaces (user_id, position);

alter table public.workspaces enable row level security;

create policy "Users read their own workspaces" on public.workspaces
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own workspaces" on public.workspaces
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change their own workspaces" on public.workspaces
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users delete their own workspaces" on public.workspaces
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Everyone who already has data starts with a Personal workspace.
insert into public.workspaces (user_id, name)
select distinct user_id, 'Personal'
from (
  select user_id from public.notes
  union
  select user_id from public.slack_links
) existing;

alter table public.notes add column workspace_id uuid;
update public.notes n
set workspace_id = w.id
from public.workspaces w
where w.user_id = n.user_id;
alter table public.notes
  alter column workspace_id set not null,
  add constraint notes_workspace_fk foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id) on delete cascade;
create index notes_workspace_idx on public.notes (workspace_id);

alter table public.slack_links add column workspace_id uuid;
update public.slack_links l
set workspace_id = w.id
from public.workspaces w
where w.user_id = l.user_id;
alter table public.slack_links
  alter column workspace_id set not null,
  add constraint slack_links_workspace_fk foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id) on delete cascade;

-- Users may re-route their own Slack links to another of their workspaces,
-- but may not change which Slack account a link belongs to.
revoke update on public.slack_links from authenticated;
grant update (workspace_id) on public.slack_links to authenticated;
create policy "Users re-route their own Slack links" on public.slack_links
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Rows written without a workspace (older app versions mid-deploy, future
-- integrations) go to the owner's first workspace, created if needed.
create function public.fill_workspace_id() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.workspace_id is null then
    select id into new.workspace_id from public.workspaces
    where user_id = new.user_id
    order by position, created_at
    limit 1;
    if new.workspace_id is null then
      insert into public.workspaces (user_id, name)
      values (new.user_id, 'Personal')
      returning id into new.workspace_id;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.fill_workspace_id() from public, anon, authenticated;

create trigger notes_fill_workspace before insert on public.notes
  for each row execute function public.fill_workspace_id();
create trigger slack_links_fill_workspace before insert on public.slack_links
  for each row execute function public.fill_workspace_id();
