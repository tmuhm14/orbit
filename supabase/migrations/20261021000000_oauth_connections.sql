-- Hosted MCP and OAuth 2.1 connections (ADR 008). Additive only: one new
-- column and two new checks on agent_clients, five new tables and their
-- functions. Nothing that exists changes behavior, so this can be applied
-- before the code that uses it (proof:
-- supabase/tests/oauth-connections-compat.test.mjs).
--
-- Orbit is its own OAuth authorization server for /api/mcp. A cloud app (Grok,
-- Claude) registers itself (RFC 7591), the user consents in Orbit, and the
-- app gets short-lived access tokens and rotating refresh tokens. Each
-- consented (app, user) pair is an agent_clients row with auth_kind 'oauth',
-- so it reuses A-05's capability grants, kill switch and access audit.
--
-- Codes and tokens are 256-bit random strings. The database stores only
-- HMAC-SHA256(ORBIT_API_KEY_PEPPER, value) as hex, computed by the app; it
-- never sees a code, token or the pepper.

-- agent_clients: tell OAuth connections from API keys. ---------------------

-- Existing rows (and every row the deployed code creates) are API keys.
alter table public.agent_clients add column auth_kind text not null default 'api_key';
alter table public.agent_clients add constraint agent_clients_auth_kind_check
  check (auth_kind in ('api_key', 'oauth'));
-- An OAuth connection has no API key. key_prefix and key_hash stay not null
-- (additive only), so a connection gets a random unused prefix and an
-- all-zero hash. No key can match it: that would need an HMAC output of zero.
alter table public.agent_clients add constraint agent_clients_oauth_no_key_check
  check (auth_kind = 'api_key' or key_hash = repeat('0', 64));
grant select (auth_kind) on public.agent_clients to authenticated, service_role;

-- Registered apps (RFC 7591 dynamic client registration). -------------------

-- Public clients only (token_endpoint_auth_method "none"); PKCE protects the
-- code. Registration grants nothing: an app is trusted by a user only once
-- that user consents. Apps nobody consented to are purged after 7 days.
create table public.oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique default ('orbit_ci_' || replace(gen_random_uuid()::text, '-', ''))
    check (client_id ~ '^orbit_ci_[0-9a-f]{32}$'),
  -- Chosen by the app, never verified: the consent page says so.
  client_name text check (client_name is null or char_length(btrim(client_name)) between 1 and 100),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 5),
  client_uri text check (client_uri is null or (char_length(client_uri) <= 2000 and client_uri ~ '^https://')),
  logo_uri text check (logo_uri is null or (char_length(logo_uri) <= 2000 and logo_uri ~ '^https://')),
  -- HMAC of the registering IP address, for the per-IP rate limit. Never the address.
  registration_ip_hash text not null check (registration_ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index oauth_clients_created_idx on public.oauth_clients (created_at);
create index oauth_clients_ip_idx on public.oauth_clients (registration_ip_hash, created_at);

-- One row per consented (app, user): the agent_clients row that holds the grants.
create table public.oauth_connections (
  agent_client_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  oauth_client_id uuid not null references public.oauth_clients (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint oauth_connections_agent_client_fk foreign key (agent_client_id, user_id)
    references public.agent_clients (id, user_id) on delete cascade
);
create index oauth_connections_client_idx on public.oauth_connections (oauth_client_id, user_id);
create index oauth_connections_user_idx on public.oauth_connections (user_id);

-- Authorization codes: single use, 5 minutes, bound to the app, the exact
-- redirect URI, the PKCE S256 challenge, the user, the resource and scopes.
create table public.oauth_authorization_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  oauth_client_id uuid not null references public.oauth_clients (id) on delete cascade,
  agent_client_id uuid not null,
  user_id uuid not null,
  redirect_uri text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource text not null,
  scope text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  -- The token family issued from this code, so a replayed code revokes it.
  family_id uuid,
  created_at timestamptz not null default now(),
  constraint oauth_codes_agent_client_fk foreign key (agent_client_id, user_id)
    references public.agent_clients (id, user_id) on delete cascade
);
create index oauth_codes_expires_idx on public.oauth_authorization_codes (expires_at);

-- Access tokens (1 hour) and refresh tokens (30 days, rotated on every use).
-- A family is everything issued from one code; reusing a rotated refresh
-- token revokes the whole family.
create table public.oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('access', 'refresh')),
  family_id uuid not null,
  oauth_client_id uuid not null references public.oauth_clients (id) on delete cascade,
  agent_client_id uuid not null,
  user_id uuid not null,
  -- The audience (RFC 8707): the MCP endpoint's URL.
  resource text not null,
  scope text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- A refresh token is used once; its replacement carries on the family.
  used_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason in ('reuse_detected', 'revoked', 'disconnected')),
  constraint oauth_tokens_revoked_check check ((revoked_at is null) = (revoke_reason is null)),
  constraint oauth_tokens_agent_client_fk foreign key (agent_client_id, user_id)
    references public.agent_clients (id, user_id) on delete cascade
);
create index oauth_tokens_family_idx on public.oauth_tokens (family_id);
create index oauth_tokens_agent_client_idx on public.oauth_tokens (agent_client_id);
create index oauth_tokens_expires_idx on public.oauth_tokens (expires_at);

