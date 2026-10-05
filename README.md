# Orbit

A calm, space-inspired Getting Things Done workspace built with Next.js, React, TypeScript, and Tiptap. This first version focuses on capturing and organizing thoughts.

## Run locally

```sh
npm install
npm run dev
```

Open http://localhost:3000. Use `npm run build` for a production build, `npm start` to serve it, and `npm run typecheck` for TypeScript validation.

## Included

- Quick capture into any of six GTD buckets: Inbox, Next actions, Projects, Waiting for, Someday / maybe, and Reference.
- Editable rich-text notes with headings, lists, checklists, quotes, code blocks, and dividers.
- Slash commands: type `/` in the note body, filter by name, and use arrow keys and Enter or click a command.
- Tags, workspace-wide search, tag filters, sorting, list/grid views, completion and reopening, and confirmed deletion.
- Local persistence, JSON export, sample notes on first use, and a GTD weekly-review guide.
- Responsive layouts, keyboard shortcuts, and reduced-motion support.

Keyboard shortcuts: Cmd/Ctrl+K searches, Cmd/Ctrl+J focuses quick capture. Enter captures; Shift+Enter adds a line. Notes save automatically.

## Data and limitations

This milestone uses browser localStorage under `orbit.notes.v1`. Data remains on the current browser/device and is not synchronized. Clearing browser data removes these notes; use Export your notes for a JSON copy. An unreadable store is preserved and editing is blocked instead of overwriting existing data. Storage failures show a warning and an export action. Export is a backup/download feature; importing a backup is not implemented yet.

The initial notes are editable examples, identified by `welcome-` IDs. They are created only when storage is absent, never when the user has emptied their workspace.

There is no account system or shared database yet. Do not treat this release as a multi-device or multi-user service. Multiple open tabs do not synchronize and should not be edited concurrently.

## Deploy to Vercel

The project uses the Next.js App Router with no hosting-specific dependencies. Import this repository into Vercel, select the Next.js preset, and use the default build command (`npm run build`). No environment variables are needed for this local-storage version. Deployment has not been performed by this project setup.

Official framework guidance: https://vercel.com/docs/frameworks/full-stack/nextjs

## Next milestones

1. **Shared storage and accounts.** Introduce authenticated ownership and a managed PostgreSQL database. Replace the `noteRepository` adapter in `lib/notes.ts` with authenticated API operations, and explicitly migrate browser notes after sign-in. Keep UUIDs and versioned Tiptap JSON to preserve existing notes.
2. **Cross-platform clients.** Share the note/bucket types and API contract with mobile and desktop clients. Add offline change queues, conflict resolution, and live updates before enabling concurrent editing.
3. **Inbound capture.** Accept verified email/SMS/webhook events through authenticated server routes; track source IDs for idempotency and preserve the original input.
4. **Agent organization.** Have an agent propose formatting, tags, and a bucket, with confidence, provenance, and an audit trail. Introduce user-approved external actions separately.

The current `Note` model separates stable IDs, rich content, searchable plain text, bucket, tags, timestamps, completion, and capture source. Buckets and storage access are defined in `lib/notes.ts`; workspace behavior and note editing are separate components.
