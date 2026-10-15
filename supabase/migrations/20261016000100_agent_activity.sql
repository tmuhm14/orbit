-- Progress is private run data, covered by the existing owner-only read policy.
-- Only server code writes it. No raw tool arguments or results are recorded.
alter table public.agent_runs
  add column events jsonb not null default '[]'::jsonb
    check (jsonb_typeof(events) = 'array' and jsonb_array_length(events) <= 200),
  add column parent_run_id uuid references public.agent_runs(id) on delete set null;
