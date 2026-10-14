# Orbit implementation plan

Date: October 13, 2026
Status: proposed implementation sequence; no production changes made

## Product outcome

Orbit is the place to capture information, organize it into meaningful work, delegate it, and keep the resulting knowledge. Preserve quick capture, existing notes, workspace separation, and the playful space identity.

First release demonstration: capture a message → clarify it into a task → link it to a project → delegate preparation of an outcome → see progress or answer a question → review the result → save the result as linked documentation. Sending anything back to an external system is a later, explicitly authorized action.

## Scope and assumptions

- Evolve the existing Next.js, Supabase, Tiptap, and provider-adapter implementation. Do not rewrite the app or replace its storage system.
- Start with single-user workspaces. Person names on follow-ups are descriptive metadata, not shared access or team membership.
- Keep the current GTD buckets as organizational views. Add item kind independently from bucket.
- Support the built-in agent first, then external agents through documented contracts. Do not promise compatibility with a named bot until its authentication and tool capabilities are tested.
- No paid infrastructure selection, new connector permissions, production migrations, deployment, or external messages are implied by this planning document.
- Voice capture, offline clients, collaborative editing, and broad autonomous monitoring follow the first useful delegation release.

## Experience

| Destination | Purpose | First implementation |
| --- | --- | --- |
| Home | What deserves attention now | Capture, Inbox count, due tasks, next actions, waiting items; add live assignments when available |
| Inbox | Clarify incoming information | Preserve source, choose kind, connect to project, file or delegate |
| Tasks | Work and follow-ups | Next actions, due dates, waiting and completed filters |
| Projects | Outcomes and related work | Project detail with linked tasks, notes, documents and assignments |
| Library | Knowledge worth retaining | Notes/documents, tags, source links, full-page reading and editing |
| Agents | Work delegated and results | Assignments, questions, review queue, run history, recurring work |

Connections and model credentials belong in Settings. Existing scheduled debriefs remain available throughout navigation changes. Home must never display invented progress or empty fake agent cards.

## Foundation contracts

These are proposed design decisions to capture in draft ADRs before implementation of dependent features. Tony approves ADRs before merge, per repository standards.

### Items and relationships

- Retain the `notes` table and stable IDs initially; extend it additively. Avoid a simultaneous physical table rename and client/API rewrite.
- Add `kind`: note, task, project, document, followup. Existing rows default to note; suggest conversions based on buckets rather than silently reclassifying all existing data.
- Preserve `bucket`, source provenance, rich content, tags, completion and calendar `due_date`.
- Link items to a project with same-user/same-workspace enforcement. Reject invalid project targets, self-links and invalid relationship changes. Define unlink/archive behavior before supporting deletion or cross-workspace moves.
- Follow-ups add who/what is expected and a next check date. Timed reminders use a separate timestamp and timezone contract; calendar due dates stay date-only.
- Add a server-managed revision. Updates and deletes require the expected revision. Return a conflict response and retain the user's unsaved draft on mismatch.
- Agent mutation and audit history are one database transaction. Undo verifies the current revision and affected values; never overwrite subsequent human edits or delete an edited agent-created item silently.
- Every browser, capture, agent, scheduled report, import, and external API writer participates in the new contract. Define rollout for old clients before enforcing new preconditions.

### Assignments and execution

- Add an assignment domain separate from existing organizing runs. One assignment references its source task, workspace, requested outcome, context items, executor and allowed capabilities.
- Assignment states: queued, running, needs_input, needs_review, completed, failed, canceled. An approved transition table governs all changes.
- Separate execution attempts and append-only events from assignment state. Store artifacts/result references and review decisions.
- Preparing a result does not complete the original task automatically. The user can accept, request changes or reject a result.
- First executor prepares a draft or summary using explicitly selected Orbit context. It does not gain external write access.
- Introduce durable execution before external side effects or long-lived work: persisted steps, leased claims, heartbeats, retries, cancellation, idempotency and recovery after process loss.
- Treat captured material as untrusted content. Only user-authored assignment instructions grant intent; server checks enforce capabilities independently of model output.
- Normalize provider errors before displaying or recording them. Access configuration through a typed server module and never log note bodies, model outputs, secrets or raw connector payloads.

### Connections and external agents

