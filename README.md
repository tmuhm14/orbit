# Orbit

Live app: [orbit-swart-mu.vercel.app](https://orbit-swart-mu.vercel.app)

A calm, space-inspired Getting Things Done workspace built with Next.js, React, TypeScript, and Tiptap. This first version focuses on capturing and organizing thoughts.

## Run locally

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
- Account-scoped local persistence, explicit legacy-note import, JSON export, and a GTD weekly-review guide.
- Responsive layouts, keyboard shortcuts, and reduced-motion support.

Keyboard shortcuts: Cmd/Ctrl+K searches, Cmd/Ctrl+J focuses quick capture. Enter captures; Shift+Enter adds a line. Notes save automatically.

## Data and limitations

Accounts are managed by Supabase Auth. The server verifies the user before rendering the workspace, and uses HTTP-only cookies (Secure in production, SameSite=Lax). Authenticated responses are not cached. Supabase handles password hashing and authentication rate limits.

Notes still use browser localStorage under `orbit.notes.v1:<user UUID>`. They are separated by account in the application, but are **not encrypted or synchronized**. Anyone with access to the browser profile or developer tools can access locally stored notes. Use separate browser profiles on shared devices. Cloud persistence with row-level authorization is the next milestone.

Existing anonymous notes under `orbit.notes.v1` are preserved. After sign-in, use **Import my notes** to claim them for that account; they are never automatically assigned. The original source remains intact as a backup. New accounts start with an empty workspace.

Clearing browser data removes local notes. Export your notes for a JSON copy; importing exported backups is not implemented. Multiple tabs editing the same account do not resolve concurrent changes. Sign-out/account changes in another tab are checked via an auth event, on focus, and every minute.

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

The application uses only the publishable key. Supabase admin/service-role credentials are never imported by the application or sent to browsers. The optional integration test uses an admin key only to create and remove its own disposable test account.

## Validation

- `npm test`: account isolation, explicit legacy import, duplicate handling, and invalid-data preservation.
- `npm run build`: production compilation and type checking.
- `ORBIT_AUTH_INTEGRATION=1 node --env-file=.env.local tests/auth-smoke.mjs`: opt-in provider/server checks against a running local app. Set `ORBIT_TEST_URL` for a different origin. Requires a Supabase admin key and creates/removes one disposable test account; sends no emails. Checks anonymous access, invalid passwords, verified sessions, forged cookies, and sign-out.

## Deploy to Vercel

The project uses the Next.js App Router with no hosting-specific dependencies. Import this repository into Vercel, select the Next.js preset, and use the default build command (`npm run build`). The connected Supabase integration supplies the authentication environment variables. The production project is `orbit` in the `tmuhm14s-projects` Vercel workspace and is connected to `tmuhm14/orbit` on GitHub. Pushes to `main` deploy to production.

Official framework guidance: https://vercel.com/docs/frameworks/full-stack/nextjs

## Next milestones

1. **Shared note storage.** Accounts are in place. Add PostgreSQL note persistence with per-user row-level security and authenticated API operations, then migrate account-scoped browser notes. Keep UUIDs and versioned Tiptap JSON to preserve existing notes.
2. **Cross-platform clients.** Share the note/bucket types and API contract with mobile and desktop clients. Add offline change queues, conflict resolution, and live updates before enabling concurrent editing.
3. **Inbound capture.** Accept verified email/SMS/webhook events through authenticated server routes; track source IDs for idempotency and preserve the original input.
4. **Agent organization.** Have an agent propose formatting, tags, and a bucket, with confidence, provenance, and an audit trail. Introduce user-approved external actions separately.

The current `Note` model separates stable IDs, rich content, searchable plain text, bucket, tags, timestamps, completion, and capture source. Buckets and storage access are defined in `lib/notes.ts`; workspace behavior and note editing are separate components.
