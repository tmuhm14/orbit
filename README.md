# Orbit

Live app: [orbit-swart-mu.vercel.app](https://orbit-swart-mu.vercel.app)

A calm, space-inspired Getting Things Done workspace built with Next.js, React, TypeScript, and Tiptap. This first version focuses on capturing and organizing thoughts.

## External agents and MCP

External bots can list agent-enabled workspaces, read notes, and capture Inbox notes through `/api/v1/workspaces` and `/api/v1/notes`. A local MCP adapter exposes the same operations to agents that support stdio. See [connection instructions](docs/api/agents.md) and the [OpenAPI contract](docs/api/openapi.json). Authentication uses a Supabase user access token and respects per-workspace agent permissions. Deploy these routes before connecting a production bot.

## Run locally

Requires Node.js 22.6 or newer (see `.nvmrc`); the test runner uses built-in TypeScript stripping.

```sh
npm install
cp .env.example .env.local
# Fill in the Supabase project URL and publishable key.
npm run dev
```

Open http://localhost:3000. Use `npm run build` for a production build, `npm start` to serve it, and `npm run typecheck` for TypeScript validation.

## Included

- Quick capture into any of six GTD buckets: Inbox, Next actions, Projects, Waiting for, Someday / maybe, and Reference.
- Editable rich-text notes with headings, lists, checklists, quotes, code blocks, and dividers.
- Slash commands: type `/` in the note body, filter by name, and use arrow keys and Enter or click a command.
- Tags, workspace-wide search, tag filters, sorting, list/grid views, completion and reopening, and confirmed deletion.
- Email/password accounts, confirmed email signup, password recovery, and sign-out through Supabase Auth.
- Account storage in Supabase with row-level security, a one-time move of older browser-only notes, JSON export, and a GTD weekly-review guide.
- Multiple workspaces (e.g. Personal and Waltz) under one login: switch from the colored pill in the top bar or the sidebar card. Each workspace has its own color and can be set as the account's default in the switcher. The default opens after sign-in on any device. Each space has its own buckets, notes, tags, and search, and a note can be moved between spaces from the editor.
- Email capture: each workspace has a private address; forwarded emails land in its Inbox.
- Organizing agent with your own Anthropic, OpenAI, or xAI (Grok) key: triages Slack and email captures as they arrive, organizes a workspace on request or follows a typed instruction, and logs every change with one-click undo. Opt-in per workspace.
- A Jira dashboard (**Jira** in the left navigation): issues assigned to you, what your team's projects moved lately, and what's coming up, read live from Jira.
- Scheduled team debriefs from Jira and GitHub activity, with linked reports in Orbit. Existing accounts get an off-by-default 6 a.m. Central task for Specialty and Patient Management; add the exact GitHub repositories and connect read-only credentials to turn it on.
- "Send to Orbit" Slack message shortcut that drops messages into the Inbox of the workspace that Slack is linked to.
- Responsive layouts, keyboard shortcuts, and reduced-motion support.

Keyboard shortcuts: Cmd/Ctrl+K searches, Cmd/Ctrl+J focuses quick capture. Enter captures; Shift+Enter adds a line. Notes save automatically.

## Data and limitations

Accounts are managed by Supabase Auth. The server verifies the user before rendering the workspace, and uses HTTP-only cookies (Secure in production, SameSite=Lax). Authenticated responses are not cached. Supabase handles password hashing and authentication rate limits.

Notes are stored in the Supabase `notes` table with row-level security: each signed-in user can read and write only their own rows. The browser talks to `/api/notes`, which uses the signed-in session (never an admin key). Edits save in batches about a second after typing stops, and the list refreshes on focus and every 30 seconds so notes captured elsewhere (Slack) appear.

The home screen's Due items panel shows unfinished notes in the current workspace, grouped into Overdue, Today, and Upcoming. Add or clear a calendar due date in the note editor. Apply `supabase/migrations/20261013000000_note_due_dates.sql` before deploying this feature; it adds the nullable `due_date` column used when loading and saving notes. Dates are interpreted in the viewer's local calendar, without a time of day.

Notes from earlier versions live in this browser's localStorage (`orbit.notes.v1:<user UUID>`, plus unclaimed anonymous notes under `orbit.notes.v1`). After sign-in, **Move my notes** uploads them to the account once. They are never moved automatically, and the originals stay in localStorage as a backup.

Export your notes for a JSON copy; importing exported backups is not implemented. Concurrent edits to the same note from two tabs or devices are last-write-wins. Sign-out/account changes in another tab are checked via an auth event, on focus, and every minute.

## Authentication setup

1. Connect a Supabase project and set `NEXT_PUBLIC_SUPABASE_URL` plus `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` also works).
2. Set `NEXT_PUBLIC_SITE_URL` to the canonical app origin; defaults are the production URL above and `http://localhost:3000` in development.
3. In Supabase Authentication → URL Configuration, set the production Site URL and allow these exact callback URLs:
   - `https://orbit-swart-mu.vercel.app/auth/callback`
   - `https://orbit-swart-mu.vercel.app/auth/callback?next=reset`
   - `http://localhost:3000/auth/callback`
   - `http://localhost:3000/auth/callback?next=reset`
