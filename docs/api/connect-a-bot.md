# Connect a bot

This guide gives a bot (a Grok, Claude or custom agent) its own Orbit key. The full reference is in [agents.md](agents.md).

## 1. Turn on agent access for the space

The bot can use only spaces whose **Allow the agent to read and change notes** switch is on. Turn it on in **Settings → Model & agent**. Turning it off later blocks every key in that space immediately.

## 2. Create a key

1. Open **Settings → Agents & API keys**.
2. Name the key after the bot, for example "Grok bot".
3. Tick what it may do in each space:
   - **Read** lets it list notes.
   - **Capture** lets it add Inbox notes. It can't edit or delete anything.
4. Click **Create key**. Copy the key that appears, `orbit_sk_…`, into the bot's secret store. Orbit shows it **once**.

Give each bot its own key, so you can see and revoke each one separately.

## 3. Use it

HTTP:

```sh
export ORBIT_URL=https://orbit-swart-mu.vercel.app
export ORBIT_API_KEY=orbit_sk_...   # from your secret store

curl "$ORBIT_URL/api/v1/workspaces" -H "Authorization: Bearer $ORBIT_API_KEY"

curl -X POST "$ORBIT_URL/api/v1/notes" \
  -H "Authorization: Bearer $ORBIT_API_KEY" -H "Content-Type: application/json" \
  -d '{"workspaceId":"<id from the list>","title":"Follow up","text":"Call the vendor"}'
```

MCP: set `ORBIT_URL` and `ORBIT_API_KEY` in the environment of `node scripts/orbit-mcp.mjs`. The JSON entry is in [agents.md](agents.md#mcp-configuration).

A `403` with `code: "capability_denied"` means the key wasn't granted that action in that space. Edit its access in Settings. The change applies to the bot's next request.

## 4. Watch and revoke

Settings → Agents & API keys shows when each key was last used. It also has a **Recent access** log: which key, what it did, in which space, and whether it was refused. The log never records note content.

**Revoke** stops the key on its next request. If a key leaks, revoke it and create a new one.

## Migrating from `ORBIT_ACCESS_TOKEN`

Bots that send a Supabase user access token keep working; no end date is scheduled. That access is deprecated: responses include a `Deprecation` header, and the MCP adapter prints a warning. An API key is scoped and revocable, so we recommend moving to one. To migrate, create a key as above, replace `ORBIT_ACCESS_TOKEN` with `ORBIT_API_KEY`, and stop refreshing the user session in the bot.
