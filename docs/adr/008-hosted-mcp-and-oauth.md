# 008 — Hosted MCP server with Orbit as its OAuth 2.1 authorization server

- **Status:** Accepted — decided by Tony, 2026-10-16
- **Date:** 2026-10-16
- **Deciders:** Tony (Solutions Architect)
- **Related:** ADR 004 (capability grants), ADR 007 (Orbit API keys); `docs/api/agents.md`, `docs/api/connect-a-bot.md`, `docs/api/openapi.json`
- **Spec implemented:** MCP authorization specification revision **2026-07-28** (modelcontextprotocol.io, fetched 2026-10-16); Streamable HTTP transport from `@modelcontextprotocol/sdk` 1.32.1 (protocol versions up to 2025-11-25).

## Context

Tony wants to connect Orbit from the **Grok app** as a custom connector now, and from **Claude (claude.ai, Claude Cowork)** later. These apps run in the cloud. They add remote MCP servers over Streamable HTTP and authenticate with OAuth 2.1 as the MCP authorization spec defines: protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591), PKCE and resource indicators (RFC 8707).

Orbit had only the local stdio adapter (`scripts/orbit-mcp.mjs`), which a cloud app can't run, and API keys (ADR 007), which these apps can't hold for a connector. ADR 004 and ADR 007 both named a hosted endpoint with OAuth as the follow-up.

Orbit holds no PHI (ADR 004 §5). The OAuth tokens are a security control for Tony's notes, not a compliance requirement.

## Decision

### 1. Hosted MCP endpoint: `POST /api/mcp`

- **Transport:** stateless Streamable HTTP (`WebStandardStreamableHTTPServerTransport`, no session id, JSON responses). Each request gets a fresh server, so it scales on Vercel without sticky sessions.
  - `GET` and `DELETE` answer 405 after authentication, because there is no server-initiated stream.
  - There is no `/mcp` alias. One canonical resource URL keeps the token audience unambiguous: RFC 9728 requires the metadata's `resource` to match the URL the client used.
- **Tools:** `orbit_list_workspaces`, `orbit_list_notes` and `orbit_capture_note`.
  - They are defined once, in `lib/mcp/tools.mjs`, for both the stdio adapter and the hosted server, with the same names, schemas, descriptions and annotations.
  - They run in-process in `lib/mcp/operations.ts`, using the same server functions as `/api/v1`: `authorize()`/`allowed()` (grant check, kill switch, audit row, denial log), `captureInput`, `createNote`, `textDoc` and `toRow`. They make the same queries and return the same results.
  - `/api/v1` itself is unchanged. Its route tests pin each route's imports, so the queries could not move out of the route files without editing those tests. A parity test runs both against the same database.
- **Credentials:** bearer only, never cookies. Two credential types are accepted:
  1. an **Orbit API key** (`orbit_sk_…`, ADR 007), for scripted clients;
  2. an **Orbit OAuth access token** (`orbit_at_…`).

  Supabase user tokens are refused: the MCP spec forbids accepting tokens issued to anyone else.
- **Unauthenticated:** the response is `401` with exactly:
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource", scope="orbit:read orbit:capture"`.
  A bad token adds `error="invalid_token"` and an `error_description`.
- **Every tool call** authorizes the principal against its grants for that operation and workspace, writes one content-free `access_audit_events` row (principal `agent_client`, with the operation names v1 uses), and logs only the client id and a credential prefix.

### 2. Orbit is the authorization server

