-- A-05: external agent API keys, capability grants and the access audit trail
-- (ADR 004, ADR 007). Additive only: three new tables and their functions.
-- Nothing that exists changes, so this can be applied before the code that
-- uses it (proof: supabase/tests/agent-api-keys-compat.test.mjs).
--
-- Keys look like orbit_sk_<prefix>_<secret>. The database stores the 12-hex
-- prefix (safe to show and log) and an HMAC-SHA256 of the whole key, keyed
-- with a server-side pepper (ORBIT_API_KEY_PEPPER) that the database never
-- sees. The secret itself is never stored; the app shows it once.

-- External agents. ------------------------------------------------------------

create table public.agent_clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  key_prefix text not null unique check (key_prefix ~ '^[0-9a-f]{12}$'),
  -- HMAC-SHA256(pepper, full key), lowercase hex. Never the key.
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  unique (id, user_id)
);
create index agent_clients_user_idx on public.agent_clients (user_id, created_at desc);

-- Capability grants (ADR 004 §1–2), v1 subset: agent_client principals and the
-- three workspace-scoped capabilities. external.read / external.write and
-- builtin_agent rows arrive with I-01 and the built-in executor switch-over.
create table public.capability_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  principal_type text not null default 'agent_client' check (principal_type in ('agent_client')),
  principal_id uuid not null,
  capability text not null check (capability in ('workspace.read', 'item.write', 'assignment.execute')),
  -- item.write is create-only in v1 (ADR 007 proposes no update for now).
  constraints jsonb not null default '{}'::jsonb,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason in ('user', 'client_revoked')),
  constraint capability_grants_revoked_check check ((revoked_at is null) = (revoke_reason is null)),
  constraint capability_grants_v1_constraints_check check (case capability
    when 'item.write' then constraints = '{"operations": ["create"]}'::jsonb
    else constraints = '{}'::jsonb end),
  constraint capability_grants_workspace_fk foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id) on delete cascade,
  constraint capability_grants_client_fk foreign key (principal_id, user_id)
    references public.agent_clients (id, user_id) on delete cascade
);
create unique index capability_grants_active on public.capability_grants
  (principal_id, workspace_id, capability) where revoked_at is null;
create index capability_grants_user_idx on public.capability_grants (user_id);
create index capability_grants_workspace_idx on public.capability_grants (workspace_id);

-- Content-free access audit (ADR 004 §5): who, which operation, which
-- workspace, the outcome and when. Never titles, text, payloads or keys.
create table public.access_audit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  principal_type text not null check (principal_type in ('agent_client', 'user_token')),
  principal_id uuid references public.agent_clients (id) on delete set null,
  operation text not null check (operation in ('workspace.list', 'item.read', 'item.create')),
  -- No foreign keys: the record outlives a deleted workspace or note.
  workspace_id uuid,
  resource_id uuid,
  outcome text not null check (outcome in ('allowed', 'denied')),
  code text check (code in ('capability_denied', 'agent_disabled', 'client_revoked')),
  occurred_at timestamptz not null default now(),
  constraint access_audit_events_outcome_code_check check ((outcome = 'denied') = (code is not null)),
  constraint access_audit_events_principal_check check (principal_type = 'agent_client' or principal_id is null)
);
create index access_audit_events_user_idx on public.access_audit_events (user_id, occurred_at desc);
create index access_audit_events_occurred_idx on public.access_audit_events (occurred_at);

-- Access: owners read their own rows; every write goes through the functions
-- below. The key hash is not readable by anyone but the verifier.

alter table public.agent_clients enable row level security;
alter table public.capability_grants enable row level security;
alter table public.access_audit_events enable row level security;

create policy "Users read their own agent clients" on public.agent_clients
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own capability grants" on public.capability_grants
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own access audit events" on public.access_audit_events
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.agent_clients, public.capability_grants, public.access_audit_events
  from public, anon, authenticated, service_role;
grant select (id, user_id, name, key_prefix, created_at, last_used_at, revoked_at)
  on public.agent_clients to authenticated, service_role;
grant select on public.capability_grants, public.access_audit_events to authenticated, service_role;

-- Owner functions (Settings → Agents & API keys). ---------------------------

