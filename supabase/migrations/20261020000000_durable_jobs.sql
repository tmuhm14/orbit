-- A-04: durable jobs on Postgres (ADR 005 tier 3, ADR 006).
--
-- Purely additive: two new tables (jobs, job_steps), their indexes, and new
-- functions. No existing table, column, constraint, policy, trigger, grant or
-- function changes.
--
-- Semantics (ADR 005 §2): at-least-once delivery with idempotent or
-- reconciled effects. A job is claimed with a lease (lease_token, fencing);
-- every later call for that delivery must present the token, and an expired,
-- revoked or superseded lease is `lease_lost` and writes nothing. Payloads
-- hold ids only (no content); error codes are normalized identifiers.
--
-- Access: everything is service_role only, through the functions below. RLS
-- is on with no policies, and anon/authenticated have no table or function
-- privileges: jobs carry no user-facing state (the owning record, such as an
-- assignment, is what the UI shows; ADR 005 §6).

-- Tables. ----------------------------------------------------------------------

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  -- Dotted lower-case identifier, e.g. 'assignment.run'.
  kind text not null
    constraint jobs_kind_check
    check (char_length(kind) <= 64 and kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  -- Ids only: a flat object of scalars (enforced by enqueue_job; size capped here).
  payload jsonb not null default '{}'::jsonb
    constraint jobs_payload_check
    check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 2048),
  -- Unique per kind: enqueueing the same key again returns the existing job.
  idempotency_key text not null
    constraint jobs_idempotency_key_check
    check (char_length(idempotency_key) between 1 and 200),
  status text not null default 'queued'
    constraint jobs_status_check
    check (status in ('queued', 'running', 'completed', 'dead', 'canceled')),
  run_at timestamptz not null default now(),
  -- Deliveries so far (claims), and the most allowed before the job is dead.
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 5 check (max_attempts between 1 and 25),
  -- Retry delay: min(max, base * 2^(attempts - 1)), with "equal jitter" (half
  -- fixed, half random), for failures and expired leases.
  backoff_base_seconds integer not null default 15 check (backoff_base_seconds between 1 and 3600),
  backoff_max_seconds integer not null default 900
    check (backoff_max_seconds between 1 and 86400),
  leased_by text check (char_length(leased_by) between 1 and 100),
  lease_token uuid,                               -- fencing token; never logged
  lease_expires_at timestamptz,
  last_error_code text
    constraint jobs_last_error_code_check
    check (last_error_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint jobs_kind_idempotency_key_key unique (kind, idempotency_key),
  constraint jobs_backoff_order check (backoff_max_seconds >= backoff_base_seconds),
  constraint jobs_lease_when_running check (
    (status = 'running') = (lease_token is not null and lease_expires_at is not null and leased_by is not null)),
  constraint jobs_finished_when_final check (
    (status in ('completed', 'dead', 'canceled')) = (finished_at is not null))
);
-- Ready work, in order.
create index jobs_ready_idx on public.jobs (run_at, created_at) where status = 'queued';
-- Leases for the reaper.
create index jobs_lease_idx on public.jobs (lease_expires_at) where status = 'running';
-- Retention purge.
create index jobs_finished_idx on public.jobs (finished_at) where finished_at is not null;

-- Persisted steps of multi-step jobs (ADR 005 §2): a step with an external
-- effect records 'started' (intent) before the call and 'succeeded' (with an
-- ids-only result) after it. A retry that finds 'started' must reconcile the
-- effect before repeating it. Steps survive retries of the same job.
create table public.job_steps (
  job_id uuid not null references public.jobs (id) on delete cascade,
  name text not null
    constraint job_steps_name_check
    check (char_length(name) <= 64 and name ~ '^[a-z][a-z0-9_.:-]*$'),
  status text not null check (status in ('started', 'succeeded')),
  result jsonb
    constraint job_steps_result_check
    check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 2048)),
  attempt smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (job_id, name)
);

alter table public.jobs enable row level security;
alter table public.job_steps enable row level security;
revoke all on public.jobs, public.job_steps from public, anon, authenticated, service_role;
-- Reads for reconciliation and operations (status, attempts, codes; no content exists).
grant select on public.jobs, public.job_steps to service_role;

-- Internal helpers. ---------------------------------------------------------------