- Split grants into workspace read, item write, assignment execution, external read, and specific external write actions. Keep revocation server-enforced.
- Expand the existing HTTP/MCP surface after version and assignment semantics stabilize. External agents need claim/progress/question/result operations, idempotent capture, scoped authorization and a tested refresh/revocation story.
- Use adapters for provider-specific integration code. Start with Slack context retrieval, then one email provider, then Teams; do not treat forwarded-email capture as mailbox access.
- Outbound actions require a stored, reviewable payload, destination and authorization. Editing the payload invalidates an earlier approval. Reconcile ambiguous sends before retrying.
- Do not copy regulated content to a model or connector by default. Apply the repository's PHI handling rules, minimum necessary access, and access auditing. Existing encryption alone is not a compliance determination.

## Delivery waves and tickets

### Wave 0 — contracts and coordination

| ID | Work | Owner | Depends on | Done when |
| --- | --- | --- | --- | --- |
| O-01 | Draft ADRs for item evolution, conflict handling, assignments, capability grants and runtime boundary | Lead | — | State transitions, error contracts, migration sequence and unresolved choices are explicit |
| O-02 | Extract shared shell, navigation, capture and current Home into focused components without behavior changes | Experience | — | Existing routes, capture shortcuts, dialogs, workspace switching and scheduled jobs still work |
| O-03 | Establish verification baseline and identify missing isolation/concurrency tests | Lead | — | Existing tests and typecheck results recorded; test convention resolved without unrelated rewrite |

Wave 0 is the first agent dispatch. O-01 drafts can be reviewed while O-02 and O-03 proceed. Do not let multiple agents edit the shared shell or global stylesheet.

### Wave 1 — dependable items and useful daily views

| ID | Work | Owner | Depends on | Done when |
| --- | --- | --- | --- | --- |
| D-01 | Add revisioned mutations, conflict responses, atomic agent audit and safe undo | Data | O-01 | Two simultaneous writers cannot silently overwrite each other; undo detects intervening changes |
| D-02 | Add kinds and validated project links; update serialization, validation, capture and export | Data | D-01 | Legacy items remain readable and unchanged; invalid cross-workspace links fail |
| D-03 | Add follow-up metadata and separate reminder contract | Data | D-02 | Waiting person/reason/check date persist; timezone behavior is specified and tested |
| U-01 | Home focused on capture, needs attention, due/next/waiting items | Experience | O-02 | Uses real current data; empty/loading/error states work; category grid no longer dominates |
| U-02 | Add kind selection, project linking and follow-up properties to item editor | Experience | D-02, D-03, O-02 | Existing editing/autosave survives; conflicts retain drafts and offer recovery |
| U-03 | Tasks, project detail and Library views with full-page document editing | Experience | U-02 | Linked work is navigable; filters are useful; browser back/forward and direct links work |

Release gate: existing Slack/email capture, scheduled reports and exports work with the new model. Test migration on representative synthetic legacy data before production deployment.

### Wave 2 — complete one delegation workflow

| ID | Work | Owner | Depends on | Done when |
| --- | --- | --- | --- | --- |
| A-01 | Assignment schema, transition validation and authenticated APIs | Agents | O-01, D-02 | Invalid transitions and cross-account/context access are rejected |
| A-02 | Built-in preparation executor with selected context and result artifacts | Agents | A-01, D-01 | A task produces a linked draft/summary; failure and budget exhaustion are visible |
| U-04 | Delegate panel and assignment detail | Experience | A-01, U-02 | User sets outcome/context, sees progress, answers questions and cancels |
| U-05 | Agents page, review queue and Home assignment summaries | Experience | A-02, U-04 | Accept/request changes/reject work; accepted result links back to project; task completion stays explicit |
| A-03 | End-to-end slice verification | Lead | A-02, U-05 | Capture → project → delegate → review → result succeeds with mocked providers, including failure paths |

Release gate: demonstrate this workflow with synthetic data. A browser refresh must preserve assignment state and results. A timed-out execution must surface failure rather than appear to work forever.

### Wave 3 — durable work and external agents

| ID | Work | Owner | Depends on | Done when |
| --- | --- | --- | --- | --- |
| A-04 | Durable worker/queue adapter, claim leases and persisted steps | Agents | A-03; runtime ADR | Restart, expired lease, duplicate delivery, retry and cancellation scenarios pass |
| A-05 | Scoped grants and external-agent authentication lifecycle | Agents | A-01; auth ADR | Per-agent grants can be revoked; access checks apply on each operation; credentials are never logged |
| A-06 | Assignment HTTP/MCP operations and idempotent capture | Agents | A-04, A-05 | External executor can claim, report, ask and submit a result; duplicate calls do not duplicate work |
| D-04 | Reminder dispatch and recurring task instances | Data | D-03, A-04 | One logical occurrence per schedule; snooze/cancel, timezones, DST and retries behave correctly |

