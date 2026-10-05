-- Notes move from browser localStorage into Postgres so server-side capture
-- (Slack today, an organizing agent later) can reach a user's inbox.

create table public.notes (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default '' check (char_length(title) <= 2000),
  content jsonb not null,
  plain_text text not null default '',
  bucket text not null default 'inbox'
    check (bucket in ('inbox', 'next', 'projects', 'waiting', 'someday', 'reference')),
  tags text[] not null default '{}',
  -- Where the note came from. source_ref is a stable external id (for Slack:
  -- team/channel/message ts) so forwarding the same message twice is a no-op.
  source text not null default 'web' check (source in ('web', 'slack')),
  source_ref text,
  origin jsonb,
  -- Reserved for the organizing agent: 'pending' notes are waiting for triage.
  triage_status text not null default 'none'
    check (triage_status in ('none', 'pending', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, source_ref)
);

create index notes_user_updated_idx on public.notes (user_id, updated_at desc);
create index notes_triage_pending_idx on public.notes (triage_status)
  where triage_status = 'pending';

alter table public.notes enable row level security;

create policy "Users read their own notes" on public.notes
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own notes" on public.notes
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change their own notes" on public.notes
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users delete their own notes" on public.notes
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Which Orbit account a Slack user's forwarded messages belong to.
-- Users may see and remove their own links, but only the server (after
-- verifying a signed link from Slack) may create them. Otherwise anyone could
-- claim another person's Slack ID and receive their forwarded messages.
create table public.slack_links (
  slack_team_id text not null,
  slack_user_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  slack_team_name text,
  created_at timestamptz not null default now(),
  primary key (slack_team_id, slack_user_id)
);

create index slack_links_user_idx on public.slack_links (user_id);

alter table public.slack_links enable row level security;

create policy "Users read their own Slack links" on public.slack_links
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users remove their own Slack links" on public.slack_links
  for delete to authenticated using ((select auth.uid()) = user_id);
