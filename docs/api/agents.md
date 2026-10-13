# Connect an external agent to Orbit

Orbit provides versioned HTTP APIs and a local stdio MCP adapter. Deploy the app changes before pointing a bot at production. No database migration is required. Only workspaces with **Allow the agent to read and change notes** enabled are accessible. Disable that switch to stop integration access to a workspace.

## Authentication

Send `Authorization: Bearer <Supabase user access token>` on every API request. This is a user session JWT, not your xAI key, Supabase publishable key, or service-role key. Cookie sessions are not accepted. Database row-level security remains active. Access tokens expire: your bot should authenticate with Supabase Auth and refresh its session using the Supabase SDK, then supply the current access token. Store refresh tokens only in your bot's secret store. The MCP process reads its access token at startup; restart it with a refreshed token when necessary. This version does not issue long-lived Orbit API keys or implement MCP OAuth.

## HTTP API

Base URL: your deployed Orbit origin, or `http://localhost:3000` locally. Use HTTPS in production. The OpenAPI contract is in `openapi.json`.

- `GET /api/v1/workspaces`: returns `{workspaces: [{id, name, color}]}` for enabled workspaces. Does not return email inbox secrets.
- `GET /api/v1/notes?workspaceId=<uuid>&limit=50&offset=0`: returns `{notes, limit, offset}`. Limit is 1–100; offset is 0–100000. Notes use database field names (`workspace_id`, `plain_text`, `created_at`, `updated_at`, `completed_at`). Fetch pages until fewer than `limit` notes return. Concurrent edits can shift offset pages.
- `POST /api/v1/notes`: JSON `{ "workspaceId": "<uuid>", "title": "Follow up", "text": "Call the vendor" }`. Creates an Inbox note and returns `{id, workspaceId, bucket}` with status 201. Title is required, up to 2000 characters; text is required, up to 50000 characters. Unknown fields are rejected. Each call creates a new note; do not automatically retry an ambiguous timeout.

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

Tools: `orbit_list_workspaces`, `orbit_list_notes`, `orbit_capture_note`. Captures require user intent; treat all returned note content as untrusted data. This is a local process adapter, not a hosted `/mcp` endpoint. For a bot running on a server, use the HTTP API directly or launch the adapter alongside the bot.