-- Grants arrive as [{"workspaceId": "<uuid>", "capability": "<name>"}, ...].
-- Returns the distinct valid pairs, or null when the payload is malformed.
create function public.agent_grant_pairs(p_grants jsonb)
returns table (workspace_id uuid, capability text)
language plpgsql immutable set search_path = '' as $$
begin
  if p_grants is null or jsonb_typeof(p_grants) <> 'array' or jsonb_array_length(p_grants) > 300
     or exists (
       select 1 from jsonb_array_elements(p_grants) e
       where jsonb_typeof(e) <> 'object'
         or (select count(*) from jsonb_object_keys(e)) <> 2
         or jsonb_typeof(e -> 'workspaceId') is distinct from 'string'
         or (e ->> 'workspaceId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or jsonb_typeof(e -> 'capability') is distinct from 'string'
         or (e ->> 'capability') not in ('workspace.read', 'item.write', 'assignment.execute')) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  return query select distinct (e ->> 'workspaceId')::uuid, e ->> 'capability'
    from jsonb_array_elements(p_grants) e;
end $$;

create function public.agent_client_json(p_client public.agent_clients)
returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_client.id, 'name', p_client.name, 'keyPrefix', p_client.key_prefix,
    'createdAt', p_client.created_at, 'lastUsedAt', p_client.last_used_at,
    'revokedAt', p_client.revoked_at,
    'grants', coalesce((select jsonb_agg(jsonb_build_object('workspaceId', g.workspace_id,
        'capability', g.capability, 'constraints', g.constraints, 'grantedAt', g.granted_at)
        order by g.workspace_id, g.capability)
      from public.capability_grants g
      where g.principal_id = p_client.id and g.revoked_at is null), '[]'::jsonb))
$$;