-- Access: owners read metadata of their own connections; nobody reads a code
-- or token hash or the registration IP hash. Every write goes through the
-- functions below.

alter table public.oauth_clients enable row level security;
alter table public.oauth_connections enable row level security;
alter table public.oauth_authorization_codes enable row level security;
alter table public.oauth_tokens enable row level security;

create policy "Users read apps they connected" on public.oauth_clients
  for select to authenticated using (exists (
    select 1 from public.oauth_connections c
    where c.oauth_client_id = oauth_clients.id and c.user_id = (select auth.uid())));
create policy "Users read their own OAuth connections" on public.oauth_connections
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their own OAuth token metadata" on public.oauth_tokens
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.oauth_clients, public.oauth_connections, public.oauth_authorization_codes, public.oauth_tokens
  from public, anon, authenticated, service_role;
grant select (id, client_id, client_name, redirect_uris, client_uri, logo_uri, created_at)
  on public.oauth_clients to authenticated;
grant select on public.oauth_connections to authenticated;
grant select (id, kind, family_id, oauth_client_id, agent_client_id, user_id, resource, scope,
  created_at, expires_at, used_at, revoked_at, revoke_reason)
  on public.oauth_tokens to authenticated;

-- Helpers (not callable by any API role). ---------------------------------------

create function public.oauth_client_json(p_client public.oauth_clients)
returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p_client.id, 'clientId', p_client.client_id,
    'clientName', p_client.client_name, 'redirectUris', to_jsonb(p_client.redirect_uris),
    'clientUri', p_client.client_uri, 'logoUri', p_client.logo_uri, 'createdAt', p_client.created_at)
$$;

-- The same shape verify_agent_key returns: active grants with each
-- workspace's kill switch, read now.
create function public.oauth_agent_grants(p_agent_client_id uuid)
returns jsonb
language sql stable set search_path = '' as $$
  select coalesce((select jsonb_agg(jsonb_build_object('workspaceId', g.workspace_id,
      'capability', g.capability, 'constraints', g.constraints, 'agentEnabled', w.agent_enabled)
      order by w.position, w.created_at, g.capability)
    from public.capability_grants g
    join public.workspaces w on w.id = g.workspace_id and w.user_id = g.user_id
    where g.principal_id = p_agent_client_id and g.revoked_at is null), '[]'::jsonb)
$$;

-- Issues an access and a refresh token in a family. Lifetimes live here only.
create function public.oauth_issue_tokens(p_family uuid, p_oauth_client_id uuid, p_agent_client_id uuid,
  p_user_id uuid, p_resource text, p_scope text, p_access_hash text, p_refresh_hash text)
returns jsonb
language plpgsql set search_path = '' as $$
begin
  insert into public.oauth_tokens (token_hash, kind, family_id, oauth_client_id, agent_client_id, user_id,
    resource, scope, expires_at)
  values
    (p_access_hash, 'access', p_family, p_oauth_client_id, p_agent_client_id, p_user_id, p_resource, p_scope,
      now() + interval '1 hour'),
    (p_refresh_hash, 'refresh', p_family, p_oauth_client_id, p_agent_client_id, p_user_id, p_resource, p_scope,
      now() + interval '30 days');
  return jsonb_build_object('status', 'issued', 'expiresIn', 3600, 'refreshExpiresIn', 2592000,
    'scope', p_scope, 'resource', p_resource);