-- True when p is a flat object of at most 16 scalar values (strings of at
-- most 100 characters, numbers, booleans, null) with identifier-like keys.
create function public.job_payload_valid(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and jsonb_typeof(p) = 'object'
    and (select count(*) from jsonb_object_keys(p)) <= 16
    and not exists (
      select 1 from jsonb_each(p) e
      where e.key !~ '^[a-zA-Z][a-zA-Z0-9_]{0,39}$'
         or jsonb_typeof(e.value) not in ('string', 'number', 'boolean', 'null')
         or (jsonb_typeof(e.value) = 'string' and char_length(e.value #>> '{}') > 100))
$$;
revoke execute on function public.job_payload_valid(jsonb) from public, anon, authenticated, service_role;

-- Backoff before delivery number `attempts + 1`, in seconds: exponential,
-- capped, with equal jitter (between half and all of the capped delay).
create function public.job_backoff_seconds(p_attempts integer, p_base integer, p_max integer)
returns numeric
language sql volatile set search_path = '' as $$
  select v.d / 2 + random() * v.d / 2
  from (select least(p_max::numeric, p_base::numeric * power(2::numeric, greatest(p_attempts - 1, 0))) d) v
$$;
revoke execute on function public.job_backoff_seconds(integer, integer, integer) from public, anon, authenticated, service_role;

-- The running job for (id, token) with a live lease, locked; null otherwise.
create function public.job_lease(p_job_id uuid, p_lease_token uuid) returns public.jobs
language plpgsql set search_path = '' as $$
declare
  v_job public.jobs;
begin
  if p_job_id is null or p_lease_token is null then
    return null;
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_expires_at <= now() then
    return null;
  end if;
  return v_job;
end $$;
revoke execute on function public.job_lease(uuid, uuid) from public, anon, authenticated, service_role;

-- Functions (service_role only). ------------------------------------------------

-- Idempotent enqueue. Results:
--   created { jobId, jobStatus: 'queued', runAt }
--   exists  { jobId, jobStatus, runAt } (same kind and key; nothing changes)
--   invalid_payload
create function public.enqueue_job(p_kind text, p_idempotency_key text, p_payload jsonb,
  p_run_at timestamptz default null, p_max_attempts integer default null,
  p_backoff_base_seconds integer default null, p_backoff_max_seconds integer default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
  v_base integer := coalesce(p_backoff_base_seconds, 15);
  v_max integer := coalesce(p_backoff_max_seconds, 900);
  v_attempts integer := coalesce(p_max_attempts, 5);
begin
  if p_kind is null or char_length(p_kind) > 64 or p_kind !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200
     or not public.job_payload_valid(coalesce(p_payload, '{}'::jsonb))
     or v_attempts not between 1 and 25 or v_base not between 1 and 3600
     or v_max not between v_base and 86400 then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  insert into public.jobs (kind, idempotency_key, payload, run_at, max_attempts,
    backoff_base_seconds, backoff_max_seconds)
  values (p_kind, p_idempotency_key, coalesce(p_payload, '{}'::jsonb), coalesce(p_run_at, now()),
    v_attempts, v_base, v_max)
  on conflict (kind, idempotency_key) do nothing
  returning * into v_job;
  if found then
    return jsonb_build_object('status', 'created', 'jobId', v_job.id, 'jobStatus', v_job.status,
      'runAt', v_job.run_at);
  end if;
  select * into v_job from public.jobs where kind = p_kind and idempotency_key = p_idempotency_key;
  return jsonb_build_object('status', 'exists', 'jobId', v_job.id, 'jobStatus', v_job.status,
    'runAt', v_job.run_at);
end $$;

-- Claims up to p_batch_size (1–25) ready jobs, oldest run_at first, with a
-- lease of p_lease_seconds (15–900). FOR UPDATE SKIP LOCKED: concurrent
-- workers never claim the same job. p_kinds limits the kinds (null: any);
-- p_job_id claims only that job (the in-request fast path). Each claim is a
-- delivery and counts as an attempt. Returns a jsonb array of
--   { id, kind, payload, attempt, maxAttempts, leaseToken, leaseExpiresAt, steps }
-- (steps: { name: { status, result } }), or [] when nothing is ready or the
-- arguments are invalid.
create function public.claim_jobs(p_worker text, p_lease_seconds integer, p_batch_size integer,
  p_kinds text[] default null, p_job_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_seconds integer := coalesce(p_lease_seconds, 60);
  v_batch integer := coalesce(p_batch_size, 1);
  v_result jsonb;
begin
  if p_worker is null or char_length(p_worker) not between 1 and 100
     or v_seconds not between 15 and 900 or v_batch not between 1 and 25 then
    return '[]'::jsonb;
  end if;
  with picked as (
    select j.id from public.jobs j
    where j.status = 'queued' and j.run_at <= now()
      and (p_kinds is null or j.kind = any (p_kinds))
      and (p_job_id is null or j.id = p_job_id)
    order by j.run_at, j.created_at, j.id
    limit v_batch
    for update skip locked
  ), claimed as (
    update public.jobs j set status = 'running', attempts = j.attempts + 1, leased_by = p_worker,
      lease_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => v_seconds),
      started_at = coalesce(j.started_at, now()), updated_at = now()
    from picked where j.id = picked.id
    returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'payload', c.payload,
      'attempt', c.attempts, 'maxAttempts', c.max_attempts, 'leaseToken', c.lease_token,
      'leaseExpiresAt', c.lease_expires_at,
      'steps', coalesce((select jsonb_object_agg(s.name, jsonb_build_object('status', s.status, 'result', s.result))
                         from public.job_steps s where s.job_id = c.id), '{}'::jsonb))
      order by c.run_at, c.created_at, c.id), '[]'::jsonb)
  into v_result
  from claimed c;
  return v_result;
end $$;

-- Extends a live lease by p_lease_seconds (15–900, default 60).
-- Results: ok { leaseExpiresAt }, lease_lost (expired, canceled, finished or
-- re-delivered), invalid_payload.
create function public.heartbeat_job(p_job_id uuid, p_lease_token uuid, p_lease_seconds integer default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
  v_seconds integer := coalesce(p_lease_seconds, 60);
begin
  if v_seconds not between 15 and 900 then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  v_job := public.job_lease(p_job_id, p_lease_token);
  if v_job.id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  update public.jobs set lease_expires_at = now() + make_interval(secs => v_seconds), updated_at = now()
  where id = v_job.id returning * into v_job;
  return jsonb_build_object('status', 'ok', 'leaseExpiresAt', v_job.lease_expires_at);
end $$;

-- Results: completed, lease_lost.
create function public.complete_job(p_job_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  v_job := public.job_lease(p_job_id, p_lease_token);
  if v_job.id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  update public.jobs set status = 'completed', leased_by = null, lease_token = null,
    lease_expires_at = null, finished_at = now(), updated_at = now()
  where id = v_job.id;
  return jsonb_build_object('status', 'completed');
end $$;

-- Records a failed delivery with a normalized code. With p_retryable and
-- attempts left, the job returns to the queue after the backoff; otherwise
-- it is dead (kept for inspection, never retried automatically).
-- Results: retrying { runAt }, dead, lease_lost, invalid_payload.
create function public.fail_job(p_job_id uuid, p_lease_token uuid, p_error_code text,
  p_retryable boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,39}$' then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  v_job := public.job_lease(p_job_id, p_lease_token);
  if v_job.id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  if coalesce(p_retryable, true) and v_job.attempts < v_job.max_attempts then
    update public.jobs set status = 'queued', leased_by = null, lease_token = null,
      lease_expires_at = null, last_error_code = p_error_code, updated_at = now(),
      run_at = now() + make_interval(secs => public.job_backoff_seconds(v_job.attempts,
        v_job.backoff_base_seconds, v_job.backoff_max_seconds)::double precision)
    where id = v_job.id returning * into v_job;
    return jsonb_build_object('status', 'retrying', 'runAt', v_job.run_at);
  end if;
  update public.jobs set status = 'dead', leased_by = null, lease_token = null,
    lease_expires_at = null, last_error_code = p_error_code, finished_at = now(), updated_at = now()
  where id = v_job.id;
  return jsonb_build_object('status', 'dead');
end $$;

-- Hands a delivery back without counting it as an attempt (for example the
-- work is busy elsewhere, or the worker is near its deadline), to run again
-- after p_delay_seconds (0–3600). Results: released { runAt }, lease_lost,
-- invalid_payload.
create function public.release_job(p_job_id uuid, p_lease_token uuid, p_delay_seconds integer default 0)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
  v_delay integer := coalesce(p_delay_seconds, 0);
begin
  if v_delay not between 0 and 3600 then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  v_job := public.job_lease(p_job_id, p_lease_token);
  if v_job.id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  update public.jobs set status = 'queued', attempts = greatest(v_job.attempts - 1, 0),
    leased_by = null, lease_token = null, lease_expires_at = null, updated_at = now(),
    run_at = now() + make_interval(secs => v_delay)
  where id = v_job.id returning * into v_job;
  return jsonb_build_object('status', 'released', 'runAt', v_job.run_at);
end $$;

-- Cancels a queued or running job, by id or by (kind, idempotency key). A
-- running delivery loses its lease at once, so its next heartbeat or
-- complete is lease_lost. Results: canceled { jobId }, not_found,
-- already_finished { jobId, jobStatus }.
create function public.cancel_job(p_job_id uuid default null, p_kind text default null,
  p_idempotency_key text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  if p_job_id is not null then
    select * into v_job from public.jobs where id = p_job_id for update;
  elsif p_kind is not null and p_idempotency_key is not null then
    select * into v_job from public.jobs where kind = p_kind and idempotency_key = p_idempotency_key for update;
  end if;
  if v_job.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_job.status not in ('queued', 'running') then
    return jsonb_build_object('status', 'already_finished', 'jobId', v_job.id, 'jobStatus', v_job.status);
  end if;
  update public.jobs set status = 'canceled', leased_by = null, lease_token = null,
    lease_expires_at = null, finished_at = now(), updated_at = now()
  where id = v_job.id;
  return jsonb_build_object('status', 'canceled', 'jobId', v_job.id);
end $$;

-- Reaper: running jobs whose lease expired (process lost, or cut off by the
-- platform) go back to the queue after the backoff with last_error_code
-- 'lease_expired', or are dead when no attempts are left. Rows locked by a
-- concurrent writer are skipped and picked up next time. Returns
-- { requeued, dead } counts.
create function public.reap_jobs() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
  v_requeued integer := 0;
  v_dead integer := 0;
begin
  for v_job in
    select * from public.jobs
    where status = 'running' and lease_expires_at <= now()
    order by lease_expires_at
    limit 500
    for update skip locked
  loop
    if v_job.attempts < v_job.max_attempts then
      update public.jobs set status = 'queued', leased_by = null, lease_token = null,
        lease_expires_at = null, last_error_code = 'lease_expired', updated_at = now(),
        run_at = now() + make_interval(secs => public.job_backoff_seconds(v_job.attempts,
          v_job.backoff_base_seconds, v_job.backoff_max_seconds)::double precision)
      where id = v_job.id;
      v_requeued := v_requeued + 1;
    else
      update public.jobs set status = 'dead', leased_by = null, lease_token = null,
        lease_expires_at = null, last_error_code = 'lease_expired', finished_at = now(), updated_at = now()
      where id = v_job.id;
      v_dead := v_dead + 1;
    end if;
  end loop;
  return jsonb_build_object('requeued', v_requeued, 'dead', v_dead);
end $$;

-- Records a step of the leased job: 'started' (intent, before an external
-- effect) or 'succeeded' with an ids-only result (a flat object, as for
-- payloads). Results: saved, lease_lost, invalid_payload.
create function public.save_job_step(p_job_id uuid, p_lease_token uuid, p_name text, p_status text,
  p_result jsonb default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  if p_name is null or char_length(p_name) > 64 or p_name !~ '^[a-z][a-z0-9_.:-]*$'
     or p_status is null or p_status not in ('started', 'succeeded')
     or (p_result is not null and not public.job_payload_valid(p_result)) then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  v_job := public.job_lease(p_job_id, p_lease_token);
  if v_job.id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  insert into public.job_steps (job_id, name, status, result, attempt)
  values (v_job.id, p_name, p_status, p_result, v_job.attempts)
  on conflict (job_id, name) do update set status = excluded.status, result = excluded.result,
    attempt = excluded.attempt, updated_at = now();
  return jsonb_build_object('status', 'saved');
end $$;

-- Retention: completed and canceled jobs after 7 days, dead jobs after 30
-- (their steps cascade). Up to 1000 rows per call. Returns the count.
create function public.purge_jobs() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  with doomed as (
    select id from public.jobs
    where (status in ('completed', 'canceled') and finished_at < now() - interval '7 days')
       or (status = 'dead' and finished_at < now() - interval '30 days')
    limit 1000
    for update skip locked
  )
  delete from public.jobs j using doomed where j.id = doomed.id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Grants. -------------------------------------------------------------------------

revoke execute on function public.enqueue_job(text, text, jsonb, timestamptz, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.enqueue_job(text, text, jsonb, timestamptz, integer, integer, integer) to service_role;
revoke execute on function public.claim_jobs(text, integer, integer, text[], uuid) from public, anon, authenticated;
grant execute on function public.claim_jobs(text, integer, integer, text[], uuid) to service_role;
revoke execute on function public.heartbeat_job(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.heartbeat_job(uuid, uuid, integer) to service_role;
revoke execute on function public.complete_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_job(uuid, uuid) to service_role;
revoke execute on function public.fail_job(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.fail_job(uuid, uuid, text, boolean) to service_role;
revoke execute on function public.release_job(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.release_job(uuid, uuid, integer) to service_role;
revoke execute on function public.cancel_job(uuid, text, text) from public, anon, authenticated;
grant execute on function public.cancel_job(uuid, text, text) to service_role;
revoke execute on function public.reap_jobs() from public, anon, authenticated;
grant execute on function public.reap_jobs() to service_role;
revoke execute on function public.save_job_step(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_job_step(uuid, uuid, text, text, jsonb) to service_role;
revoke execute on function public.purge_jobs() from public, anon, authenticated;
grant execute on function public.purge_jobs() to service_role;
