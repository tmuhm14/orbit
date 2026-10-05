# Orbit

Live app: [orbit-swart-mu.vercel.app](https://orbit-swart-mu.vercel.app)

A calm, space-inspired Getting Things Done workspace built with Next.js, React, TypeScript, and Tiptap. This first version focuses on capturing and organizing thoughts.

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
- "Send to Orbit" Slack message shortcut that drops messages into the Inbox.
- Responsive layouts, keyboard shortcuts, and reduced-motion support.

Keyboard shortcuts: Cmd/Ctrl+K searches, Cmd/Ctrl+J focuses quick capture. Enter captures; Shift+Enter adds a line. Notes save automatically.

## Data and limitations

Accounts are managed by Supabase Auth. The server verifies the user before rendering the workspace, and uses HTTP-only cookies (Secure in production, SameSite=Lax). Authenticated responses are not cached. Supabase handles password hashing and authentication rate limits.

Notes are stored in the Supabase `notes` table with row-level security: each signed-in user can read and write only their own rows. The browser talks to `/api/notes`, which uses the signed-in session (never an admin key). Edits save in batches about a second after typing stops, and the list refreshes on focus and every 30 seconds so notes captured elsewhere (Slack) appear.

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

The first time, Orbit replies (visible only to you) with a link to connect your Slack account. Open it in a browser where you are signed in to Orbit and confirm. The link is signed and expires after 15 minutes. Only the server can create Slack links, so no one can claim someone else's Slack account.

Setup:

1. Apply `supabase/migrations/20261005000000_notes_and_slack.sql` to the Supabase project (SQL editor, or `supabase db push`).
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

## Validation

- `npm test`: account isolation, explicit legacy import and browser-note moves, duplicate handling, invalid-data preservation, Slack signature checks, message conversion, and link tokens.
- `npm run build`: production compilation and type checking.
- `ORBIT_AUTH_INTEGRATION=1 node --env-file=.env.local tests/auth-smoke.mjs`: opt-in provider/server checks against a running local app. Set `ORBIT_TEST_URL` for a different origin. Requires a Supabase admin key and creates/removes one disposable test account; sends no emails. Checks anonymous access, invalid passwords, verified sessions, forged cookies, and sign-out.

## Deploy to Vercel

The project uses the Next.js App Router with no hosting-specific dependencies. Import this repository into Vercel, select the Next.js preset, and use the default build command (`npm run build`). The connected Supabase integration supplies the authentication environment variables. The production project is `orbit` in the `tmuhm14s-projects` Vercel workspace and is connected to `tmuhm14/orbit` on GitHub. Pushes to `main` deploy to production.

Official framework guidance: https://vercel.com/docs/frameworks/full-stack/nextjs

## Next milestones

1. **Shared note storage.** Done: notes live in Postgres with per-user row-level security. Next: live updates instead of polling, and conflict handling beyond last-write-wins.
2. **Cross-platform clients.** Share the note/bucket types and API contract with mobile and desktop clients. Add offline change queues, conflict resolution, and live updates before enabling concurrent editing.
3. **Inbound capture.** Slack is in place (`source`, `source_ref` for idempotency, `origin` for provenance). Email/SMS can follow the same pattern.
4. **Agent organization.** Have an agent propose formatting, tags, and a bucket, with confidence, provenance, and an audit trail. Introduce user-approved external actions separately.

The current `Note` model separates stable IDs, rich content, searchable plain text, bucket, tags, timestamps, completion, and capture source. Buckets and storage access are defined in `lib/notes.ts`, and `components/use-notes.ts` is the only place the workspace loads or saves notes (through `/api/notes`). Slack capture is in `lib/slack.ts` and `app/api/slack/interact`. Session checks live in `components/use-session-watch.ts`; the workspace, note editor, search, and weekly-review dialogs are separate components.