end $$;

create function public.oauth_revoke_family(p_family uuid, p_reason text)
returns void
language sql set search_path = '' as $$
  update public.oauth_tokens set revoked_at = now(), revoke_reason = p_reason
    where family_id = p_family and revoked_at is null
$$;

-- Server functions (service_role). --------------------------------------------

-- Registers a public client. The app has already validated the metadata;
-- this checks it again and applies the rate limits: 10 registrations an hour
-- per IP, 500 an hour overall.
create function public.register_oauth_client(p_client_name text, p_redirect_uris text[],
  p_client_uri text, p_logo_uri text, p_ip_hash text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_client public.oauth_clients;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_redirect_uris is null or cardinality(p_redirect_uris) not between 1 and 5
     or exists (select 1 from unnest(p_redirect_uris) u where u is null or char_length(u) > 2000
       or u !~ '^(https://[^/?#@[:space:]]+|http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?)([/?][^#[:space:]]*)?$')
     or (p_client_name is not null and char_length(btrim(p_client_name)) not between 1 and 100)
     or (p_client_uri is not null and (char_length(p_client_uri) > 2000 or p_client_uri !~ '^https://'))
     or (p_logo_uri is not null and (char_length(p_logo_uri) > 2000 or p_logo_uri !~ '^https://')) then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('oauth_register', 0));
  if (select count(*) from public.oauth_clients
      where registration_ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 10
     or (select count(*) from public.oauth_clients where created_at > now() - interval '1 hour') >= 500 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  insert into public.oauth_clients (client_name, redirect_uris, client_uri, logo_uri, registration_ip_hash)
    values (nullif(btrim(p_client_name), ''), p_redirect_uris, p_client_uri, p_logo_uri, p_ip_hash)
    returning * into v_client;
  return jsonb_build_object('status', 'registered', 'client', public.oauth_client_json(v_client));
end $$;

-- A registered app's public metadata, for the consent page; null if unknown.
create function public.get_oauth_client(p_client_id text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.oauth_client_json(c) from public.oauth_clients c where c.client_id = p_client_id
$$;

-- Exchanges a code for tokens. Any presentation burns the code; presenting a
-- used code again revokes everything issued from it (OAuth 2.1 §4.1.3). The
-- app passes BASE64URL(SHA256(code_verifier)) for the PKCE comparison.
create function public.exchange_oauth_code(p_code_hash text, p_client_id text, p_redirect_uri text,
  p_verifier_challenge text, p_resource text, p_access_hash text, p_refresh_hash text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_code public.oauth_authorization_codes;
  v_client public.oauth_clients;
  v_family uuid := gen_random_uuid();
begin
  if p_code_hash is null or coalesce(p_access_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_refresh_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  select * into v_code from public.oauth_authorization_codes where code_hash = p_code_hash for update;
  if not found then
    return jsonb_build_object('status', 'invalid_grant');
  end if;
  if v_code.used_at is not null then
    if v_code.family_id is not null then
      perform public.oauth_revoke_family(v_code.family_id, 'reuse_detected');
    end if;
    return jsonb_build_object('status', 'invalid_grant', 'reason', 'code_reused');
  end if;
  update public.oauth_authorization_codes set used_at = now() where code_hash = p_code_hash;
  select * into v_client from public.oauth_clients where id = v_code.oauth_client_id;
  if v_code.expires_at <= now() or v_client.client_id is distinct from p_client_id
     or v_code.redirect_uri is distinct from p_redirect_uri
     or v_code.code_challenge is distinct from p_verifier_challenge then
    return jsonb_build_object('status', 'invalid_grant');
  end if;
  if p_resource is not null and p_resource <> v_code.resource then
    return jsonb_build_object('status', 'invalid_target');
  end if;
  if exists (select 1 from public.agent_clients where id = v_code.agent_client_id and revoked_at is not null) then
    return jsonb_build_object('status', 'invalid_grant');
  end if;
  update public.oauth_authorization_codes set family_id = v_family where code_hash = p_code_hash;
  return public.oauth_issue_tokens(v_family, v_code.oauth_client_id, v_code.agent_client_id, v_code.user_id,
    v_code.resource, v_code.scope, p_access_hash, p_refresh_hash);
end $$;

-- Rotates a refresh token: the presented one is used up and a new pair is
-- issued in the same family. Presenting a used or another app's refresh
-- token revokes the family.
create function public.refresh_oauth_token(p_refresh_hash text, p_client_id text, p_resource text,
  p_access_hash text, p_new_refresh_hash text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token public.oauth_tokens;
  v_client public.oauth_clients;
begin
  if p_refresh_hash is null or coalesce(p_access_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_new_refresh_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  select * into v_token from public.oauth_tokens
    where token_hash = p_refresh_hash and kind = 'refresh' for update;
  if not found or v_token.revoked_at is not null then
    return jsonb_build_object('status', 'invalid_grant');
  end if;
  select * into v_client from public.oauth_clients where id = v_token.oauth_client_id;
  if v_token.used_at is not null or v_client.client_id is distinct from p_client_id then
    perform public.oauth_revoke_family(v_token.family_id, 'reuse_detected');
    return jsonb_build_object('status', 'invalid_grant', 'reason', 'reuse_detected');
  end if;
  if v_token.expires_at <= now()
     or exists (select 1 from public.agent_clients where id = v_token.agent_client_id and revoked_at is not null) then
    return jsonb_build_object('status', 'invalid_grant');
  end if;
  if p_resource is not null and p_resource <> v_token.resource then
    return jsonb_build_object('status', 'invalid_target');
  end if;
  update public.oauth_tokens set used_at = now() where id = v_token.id;
  return public.oauth_issue_tokens(v_token.family_id, v_token.oauth_client_id, v_token.agent_client_id,
    v_token.user_id, v_token.resource, v_token.scope, p_access_hash, p_new_refresh_hash);
end $$;

-- Verifies an access token for one resource. Null for an unknown, expired,
-- revoked or other-audience token; {status: revoked} when the connection was
-- disconnected; otherwise the user, connection, scope and grants, read now
-- (never cached), so Settings changes apply to the next request.
create function public.verify_oauth_token(p_token_hash text, p_resource text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token public.oauth_tokens;
  v_agent public.agent_clients;
begin
  if p_token_hash is null or p_resource is null then
    return null;
  end if;
  select * into v_token from public.oauth_tokens where token_hash = p_token_hash and kind = 'access';
  if not found or v_token.revoked_at is not null or v_token.expires_at <= now()
     or v_token.resource <> p_resource then
    return null;
  end if;
  select * into v_agent from public.agent_clients where id = v_token.agent_client_id;
  if v_agent.revoked_at is not null then
    return jsonb_build_object('status', 'revoked', 'userId', v_agent.user_id, 'clientId', v_agent.id);
  end if;
  update public.agent_clients set last_used_at = now()
    where id = v_agent.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return jsonb_build_object('status', 'ok', 'userId', v_agent.user_id, 'clientId', v_agent.id,
    'scope', v_token.scope, 'grants', public.oauth_agent_grants(v_agent.id));
end $$;

-- RFC 7009. A refresh token revokes its family; an access token only itself.
-- Unknown tokens and other apps' tokens change nothing (the route answers 200).
create function public.revoke_oauth_token(p_token_hash text, p_client_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token public.oauth_tokens;
begin
  select t.* into v_token from public.oauth_tokens t
    join public.oauth_clients c on c.id = t.oauth_client_id
    where t.token_hash = p_token_hash and c.client_id = p_client_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_token.kind = 'refresh' then
    perform public.oauth_revoke_family(v_token.family_id, 'revoked');
  else
    update public.oauth_tokens set revoked_at = now(), revoke_reason = 'revoked'
      where id = v_token.id and revoked_at is null;
  end if;
  return jsonb_build_object('status', 'revoked');
end $$;

-- Daily from scheduler slot 06: expired codes and tokens (a day after expiry)
-- and apps nobody consented to within 7 days. Repeating it is harmless.
create function public.purge_oauth_records()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_codes integer;
  v_tokens integer;
  v_clients integer;
begin
  delete from public.oauth_authorization_codes where expires_at < now() - interval '1 day';
  get diagnostics v_codes = row_count;
  delete from public.oauth_tokens where expires_at < now() - interval '1 day';
  get diagnostics v_tokens = row_count;
  delete from public.oauth_clients c where c.created_at < now() - interval '7 days'
    and not exists (select 1 from public.oauth_connections x where x.oauth_client_id = c.id);
  get diagnostics v_clients = row_count;
  return v_codes + v_tokens + v_clients;
end $$;

-- Owner functions (the consent page and Settings). -------------------------------

-- Allow on the consent page, from the user's own session. Validates the app
-- and the exact redirect URI again, creates the connection (or reuses the
-- active one for this app and user), replaces its grants with what the user
-- ticked, and stores the code's HMAC with everything it is bound to.
create function public.create_oauth_authorization(p_client_id text, p_redirect_uri text, p_code_hash text,
  p_code_challenge text, p_resource text, p_scope text, p_grants jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_client public.oauth_clients;
  v_agent public.agent_clients;
  v_pairs integer;
  v_owned integer;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$'
     or p_code_challenge is null or p_code_challenge !~ '^[A-Za-z0-9_-]{43}$'
     or p_resource is null or p_resource !~ '^https?://' or char_length(p_resource) > 2000
     or p_scope is null or p_scope !~ '^orbit:(read|capture)( orbit:(read|capture))?$' then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  select * into v_client from public.oauth_clients where client_id = p_client_id;
  if not found or p_redirect_uri is null or not (p_redirect_uri = any (v_client.redirect_uris)) then
    return jsonb_build_object('status', 'not_found');
  end if;
  begin
    select count(*), count(w.id) into v_pairs, v_owned
      from public.agent_grant_pairs(p_grants) p
      left join public.workspaces w on w.id = p.workspace_id and w.user_id = v_uid;
  exception when sqlstate '22023' then
    return jsonb_build_object('status', 'invalid_payload');
  end;
  if v_pairs = 0 then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  if v_owned <> v_pairs then
    return jsonb_build_object('status', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('agent_clients:' || v_uid::text, 0));
  select a.* into v_agent from public.oauth_connections c
    join public.agent_clients a on a.id = c.agent_client_id
    where c.oauth_client_id = v_client.id and c.user_id = v_uid and a.revoked_at is null
    order by c.created_at desc limit 1;
  if not found then
    if (select count(*) from public.agent_clients
        where user_id = v_uid and auth_kind = 'oauth' and revoked_at is null) >= 25 then
      return jsonb_build_object('status', 'limit_reached');
    end if;
    -- A random prefix nobody holds a key for; retried on the rare collision.
    for i in 1..3 loop
      begin
        insert into public.agent_clients (user_id, name, key_prefix, key_hash, auth_kind)
          values (v_uid, coalesce(v_client.client_name, 'Connected app'),
            substr(md5(gen_random_uuid()::text), 1, 12), repeat('0', 64), 'oauth')
          returning * into v_agent;
        exit;
      exception when unique_violation then
        if i = 3 then raise; end if;
      end;
    end loop;
    insert into public.oauth_connections (agent_client_id, user_id, oauth_client_id)
      values (v_agent.id, v_uid, v_client.id);
  end if;
  update public.capability_grants g set revoked_at = now(), revoke_reason = 'user'
    where g.principal_id = v_agent.id and g.revoked_at is null
      and not exists (select 1 from public.agent_grant_pairs(p_grants) p
        where p.workspace_id = g.workspace_id and p.capability = g.capability);
  insert into public.capability_grants (user_id, workspace_id, principal_id, capability, constraints)
    select v_uid, p.workspace_id, v_agent.id, p.capability,
      case p.capability when 'item.write' then '{"operations": ["create"]}'::jsonb else '{}'::jsonb end
    from public.agent_grant_pairs(p_grants) p
    on conflict (principal_id, workspace_id, capability) where revoked_at is null do nothing;
  insert into public.oauth_authorization_codes (code_hash, oauth_client_id, agent_client_id, user_id,
    redirect_uri, code_challenge, resource, scope, expires_at)
  values (p_code_hash, v_client.id, v_agent.id, v_uid, p_redirect_uri, p_code_challenge, p_resource, p_scope,
    now() + interval '5 minutes');
  return jsonb_build_object('status', 'created', 'connectionId', v_agent.id);
end $$;

-- The user's connected apps for Settings: metadata and active grants only.
create function public.list_oauth_connections()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', a.name, 'clientId', o.client_id, 'clientName', o.client_name,
      'redirectUris', to_jsonb(o.redirect_uris), 'clientUri', o.client_uri,
      'connectedAt', c.created_at, 'lastUsedAt', a.last_used_at, 'revokedAt', a.revoked_at,
      'grants', coalesce((select jsonb_agg(jsonb_build_object('workspaceId', g.workspace_id,
          'capability', g.capability) order by g.workspace_id, g.capability)
        from public.capability_grants g where g.principal_id = a.id and g.revoked_at is null), '[]'::jsonb))
      order by c.created_at desc)
    from public.oauth_connections c
    join public.agent_clients a on a.id = c.agent_client_id
    join public.oauth_clients o on o.id = c.oauth_client_id
    where c.user_id = v_uid), '[]'::jsonb);
end $$;

-- Disconnect in Settings: the connection, its grants and every token it holds
-- stop working on the next request. Repeating it is harmless.
create function public.disconnect_oauth_connection(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_agent public.agent_clients;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  update public.agent_clients a set revoked_at = coalesce(a.revoked_at, now())
    where a.id = p_id and a.user_id = v_uid and a.auth_kind = 'oauth'
      and exists (select 1 from public.oauth_connections c where c.agent_client_id = a.id)
    returning a.* into v_agent;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  update public.capability_grants set revoked_at = now(), revoke_reason = 'client_revoked'
    where principal_id = v_agent.id and revoked_at is null;
  update public.oauth_tokens set revoked_at = now(), revoke_reason = 'disconnected'
    where agent_client_id = v_agent.id and revoked_at is null;
  return jsonb_build_object('status', 'revoked', 'id', v_agent.id, 'revokedAt', v_agent.revoked_at);
end $$;

-- Grants. -------------------------------------------------------------------------

revoke execute on function public.oauth_client_json(public.oauth_clients) from public, anon, authenticated, service_role;
revoke execute on function public.oauth_agent_grants(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.oauth_issue_tokens(uuid, uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.oauth_revoke_family(uuid, text) from public, anon, authenticated, service_role;

revoke execute on function public.register_oauth_client(text, text[], text, text, text) from public, anon, authenticated;
grant execute on function public.register_oauth_client(text, text[], text, text, text) to service_role;
revoke execute on function public.get_oauth_client(text) from public, anon, authenticated;
grant execute on function public.get_oauth_client(text) to service_role;
revoke execute on function public.exchange_oauth_code(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.exchange_oauth_code(text, text, text, text, text, text, text) to service_role;
revoke execute on function public.refresh_oauth_token(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.refresh_oauth_token(text, text, text, text, text) to service_role;
revoke execute on function public.verify_oauth_token(text, text) from public, anon, authenticated;
grant execute on function public.verify_oauth_token(text, text) to service_role;
revoke execute on function public.revoke_oauth_token(text, text) from public, anon, authenticated;
grant execute on function public.revoke_oauth_token(text, text) to service_role;
revoke execute on function public.purge_oauth_records() from public, anon, authenticated;
grant execute on function public.purge_oauth_records() to service_role;

revoke execute on function public.create_oauth_authorization(text, text, text, text, text, text, jsonb) from public, anon, service_role;
grant execute on function public.create_oauth_authorization(text, text, text, text, text, text, jsonb) to authenticated;
revoke execute on function public.list_oauth_connections() from public, anon, service_role;
grant execute on function public.list_oauth_connections() to authenticated;
revoke execute on function public.disconnect_oauth_connection(uuid) from public, anon, service_role;
grant execute on function public.disconnect_oauth_connection(uuid) to authenticated;