4. Keep email confirmation enabled. Configure custom SMTP with a verified sender before opening registration broadly. Supabase's built-in email service is restricted and is not a production mail service. Email setup was deferred. `AUTH_EMAIL_ENABLED` defaults to false, so public registration and password-recovery actions are paused. Create accounts in Supabase Authentication → Users → Add user for now. After setting up and testing SMTP, set `AUTH_EMAIL_ENABLED=true` in Vercel and redeploy.
5. Use the default confirmation/recovery email templates with `{{ .ConfirmationURL }}`. Links use PKCE and must be opened in the browser that requested them.

Browser-facing routes use only the publishable key with the user's session. The Supabase secret key (`SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`) is used only in `lib/supabase/admin.ts`, which is server-only, for Slack callbacks that arrive without a browser session. Those routes verify Slack's signature and look up the linked account before writing. The optional integration test uses an admin key only to create and remove its own disposable test account.

## Slack capture

Use **Send to Orbit** from the ⋯ menu of any Slack message. The message lands in your Inbox tagged `slack`, with a link back to the original. Sending the same message twice does nothing the second time. Slack notes are marked `triage_status = 'pending'` for the planned organizing agent.

Each connected Slack workspace sends to one Orbit workspace. You choose it when connecting (a workspace whose name matches the Slack team is preselected, e.g. `waltzhealth` → Waltz), and can change it or disconnect later under **Slack sends to** in the workspace switcher.

The first time, Orbit replies (visible only to you) with a link to connect your Slack account. Open it in a browser where you are signed in to Orbit and confirm. The link is signed and expires after 15 minutes. Only the server can create Slack links, so no one can claim someone else's Slack account.

Setup:

1. Apply the migrations in `supabase/migrations/` in order to the Supabase project (SQL editor, or `supabase db push`).
2. At https://api.slack.com/apps choose **Create New App → From a manifest**, pick your workspace, and paste:

   ```yaml
   display_information:
     name: Orbit
     description: Send Slack messages to your Orbit inbox
   features:
     bot_user:
       display_name: Orbit
     shortcuts:
       - name: Send to Orbit
         type: message
         callback_id: send_to_orbit
         description: Add this message to your Orbit inbox
   oauth_config:
     scopes:
       bot:
         - commands
   settings:
     interactivity:
       is_enabled: true
       request_url: https://orbit-swart-mu.vercel.app/api/slack/interact
   ```

3. Install the app to the workspace. Copy **Basic Information → Signing Secret** into `SLACK_SIGNING_SECRET` in Vercel (and `.env.local` for local work). `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` must also be set; the Vercel Supabase integration provides it.
4. Redeploy. Slack can't reach `localhost`, so test locally through a tunnel (for example `ngrok http 3000`) and point the request URL at it temporarily.

## Email capture

Each workspace has a private address such as `waltz-a1b2c3d4e5f6@<id>.resend.app`, shown under **Email into …** in the workspace switcher (with Copy). Forward or send an email there and it lands in that workspace's Inbox, tagged `email`. The subject becomes the title (`Fwd:`/`FW:` removed), the body becomes the note, and attachments are listed by name but not imported. Duplicate deliveries are ignored by `Message-ID`. Email notes are marked `triage_status = 'pending'` for the organizing agent.

The 12-character part of the address works like a password: anyone who knows it can add to that inbox. Use the refresh button next to the address to issue a new one; the old one stops working right away.