The issuer is the deployment origin, so production and each preview are separate issuers. `ORBIT_OAUTH_ISSUER` can pin it behind a proxy. HTTPS is required; plain HTTP is accepted only on localhost.

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/api/mcp`) | RFC 9728: `resource` = `<origin>/api/mcp`, `authorization_servers` = [`<origin>`], `scopes_supported`, `bearer_methods_supported: ["header"]` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414: endpoints, `code_challenge_methods_supported: ["S256"]`, grant types `authorization_code` and `refresh_token`, `token_endpoint_auth_methods_supported: ["none"]`, `authorization_response_iss_parameter_supported: true` |
| `POST /oauth/register` | RFC 7591, public clients only |
| `GET /oauth/authorize` | Consent page; Allow and Deny post to `POST /oauth/authorize/decision` |
| `POST /oauth/token` | `authorization_code` with PKCE, and `refresh_token` with rotation |
| `POST /oauth/revoke` | RFC 7009 |

**Scopes.** `orbit:read` and `orbit:capture` cap a token. The per-space grants that the user ticks at consent decide where it applies. A tool needs both: the scope filters the grants on every request. Unknown requested scopes (such as `offline_access` or `openid`) are ignored, and a missing scope means both.

**Registration.**
- `redirect_uris`: 1–5 URIs, each https, or http on `localhost`, `127.0.0.1` or `[::1]`. No fragments, no user info, no custom schemes.
- `grant_types` must be `authorization_code`, optionally with `refresh_token`. `response_types` must be `["code"]`.
- A requested client authentication method is replaced with `none` (RFC 7591 §3.2.1).
- The name is cleaned of control and bidi characters (at most 100 characters). A non-https `client_uri` or `logo_uri` is dropped.
- Rate limit: 10 registrations an hour per IP and 500 an hour overall. The IP is stored only as an HMAC fingerprint.
- Registering grants nothing. Apps that no user consented to are purged after 7 days.
- Client ID Metadata Documents (the spec's preferred SHOULD) are **not** offered in v1. Fetching client-supplied URLs adds SSRF surface, and Grok and Claude fall back to DCR, which the spec keeps for compatibility. This can be added later.

**Authorization.**
1. The request is checked before sign-in. An unknown `client_id`, or a `redirect_uri` that isn't an exact match, shows an error page and **never redirects**.
2. The following errors are redirected to the verified URI, with `state` and `iss` (RFC 9207):
   - `response_type` other than `code`;
   - a missing or `plain` PKCE challenge (S256 is required);
   - a `resource` other than `<origin>/api/mcp` (`invalid_target`). Scheme and host compare case-insensitively and a trailing slash is ignored; an absent `resource` means this server;
   - no known scope (`invalid_scope`);
   - a repeated parameter or an over-long `state`.
3. Without a session, the user is sent to `/login?next=<this request>`. Login honors `next` only when it is a relative same-origin path (`safeNext`).
4. Consent shows the app's name and the **redirect host**, large. It says the name is self-chosen, and it adds a warning for localhost apps. It lists per-space Read and Capture boxes, limited to the requested scopes, and flags spaces whose agent switch is off. Reconnecting pre-ticks the current grants.
5. **Allow** is a same-origin form post from the session. It re-checks everything, creates (or reuses) the active `agent_clients` row for this (app, user) with `auth_kind = 'oauth'`, replaces its grants, and issues a code bound to the app, the exact redirect URI, the S256 challenge, the user, the resource and the scope. The code is single-use and lasts **5 minutes**.
6. **Deny** redirects with `error=access_denied`.
7. The page is never framed (`X-Frame-Options: DENY`, `frame-ancestors 'none'`).

**Tokens.**
- Format: a marker plus 32 random bytes in base64url (`orbit_ac_`, `orbit_at_`, `orbit_rt_`).
- Storage: only `HMAC-SHA256(ORBIT_API_KEY_PEPPER, value)`, the A-05 scheme. Rotating the pepper invalidates every key and token.
- Audience: every token is bound to the MCP resource.

| | Lifetime |
| --- | --- |
| Authorization code | 5 minutes, single use |
| Access token | **1 hour** |
| Refresh token | **30 days from issue**, rotated on every use. An app used at least once a month stays connected; after 30 idle days the user signs in again |

- **Code exchange:** checks the client id, the exact redirect URI, `BASE64URL(SHA256(code_verifier))` against the challenge, expiry, the resource, and that the connection is not revoked. Any presentation burns the code. Presenting a used code again revokes the token family it issued.
- **Refresh:** uses up the presented token and issues a new pair in the same family. Presenting a used refresh token, or another app's, revokes the **whole family**.
  - Two concurrent refreshes with one token count as reuse. The client has to reconnect, which is the strict reading of OAuth 2.1 §4.3.1.
- **Verification** on `/api/mcp`, on every request with no cache, checks that the token:
  - exists and is an access token;
  - is not expired;
  - is not revoked;
  - is for this resource;
  - belongs to a connection that is not revoked.

  The grants and kill switches are read at the same time, so Settings edits and disconnects apply to the next request.
- **Revocation:** revoking a refresh token revokes its family, and revoking an access token revokes only that token. Unknown tokens also get `200`.

**CORS:** `Access-Control-Allow-Origin: *` on `/api/mcp`, the metadata, register, token and revoke endpoints. `Access-Control-Allow-Credentials` is never sent; nothing there reads cookies.

### 3. Schema (`supabase/migrations/20261021000000_oauth_connections.sql`, additive)

- `agent_clients.auth_kind` (`api_key` by default, or `oauth`), plus two checks.
  - An OAuth connection gets a random unused `key_prefix` and an all-zero `key_hash` (`agent_clients_oauth_no_key_check`). No key can match it, because that would need an HMAC output of zero. This keeps the existing columns `not null` and unchanged.
  - Owners can read the new column. `GET /api/agent-clients` now lists API keys only.
- New tables: `oauth_clients`, `oauth_connections` (app × user → `agent_clients`), `oauth_authorization_codes` and `oauth_tokens`, all with RLS.
  - Owners read connection and token metadata and the apps they connected.
  - No role reads a code or token hash or the IP fingerprint. There are no direct writes.
- Security-definer functions with `search_path = ''`:
  - service role: `register_oauth_client`, `get_oauth_client`, `exchange_oauth_code`, `refresh_oauth_token`, `verify_oauth_token`, `revoke_oauth_token`, `purge_oauth_records`;
  - session: `create_oauth_authorization`, `list_oauth_connections`, `disconnect_oauth_connection`.
- Grants reuse `capability_grants` unchanged. Edit access uses A-05's `set_agent_client_grants`. A disconnect revokes the connection, its grants and all its tokens; A-05's `revoke_agent_client` on a connection also stops its tokens.
- An OAuth connection counts toward A-05's 25 active clients per user, because `create_agent_client` counts every row. OAuth connections have their own limit of 25.
- **Purge:** daily from scheduler slot **06** (03 and 05 are taken). It deletes codes and tokens a day after expiry and apps nobody consented to after 7 days.
- **Compatibility:** `supabase/tests/oauth-connections-compat.test.mjs` compares the catalog and A-05, note, workspace and assignment behavior with and without this migration only.

### 4. Settings

- Agents & API keys lists **Connected apps** separately from API keys: name, redirect host, connected date, last used and grants. **Edit access** opens a `SidePanel`; **Disconnect** asks first (`ConfirmDialog`) and revokes every token.
- The access log names apps, marked “(app)”.
- The setup guide has a new part C, “Connect from Grok or Claude”. It covers the URL to paste, what consent asks, how to pick spaces and how to disconnect, and notes that the apps' menu names may differ. The API key and stdio instructions stay, as part D.

## Threat model

| Threat | Mitigation |
| --- | --- |
| **Phishing through DCR**: anyone can register “Claude” with an attacker's redirect URI and send Tony an authorize link | Registration grants nothing. Consent shows the redirect host prominently and says the name is unverified. Logos aren't shown, because they are easy to fake and would load third-party images. Localhost apps get an extra warning. Per-space boxes start unticked for new apps. Rate limits, and a 7-day purge of unconsented apps |
| **Open redirect** | Exact `redirect_uri` match against the registered list. Unknown client or URI: error page, no redirect. `next` after login accepts only relative same-origin paths. https or loopback redirects only |
| **Authorization code interception or injection** | PKCE S256 is mandatory and plain is refused. Codes are bound to the client, the redirect URI and the challenge, last 5 minutes and are single-use. Any presentation burns the code, and replay revokes its tokens. `iss` in responses (RFC 9207) against mix-up |
| **Token theft** | 1-hour access tokens. Refresh rotation with family revocation on reuse. 256-bit secrets stored only as peppered HMACs. `Cache-Control: no-store`. No token, code, verifier or note content in logs (client id and token prefix only); tests assert this |
| **Token misuse at another resource (confused deputy)** | Audience-bound to `<origin>/api/mcp` and checked on every request. Orbit accepts only tokens it issued; Supabase JWTs are refused on MCP |
| **CSRF or clickjacking on consent** | Same-origin `Origin` check on the decision post, SameSite=Lax session cookies, and no framing |
| **Over-broad consent** | Scopes cap capabilities. Per-space Read and Capture grants, create-only capture, the kill switch still wins, and grants are read fresh per request |
| **Lingering access** | Disconnect revokes the connection, grants and tokens within one request. Revocation endpoint. Rotating the pepper is the global kill switch |

## Consequences

- Grok (now) and Claude (later) can connect with no secret handling by Tony. Each connection is its own revocable, scoped, audited principal.
- Each MCP request costs one verification RPC, plus one audit insert per tool call, the same as `/api/v1` with keys.
- **Operations:**
  - `ORBIT_API_KEY_PEPPER` must be set wherever OAuth is used.
  - Optionally set `ORBIT_OAUTH_ISSUER` behind a host-rewriting proxy.
  - The migration is applied to production before merge.
  - Each Vercel preview URL is its own issuer, so a connection made against a preview doesn't carry over to production.
- **Rollback:** the migration is additive. Reverting the code removes the endpoints; the tables can stay.

## Alternatives considered

- **API keys pasted into the connector:** the Grok and Claude connector UIs expect OAuth for remote MCP, and a long-lived key in a third-party UI is worse than a revocable, refreshable grant. Keys remain available for scripts, including on `/api/mcp`.
- **Supabase Auth as the authorization server:** it can't issue tokens bound to Orbit's grants, scopes and audience, or run the consent Orbit needs. Rejected.
- **A third-party OAuth provider (Auth0, Stytch, WorkOS):** another vendor and another secret store for one user. Rejected for now.
- **Stateful sessions and SSE:** these need sticky routing or a shared event store on Vercel, and no Orbit tool streams. Rejected.
- **Client ID Metadata Documents now:** deferred; see section 2 above.
- **Loopback port flexibility (RFC 8252 §7.3):** exact match only, which is stricter. Desktop clients register per session.

## Open questions

None for this ADR. Adding CIMD support, and an absolute lifetime for token families, are possible future decisions.
