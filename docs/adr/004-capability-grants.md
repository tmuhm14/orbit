# 004 — Capability grants with server-enforced revocation

- **Status:** Proposed — awaiting Tony's approval
- **Date:** 2026-10-13
- **Ticket:** O-01 (contract for A-01's capability check; implemented in A-05; used by A-06, I-01–I-05, K-02)
- **Deciders:** Tony (Solutions Architect)
- **Related:** ADR 003 (assignment capabilities), ADR 005 (runtime); plan "Connections and external agents"

## Context

Access today rests on one switch per workspace and on who holds the user's session:

| Principal | Authentication | What it can do | Gate |
| --- | --- | --- | --- |
| Owner in the browser | Supabase cookie session (`routeUser()` in `lib/supabase/route-auth.ts`, same-origin check on mutations) | Everything in own workspaces via RLS | — |
| Built-in organizing agent | Server, admin client (`lib/supabase/admin.ts`), scoped by `supabaseAgentStore()` filters | Read and change every note in the workspace | `workspaces.agent_enabled` (`20261010000000_agent.sql`, default off; on for "Personal") plus a saved key in `agent_settings` |
| External agent (HTTP / MCP) | **The user's own Supabase JWT** as a bearer token (`integrationUser()` in `lib/integrations/auth.ts`; `scripts/orbit-mcp.mjs` reads `ORBIT_ACCESS_TOKEN`) | List enabled workspaces, page through notes, create Inbox notes (`app/api/v1/*`) | Same `agent_enabled` switch (`allowed()` in `app/api/v1/notes/route.ts`) |
| Slack capture | Signed Slack request + `slack_links` row (server-created after a signed link token) | Insert notes into the linked workspace | Link exists |
| Email capture | Secret `workspaces.inbox_token` in the address | Insert notes | Token |
| Scheduled reports | Server; Jira/GitHub tokens encrypted in `scheduled_integrations` | Read Jira/GitHub metadata (external read) | Task `enabled` |

Gaps:

1. One boolean means "the agent may read **and** change notes" (`docs/api/agents.md`); read-only or capture-only access is impossible.
2. An external agent is indistinguishable from the user. It holds a full user JWT, so outside Orbit's `/api/v1` routes it could call PostgREST directly with owner RLS rights. Turning off `agent_enabled` stops `/api/v1`, but not that token.
3. A Supabase access token can't be revoked before it expires (about 1 hour by default); refresh tokens live in the bot's store.
4. No notion of external write; outbound actions (I-05) need per-action authority plus payload approval.
5. No access audit. The repository HIPAA rules require auditing PHI access; this repo has no `auditPhiAccess()` helper (the `src/lib/audit.ts` the global rules reference does not exist here).

## Decision

### 1. Capability vocabulary

| Capability | Scope | Allows | Never allows |
| --- | --- | --- | --- |
| `workspace.read` | workspace (optionally narrowed to an assignment's selected items) | List/read items and their metadata | Writes, other workspaces, secrets (`inbox_token`, keys) |
| `item.write` | workspace; `constraints.operations ⊆ {create, update}` | Create items (capture) and/or revisioned updates (ADR 002) | Delete (owner only in v1), changing `source`/`origin`, cross-workspace moves |
| `assignment.execute` | assignments where the principal is the executor | Claim, heartbeat, progress, ask, submit, fail (ADR 003 executor functions) | Creating or reviewing assignments; transitions reserved for `user` |
| `external.read` | one connection (e.g. a Slack team, a mailbox, the Jira site) | Fetch context from that connection | Any write to it |
| `external.write` | one connection **and** one named action (e.g. `slack.chat.postMessage`, `email.send`) with optional destination allowlist | Executing a stored, user-approved outbound action | Executing without a matching approval of the exact payload (I-05) |

The owner's browser session is not a grantee; it keeps full owner rights through RLS. Delete stays owner-only.

### 2. Principals and storage (migration in A-05, proposed `20261024000000_capability_grants.sql`)

```sql
create table public.agent_clients (           -- external agents (A-05)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  credential_hash text,                        -- if Orbit-issued keys are chosen (open question 1); never the secret
  credential_hint text check (char_length(credential_hint) <= 4),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  unique (id, user_id)
);

create table public.capability_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid,                           -- null only for account-level external connections
  principal_type text not null check (principal_type in ('builtin_agent', 'agent_client')),
  principal_id uuid,                           -- agent_clients.id; null for builtin_agent
  capability text not null check (capability in
    ('workspace.read', 'item.write', 'assignment.execute', 'external.read', 'external.write')),
  connection_id uuid,                          -- required for external.* (connections table arrives in I-01)
  action text,                                 -- required for external.write
  constraints jsonb not null default '{}',
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason in ('user', 'client_revoked', 'connection_revoked', 'expired', 'admin')),
  check ((principal_type = 'builtin_agent') = (principal_id is null)),
  check (capability not like 'external.%' or connection_id is not null),
  check ((capability = 'external.write') = (action is not null)),
  constraint capability_grants_workspace_fk foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id) on delete cascade,
  constraint capability_grants_client_fk foreign key (principal_id, user_id)
    references public.agent_clients (id, user_id) on delete cascade
);
create unique index capability_grants_active on public.capability_grants
  (user_id, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), principal_type,
   coalesce(principal_id, '00000000-0000-0000-0000-000000000000'::uuid), capability,
   coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(action, ''))
  where revoked_at is null;
```

RLS: owner `select`; owner may set `revoked_at` through a `revoke_capability_grant(p_id)` function (`authenticated`). Grants are created only through server routes after explicit user action in Settings. Revoked rows are kept as history.

**Assignments narrow, never widen.** `assignments.capabilities` (ADR 003) must be a subset of the executor's active grants at creation, and is re-checked on every executor call.

### 3. Enforcement

One server-only module, `lib/grants/server.ts`:

```ts
authorize(admin, {
  userId, principal: { type: "builtin_agent" } | { type: "agent_client"; id },
  capability, workspaceId?, connectionId?, action?, operation?,
}): Promise<{ ok: true } | { ok: false; code: "capability_denied" | "agent_disabled" | "client_revoked" }>
```

- **Checked on every operation**, from the database, with no cross-request cache. Revocation takes effect on the next call. This is what makes revocation server-enforced, regardless of how long a bearer token stays valid.
- `workspaces.agent_enabled` remains the **kill switch**: when false, every non-owner principal is denied in that workspace, whatever the grants say. The existing Settings toggle keeps its meaning.
- **Long-running work re-checks at step boundaries:** each built-in executor tool call, each external `heartbeat`/`submit`. On denial the attempt stops; the assignment goes to `failed` with `capability_revoked` (ADR 003 T15/T16). A revoked `external.write` invalidates pending approvals that depend on it.
- Model output never grants or widens anything. Capabilities come from grant rows and the user-authored assignment row only.
- Every check that reads PHI-capable data for a non-owner principal writes an access-audit row (§5).

### 4. Compatibility with today's switch

Until A-05 ships, A-01 uses a static policy instead of the grants table: the built-in executor has `workspace.read` (selected context only) and `assignment.execute` when `agent_enabled` is true and a key exists (the `createRun()` checks in `lib/agent/server.ts`).

A-05 migration seeds grants so behavior is unchanged on day one:

| Existing state | Seeded grants |
| --- | --- |
| `agent_enabled = true` | `builtin_agent`: `workspace.read`, `item.write {operations: [create, update]}`, `assignment.execute` |
| v1 API callers (user JWT) | No row. They remain a transitional `user_token` principal limited to today's `/api/v1` operations (`workspace.read` + `item.write {create}`), gated by `agent_enabled`. |

**Deprecation of user-JWT integrations:** once `agent_clients` credentials exist, `/api/v1` accepts both for one announced window, then user JWTs are refused on `/api/v1` with `401 credential_type_unsupported`. `docs/api/agents.md` and `openapi.json` get a new `securityScheme`. The token-held-by-bot issue (gap 2) is closed only when bots stop holding user JWTs; ADR 002 phase C′ (revoking direct DML for `authenticated`) narrows what a leaked JWT can do in the meantime.

### 5. Audit and PHI

- `capability_grants` rows (granted/revoked/expired) are the grant history. No secrets are stored; `credential_hash` uses a slow hash and the plaintext is shown once.
- New table `access_audit_events` (A-05, same migration): `user_id`, `principal_type`, `principal_id`, `action` (e.g. `item.read`, `item.write`, `assignment.artifact.read`), `resource_type`, `resource_id`, `workspace_id`, `occurred_at`. **No content, titles or payloads.** Written by `lib/audit.ts` (`auditPhiAccess()`, matching the repository standard's helper name and required fields `userId`, `action`, `resourceType`, `resourceId`, `timestamp`). The audit table is insert-only (`service_role`); owners may read their own rows.
- Denials return generic messages and log principal id, capability and code only. Credentials and bearer tokens are never logged (A-05 done criterion).

### 6. Error contract

| HTTP | `code` | When |
| --- | --- | --- |
| 401 | `invalid_credentials` | Missing, malformed, expired or unknown credential |
| 401 | `client_revoked` | `agent_clients.revoked_at` set |
| 401 | `credential_type_unsupported` | User JWT after the deprecation window |
| 403 | `agent_disabled` | Kill switch off for the workspace |
| 403 | `capability_denied` | No active grant; body `{ capability }` (no other detail) |
| 404 | `not_found` | Resource outside the grant's scope (no existence leak) |
| 409 | `approval_required` / `approval_stale` | `external.write` without an approval of the current payload hash (I-05) |

## Consequences

- Read-only, capture-only and execute-only agents become possible, and revoking any of them works on the next request.
- Every operation for a non-owner principal costs one indexed lookup (plus an audit insert where PHI is read). Acceptable at current scale; revisit if hot.
- External integrations must migrate credentials once; docs and MCP adapter (`scripts/orbit-mcp.mjs`) change in A-05/A-06.
- Tests (A-05): grant/deny per capability and scope; revocation mid-assignment fails the attempt on the next step; kill switch overrides grants; a credential is never present in logs; audit rows written without content.

## Alternatives considered

- **Keep the single `agent_enabled` boolean.** Can't express read-only or per-action external write. Rejected; kept as a kill switch.
- **Encode scopes in JWT claims / custom Supabase tokens.** Revocation would wait for token expiry; claims can't track per-assignment narrowing. Rejected as the enforcement point (may still be used for authentication).
- **Postgres roles / RLS per capability.** RLS can't express connection- and action-level scopes, or audit, cleanly, and the admin client bypasses RLS. Rejected; database constraints still enforce ownership.
- **OAuth 2.1 for MCP now.** Right long-term for hosted MCP, but larger than needed before a hosted `/mcp` endpoint exists. Kept as open question 1.

## Open questions

1. **External agent credential type:** Orbit-issued API keys (hashed, revocable), OAuth 2.1 (hosted MCP), or Supabase JWTs with server-side grants. *Decider: Tony. Blocks: A-05 ("auth ADR" in the plan should be a follow-up ADR once chosen).*
2. **Deprecation window** for user-JWT `/api/v1` access. *Decider: Tony.*
3. **Is `access_audit_events` required for all workspaces or only ones flagged as possibly holding PHI** (needs a workspace-level flag)? `// TODO: HIPAA review needed`. *Decider: Tony + compliance.*
4. **Should `item.write {update}` be grantable to external agents in v1** (it needs the ADR 002 expected-revision contract on a new v1 endpoint)? *Decider: Tony.*
5. **Do Slack links and email inbox tokens become grants** (`item.write {create}` for a `connection` principal), or stay as their own mechanisms? Proposed: stay as is until I-01. *Owner: Integrations.*
6. **Should Waltz workspaces default to no built-in agent grants** even if `agent_enabled` is toggled on, pending content review (as the agent migration comment suggests)? *Decider: Tony.*
