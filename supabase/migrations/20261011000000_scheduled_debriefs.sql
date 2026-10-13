-- Account-owned recurring work and reports. Secrets stay server-only.
create table public.scheduled_integrations (
  user_id uuid primary key references auth.users (id) on delete cascade,
  jira_site text,
  jira_email text,
  jira_token_ciphertext text,
  jira_key_hint text,
  github_token_ciphertext text,
  github_key_hint text,
  updated_at timestamptz not null default now()
);
alter table public.scheduled_integrations enable row level security;

create table public.scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  kind text not null check (kind in ('team_debrief')),
  enabled boolean not null default false,
  timezone text not null default 'America/Chicago',
  delivery_hour smallint not null default 6 check (delivery_hour between 3 and 23),
  cadence text not null default 'daily' check (cadence in ('daily', 'weekdays')),
  jira_projects text[] not null default '{}',
  github_repos text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index scheduled_tasks_enabled_idx on public.scheduled_tasks (enabled, delivery_hour)
  where enabled;
alter table public.scheduled_tasks enable row level security;
create policy "Users read their own scheduled tasks" on public.scheduled_tasks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own scheduled tasks" on public.scheduled_tasks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change their own scheduled tasks" on public.scheduled_tasks
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users remove their own scheduled tasks" on public.scheduled_tasks
  for delete to authenticated using ((select auth.uid()) = user_id);

create table public.scheduled_task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.scheduled_tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  report_date date not null,
  trigger text not null check (trigger in ('scheduled', 'manual')),
  status text not null default 'running'
    check (status in ('running', 'done', 'partial', 'failed')),
  report jsonb,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint scheduled_task_runs_owner_fk foreign key (task_id, user_id)
    references public.scheduled_tasks (id, user_id) on delete cascade
);
create unique index scheduled_task_runs_once_per_day
  on public.scheduled_task_runs (task_id, report_date) where trigger = 'scheduled';
create index scheduled_task_runs_recent_idx
  on public.scheduled_task_runs (user_id, created_at desc);
alter table public.scheduled_task_runs enable row level security;
create policy "Users read their own scheduled reports" on public.scheduled_task_runs
  for select to authenticated using ((select auth.uid()) = user_id);

-- Existing accounts get a prepared task. It remains off until sources are connected.
insert into public.scheduled_tasks
  (user_id, name, kind, jira_projects, delivery_hour, timezone)
select distinct user_id, 'Nightly team debrief', 'team_debrief',
  array['Specialty', 'Patient Management'], 6, 'America/Chicago'
from public.workspaces;
