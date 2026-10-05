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
- Multiple workspaces (e.g. Personal and Waltz) under one login: switch from the colored pill in the top bar or the sidebar card. Each workspace has its own color (chosen in the switcher). Each has its own buckets, notes, tags, and search, and a note can be moved between workspaces from the editor.
- Email capture: each workspace has a private address; forwarded emails land in its Inbox.
- "Send to Orbit" Slack message shortcut that drops messages into the Inbox of the workspace that Slack is linked to.
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

## Settings and administration

- **Settings** (`/settings`, every user, linked from the sidebar): rename, recolor, reorder, add, and delete workspaces (deleting requires typing the name and removes that workspace's notes; the last workspace can't be deleted); copy or replace each workspace's email address; re-route or disconnect Slack; change password (requires the current one); export all notes.
- **Administration** (`/admin`, owner only): system health (which integrations are configured), all users with their workspaces, note counts by source, and pending triage; create accounts with a temporary password (sign-up is closed while account email is off), set a user's password, disable or re-enable accounts; integration URLs to paste into Slack and Resend; and the last 50 Slack/email capture outcomes, including failures, from `integration_events`.

Access to `/admin` comes from `ORBIT_ADMIN_EMAILS` (comma-separated). Everyone else gets a 404, and every admin action checks again on the server. Admin reads and writes use the server-only Supabase secret key. Secrets are never shown in the UI; change them in Vercel.

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

## Validation

- `npm test`: account isolation, explicit legacy import and browser-note moves, duplicate handling, invalid-data preservation, Slack signature checks, message conversion, link tokens, Resend webhook signatures, email address parsing, and email-to-note conversion.
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
