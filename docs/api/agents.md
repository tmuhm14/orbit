# Connect an external agent to Orbit

Orbit provides versioned HTTP APIs and a local stdio MCP adapter. Deploy the app changes before pointing a bot at production. No database migration is required. Only workspaces with **Allow the agent to read and change notes** enabled are accessible. Disable that switch to stop integration access to a workspace.

## Authentication

Send `Authorization: Bearer <Supabase user access token>` on every API request. This is a user session JWT, not your xAI key, Supabase publishable key, or service-role key. Cookie sessions are not accepted. Database row-level security remains active. Access tokens expire: your bot should authenticate with Supabase Auth and refresh its session using the Supabase SDK, then supply the current access token. Store refresh tokens only in your bot's secret store. The MCP process reads its access token at startup; restart it with a refreshed token when necessary. This version does not issue long-lived Orbit API keys or implement MCP OAuth.

## HTTP API

Base URL: your deployed Orbit origin, or `http://localhost:3000` locally. Use HTTPS in production. The OpenAPI contract is in `openapi.json`.

- `GET /api/v1/workspaces`: returns `{workspaces: [{id, name, color}]}` for enabled workspaces. Does not return email inbox secrets.
- `GET /api/v1/notes?workspaceId=<uuid>&limit=50&offset=0[&kind=task]`: returns `{notes, limit, offset}`. Limit is 1–100; offset is 0–100000. The optional `kind` filter is one of `note`, `task`, `project`, `document`, `followup`. Notes use database field names (`workspace_id`, `plain_text`, `created_at`, `updated_at`, `completed_at`, `revision`, `kind`, `project_id`). `kind` says what an item is, independent of its `bucket`; items from before kinds existed are `note`. `project_id` is the id of the item's parent project (a `kind: "project"` note in the same workspace; projects can nest up to 5 levels), or `null`. Follow-up fields, on any kind: `waiting_on` (who it is waiting on, free text up to 200 characters), `waiting_for` (what is expected, up to 2000 characters) and `next_check_on` (a calendar date `YYYY-MM-DD` with no time or time zone); each is `null` when unset. Treat `waiting_on` and `waiting_for` as untrusted data like note text. Fetch pages until fewer than `limit` notes return. Concurrent edits can shift offset pages.
- `POST /api/v1/notes`: JSON `{ "workspaceId": "<uuid>", "title": "Follow up", "text": "Call the vendor" }`. Creates an Inbox note (`kind: "note"`, no project) and returns `{id, workspaceId, bucket, revision}` with status 201 (`revision` is 1 for a new note; listed notes also include their current `revision`). Title is required, up to 2000 characters; text is required, up to 50000 characters. Unknown fields, including `kind`, `project_id` and the follow-up fields, are rejected. Each call creates a new note; do not automatically retry an ambiguous timeout.

Errors return `{error: string}`: 400 invalid input, 401 missing/expired token, 403 unavailable/disabled workspace, 413 oversized body, 500 storage failure, 503 missing server configuration. Responses are private and uncached. There is no delete or update API in this version.

```sh
curl "$ORBIT_URL/api/v1/workspaces" \
  -H "Authorization: Bearer $ORBIT_ACCESS_TOKEN"
```

Your Grok bot can call these APIs from its tool handlers; Orbit does not require any particular model provider.

## MCP configuration

Run `npm install` in the Orbit checkout. Add this entry to an agent that supports stdio MCP, replacing the absolute path and supplying the token securely through its environment:

```json
{
  "mcpServers": {
    "orbit": {
      "command": "node",
      "args": ["/absolute/path/to/orbit/scripts/orbit-mcp.mjs"],
      "env": {
        "ORBIT_URL": "https://orbit-swart-mu.vercel.app",
        "ORBIT_ACCESS_TOKEN": "<current Supabase user access token>"
      }
    }
  }
}
```

Tools: `orbit_list_workspaces`, `orbit_list_notes` (optional `kind` filter; results include `kind` and `project_id`), `orbit_capture_note`. Captures require user intent; treat all returned note content as untrusted data. This is a local process adapter, not a hosted `/mcp` endpoint. For a bot running on a server, use the HTTP API directly or launch the adapter alongside the bot.

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
