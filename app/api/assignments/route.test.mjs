import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as transitions from "../../../lib/assignments/transitions.ts";
import * as notesModule from "../../../lib/notes.ts";
import { loadTs } from "../../../tests/load-ts.mjs";

// Assignment routes with doubles for the Supabase client. The real
// routeUser() runs (sign-in and the same-origin check on mutations), with
// only its client and config replaced. The rpc double returns what the SQL
// functions return; the functions themselves are exercised against Postgres
// in supabase/tests/assignments.test.mjs.
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const WS = "12345678-1234-4234-8234-123456789abc";
const NOTE = "11111111-1111-4111-8111-111111111111";
const CTX = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const ART = "44444444-4444-4444-8444-444444444444";
const QID = "55555555-5555-4555-8555-555555555555";
const SECRET_TEXT = "Ask the vendor about invoice 4471";
const ORIGIN = "http://localhost";

const row = (patch = {}) => ({
  id: ID, workspace_id: WS, source_note_id: NOTE, requested_outcome: SECRET_TEXT, executor_kind: "builtin",
  capabilities: ["assignment.execute", "workspace.read"], state: "queued", revision: 1, current_attempt_id: null,
  max_attempts: 1, error_code: null, created_at: "2026-10-14T00:00:00+00:00", updated_at: "2026-10-14T00:00:00+00:00",
  state_changed_at: "2026-10-14T00:00:00+00:00", finished_at: null, ...patch,
});

let calls, rpcResult, signedIn, tables;
beforeEach(() => {
  calls = [];
  rpcResult = () => ({ data: { status: "created", assignment: row() }, error: null });
  signedIn = true;
  tables = {
    workspaces: [{ id: WS }],
    assignments: [row(), row({ id: "66666666-6666-4666-8666-666666666666", workspace_id: "99999999-9999-4999-8999-999999999999" })],
    assignment_context_items: [{ assignment_id: ID, note_id: CTX, position: 1, revision_at_selection: 3, content_role: "untrusted_data" }],
    assignment_attempts: [{ assignment_id: ID, id: "77777777-7777-4777-8777-777777777777", attempt_number: 1, status: "waiting",
      lease_expires_at: "2026-10-14T00:01:30+00:00", heartbeat_at: "2026-10-14T00:00:00+00:00", provider: null, model: null,
      error_code: null, started_at: "2026-10-14T00:00:00+00:00", finished_at: "2026-10-14T00:00:10+00:00" }],
    assignment_events: [{ assignment_id: ID, id: 9, attempt_id: null, type: "state_changed", actor: "user", from_state: null,
      to_state: "queued", payload: { revision: 1 }, created_at: "2026-10-14T00:00:00+00:00" }],
    assignment_questions: [{ assignment_id: ID, id: QID, attempt_id: "77777777-7777-4777-8777-777777777777", prompt: "Which tone?",
      answer: null, asked_at: "2026-10-14T00:00:05+00:00", answered_at: null, closed_at: null }],
    assignment_artifacts: [],
    assignment_reviews: [],
  };
});

function from(table) {
  const filters = [];
  const builder = {
    select: (columns) => (calls.push(["select", table, columns]), builder),
    eq: (column, value) => (filters.push((r) => column === "user_id" || r[column] === value), builder),
    in: (column, values) => (calls.push(["in", table, column, values]), filters.push((r) => values.includes(r[column])), builder),
    not: (column, op, value) => (calls.push(["not", table, column, op, value]),
      filters.push((r) => (op === "is" && value === null ? r[column] != null : true)), builder),
    order: () => builder,
    limit: () => builder,
    returns: async () => ({ data: tables[table].filter((r) => filters.every((f) => f(r))), error: null }),
    maybeSingle: async () => ({ data: tables[table].find((r) => filters.every((f) => f(r))) ?? null, error: null }),
  };
  return builder;
}
const supabase = {
  from,
  rpc: async (name, args) => {
    calls.push(["rpc", name, args]);
    return name === "reap_own_assignment_leases" ? { data: { timedOut: 0, unavailable: 0 }, error: null } : rpcResult(name, args);
  },
  auth: { getUser: async () => ({ data: { user: signedIn ? { id: USER } : null } }) },
};

