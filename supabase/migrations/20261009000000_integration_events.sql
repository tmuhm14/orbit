-- A short log of inbound captures (Slack, email) for the admin health view.
-- Row-level security is on with no policies, so only the server's secret key
-- can read or write it; browsers never see it.
create table public.integration_events (
  id bigint generated always as identity primary key,
  source text not null check (source in ('slack', 'email')),
  status text not null
    check (status in ('captured', 'duplicate', 'unlinked', 'ignored', 'error')),
  detail text check (char_length(detail) <= 500),
  user_id uuid references auth.users (id) on delete set null,
  workspace_id uuid references public.workspaces (id) on delete set null,
  created_at timestamptz not null default now()
);

create index integration_events_created_idx
  on public.integration_events (created_at desc);

alter table public.integration_events enable row level security;
