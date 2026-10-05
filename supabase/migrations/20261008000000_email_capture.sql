-- Email capture: each workspace gets a private inbound address
-- (<name>-<inbox_token>@<receiving domain>) and emails become notes.

alter table public.notes drop constraint notes_source_check;
alter table public.notes
  add constraint notes_source_check check (source in ('web', 'slack', 'email'));

-- The token is the secret part of the address. 12 hex characters from a
-- random UUID; regenerate it to retire an address that has leaked.
create function public.new_inbox_token() returns text
language sql volatile set search_path = '' as $$
  select substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
$$;

alter table public.workspaces
  add column inbox_token text not null default public.new_inbox_token();
alter table public.workspaces
  add constraint workspaces_inbox_token_key unique (inbox_token);

-- Users may rename and recolor their workspaces, but the token changes only
-- through regenerate_inbox_token, which picks a fresh random value.
revoke update on public.workspaces from authenticated;
grant update (name, color, position) on public.workspaces to authenticated;

create function public.regenerate_inbox_token(workspace uuid) returns text
language sql volatile security definer set search_path = '' as $$
  update public.workspaces
  set inbox_token = public.new_inbox_token()
  where id = workspace and user_id = (select auth.uid())
  returning inbox_token
$$;
revoke execute on function public.regenerate_inbox_token(uuid) from public, anon;
grant execute on function public.regenerate_inbox_token(uuid) to authenticated;