const routeAuth = loadTs(new URL("../../../lib/supabase/route-auth.ts", import.meta.url), {
  "./server": { createClient: async () => supabase },
  "./config": { authConfig: () => ({ url: "http://supabase.test", key: "k" }) },
});
const server = loadTs(new URL("../../../lib/assignments/server.ts", import.meta.url), {
  "@/lib/supabase/route-auth": routeAuth,
});
const validation = loadTs(new URL("../../../lib/assignments/validation.ts", import.meta.url), { "./transitions": transitions });
// The built-in executor's kickoff (A-02, A-04): the enqueue and the run are
// doubles that record ids; after() callbacks are collected. The real
// queuedBuiltinAssignment() decides what to enqueue.
let scheduled, enqueued, afterCallbacks;
beforeEach(() => {
  scheduled = [];
  enqueued = [];
  afterCallbacks = [];
});
const executorServer = loadTs(new URL("../../../lib/assignments/executor-server.ts", import.meta.url), {
  "@/lib/supabase/admin": { createAdminClient: () => null },
  "@/lib/agent/server": { loadAgentSettings: async () => null },
  "@/lib/agent/providers": { createProvider: () => null },
  "@/lib/runtime/postgres": { postgresJobQueue: () => null },
  "@/lib/runtime/worker": { runJobNow: async () => "not_claimed", workerId: () => "w" },
  "./executor": { EXECUTOR_MIN_START_MS: 60_000, EXECUTOR_WALL_CLOCK_MS: 240_000, executeAssignment: async () => ({ outcome: "skipped" }),
    materialFromRows: () => null, previousArtifactId: () => null },
});
// U-05: save-document and availability. The real fromRow() maps the note.
const notesDb = loadTs(new URL("../../../lib/notes-db.ts", import.meta.url), { "./notes": notesModule });
const documents = loadTs(new URL("../../../lib/assignments/documents.ts", import.meta.url), {
  "@/lib/supabase/route-auth": routeAuth,
  "@/lib/notes-db": notesDb,
  "./server": server,
});
let adminClient, agentSettings;
beforeEach(() => {
  adminClient = { admin: true };
  agentSettings = async () => ({ provider: "anthropic", model: "m", keyHint: "wxyz", autoTriage: true, apiKey: "sk-secret-key-wxyz" });
});
const imports = {
  "@/lib/assignments/documents": documents,
  "@/lib/supabase/admin": { createAdminClient: () => adminClient },
  "@/lib/agent/server": { loadAgentSettings: (...args) => (calls.push(["settings", ...args]), agentSettings(...args)) },
  "next/server": { after: (callback) => afterCallbacks.push(callback) },
  "@/lib/supabase/route-auth": routeAuth,
  "@/lib/assignments/server": server,
  "@/lib/assignments/validation": validation,
  "@/lib/assignments/executor-server": {
    ...executorServer,
    enqueueAssignmentRun: async (a) => (enqueued.push([a.id, a.revision]), `job-${a.revision}`),
    kickoffAssignmentRun: async (a, jobId, options) => (scheduled.push([a.id, jobId, typeof options.deadlineAt]), "completed"),
  },
};
const runAfter = async () => {
  for (const callback of afterCallbacks.splice(0)) await callback();
};
const load = (path) => loadTs(new URL(path, import.meta.url), imports);
const collection = load("./route.ts");
const detail = load("./[id]/route.ts");
const actions = {
  cancel: load("./[id]/cancel/route.ts"),
  retry: load("./[id]/retry/route.ts"),
  answer: load("./[id]/answer/route.ts"),
  review: load("./[id]/review/route.ts"),
};
const kickoff = load("./kickoff/route.ts");
const saveDocument = load("./[id]/save-document/route.ts");
const availability = load("./availability/route.ts");

