# 007 — External agents authenticate with Orbit-issued API keys

- **Status:** Accepted — decided by Tony, 2026-10-15. Section "Proposed answers" holds proposals awaiting Tony's confirmation.
- **Date:** 2026-10-15
- **Ticket:** A-05 (resolves ADR 004 open question 1; the plan's "auth ADR")
- **Deciders:** Tony (Solutions Architect)
- **Related:** ADR 004 (capability grants, the contract this implements), ADR 003 (`assignment.execute`), ADR 002 (revisioned writes); `docs/api/agents.md`, `docs/api/openapi.json`; plan "Connections and external agents"

## Context

`/api/v1/*` and the stdio MCP adapter (`scripts/orbit-mcp.mjs`) authenticate with the user's own Supabase access token (`integrationUser()` in `lib/integrations/auth.ts` before this change; `ORBIT_ACCESS_TOKEN`). ADR 004 lists the gaps: a bot holding a user JWT is indistinguishable from the user, can call PostgREST directly with owner RLS rights, can't be revoked before the token expires, and leaves no audit trail. The only gate is the per-workspace `agent_enabled` switch.

ADR 004 left the credential type open (OAuth 2.1, Orbit keys, or Supabase JWTs with server-side grants). Tony chose Orbit-issued API keys on 2026-10-15. Orbit holds no PHI (ADR 004 §5), and the Waltz Azure Key Vault standards don't apply to Orbit; the audit trail is a security control, not a compliance requirement.

What is stored: a key prefix and an HMAC of the key, never the key. What is logged: the key prefix, the capability and a denial code, never the key, the secret or a bearer token. What is audited: principal, operation, workspace, resource id, outcome and time, never titles, text or payloads.

## Decision

### 1. Key format

`orbit_sk_<prefix>_<secret>`

- `prefix`: 12 lowercase hex characters (6 random bytes). Stored in `agent_clients.key_prefix` (unique), shown in Settings, safe to log. It locates the row and grants nothing on its own.
- `secret`: 32 random bytes, base64url, 43 characters (256 bits).
- The `orbit_sk_` marker lets `/api/v1` tell keys from Supabase JWTs and lets secret scanners match them.

### 2. Storage and hashing

- `agent_clients.key_hash` = lowercase hex `HMAC-SHA256(ORBIT_API_KEY_PEPPER, full key)`. The app computes it; the database never sees the key or the pepper.
- ADR 004 §5 said "slow hash". That applies to low-entropy secrets such as passwords. With a 256-bit random secret, brute force is infeasible, and a slow hash would only add latency to every request. The pepper means a leaked table can't be used to test guesses offline. This is a deliberate refinement.
- `verify_agent_key(prefix, hash)` looks up by prefix and compares HMAC outputs with `=`. An attacker can't choose the HMAC output without the pepper, so the comparison's timing leaks nothing about the secret. A wrong prefix and a wrong secret both return null (`401 invalid_credentials`).
- `ORBIT_API_KEY_PEPPER` (at least 32 characters) is read through `lib/grants/config.ts`. It has no default. When a key is created or presented without it, the request fails fast with `503 not_configured` and a log line naming the variable, never its value. Rotating the pepper invalidates every key; that is the emergency "revoke all" lever.
- Settings shows the full key once, in the create response. It is never retrievable again.

### 3. Schema (migration `20261020000100_agent_api_keys.sql`, additive)

ADR 004 §2 proposed `20261024000000_capability_grants.sql`; the file name and the v1 subset differ as follows.

| Table | Columns (v1) | Access |
| --- | --- | --- |
| `agent_clients` | `id`, `user_id`, `name` (1–100), `key_prefix`, `key_hash`, `created_at`, `last_used_at`, `revoked_at` | Owner `select` on every column except `key_hash` (column grant); no direct writes |
| `capability_grants` | `id`, `user_id`, `workspace_id` (composite FK to the owner's workspace, cascade), `principal_type` (`agent_client` only), `principal_id` (composite FK to the owner's client), `capability` (`workspace.read`, `item.write`, `assignment.execute`), `constraints` (`item.write` must be `{"operations": ["create"]}`; others `{}`), `granted_at`, `revoked_at`, `revoke_reason` (`user`, `client_revoked`) | Owner `select`; no direct writes. One active row per (client, workspace, capability) |
| `access_audit_events` | `id`, `user_id`, `principal_type` (`agent_client`, `user_token`), `principal_id`, `operation` (`workspace.list`, `item.read`, `item.create`), `workspace_id`, `resource_id`, `outcome` (`allowed`, `denied`), `code` (`capability_denied`, `agent_disabled`, `client_revoked`), `occurred_at` | Owner `select`; insert only through `record_access_event` (service role). No foreign keys on workspace or resource, so history outlives deletes |

Functions (all `security definer`, `search_path = ''`):

| Function | Role | Does |
| --- | --- | --- |
| `create_agent_client(name, prefix, hash, grants)` | authenticated | Validates the name, the prefix and hash shapes, and that each granted workspace is the caller's. Allows at most 25 active clients per user. Returns `{status: created, client}` or `invalid_payload`, `not_found`, `limit_reached`, `duplicate_prefix` (the route retries once) |
| `set_agent_client_grants(id, grants)` | authenticated | Replaces the active grant set. Removed rows get `revoked_at` and `revoke_reason = user`; unchanged rows keep `granted_at`. Refuses a revoked client (`client_revoked`) |
| `revoke_agent_client(id)` | authenticated | Sets `revoked_at` (idempotent) and revokes all grants (`client_revoked`) |
| `verify_agent_key(prefix, hash)` | service_role | Returns null, `{status: revoked, userId, clientId}`, or `{status: ok, userId, clientId, grants: [{workspaceId, capability, constraints, agentEnabled}]}`. Updates `last_used_at` at most once a minute |
| `record_access_event(...)` | service_role | Inserts one audit row; refuses a client that isn't the user's |
| `purge_access_audit_events()` | service_role | Deletes rows older than 90 days; called from scheduler slot `05` |

Deferred until a consumer exists, and added additively then: `builtin_agent` principal rows and ADR 004 §4's seeding (the built-in executor keeps its static policy until its owners switch it to `authorize()`), `external.read` / `external.write` with `connection_id` / `action` (I-01, I-05), and `expires_at`.

### 4. Authentication and authorization on `/api/v1`

`integrationAuth(request, operation)` in `lib/integrations/auth.ts`:

1. Accepts only `Authorization: Bearer ...`. A missing header returns `401 invalid_credentials`. Cookies are never read.
2. **`orbit_sk_...`:** parse the key (`401 invalid_credentials` if malformed). Read the pepper, compute the HMAC, and call `verify_agent_key` through the server role. A revoked key returns `401 client_revoked` and an audit row. No result is cached across requests: each request verifies again and reads the grants and the kill switch fresh, so revocation and grant edits apply to the next call.
3. **Anything else:** treated as a Supabase user token. See section 5.

`authorize(auth, capability, workspaceId, operation)`, using `checkGrant()` in `lib/grants/server.ts`:

| Operation | Needs |
| --- | --- |
| `GET /api/v1/workspaces` | Returns only workspaces with at least one active grant and `agent_enabled = true`, each with `capabilities` |
| `GET /api/v1/notes` | `workspace.read` in that workspace |
| `POST /api/v1/notes` | `item.write` with `create` in that workspace |

Results:
- No matching grant, including for an unknown or other user's workspace: `403 capability_denied` with `{capability}`. The response is identical either way, so nothing about existence leaks.
- A grant exists but `agent_enabled` is off: `403 agent_disabled`. The kill switch still overrides grants.

Data access for keys uses the server role. Every query is filtered by the key's `user_id` and the authorized workspace, and the notes composite FK ties inserts to that user. The key never reaches PostgREST, so ADR 004 gap 2 closes for key-holding bots.

Every allowed or denied operation writes one content-free audit row. Audit writes fail open: a failed write logs `access audit write failed` and does not block the operation. Denials log `{event, key: orbit_sk_<prefix>, capability, code}`.

Error bodies are `{error, code}`, with `capability` on `capability_denied`. The `code` field is additive to v1.

### 5. Supabase user tokens: deprecation

- These are accepted until the sunset date (`ORBIT_USER_TOKEN_SUNSET`, `YYYY-MM-DD` UTC, default `2026-11-19`). Behavior is unchanged: today's policy, `workspace.read` plus `item.write {create}` behind `agent_enabled`, read on each request.
- Every response carries `Deprecation: @1792454400` (RFC 9745; 2026-10-20, when keys shipped) and `Sunset: <HTTP-date>` (RFC 8594). The error message and docs point to Settings → Agents & API keys.
- Each operation writes an audit row with `principal_type = user_token` and no principal id. If the server role isn't configured, the request still works and logs `access audit unavailable`.
- From the sunset date on, user tokens are refused with `401 credential_type_unsupported` (ADR 004 §6). To extend the window, set a later date; no code change is needed.
- The MCP adapter prefers `ORBIT_API_KEY`. It still accepts `ORBIT_ACCESS_TOKEN` with a stderr warning, and warns once when the server sends `Sunset`. Neither value is printed.

### 6. Settings

Settings → Connections → **Agents & API keys** (`components/agent-keys-settings.tsx`), backed by cookie-session routes. Mutations use `routeUser(..., { mutating: true })`, so a same-origin `Origin` header is required.

| Route | Does |
| --- | --- |
| `GET /api/agent-clients` | Clients with active grants; never the hash |
| `POST /api/agent-clients` `{name, grants}` | Returns `{client, apiKey}` once, with status 201 |
| `PUT /api/agent-clients/{id}/grants` `{grants}` | Replaces the grants |
| `POST /api/agent-clients/{id}/revoke` | Revokes the client |
| `GET /api/agent-clients/access-log?limit=50` | The latest audit events (1–200) |

The UI offers Read (`workspace.read`) and Capture (`item.write {create}`) per space. `assignment.execute` is accepted by the API and schema but not offered until A-06 ships the executor operations.

## Consequences

- Each bot gets its own revocable, scoped identity, and users can see what it did. Revocation is immediate, within one request.
- Each `/api/v1` request costs one verification RPC, which reads grants with a join on workspaces, plus one audit insert. This is fine at current scale; revisit if it becomes hot (the indexes are on `key_prefix` and the grant principal).
- Operations:
  - Set `ORBIT_API_KEY_PEPPER` in every environment before keys are used, and never rotate it casually.
  - The lead applies the migration to production before merge. The compatibility test `supabase/tests/agent-api-keys-compat.test.mjs` proves existing behavior is unchanged.
- The bot's server-role path bypasses RLS, so correctness rests on the route filters (`user_id`, the authorized workspace) and on composite FKs. Tests cover both.
- Rollback: the migration is additive. Reverting the code restores the old JWT-only routes. The tables can stay or be dropped.
- Follow-ups:
  - A-06 adds assignment operations under `assignment.execute`.
  - I-01 adds `external.*` and connection principals.
  - The built-in executor moves to `authorize()` with seeded `builtin_agent` grants.
  - A hosted `/mcp` endpoint can add OAuth 2.1 later; keys remain for bots.

## Alternatives considered

- **OAuth 2.1 (hosted MCP):** the right long-term fit for third-party MCP clients, but it needs a hosted MCP endpoint and authorization server that Orbit doesn't have. Not chosen now; keys don't preclude it.
- **Supabase JWTs with server-side grants:** these keep the PostgREST bypass (gap 2) and the expiry-bound revocation (gap 3). Rejected.
- **bcrypt/argon2 key hashes:** these add CPU per request with no security gain for 256-bit random secrets. Rejected in favor of a peppered HMAC.
- **Caching verification for a few seconds:** this would break "revocation applies on the next request". Rejected.
- **Fail-closed audit:** an audit outage would stop all bot captures. Rejected for v1 because the audit is a security aid, not a compliance record (ADR 004 §5). Revisit if that changes.

## Proposed answers to ADR 004's remaining open questions

These are **proposed, awaiting Tony's confirmation**. The implementation follows them, and each can be changed by configuration or a small follow-up.

1. **Deprecation window for user-JWT `/api/v1` (ADR 004 Q2):** 30 days from when keys ship (2026-10-20 to 2026-11-19), announced through `Deprecation` / `Sunset` headers and the MCP warning. Afterwards, `401 credential_type_unsupported`. Configurable with `ORBIT_USER_TOKEN_SUNSET`.
2. **`access_audit_events` retention (ADR 004 Q3):** 90 days, purged daily from scheduler slot `05` by `purge_access_audit_events()`.
3. **`item.write {update}` for external agents in v1 (ADR 004 Q4):** no; create-only for now. A table check constraint enforces `{"operations": ["create"]}`. Update needs a v1 endpoint on the ADR 002 expected-revision contract, which is a separate ticket and widens the check constraint.
4. **Slack links and email inbox tokens as grants (ADR 004 Q5):** they stay separate mechanisms until I-01, as ADR 004 proposed. They are not agent principals and are unaffected by this change.
