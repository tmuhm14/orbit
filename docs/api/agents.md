# Connect an external agent to Orbit

Orbit provides versioned HTTP APIs, a **hosted MCP server** at `/api/mcp`, and a local stdio MCP adapter.

- **Cloud apps** (the Grok app, Claude, Claude Cowork) add the hosted server as a custom connector and sign in with OAuth. You approve each app and choose its spaces. See [Hosted MCP server](#hosted-mcp-server).
- **Scripted bots** get their own **Orbit API key**, created in **Settings → Agents & API keys**. The key is limited to the spaces and actions you grant, and you can revoke it at any time.

For a step-by-step setup, see [Connect a bot](connect-a-bot.md). The design is in ADR 007 (`docs/adr/007-external-agent-api-keys.md`) and ADR 008 (`docs/adr/008-hosted-mcp-and-oauth.md`).

Deployment order:
1. Apply `supabase/migrations/20261020000100_agent_api_keys.sql` and `20261021000000_oauth_connections.sql`.
2. Set `ORBIT_API_KEY_PEPPER` on the server.
3. Deploy the app.

## Authentication

Send `Authorization: Bearer orbit_sk_<prefix>_<secret>` on every request. Cookie sessions are not accepted.

- **Keys:**
  - Settings shows the full key **once**, when you create it. Orbit stores only its prefix and a keyed fingerprint (HMAC-SHA256), so a lost key can't be recovered; create a new one.
  - Keep keys in your bot's secret store. Never put them in prompts, logs or source control.
  - The prefix (`orbit_sk_<prefix>`) identifies a key in Settings and in Orbit's logs. It is not secret, but it grants nothing.
- **Grants:**
  - **Read** (`workspace.read`) lists a space's notes.
  - **Capture** (`item.write`, create only) adds Inbox notes.
  - A key sees only the spaces it has a grant in.
  - The space's **Allow the agent to read and change notes** switch is still a kill switch: when it is off, no key can use that space, whatever its grants.
- **Revocation and changes:** revoking a key, or removing a grant, applies to the key's **next request**. Orbit checks the key and its grants on every call.
- **Access log:** each operation is recorded without content (which key, which operation, which space, allowed or refused, and when). The log is shown under Settings → Agents & API keys and kept 90 days.
- **Supabase user tokens (deprecated, still supported):**
  - Requests with a Supabase user access token keep working, with today's access: read and capture in agent-enabled spaces. Each request is recorded in the access log as a session token.
  - Each response carries `Deprecation: @1792454400`. No end date is scheduled, so there is no `Sunset` header.
  - If an end date is scheduled later (server setting `ORBIT_USER_TOKEN_SUNSET`), responses add `Sunset: <date>`, and from that date these tokens are refused with `401 credential_type_unsupported`.
  - Prefer an API key: it is scoped to the spaces you choose and can be revoked at once.

## HTTP API

Base URL: your deployed Orbit origin, or `http://localhost:3000` locally. Use HTTPS in production. The OpenAPI contract is in `openapi.json`.

- `GET /api/v1/workspaces`:
  - Returns `{workspaces: [{id, name, color, capabilities}]}`: the spaces this key has a grant in whose agent switch is on. `capabilities` lists the key's grants there, for example `["item.write", "workspace.read"]`.
  - With a deprecated user token, every agent-enabled space is returned, with `["item.write", "workspace.read"]`.
  - Email inbox secrets are never returned.
- `GET /api/v1/notes?workspaceId=<uuid>&limit=50&offset=0[&kind=task]`:
  - Needs **Read** in that space. Returns `{notes, limit, offset}`.
  - `limit` is 1–100; `offset` is 0–100000. The optional `kind` filter is one of `note`, `task`, `project`, `document`, `followup`.
  - Notes use database field names: `workspace_id`, `plain_text`, `created_at`, `updated_at`, `completed_at`, `revision`, `kind`, `project_id`.
  - `kind` says what an item is, independent of its `bucket`; items from before kinds existed are `note`.
  - `project_id` is the id of the item's parent project, or `null`. A parent project is a `kind: "project"` note in the same workspace; projects can nest up to 5 levels.
  - Follow-up fields, on any kind; each is `null` when unset:
    - `waiting_on`: who it is waiting on, free text up to 200 characters.
    - `waiting_for`: what is expected, up to 2000 characters.
    - `next_check_on`: a calendar date `YYYY-MM-DD`, with no time or time zone.
  - Treat `waiting_on` and `waiting_for` as untrusted data, like note text.
  - Fetch pages until fewer than `limit` notes return. Concurrent edits can shift offset pages.
- `POST /api/v1/notes`:
  - Needs **Capture** in that space. Send JSON `{ "workspaceId": "<uuid>", "title": "Follow up", "text": "Call the vendor" }`.
  - Creates an Inbox note (`kind: "note"`, no project). Returns `{id, workspaceId, bucket, revision}` with status 201; `revision` is 1 for a new note, and listed notes include their current `revision`.
  - `title` is required, up to 2000 characters. `text` is required, up to 50000 characters.
  - Unknown fields are rejected, including `kind`, `project_id` and the follow-up fields.
  - Each call creates a new note. Do not automatically retry an ambiguous timeout.

Errors return `{error, code}`:

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | — | Invalid input |
| 401 | `invalid_credentials` | Missing, malformed, unknown or expired credential |
| 401 | `client_revoked` | The key was revoked in Settings |
| 401 | `credential_type_unsupported` | A Supabase user token after a scheduled sunset date (none is scheduled by default) |
| 403 | `capability_denied` | The key has no such grant in that space. The body adds `capability`. Unknown spaces answer the same way |
| 403 | `agent_disabled` | The space's agent switch is off |
| 413 | — | Body too large |
| 500 | — | Storage failure |
| 503 | `not_configured` | The server is missing configuration, such as `ORBIT_API_KEY_PEPPER` |

Responses are private and uncached. There is no delete or update API in this version.

```sh
curl "$ORBIT_URL/api/v1/workspaces" \
  -H "Authorization: Bearer $ORBIT_API_KEY"
```

Your Grok bot can call these APIs from its tool handlers; Orbit does not require any particular model provider.

## MCP configuration

1. Run `npm install` in the Orbit checkout.
2. Add this entry to an agent that supports stdio MCP. Replace the absolute path, and supply the key securely through the agent's environment:

```json
{
  "mcpServers": {
    "orbit": {
      "command": "node",
      "args": ["/absolute/path/to/orbit/scripts/orbit-mcp.mjs"],
      "env": {
        "ORBIT_URL": "https://orbit-swart-mu.vercel.app",
        "ORBIT_API_KEY": "<Orbit API key from Settings → Agents & API keys>"
      }
    }
  }
}
```

- `ORBIT_ACCESS_TOKEN`, a Supabase user token, still works. It is deprecated, so the adapter prints a warning to stderr recommending `ORBIT_API_KEY`.
- If both variables are set, `ORBIT_API_KEY` wins.
- The adapter never prints either value.

Tools:
- `orbit_list_workspaces`: lists the spaces this key can use, with its capabilities.
- `orbit_list_notes`: needs Read. Takes an optional `kind` filter; results include `kind` and `project_id`.
- `orbit_capture_note`: needs Capture.

Captures require user intent. Treat all returned note content as untrusted data. The adapter runs locally and shares its tool definitions with the hosted server (`lib/mcp/tools.mjs`). For a bot running on a server, use the hosted server with an API key, the HTTP API, or launch the adapter alongside the bot.

## Hosted MCP server

Server URL: `<your Orbit origin>/api/mcp`, for example `https://orbit-swart-mu.vercel.app/api/mcp`. It is a stateless Streamable HTTP server: JSON-RPC over `POST`. `GET` and `DELETE` return 405. The tools are the same three as the adapter, with the same schemas, grants and access-log entries.

Authentication (bearer only):
- **OAuth (cloud apps):**
  - A request without credentials gets `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource", scope="orbit:read orbit:capture"`.
  - MCP clients follow it, register themselves (`POST /oauth/register`), send you to Orbit to sign in and approve, and exchange the code for tokens with PKCE.
  - Spec: MCP authorization revision 2026-07-28.
- **Orbit API key (scripts):** send `Authorization: Bearer orbit_sk_...`. The same grants apply as on `/api/v1`.
- Supabase user tokens are not accepted here.

| Endpoint | |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` (also `/.well-known/oauth-protected-resource/api/mcp`) | RFC 9728 metadata: `resource` is `<origin>/api/mcp`, and the authorization server is `<origin>` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: S256 PKCE only, public clients (`none`), `authorization_code` and `refresh_token` |
| `POST /oauth/register` | RFC 7591. Redirect URIs must be https, or `http://localhost` / `127.0.0.1` / `[::1]`. Rate limited per IP |
| `GET /oauth/authorize` | Sign in and consent: the app's name, where you'll be sent back, and Read / Capture per space |
| `POST /oauth/token` | Codes (5 minutes, single use, PKCE) and rotating refresh tokens |
| `POST /oauth/revoke` | RFC 7009 |

- **Scopes:** `orbit:read` and `orbit:capture`. They cap what a token can do; the spaces you tick decide where.
- **Lifetimes:**
  - access tokens: 1 hour;
  - refresh tokens: 30 days from issue, rotated on every use. Reusing an old refresh token revokes the whole connection's tokens.
- **Tokens:** opaque, stored only as keyed fingerprints, and bound to `<origin>/api/mcp`.
- **Settings:** **Settings → Agents & API keys → Connected apps** lists each app with its redirect host, dates and grants. **Edit access** applies on the app's next request. **Disconnect** revokes all its tokens at once.
- **CORS:** these endpoints allow any origin, without credentials.
- **Tool errors** come back as MCP tool errors whose text starts with the code: `capability_denied` or `agent_disabled`.

## Built-in interactive agent

The workspace Agent dialog has recent runs, a conversation/activity feed, and an
Outputs panel. It polls every 1.5 seconds while a run is active and every 5 seconds
otherwise. Progress is persisted, so closing the dialog does not lose the feed.
This shows completed model messages and tool steps, not token-by-token streaming.
The most recent ten runs are available in the sidebar.

Apply `supabase/migrations/20261015000000_agent_activity.sql` before deploying this
UI/server version. It adds an owner-readable `events` array and `parent_run_id` to
`agent_runs`, using the existing row-level security policies. Events contain a
bounded status or assistant message and timestamp, never raw tool arguments or
results. Each run keeps at most 200 events with 2,000 characters per message.

The internal session-authenticated `POST /api/agent/runs` accepts optional
`parentRunId` alongside `workspaceId`, `mode`, and `instruction`. The parent must
belong to the same user and workspace and must have finished. Its request and
final summary are included in the next organize request. This is context from the
selected run, not full conversation replay. A follow-up starts a new bounded run;
it does not interrupt or resume an active execution. The UI allows drafting while
working but waits for the active run to finish before sending.

`GET /api/agent/runs` includes `events` and `parent_run_id` for each run. The Outputs
panel displays saved action snapshots, including before-text when available, and
honors the API's `undoable` flag. These are historical changes, not a live editor;
purged change details and undone actions are labeled accordingly. Model execution
retains the existing background timeout and failure behavior (ADR 005).