-- The app generates the key and its HMAC; only the prefix and hash arrive here.
create function public.create_agent_client(p_name text, p_key_prefix text, p_key_hash text, p_grants jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_client public.agent_clients;
  v_pairs integer;
  v_owned integer;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100
     or p_key_prefix is null or p_key_prefix !~ '^[0-9a-f]{12}$'
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  begin
    select count(*), count(w.id) into v_pairs, v_owned
      from public.agent_grant_pairs(p_grants) p
      left join public.workspaces w on w.id = p.workspace_id and w.user_id = v_uid;
  exception when sqlstate '22023' then
    return jsonb_build_object('status', 'invalid_payload');
  end;
  if v_owned <> v_pairs then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- Serialize per user so the limit holds under concurrent creates.
  perform pg_advisory_xact_lock(hashtextextended('agent_clients:' || v_uid::text, 0));
  if (select count(*) from public.agent_clients where user_id = v_uid and revoked_at is null) >= 25 then
    return jsonb_build_object('status', 'limit_reached');
  end if;
  begin
    insert into public.agent_clients (user_id, name, key_prefix, key_hash)
      values (v_uid, btrim(p_name), p_key_prefix, p_key_hash)
      returning * into v_client;
  exception when unique_violation then
    return jsonb_build_object('status', 'duplicate_prefix');
  end;
  insert into public.capability_grants (user_id, workspace_id, principal_id, capability, constraints)
    select v_uid, p.workspace_id, v_client.id, p.capability,
      case p.capability when 'item.write' then '{"operations": ["create"]}'::jsonb else '{}'::jsonb end
    from public.agent_grant_pairs(p_grants) p;
  return jsonb_build_object('status', 'created', 'client', public.agent_client_json(v_client));
end $$;

-- Replaces the client's active grants. Removed grants are kept as revoked
-- history; unchanged ones keep their granted_at.
create function public.set_agent_client_grants(p_id uuid, p_grants jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_client public.agent_clients;
  v_pairs integer;
  v_owned integer;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_client from public.agent_clients
    where id = p_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_client.revoked_at is not null then
    return jsonb_build_object('status', 'client_revoked');
  end if;
  begin
    select count(*), count(w.id) into v_pairs, v_owned
      from public.agent_grant_pairs(p_grants) p
      left join public.workspaces w on w.id = p.workspace_id and w.user_id = v_uid;
  exception when sqlstate '22023' then
    return jsonb_build_object('status', 'invalid_payload');
  end;
  if v_owned <> v_pairs then
    return jsonb_build_object('status', 'not_found');
  end if;
  update public.capability_grants g set revoked_at = now(), revoke_reason = 'user'
    where g.principal_id = v_client.id and g.revoked_at is null
      and not exists (select 1 from public.agent_grant_pairs(p_grants) p
        where p.workspace_id = g.workspace_id and p.capability = g.capability);
  insert into public.capability_grants (user_id, workspace_id, principal_id, capability, constraints)
    select v_uid, p.workspace_id, v_client.id, p.capability,
      case p.capability when 'item.write' then '{"operations": ["create"]}'::jsonb else '{}'::jsonb end
    from public.agent_grant_pairs(p_grants) p
    on conflict (principal_id, workspace_id, capability) where revoked_at is null do nothing;
  return jsonb_build_object('status', 'saved', 'client', public.agent_client_json(v_client));
end $$;

-- Revokes the key and every grant. Takes effect on the next request: the
-- verifier reads this row on every call. Repeating it is harmless.
create function public.revoke_agent_client(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_client public.agent_clients;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  update public.agent_clients set revoked_at = coalesce(revoked_at, now())
    where id = p_id and user_id = v_uid
    returning * into v_client;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  update public.capability_grants set revoked_at = now(), revoke_reason = 'client_revoked'
    where principal_id = v_client.id and revoked_at is null;
  return jsonb_build_object('status', 'revoked', 'client', public.agent_client_json(v_client));
end $$;

-- Server functions (service_role). --------------------------------------------

-- Looks up a key by prefix and compares the stored HMAC with the one the
-- server computed. Both sides are HMAC outputs under a pepper the caller can't
-- know, so the comparison leaks nothing about the secret. Returns null for an
-- unknown prefix or wrong secret, {status: revoked} for a revoked key, or the
-- user, client and active grants (with each workspace's kill switch) read now.
create function public.verify_agent_key(p_key_prefix text, p_key_hash text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_client public.agent_clients;
begin
  if p_key_prefix is null or p_key_hash is null then
    return null;
  end if;
  select * into v_client from public.agent_clients where key_prefix = p_key_prefix;
  if not found or v_client.key_hash <> p_key_hash then
    return null;
  end if;
  if v_client.revoked_at is not null then
    return jsonb_build_object('status', 'revoked', 'userId', v_client.user_id, 'clientId', v_client.id);
  end if;
  -- At most one write a minute per key.
  update public.agent_clients set last_used_at = now()
    where id = v_client.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return jsonb_build_object('status', 'ok', 'userId', v_client.user_id, 'clientId', v_client.id,
    'grants', coalesce((select jsonb_agg(jsonb_build_object('workspaceId', g.workspace_id,
        'capability', g.capability, 'constraints', g.constraints, 'agentEnabled', w.agent_enabled)
        order by w.position, w.created_at, g.capability)
      from public.capability_grants g
      join public.workspaces w on w.id = g.workspace_id and w.user_id = g.user_id
      where g.principal_id = v_client.id and g.revoked_at is null), '[]'::jsonb));
end $$;

create function public.record_access_event(p_user_id uuid, p_principal_type text, p_principal_id uuid,
  p_operation text, p_workspace_id uuid, p_resource_id uuid, p_outcome text, p_code text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_principal_type = 'agent_client' and not exists (
    select 1 from public.agent_clients where id = p_principal_id and user_id = p_user_id) then
    raise exception 'unknown principal' using errcode = '23503';
  end if;
  insert into public.access_audit_events (user_id, principal_type, principal_id, operation,
    workspace_id, resource_id, outcome, code)
  values (p_user_id, p_principal_type, p_principal_id, p_operation, p_workspace_id,
    p_resource_id, p_outcome, p_code);
end $$;

-- 90-day retention (ADR 007, proposed). Run daily from one scheduler slot;
-- repeating it is harmless.
create function public.purge_access_audit_events()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  delete from public.access_audit_events where occurred_at < now() - interval '90 days';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Grants. -------------------------------------------------------------------------

revoke execute on function public.agent_grant_pairs(jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.agent_client_json(public.agent_clients) from public, anon, authenticated, service_role;

revoke execute on function public.create_agent_client(text, text, text, jsonb) from public, anon, service_role;
grant execute on function public.create_agent_client(text, text, text, jsonb) to authenticated;
revoke execute on function public.set_agent_client_grants(uuid, jsonb) from public, anon, service_role;
grant execute on function public.set_agent_client_grants(uuid, jsonb) to authenticated;
revoke execute on function public.revoke_agent_client(uuid) from public, anon, service_role;
grant execute on function public.revoke_agent_client(uuid) to authenticated;

revoke execute on function public.verify_agent_key(text, text) from public, anon, authenticated;
grant execute on function public.verify_agent_key(text, text) to service_role;
revoke execute on function public.record_access_event(uuid, text, uuid, text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_access_event(uuid, text, uuid, text, uuid, uuid, text, text) to service_role;
revoke execute on function public.purge_access_audit_events() from public, anon, authenticated;
grant execute on function public.purge_access_audit_events() to service_role;