const headers = (origin = ORIGIN) => ({ host: "localhost", ...(origin ? { origin } : {}) });
async function send(handler, url, { method = "POST", body, origin, id, raw } = {}) {
  const init = { method, headers: headers(origin) };
  if (body !== undefined || raw !== undefined) init.body = raw ?? JSON.stringify(body);
  const response = await handler(new Request(`http://localhost${url}`, init), id ? { params: Promise.resolve({ id }) } : undefined);
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const create = (body, options) => send(collection.POST, "/api/assignments", { body, ...options });
const act = (action, body, options = {}) =>
  send(actions[action].POST, `/api/assignments/${options.id ?? ID}/${action}`, { body, id: options.id ?? ID, ...options });
const rpcCalls = () => calls.filter((c) => c[0] === "rpc" && c[1] !== "reap_own_assignment_leases");
const validCreate = { workspaceId: WS, sourceNoteId: NOTE, requestedOutcome: `  ${SECRET_TEXT}  `, contextNoteIds: [CTX] };

// --- Create ---------------------------------------------------------------------

test("create: calls create_assignment with the parsed body and returns 201", async () => {
  const r = await create(validCreate);
  assert.equal(r.status, 201);
  assert.deepEqual(rpcCalls(), [["rpc", "create_assignment", {
    p_workspace_id: WS, p_source_note_id: NOTE, p_requested_outcome: SECRET_TEXT, p_context_note_ids: [CTX],
    p_executor_kind: "builtin", p_capabilities: null }]]);
  assert.deepEqual(r.body.assignment, {
    id: ID, workspaceId: WS, sourceNoteId: NOTE, requestedOutcome: SECRET_TEXT, executorKind: "builtin",
    capabilities: ["assignment.execute", "workspace.read"], state: "queued", revision: 1, currentAttemptId: null,
    maxAttempts: 1, errorCode: null, createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z",
    stateChangedAt: "2026-10-14T00:00:00.000Z", finishedAt: null });
  assert.equal(r.headers.get("cache-control"), "private, no-store");
});

test("create: malformed bodies are 400 before any database call", async () => {
  const many = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  for (const body of [
    {}, [], "x", { ...validCreate, requestedOutcome: "   " }, { ...validCreate, requestedOutcome: "x".repeat(4001) },
    { ...validCreate, workspaceId: "nope" }, { ...validCreate, sourceNoteId: 5 }, { ...validCreate, contextNoteIds: many },
    { ...validCreate, contextNoteIds: [CTX, CTX.toUpperCase()] }, { ...validCreate, contextNoteIds: ["x"] },
    { ...validCreate, executor: "external" }, { ...validCreate, capabilities: ["item.write"] }, { ...validCreate, kind: "task" },
  ]) {
    const r = await create(body);
    assert.deepEqual([r.status, r.body], [400, { error: "Invalid request", code: "invalid_payload" }], JSON.stringify(body).slice(0, 80));
  }
  assert.deepEqual((await create(undefined, { raw: "{not json" })).body.code, "invalid_payload");
  const big = await create(undefined, { raw: JSON.stringify({ ...validCreate, requestedOutcome: "x".repeat(40000) }) });
  assert.deepEqual([big.status, big.body.code], [413, "payload_too_large"]);
  assert.equal(rpcCalls().length, 0);
});

test("mutations require a signed-in, same-origin request", async () => {
  const mutations = [
    (o) => create(validCreate, o),
    (o) => act("cancel", { expectedRevision: 1 }, o),
    (o) => act("retry", { expectedRevision: 1 }, o),
    (o) => act("answer", { expectedRevision: 1, questionId: QID, answer: "Formal" }, o),
    (o) => act("review", { expectedRevision: 1, artifactId: ART, decision: "accept" }, o),
  ];
  for (const run of mutations) {
    for (const origin of [null, "https://evil.example"]) {
      const r = await run({ origin });
      assert.deepEqual([r.status, r.body], [403, { error: "Forbidden", code: "forbidden_origin" }]);
    }
    signedIn = false;
    assert.deepEqual((await run({})).body, { error: "Signed out", code: "unauthenticated" });
    assert.equal((await run({})).status, 401);
    signedIn = true;
  }
  signedIn = false;
  assert.equal((await send(collection.GET, `/api/assignments?workspaceId=${WS}`, { method: "GET" })).status, 401);
  assert.equal((await send(detail.GET, `/api/assignments/${ID}`, { method: "GET", id: ID })).status, 401);
  assert.equal(rpcCalls().length, 0);
});

// --- Error mapping -----------------------------------------------------------------

test("database results map to the ADR 003 error contract with fixed messages", async () => {
  const cases = [
    [{ status: "not_found" }, 404, { code: "not_found" }],
    [{ status: "invalid_payload" }, 400, { code: "invalid_payload" }],
    [{ status: "invalid_context" }, 422, { code: "invalid_context" }],
    [{ status: "capability_denied" }, 403, { code: "capability_denied" }],
    [{ status: "agent_disabled" }, 403, { code: "agent_disabled" }],
    [{ status: "artifact_superseded" }, 409, { code: "artifact_superseded" }],
    [{ status: "active_assignment_exists", assignmentId: ID }, 409, { code: "active_assignment_exists", assignmentId: ID }],
    [{ status: "conflict", currentRevision: "4", state: "running" }, 409, { code: "revision_conflict", currentRevision: 4, state: "running" }],
    [{ status: "invalid_transition", from: "completed", to: "canceled", allowed: [] }, 409,
      { code: "invalid_transition", from: "completed", to: "canceled", allowed: [] }],
    [{ status: "lease_lost" }, 500, { code: "save_failed" }],
    [null, 500, { code: "save_failed" }],
    [{ status: "saved" }, 500, { code: "save_failed" }],
  ];
  for (const [data, status, expected] of cases) {
    rpcResult = () => ({ data, error: null });
    const r = await create(validCreate);
    assert.equal(r.status, status, JSON.stringify(data));
    assert.equal(typeof r.body.error, "string");
    const { error: _message, ...rest } = r.body;
    assert.deepEqual(rest, expected);
    assert.doesNotMatch(JSON.stringify(r.body), /invoice|vendor/i, "no request content in errors");
  }
  rpcResult = () => ({ data: null, error: { message: `boom: ${SECRET_TEXT}` } });
  const failed = await create(validCreate);
  assert.deepEqual([failed.status, failed.body], [500, { error: "Could not save the assignment", code: "save_failed" }]);
});

// --- Transitions ---------------------------------------------------------------------

test("cancel and retry call transition_assignment with their target state", async () => {
  rpcResult = () => ({ data: { status: "saved", assignment: row({ state: "canceled", revision: 2 }) }, error: null });
  const r = await act("cancel", { expectedRevision: 1 });
  assert.deepEqual([r.status, r.body.assignment.state, r.body.assignment.revision], [200, "canceled", 2]);
  await act("retry", { expectedRevision: 3 });
  assert.deepEqual(rpcCalls().map((c) => c[2]), [
    { p_id: ID, p_expected_revision: 1, p_to_state: "canceled", p_payload: null },
    { p_id: ID, p_expected_revision: 3, p_to_state: "queued", p_payload: null },
  ]);
  for (const body of [{}, { expectedRevision: 0 }, { expectedRevision: "1" }, { expectedRevision: 1.5 }, { expectedRevision: 1, state: "completed" }])
    assert.equal((await act("cancel", body)).status, 400);
  assert.equal((await act("cancel", { expectedRevision: 1 }, { id: "not-a-uuid" })).status, 400);
  assert.equal(rpcCalls().length, 2);
});

test("answer and review pass user-authored text through and validate it", async () => {
  rpcResult = () => ({ data: { status: "saved", assignment: row(), reviewId: ART }, error: null });
  await act("answer", { expectedRevision: 2, questionId: QID, answer: "  Formal  " });
  const reviewed = await act("review", { expectedRevision: 3, artifactId: ART, decision: "request_changes", comment: " Shorter " });
  assert.equal(reviewed.body.reviewId, ART);
  await act("review", { expectedRevision: 4, artifactId: ART, decision: "reject" });
  assert.deepEqual(rpcCalls().map((c) => [c[1], c[2]]), [
    ["answer_assignment_question", { p_id: ID, p_expected_revision: 2, p_question_id: QID, p_answer: "Formal" }],
    ["review_assignment_artifact", { p_id: ID, p_expected_revision: 3, p_artifact_id: ART, p_decision: "request_changes", p_comment: "Shorter" }],
    ["review_assignment_artifact", { p_id: ID, p_expected_revision: 4, p_artifact_id: ART, p_decision: "reject", p_comment: null }],
  ]);
  for (const body of [
    { expectedRevision: 1, questionId: QID, answer: "" }, { expectedRevision: 1, questionId: "q", answer: "x" },
    { expectedRevision: 1, questionId: QID, answer: "x".repeat(4001) },
  ])
    assert.equal((await act("answer", body)).status, 400);
  for (const body of [
    { expectedRevision: 1, artifactId: ART, decision: "request_changes" },
    { expectedRevision: 1, artifactId: ART, decision: "request_changes", comment: "  " },
    { expectedRevision: 1, artifactId: ART, decision: "approve" },
    { expectedRevision: 1, artifactId: ART, decision: "accept", comment: 5 },
  ])
    assert.equal((await act("review", body)).status, 400);
  assert.equal(rpcCalls().length, 3);
});

// --- Reads ------------------------------------------------------------------------------

test("list: one workspace, optional state filter, reaps the caller's leases first", async () => {
  const r = await send(collection.GET, `/api/assignments?workspaceId=${WS}&state=queued,running`, { method: "GET" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.assignments.map((a) => a.id), [ID]);
  assert.equal(calls[0][1], "reap_own_assignment_leases");
  assert.deepEqual(calls.find((c) => c[0] === "in"), ["in", "assignments", "state", ["queued", "running"]]);
  for (const query of ["", "?workspaceId=x", `?workspaceId=${WS}&state=done`, `?workspaceId=${WS}&limit=0`, `?workspaceId=${WS}&limit=101`])
    assert.equal((await send(collection.GET, `/api/assignments${query}`, { method: "GET" })).status, 400, query);
  tables.workspaces = [];
  const missing = await send(collection.GET, `/api/assignments?workspaceId=${WS}`, { method: "GET" });
  assert.deepEqual([missing.status, missing.body.code], [404, "not_found"]);
});

test("detail: children of one assignment, never the lease token", async () => {
  const r = await send(detail.GET, `/api/assignments/${ID}`, { method: "GET", id: ID });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["artifacts", "assignment", "attempts", "context", "events", "questions", "reviews"]);
  assert.deepEqual(r.body.context, [{ noteId: CTX, position: 1, revisionAtSelection: 3, contentRole: "untrusted_data" }]);
  assert.equal(r.body.events[0].id, "9");
  assert.equal(r.body.questions[0].prompt, "Which tone?");
  assert.equal(r.body.attempts[0].status, "waiting");
  const selects = calls.filter((c) => c[0] === "select").map((c) => c[2]).join(",");
  assert.doesNotMatch(selects, /lease_token/);
  assert.doesNotMatch(JSON.stringify(r.body), /lease_?token/i);
  const missing = await send(detail.GET, `/api/assignments/${ART}`, { method: "GET", id: ART });
  assert.deepEqual([missing.status, missing.body.code], [404, "not_found"]);
  assert.equal((await send(detail.GET, "/api/assignments/x", { method: "GET", id: "x" })).status, 400);
});

// --- Built-in executor kickoff (A-02) ---------------------------------------------------

test("routes that queue built-in work enqueue the run, then run that job with after()", async () => {
  assert.equal(collection.maxDuration, 300);
  for (const action of ["retry", "answer", "review"]) assert.equal(actions[action].maxDuration, 300);
  await create(validCreate);
  assert.deepEqual(enqueued, [[ID, 1]], "the job exists before the response");
  assert.deepEqual(scheduled, [], "nothing runs before the response");
  await runAfter();
  assert.deepEqual(scheduled, [[ID, "job-1", "number"]]);

  rpcResult = () => ({ data: { status: "saved", assignment: row({ state: "queued", revision: 3 }) }, error: null });
  await act("retry", { expectedRevision: 2 });
  await act("answer", { expectedRevision: 2, questionId: QID, answer: "Formal" });
  await act("review", { expectedRevision: 2, artifactId: ART, decision: "request_changes", comment: "Shorter" });
  await runAfter();
  assert.deepEqual(scheduled.map((s) => s[0]), [ID, ID, ID, ID]);
  // One idempotency key per revision: assignment:<id>:<revision>.
  assert.deepEqual(enqueued, [[ID, 1], [ID, 3], [ID, 3], [ID, 3]]);
  assert.deepEqual(scheduled.slice(1).map((s) => s[1]), ["job-3", "job-3", "job-3"]);
});

test("no run is scheduled for errors, non-queued results or cancel", async () => {
  for (const data of [
    { status: "active_assignment_exists", assignmentId: ID },
    { status: "agent_disabled" },
    { status: "saved", assignment: row({ state: "completed" }) },
    { status: "saved", assignment: row({ state: "queued", executor_kind: "external" }) },
  ]) {
    rpcResult = () => ({ data, error: null });
    await create(validCreate);
    await act("review", { expectedRevision: 2, artifactId: ART, decision: "accept" });
  }
  rpcResult = () => ({ data: { status: "created", assignment: row() }, error: { message: "boom" } });
  await create(validCreate);
  rpcResult = () => ({ data: { status: "saved", assignment: row({ state: "canceled" }) }, error: null });
  await act("cancel", { expectedRevision: 1 });
  assert.equal(actions.cancel.maxDuration, undefined);
  await runAfter();
  assert.deepEqual(scheduled, []);
  assert.deepEqual(enqueued, []);
});

test("kickoff: reaps, then enqueues and runs the oldest queued built-in assignment in the workspace", async () => {
  const ping = (body, options) => send(kickoff.POST, "/api/assignments/kickoff", { body, ...options });
  const r = await ping({ workspaceId: WS });
  assert.deepEqual([r.status, r.body], [202, { scheduled: 1 }]);
  assert.equal(calls[0][1], "reap_own_assignment_leases");
  assert.deepEqual(enqueued, [[ID, 1]]);
  await runAfter();
  assert.deepEqual(scheduled, [[ID, "job-1", "number"]]);
  tables.assignments = [row({ state: "running" })];
  assert.deepEqual((await ping({ workspaceId: WS })).body, { scheduled: 0 });
  for (const body of [{}, { workspaceId: "x" }, { workspaceId: WS, extra: 1 }, []])
    assert.equal((await ping(body)).status, 400);
  assert.equal((await ping({ workspaceId: WS }, { origin: "https://evil.example" })).status, 403);
  signedIn = false;
  assert.equal((await ping({ workspaceId: WS })).status, 401);
  await runAfter();
  assert.equal(scheduled.length, 1);
});

// --- U-05: list filter and saved documents ----------------------------------------------

const SAVED = "88888888-8888-4888-8888-888888888888";
const PROJECT = "99999999-0000-4000-8000-000000000009";
const OTHER = "12121212-1212-4212-8212-121212121212";
const list = (query) => send(collection.GET, `/api/assignments?${query}`, { method: "GET" });

test("list: optional sourceNoteId filter, validated as a uuid", async () => {
  tables.assignments.push(row({ id: OTHER, source_note_id: CTX }));
  const r = await list(`workspaceId=${WS}&sourceNoteId=${CTX}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.assignments.map((a) => a.id), [OTHER]);
  assert.deepEqual((await list(`workspaceId=${WS}`)).body.assignments.map((a) => a.id).sort(), [ID, OTHER].sort());
  for (const bad of ["x", "", NOTE.slice(0, -1), `${NOTE},${CTX}`])
    assert.deepEqual((await list(`workspaceId=${WS}&sourceNoteId=${encodeURIComponent(bad)}`)).body.code, "invalid_payload", bad);
});

test("list and detail: each artifact's savedNoteId, null when not saved", async () => {
  tables.assignments.push(row({ id: OTHER, state: "completed" }));
  const artifact = (patch) => ({ assignment_id: ID, id: ART, attempt_id: "77777777-7777-4777-8777-777777777777", kind: "draft",
    title: "T", content: { type: "doc" }, plain_text: "md", source_note_ids: [], saved_note_id: null, superseded_at: null,
    created_at: "2026-10-14T00:00:00+00:00", ...patch });
  tables.assignment_artifacts = [artifact({ saved_note_id: SAVED }), artifact({ assignment_id: OTHER, id: QID })];
  const r = await list(`workspaceId=${WS}`);
  assert.deepEqual(Object.fromEntries(r.body.assignments.map((a) => [a.id, a.savedNoteId])), { [ID]: SAVED, [OTHER]: null });
  // Only the link columns are read for the list, never artifact content.
  assert.equal(calls.find((c) => c[0] === "select" && c[1] === "assignment_artifacts")[2], "assignment_id,saved_note_id");
  const d = await send(detail.GET, `/api/assignments/${ID}`, { method: "GET", id: ID });
  assert.deepEqual(d.body.artifacts.map((a) => a.savedNoteId), [SAVED]);
  tables.assignments = [];
  calls = [];
  assert.deepEqual((await list(`workspaceId=${WS}`)).body, { assignments: [] });
  assert.equal(calls.some((c) => c[1] === "assignment_artifacts"), false, "no artifact read for an empty list");
});

const noteRow = (patch = {}) => ({
  id: SAVED, workspace_id: WS, title: "Reply draft", content: { type: "doc", content: [] }, plain_text: "Dear vendor",
  bucket: "reference", tags: [], source: "web", origin: { kind: "assignment", assignmentId: ID, artifactId: ART },
  created_at: "2026-10-15T00:00:00.123456+00:00", updated_at: "2026-10-15T00:00:00.123456+00:00", completed_at: null,
  due_date: null, revision: 1, kind: "document", project_id: PROJECT, waiting_on: null, waiting_for: null, next_check_on: null,
  ...patch,
});
const saveDoc = (body, options = {}) =>
  send(saveDocument.POST, `/api/assignments/${options.id ?? ID}/save-document`, { body, id: options.id ?? ID, ...options });

test("save-document: passes the body through and returns 201 { note, assignment }", async () => {
  rpcResult = () => ({ data: { status: "created", note: noteRow(), assignment: row({ state: "completed", revision: 6 }),
    artifactId: ART }, error: null });
  const r = await saveDoc({ expectedRevision: 6, artifactId: ART });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ["assignment", "note"]);
  assert.deepEqual(r.body.note, notesDb.fromRow(noteRow()), "the GET /api/notes shape");
  assert.equal(notesModule.isNote(r.body.note), true, "current clients accept the note");
  assert.equal(r.body.note.createdAt, "2026-10-15T00:00:00.123Z");
  assert.deepEqual([r.body.note.kind, r.body.note.bucket, r.body.note.projectId, r.body.note.revision], ["document", "reference", PROJECT, 1]);
  assert.deepEqual([r.body.assignment.state, r.body.assignment.revision], ["completed", 6]);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  await saveDoc({ expectedRevision: 6, artifactId: ART, projectId: null });
  await saveDoc({ expectedRevision: 6, artifactId: ART, projectId: PROJECT, title: "  Vendor reply  " });
  assert.deepEqual(rpcCalls().map((c) => [c[1], c[2]]), [
    ["save_assignment_artifact_as_note", { p_id: ID, p_expected_revision: 6, p_artifact_id: ART, p_options: {} }],
    ["save_assignment_artifact_as_note", { p_id: ID, p_expected_revision: 6, p_artifact_id: ART, p_options: { project_id: null } }],
    ["save_assignment_artifact_as_note", { p_id: ID, p_expected_revision: 6, p_artifact_id: ART,
      p_options: { project_id: PROJECT, title: "Vendor reply" } }],
  ]);
  await runAfter();
  assert.deepEqual(scheduled, [], "saving never starts a run");
});

test("save-document: invalid bodies are 400; auth, origin and size as the other routes", async () => {
  for (const body of [
    {}, [], { artifactId: ART }, { expectedRevision: 0, artifactId: ART }, { expectedRevision: 1, artifactId: "x" },
    { expectedRevision: 1, artifactId: ART, projectId: "x" }, { expectedRevision: 1, artifactId: ART, projectId: 5 },
    { expectedRevision: 1, artifactId: ART, title: "" }, { expectedRevision: 1, artifactId: ART, title: "  " },
    { expectedRevision: 1, artifactId: ART, title: "x".repeat(201) }, { expectedRevision: 1, artifactId: ART, title: null },
    { expectedRevision: 1, artifactId: ART, kind: "note" }, { expectedRevision: 1, artifactId: ART, bucket: "next" },
  ]) {
    const r = await saveDoc(body);
    assert.deepEqual([r.status, r.body], [400, { error: "Invalid request", code: "invalid_payload" }], JSON.stringify(body));
  }
  assert.equal((await saveDoc({ expectedRevision: 1, artifactId: ART }, { id: "x" })).status, 400);
  assert.equal((await saveDoc(undefined, { raw: "{" })).status, 400);
  const big = await saveDoc(undefined, { raw: JSON.stringify({ expectedRevision: 1, artifactId: ART, title: "x".repeat(40000) }) });
  assert.deepEqual([big.status, big.body.code], [413, "payload_too_large"]);
  for (const origin of [null, "https://evil.example"])
    assert.deepEqual((await saveDoc({ expectedRevision: 1, artifactId: ART }, { origin })).body,
      { error: "Forbidden", code: "forbidden_origin" });
  signedIn = false;
  assert.deepEqual((await saveDoc({ expectedRevision: 1, artifactId: ART })).status, 401);
  assert.equal(rpcCalls().length, 0);
});

test("save-document: database results map to the error contract", async () => {
  const cases = [
    [{ status: "not_found" }, 404, { code: "not_found" }],
    [{ status: "invalid_payload" }, 400, { code: "invalid_payload" }],
    [{ status: "conflict", currentRevision: "7", state: "completed" }, 409, { code: "revision_conflict", currentRevision: 7, state: "completed" }],
    [{ status: "invalid_transition", from: "needs_review", to: "completed", allowed: ["canceled", "completed", "queued"] }, 409,
      { code: "invalid_transition", from: "needs_review", to: "completed", allowed: ["canceled", "completed", "queued"] }],
    [{ status: "artifact_superseded" }, 409, { code: "artifact_superseded" }],
    [{ status: "already_saved", noteId: SAVED }, 409, { code: "already_saved", noteId: SAVED }],
    [{ status: "invalid", code: "invalid_project_link" }, 422, { code: "invalid_project_link" }],
    [{ status: "invalid", code: "project_cycle" }, 422, { code: "project_cycle" }],
    [{ status: "invalid", code: "project_depth_exceeded" }, 422, { code: "project_depth_exceeded" }],
    [{ status: "invalid", code: "linked_item_move" }, 500, { code: "save_failed" }],
    [{ status: "already_saved" }, 500, { code: "save_failed" }],
    [{ status: "created", assignment: row() }, 500, { code: "save_failed" }],
    [{ status: "saved", assignment: row() }, 500, { code: "save_failed" }],
    [null, 500, { code: "save_failed" }],
  ];
  for (const [data, status, expected] of cases) {
    rpcResult = () => ({ data, error: null });
    const r = await saveDoc({ expectedRevision: 1, artifactId: ART, title: "Vendor invoice reply" });
    assert.equal(r.status, status, JSON.stringify(data));
    const { error: message, ...rest } = r.body;
    assert.equal(typeof message, "string");
    assert.deepEqual(rest, expected, JSON.stringify(data));
    assert.doesNotMatch(JSON.stringify(r.body), /invoice|vendor/i, "no request content in errors");
  }
  rpcResult = () => ({ data: null, error: { message: "boom: Vendor invoice reply" } });
  assert.deepEqual((await saveDoc({ expectedRevision: 1, artifactId: ART })).body,
    { error: "Could not save the assignment", code: "save_failed" });
});

// --- U-05: availability ----------------------------------------------------------------

const avail = (query = `workspaceId=${WS}`) =>
  send(availability.GET, `/api/assignments/availability?${query}`, { method: "GET" });

test("availability: each reason from the workspace switch and the saved key, never key material", async () => {
  tables.workspaces = [{ id: WS, agent_enabled: true }];
  const seen = [];
  const check = async (expected) => {
    const r = await avail();
    assert.deepEqual([r.status, r.body], [200, expected]);
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    seen.push(JSON.stringify(r.body));
  };
  await check({ available: true });
  agentSettings = async () => null;
  await check({ available: false, reason: "no_key" });
  agentSettings = async () => ({ provider: "anthropic", model: "m", keyHint: "wxyz", autoTriage: true, apiKey: null });
  await check({ available: false, reason: "key_unreadable" });
  tables.workspaces = [{ id: WS, agent_enabled: false }];
  calls = [];
  await check({ available: false, reason: "agent_disabled" });
  assert.equal(calls.some((c) => c[0] === "settings"), false, "the key isn't read for a disabled workspace");
  for (const body of seen) assert.doesNotMatch(body, /sk-|secret|wxyz|anthropic|ciphertext|hint|provider|model/i);
  // The key is read with the admin client, for the signed-in user only.
  tables.workspaces = [{ id: WS, agent_enabled: true }];
  calls = [];
  await avail();
  assert.deepEqual(calls.find((c) => c[0] === "settings"), ["settings", adminClient, USER]);
});

test("availability: owner-only, validated, and failures map to codes", async () => {
  tables.workspaces = [{ id: "99999999-9999-4999-8999-999999999999", agent_enabled: true }];
  const missing = await avail();
  assert.deepEqual([missing.status, missing.body.code], [404, "not_found"]);
  for (const query of ["", "workspaceId=x", `workspaceId=${WS.slice(1)}`])
    assert.deepEqual((await avail(query)).body.code, "invalid_payload", query);
  tables.workspaces = [{ id: WS, agent_enabled: true }];
  agentSettings = async () => { throw new Error("db down sk-secret"); };
  assert.deepEqual((await avail()).body, { error: "Could not load assignments", code: "load_failed" });
  adminClient = null;
  const unconfigured = await avail();
  assert.deepEqual([unconfigured.status, unconfigured.body.code], [503, "not_configured"]);
  signedIn = false;
  const signedOut = await avail();
  assert.deepEqual([signedOut.status, signedOut.body.code], [401, "unauthenticated"]);
});
