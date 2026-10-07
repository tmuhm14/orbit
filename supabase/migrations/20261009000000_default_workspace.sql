-- Keep the space opened at sign-in consistent across the account's devices.
alter table public.workspaces
  add column is_default boolean not null default false;

update public.workspaces w
set is_default = true
where w.id = (
  select first_space.id from public.workspaces first_space
  where first_space.user_id = w.user_id
  order by first_space.position, first_space.created_at
  limit 1
);

create unique index workspaces_one_default_per_user
  on public.workspaces (user_id) where is_default;

-- The account owner can change the default in one transaction. The column is
-- excluded from direct authenticated updates so two defaults cannot be set.
create function public.set_default_workspace(workspace uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := (select auth.uid());
begin
  if owner_id is null then return false; end if;
  perform 1 from public.workspaces
    where id = workspace and user_id = owner_id;
  if not found then return false; end if;

  update public.workspaces set is_default = false
    where user_id = owner_id and is_default;
  update public.workspaces set is_default = true
    where id = workspace and user_id = owner_id;
  return true;
end $$;

revoke execute on function public.set_default_workspace(uuid) from public, anon;
grant execute on function public.set_default_workspace(uuid) to authenticated;

-- Older clients and integrations that omit workspace_id use the default too.
create or replace function public.fill_workspace_id() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.workspace_id is null then
    select id into new.workspace_id from public.workspaces
    where user_id = new.user_id
    order by is_default desc, position, created_at
    limit 1;
    if new.workspace_id is null then
      insert into public.workspaces (user_id, name, is_default)
      values (new.user_id, 'Personal', true)
      returning id into new.workspace_id;
    end if;
  end if;
  return new;
end $$;
