-- Organizing agent: the account brings its own model API key (Anthropic,
-- OpenAI, or xAI), opts in per workspace, and every change the agent makes is
-- recorded with its before/after values so it can be undone.

-- Off by default. Notes in an enabled workspace are sent to the chosen model
-- provider, so leave it off for spaces that may hold sensitive data.
alter table public.workspaces
  add column agent_enabled boolean not null default false;
grant update (agent_enabled) on public.workspaces to authenticated;
-- Start with Personal spaces only. Work spaces (e.g. Waltz) stay off until
-- their content has been reviewed for what may go to a model provider.
update public.workspaces set agent_enabled = true
where lower(btrim(name)) = 'personal';

-- One provider and key per account. The key is encrypted by the server
-- (AES-256-GCM, AGENT_ENCRYPTION_KEY) before it is stored. No policies: the
-- browser never reads this table, only server routes using the admin client.
create table public.agent_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'openai', 'xai')),
  model text not null check (char_length(model) between 1 and 100),
  api_key_ciphertext text not null,
  -- Last four characters, so the settings screen can show which key is saved.
  key_hint text not null check (char_length(key_hint) <= 4),
  -- Triage Slack and email captures as they arrive.
  auto_triage boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.agent_settings enable row level security;

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  trigger text not null check (trigger in ('capture', 'manual')),
  mode text not null check (mode in ('triage', 'organize')),
  instruction text check (char_length(instruction) <= 2000),
  provider text not null,
  model text not null,
  status text not null default 'running'
    check (status in ('running', 'done', 'failed')),
  summary text,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint agent_runs_workspace_fk foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id) on delete cascade
);
create index agent_runs_workspace_idx
  on public.agent_runs (workspace_id, created_at desc);

-- note_id has no foreign key so the history outlives the note.
create table public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  note_id uuid not null,
  kind text not null check (kind in ('update', 'create')),
  -- Only the fields the agent changed, as stored columns.
  before jsonb,
  after jsonb not null,
  reason text,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
create index agent_actions_run_idx on public.agent_actions (run_id);

-- Users read their own history; only the server writes it.
alter table public.agent_runs enable row level security;
alter table public.agent_actions enable row level security;
create policy "Users read their own agent runs" on public.agent_runs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own agent actions" on public.agent_actions
  for select to authenticated using ((select auth.uid()) = user_id);