Runtime choice is open until hosting limits and operating cost are verified. Do not introduce a workflow vendor as an incidental dependency. Durable processing uses at-least-once delivery with idempotent/reconciled effects, not a blanket exactly-once promise.

### Wave 4 — integrated context and approved external actions

| ID | Work | Owner | Depends on | Done when |
| --- | --- | --- | --- | --- |
| I-01 | Connector adapter contract and connection health UI | Integrations | A-05 | Scopes, expiry, revocation and actionable failures are visible |
| I-02 | Slack thread context retrieval with source links | Integrations | I-01 | Authorized surrounding context resolves short captures; inaccessible threads fail safely |
| I-03 | One mailbox provider: read selected thread and prepare reply | Integrations | I-01 | Mailbox access is separate from inbound forwarding; draft retains recipients and context |
| I-04 | Teams capture and authorized conversation context | Integrations | I-01 | Capture preserves provenance and duplicate delivery is safe |
| I-05 | Reviewed outbound Slack/email/Teams actions | Integrations | A-04, I-02/I-03/I-04 as applicable | Exact destination and payload are reviewed; approval cannot be replayed for changed content; ambiguous delivery is reconciled |

Jira write actions, calendar scheduling and additional connector capabilities follow this same adapter and approval pattern. Choose Microsoft 365 vs Gmail for the first mailbox integration before I-03; this does not block earlier waves.

### Wave 5 — knowledge and personality

| ID | Work | Owner | Depends on | Done when |
| --- | --- | --- | --- | --- |
| K-01 | Document versions, backlinks and better retrieval | Data + Experience, split by contract | U-03, D-01 | Revision restore is conflict-safe; search respects workspace boundaries; sources are attributable |
| K-02 | Scoped agent memory and event-triggered follow-ups | Agents | A-04, A-05, I-01 | User can inspect, correct and remove stored memory; triggers have dedupe and budgets |
| P-01 | Motion tokens, capture feedback and project completion celebration | Experience | O-02; completion event for celebration | Motion conveys real events, reduced-motion is respected, repeated background events do not celebrate |
| P-02 | Optional companion states and workspace personalization | Experience | U-05 | State reflects actual agent work; can be disabled; keyboard and screen reader use remain clear |
| K-03 | Attachment ingestion and optional voice capture | Later scoped project | I-01, storage/access ADR | Retention, file validation, accessible fallback and processing consent are designed before launch |

P-01 can begin during Wave 1 after the shared shell is extracted; personality does not have to wait for all integrations.

## Agent coordination and file ownership

Maximum initial team: lead plus three implementation agents. Rotate the integrations role in after foundations stabilize.

- **Lead:** contracts, ADRs, API documentation, integration of work, shared package/config changes and final verification. Assign each migration filename and sequence before agents write migrations.
- **Data agent:** `lib/notes.ts`, `lib/notes-db.ts`, `components/use-notes.ts`, note APIs, assigned data migrations, co-located tests. Coordinate shared agent-write contract with Agents before either edits it.
- **Experience agent:** exclusive ownership of `components/workspace.tsx`, navigation, shared editor integration and `app/globals.css`; new view components should use isolated styles where practical.
- **Agents agent:** `lib/agent/`, new assignment domain/routes, assigned assignment migrations, execution tests. External API/MCP work follows the accepted contracts.
- **Integrations agent, later:** connector adapters and assigned routes/tests; no changes to central authentication or shared UI without lead coordination.

One writer per file. Use isolated branches/worktrees for implementation agents, with small dependency-ordered PRs into an integration branch or sequentially merged PRs. Do not have concurrent agents switch branches in the shared checkout. Read applicable AGENTS instructions and bundled Next.js guides before code changes. Follow repository branch/commit rules; no commits to main.

Each agent handoff reports: ticket, dependencies consumed, files changed, behavior delivered, migration order, tests run, limitations and downstream contract changes. Stubbed UI must be labeled in development and cannot ship as a working feature.

## Verification and rollout

