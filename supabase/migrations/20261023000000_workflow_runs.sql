-- Workflow run history: one row per run of a workflow (lib/workflows/runs.ts)
-- and the items a run started from or touched. Purely additive: two new
-- tables with their own indexes and policies. No existing table, column,
-- policy or function changes, so it is safe to apply while the previous app
-- version is live; nothing reads these tables until the run routes ship.
--
-- Rules:
-- - A run belongs to one workspace and its owner (composite foreign key to
--   workspaces); deleting the workspace deletes its runs.
-- - workflow_id is set null when the workflow is deleted, so history outlives
--   it; workflow_name and workflow_revision are snapshots taken at run time.
-- - mode 'test' is the designer's simulated run; 'live' is reserved for
--   server runs on durable jobs.
-- - steps hold step metadata only (node, kind, label, status, port, times):
--   no step output, prompts or item content. error_code is a fixed,
--   content-free identifier from the engine.
-- - workflow_run_items ties a run to items (notes of any kind) in the same
--   workspace: the item it started from ('source') or one it created or
--   updated. Deleting the item or the run deletes the link.
-- - Owners read and write their own rows (RLS).

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  workflow_id uuid references public.workflows (id) on delete set null,
  workflow_name text not null check (char_length(btrim(workflow_name)) between 1 and 80),
  workflow_revision integer not null check (workflow_revision >= 1),
  mode text not null default 'test' check (mode in ('test', 'live')),
  trigger text not null default 'manual' check (trigger in ('manual', 'item_captured')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'canceled', 'invalid')),
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  steps jsonb not null default '[]'::jsonb
    check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 200
      and pg_column_size(steps) <= 65536),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint workflow_runs_id_workspace_user_key unique (id, workspace_id, user_id),
  constraint workflow_runs_workspace_owner_fk foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id) on delete cascade,
  constraint workflow_runs_finished_when_final check ((status = 'running') = (finished_at is null)),
  constraint workflow_runs_finished_order check (finished_at is null or finished_at >= started_at)
);

-- The space's history, newest first.
create index workflow_runs_workspace_idx on public.workflow_runs (user_id, workspace_id, started_at desc);
-- One workflow's runs.
create index workflow_runs_workflow_idx on public.workflow_runs (workflow_id, started_at desc)
  where workflow_id is not null;

create table public.workflow_run_items (
  run_id uuid not null,
  item_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null default auth.uid(),
  role text not null check (role in ('source', 'created', 'updated')),
  created_at timestamptz not null default now(),
  primary key (run_id, item_id, role),
  constraint workflow_run_items_run_fk foreign key (run_id, workspace_id, user_id)
    references public.workflow_runs (id, workspace_id, user_id) on delete cascade,
  constraint workflow_run_items_item_fk foreign key (item_id, workspace_id, user_id)
    references public.notes (id, workspace_id, user_id) on delete cascade
);

-- One item's runs.
create index workflow_run_items_item_idx on public.workflow_run_items (item_id);

alter table public.workflow_runs enable row level security;
alter table public.workflow_run_items enable row level security;

create policy "Users read their own workflow runs" on public.workflow_runs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own workflow runs" on public.workflow_runs
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users finish their own workflow runs" on public.workflow_runs
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users remove their own workflow runs" on public.workflow_runs
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users read their own workflow run items" on public.workflow_run_items
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own workflow run items" on public.workflow_run_items
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users remove their own workflow run items" on public.workflow_run_items
  for delete to authenticated using ((select auth.uid()) = user_id);