How it works: Resend receives the mail and calls `POST /api/email/inbound` with a signed `email.received` webhook (Svix signature, 5-minute window). That webhook has metadata only, so the route fetches the email from `GET https://api.resend.com/emails/receiving/{id}` with your API key, finds the workspace from the recipient address, and inserts the note.

Setup:

1. Apply `supabase/migrations/20261008000000_email_capture.sql` (adds the `email` source and per-workspace `inbox_token`).
2. In Resend: **Receiving** shows your receiving domain (`<id>.resend.app`, or add an MX record for a custom domain).
3. **Webhooks → Add endpoint**: URL `https://orbit-swart-mu.vercel.app/api/email/inbound`, event `email.received`. Copy its signing secret (`whsec_…`).
4. **API Keys**: create a key that can read received emails.
5. In Vercel (and `.env.local`) set `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and `RESEND_INBOUND_DOMAIN` (just the domain, e.g. `abc123.resend.app`), then redeploy.

## Organizing agent

Open the robot button in the top bar. Choose a provider (Anthropic, OpenAI, or xAI/Grok), paste an API key, and pick a model (the list comes from your key). The key is checked against the provider, encrypted with AES-256-GCM (`AGENT_ENCRYPTION_KEY`), and stored in `agent_settings`, a table the browser cannot read. Only the last four characters are ever shown again. Model usage is billed to your provider account.

The agent only works in workspaces where **Allow the agent to read and change notes** is on. That switch is per workspace and off by default; the migration turns it on for workspaces named Personal. Notes in an enabled workspace are sent to the chosen provider, so keep it off for workspaces that may hold patient or other regulated data unless your agreement with the provider covers it.

What it does:

- **New captures**: with "Triage Slack and email captures" on, each capture is triaged right after it arrives (bucket, clearer title, tags).
- **Organize workspace / Triage inbox**: runs in the background; the dialog shows progress, then the summary.
- **Instructions**: type a request ("Group the Q4 planning notes into a project and list next actions") and press Run.

Tools: list, read, update (title, bucket, tags, completion, append text), and create notes, all scoped on the server to one user and one workspace. It cannot delete notes or reach other workspaces, and is told to treat note content (emails, Slack messages) as data, never as instructions. A run stops after 16 model turns or 60 changes. Each change is stored in `agent_actions` with the values it replaced. **Undo** restores them, or removes a note the agent created. Logs record only run ids, never note content.

Provider adapters are in `lib/agent/providers.ts` (xAI uses the OpenAI-compatible format). The loop and tools are in `lib/agent/agent.ts`, and the database glue is in `lib/agent/server.ts`.

Setup:

1. Apply `supabase/migrations/20261010000000_agent.sql`.
2. Set `AGENT_ENCRYPTION_KEY` in Vercel and `.env.local` (`openssl rand -base64 32`). Changing it makes saved keys unreadable; users then re-enter them.
3. Background runs use `maxDuration = 300` on `/api/agent/runs` and 120 on the capture routes. That requires Vercel Fluid compute (the default for new projects). Runs that are cut off show as "Timed out".

## Jira dashboard

Open **Jira** in the left navigation. It uses the Jira connection saved under **Settings → Integrations** (no extra setup) and reads Jira live each time it loads, then every five minutes while the tab is visible. Issue summaries are shown in the browser, never stored in Orbit or sent to a model.

- **Assigned to you**: your open issues, in progress first, then by priority.
- **Coming up**: across the team's projects, issues that are overdue or due within two weeks, ready to ship (`Ready for Release`), not started in the current sprint, ready for development (`Ready for Development`), or planned for the next sprint. On a site without those two status names, those groups are left out.
- **Team activity**: issues whose status changed, that were resolved, or that are in progress and were updated in the last 7, 14 or 30 days (`?days=`), split into completed and in motion, with a filter per person (`?person=`).

"The team" is the projects of your open Jira assignments plus any project keys (such as `SPEC`, not names) on your scheduled debriefs. The route is `GET /api/jira/dashboard` (`lib/jira/dashboard.ts`); grouping lives in `lib/jira/view.ts`.

## Scheduled debriefs

Open **Settings** in the left navigation to manage account details, spaces, Slack and email capture, model provider, and separate Jira and GitHub connections. Jira needs a Cloud site, account email, and API token; GitHub needs a fine-grained token with **Contents: read** and **Pull requests: read** access to the selected repositories. Open **Scheduled jobs** in the left navigation to see configured jobs, running and completed runs, and the saved audit output for each run. The history loads in pages, refreshes while the screen is open, and each run's saved record can be downloaded as JSON. Use **Set up a job** to edit the prepared job: check the Jira project names/keys, add full `owner/repo` names, and turn it on. Job definitions have their own panel, separate from connection settings. You can create more debrief jobs, choose daily or weekdays, set a delivery hour and time zone, and run one immediately. Source tokens are encrypted using `AGENT_ENCRYPTION_KEY` and are never returned to the browser. Reports store issue keys, statuses, PR numbers, commit IDs, and links; issue summaries, PR titles, bodies, and commit messages are not copied into Orbit or sent to a model.

The dispatcher is separate from task definitions so new recurring task kinds can use the same schedule and run history. Vercel invokes 24 once-daily hourly slots in `vercel.json`; the server runs only tasks due in that hour. It starts a task two hours before its chosen delivery time to allow for Vercel's hourly timing window, and a unique database key prevents duplicate scheduled reports. A missed or failed run appears in the report history; **Run now** can retry it manually. GitHub commit activity covers the default branch, while PR activity includes open and closed PR updates. Jira activity includes issues updated during the previous local calendar day.

Setup:

1. Apply `supabase/migrations/20261011000000_scheduled_debriefs.sql` after the earlier migrations.
2. Set `CRON_SECRET` in Vercel and `.env.local`; keep the existing `AGENT_ENCRYPTION_KEY` and server-side Supabase key configured.
3. Deploy the `vercel.json` schedule. Vercel Cron uses UTC; the dispatcher translates each user's local time, including daylight saving changes. On Vercel Hobby, each job may start anywhere within its scheduled hour, so reports target availability by the selected hour rather than an exact minute.

## Validation

- `npm test`: account isolation, explicit legacy import and browser-note moves, duplicate handling, invalid-data preservation, Slack signature checks, message conversion, link tokens, Resend webhook signatures, email address parsing, email-to-note conversion, API key encryption, Anthropic and OpenAI/xAI request mapping, agent tool validation and loop, schedule timing across daylight saving changes, source validation, and report data minimization.
- `npm run build`: production compilation and type checking.
- `ORBIT_AUTH_INTEGRATION=1 node --env-file=.env.local tests/auth-smoke.mjs`: opt-in provider/server checks against a running local app. Set `ORBIT_TEST_URL` for a different origin. Requires a Supabase admin key and creates/removes one disposable test account; sends no emails. Checks anonymous access, invalid passwords, verified sessions, forged cookies, and sign-out.

## Deploy to Vercel

The project uses the Next.js App Router with no hosting-specific dependencies. Import this repository into Vercel, select the Next.js preset, and use the default build command (`npm run build`). The connected Supabase integration supplies the authentication environment variables. The production project is `orbit` in the `tmuhm14s-projects` Vercel workspace and is connected to `tmuhm14/orbit` on GitHub. Pushes to `main` deploy to production.

Official framework guidance: https://vercel.com/docs/frameworks/full-stack/nextjs

## Next milestones

1. **Shared note storage.** Done: notes live in Postgres with per-user row-level security. Next: live updates instead of polling, and conflict handling beyond last-write-wins.
2. **Cross-platform clients.** Share the note/bucket types and API contract with mobile and desktop clients. Add offline change queues, conflict resolution, and live updates before enabling concurrent editing.
3. **Inbound capture.** Slack is in place (`source`, `source_ref` for idempotency, `origin` for provenance). Email/SMS can follow the same pattern.
4. **Agent organization.** Done: a bring-your-own-key agent triages and organizes notes, with an audit trail and undo. Next: external actions (Slack replies, email, calendar, Jira) behind explicit approval.

The current `Note` model separates stable IDs, rich content, searchable plain text, bucket, tags, timestamps, completion, and capture source. Buckets and storage access are defined in `lib/notes.ts`, and `components/use-notes.ts` is the only place the workspace loads or saves notes (through `/api/notes`). Slack capture is in `lib/slack.ts` and `app/api/slack/interact`. Session checks live in `components/use-session-watch.ts`; the workspace, note editor, search, and weekly-review dialogs are separate components.
