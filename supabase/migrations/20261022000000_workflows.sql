-- Workflows: designer-built graphs of agent tasks, conditions, approvals and
-- item actions (lib/workflows/model.ts). Purely additive: one new table with
-- its own indexes and policies. No existing table, column, policy or function
-- changes, so it is safe to apply while the previous app version is live;
-- nothing reads this table until the workflow routes ship.
--
-- Rules:
-- - Each workflow belongs to one workspace and its owner, tied by the
--   composite foreign key to workspaces (id, user_id); deleting the workspace
--   deletes its workflows.
-- - definition is the whole graph as one jsonb document; the API validates its
--   shape (parseDefinition) before every write. The size check is a backstop.
-- - revision supports optimistic concurrency: the API updates only the
--   revision it read and bumps it (same idea as notes, ADR 002).
-- - Owners read and write their own rows (RLS).

create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  definition jsonb not null default '{"version":1,"nodes":[],"edges":[]}'::jsonb
    check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 262144),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflows_workspace_owner_fk foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id) on delete cascade
);

create index workflows_workspace_idx on public.workflows (user_id, workspace_id, updated_at desc);

alter table public.workflows enable row level security;

create policy "Users read their own workflows" on public.workflows
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own workflows" on public.workflows
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change their own workflows" on public.workflows
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users remove their own workflows" on public.workflows
  for delete to authenticated using ((select auth.uid()) = user_id);