- Baseline and final checks: `npm test`, `npm run typecheck`, and `npm run build` for release candidates. Record actual results; do not infer passing checks.
- Existing suite uses Node's test runner while global guidance specifies Vitest/RTL. Preserve existing coverage; lead resolves the convention for new tests before adding tooling. Do not spend the product milestone on a wholesale test migration.
- The package currently has no lint script despite the global merge checklist requiring lint. O-03 must establish the intended lint check and document its result before a release is considered merge-ready.
- Business tests cover validation, permissions, state transitions, conflicts, undo, duplicate capture, worker retries and reminder schedules. Mock external systems and models.
- Database integration tests verify RLS, composite ownership constraints, atomic history, expected revisions and migration compatibility using disposable local/test data.
- UI checks cover desktop and narrow screens, keyboard capture/search/editor flows, focus management, loading/errors/empty states, contrast and reduced motion. Use synthetic content for screenshots and fixtures.
- Apply additive schema changes before dependent code. Gate new features until the migration is verified. Keep old reads functional through the rollout; reject stale legacy writes rather than silently accepting overwrites once revision enforcement activates.
- Roll back code/feature flags without dropping newly captured data. Reconcile queued/running jobs before worker rollback. Do not use destructive down-migrations as the default recovery path.
- Release notes include the demonstrated user workflow, known limits, required configuration and manual checks. Production changes are separate from local implementation.

## First implementation dispatch

1. Lead freezes the item revision and assignment interface drafts (O-01) and records baseline checks (O-03).
2. Experience agent extracts shell/Home boundaries (O-02), then delivers U-01 using existing data.
3. Data agent delivers D-01 once the revision contract is settled; all affected writers and undo paths are included.
4. Agents agent specifies A-01 against the frozen item contract, then implements it after D-02. While waiting, isolate existing agent persistence behind a store boundary only where required by D-01.
5. Integrate and verify before dispatching the next wave. Update ticket status in this file with evidence; all tickets above are currently planned.

Success is the completed user workflow, not the number of agents or components produced.

## Ticket status

### O-03 — verification baseline (done, October 13, 2026, on `main` @ d15e3a1)

- `npm run typecheck`: passes (exit 0).
- `npm test`: 41 tests, 41 pass, 0 fail (Node test runner). Non-blocking warning: `MODULE_TYPELESS_PACKAGE_JSON` for `.ts` imports; do not add `"type": "module"` without verifying Next build.
- `npm run build`: not run for baseline; needs real Supabase env. Run for release candidates.
- Lint: no lint tool or script installed (no eslint/biome/oxlint, no config). **Open decision for lead:** adopt `eslint` + `eslint-config-next` (confirm against `node_modules/next/dist/docs/` first) as a separate `chore/` PR before Wave 1 merges. Until then, the merge checklist's lint item is unmet.
- Test convention: keep Node's built-in runner for logic tests already in `tests/` and co-located `lib/**/*.test.mjs`; place new tests co-located with source. Vitest + RTL is deferred until UI component tests are needed (U-02).
- Missing coverage relevant to Wave 1/2:
  - No concurrent-writer / stale-update tests (no revision or conflict handling exists in `lib/notes-db.ts` or note APIs).
  - No agent-mutation atomicity or undo tests (in `lib/agent/server.ts` the `agent_actions` insert and the `notes` update/insert are separate calls, not one transaction).
  - No DB-level RLS / composite ownership tests against a disposable Supabase instance; isolation is tested only with in-memory fakes (localStorage, route doubles).
  - No duplicate-capture idempotency tests across Slack/email retries beyond stable source refs.
  - No UI tests for capture shortcuts, dialogs or workspace switching; O-02 relies on typecheck plus manual/browser verification.

### O-02 — shell extraction (implemented, awaiting smoke test)

- Branch `refactor/extract-workspace-shell` @ d2a685b; `components/workspace.tsx` 1054 → 310 lines, 10 new components; `globals.css` untouched.
- typecheck pass; tests 41/41; `npm run build` succeeds without secrets.
- Not yet verified in a signed-in browser session (capture, dialogs, drag-and-drop, workspace switching, Settings/Scheduled ↔ Home). Required before merge.

### O-01 — foundation ADRs (drafted, awaiting Tony's approval)

- Branch `docs/foundation-adrs` @ af65546: `docs/adr/template.md`, 001 item evolution, 002 revisions/conflicts, 003 assignments, 004 capability grants, 005 runtime boundary.
- Proposed migrations: 20261014000000_note_revisions, 20261014000100_note_write_functions (D-01); 20261015000000_note_kinds_and_project_links (D-02); 20261016000000_note_followups_and_reminders (D-03); 20261017000000_assignments (A-01); 20261021000000_note_write_enforcement (D-01 phase C′, after rollout gate).
- D-01 and A-01 are blocked on ADR approval and the open questions listed in each ADR.
