import { test, before } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, skip } from "./harness.mjs";
import { TRANSITIONS } from "../../lib/assignments/transitions.ts";

// A-01: the assignment schema and functions (ADR 003) against PGlite. Covers
// every allowed transition (T1–T16), representative forbidden ones, the
// one-active-per-item rule, ownership and workspace scoping, RLS, grants,
// append-only events, lease fencing and the reaper.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003"; // no saved model key
let n = 0;
const uuid = () => `ffffffff-0000-4000-8000-${String(++n).padStart(12, "0")}`;

let db, WA, WA2, WAoff, WB, WC;
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const user = async (who, sql, params = []) => (await as(db, "authenticated", who, sql, params))[0]?.r;
const svc = async (sql, params = []) => (await as(db, "service_role", null, sql, params))[0]?.r;

async function note(who, ws, kind = "task") {
  const id = uuid();
  const [r] = (await as(db, "authenticated", who, "select public.save_notes($1::jsonb, false) r", [JSON.stringify([{
    id, workspace_id: ws, title: "Captured text", content: { type: "doc" }, plain_text: "", bucket: "next",
    tags: [], kind, created_at: "2026-10-13T00:00:00.000Z", completed_at: null, expected_revision: null,
  }])]))[0].r;
  assert.equal(r.status, "saved");
  return id;
}
const create = (who, ws, source, { outcome = "Draft a reply", context = [], kind = "builtin", caps = null } = {}) =>
  user(who, "select public.create_assignment($1, $2, $3, $4::uuid[], $5, $6::text[]) r",
    [ws, source, outcome, context, kind, caps]);
// A fresh workspace per claimed assignment keeps the one-running-per-workspace
// rule from coupling tests.
const newWs = async (who = A, enabled = true) =>
  (await one(`insert into public.workspaces (user_id, name, agent_enabled) values ($1, 'W', $2) returning id`, [who, enabled])).id;
async function assignment(who = A, ws, options) {
  ws ??= await newWs(who);
  const r = await create(who, ws, await note(who, ws), options);
  assert.equal(r.status, "created");
  return r.assignment;
}
const row = (id) => one("select * from public.assignments where id = $1", [id]);
const rev = async (id) => Number((await row(id)).revision);
const transition = async (who, id, to, expected) =>
  user(who, "select public.transition_assignment($1, $2, $3, null) r", [id, expected ?? await rev(id), to]);
const cancel = (who, id, expected) => transition(who, id, "canceled", expected);
const retry = (who, id, expected) => transition(who, id, "queued", expected);
const answer = async (who, id, question, text = "Use the formal tone", expected) =>
  user(who, "select public.answer_assignment_question($1, $2, $3, $4) r", [id, expected ?? await rev(id), question, text]);
const review = async (who, id, artifact, decision, comment = null, expected) =>
  user(who, "select public.review_assignment_artifact($1, $2, $3, $4, $5) r",
    [id, expected ?? await rev(id), artifact, decision, comment]);
const claim = (id, seconds = null) => svc("select public.claim_assignment($1, $2) r", [id, seconds]);
const heartbeat = (lease, progress = null) =>
  svc("select public.heartbeat_assignment($1, $2, $3) r", [lease.attemptId, lease.leaseToken, progress]);
const ask = (lease, prompt = "Which tone?") =>
  svc("select public.ask_assignment_question($1, $2, $3) r", [lease.attemptId, lease.leaseToken, prompt]);
const artifactBody = (patch = {}) => ({ kind: "draft", title: "Reply draft", content: { type: "doc", content: [] },
  plain_text: "Dear vendor", source_note_ids: [], ...patch });
const submit = (lease, body = artifactBody()) =>
  svc("select public.submit_assignment_artifact($1, $2, $3::jsonb) r", [lease.attemptId, lease.leaseToken, JSON.stringify(body)]);
const fail = (lease, code = "provider_unavailable") =>
  svc("select public.fail_assignment_attempt($1, $2, $3) r", [lease.attemptId, lease.leaseToken, code]);
const systemFail = (id, code = "capability_revoked") => svc("select public.fail_assignment_system($1, $2) r", [id, code]);
const reap = () => svc("select public.reap_assignment_leases() r");
const expire = (attemptId) =>
  db.query("update public.assignment_attempts set lease_expires_at = now() - interval '1 second' where id = $1", [attemptId]);
const events = (id) => q("select type, actor, from_state, to_state, payload, attempt_id from public.assignment_events where assignment_id = $1 order by id", [id]);
const lastEvent = async (id) => (await events(id)).at(-1);

async function claimed(who = A, ws, options) {
  const a = await assignment(who, ws, options);
  const lease = await claim(a.id);
  assert.equal(lease.status, "claimed");
  return { a, lease };
}
async function inReview(who = A, ws, options) {
  const { a, lease } = await claimed(who, ws, options);
  const s = await submit(lease);
  assert.equal(s.status, "submitted");
  return { a, lease, artifactId: s.artifactId };
}
async function needsInput() {
  const { a, lease } = await claimed();
  const r = await ask(lease);
  assert.equal(r.status, "asked");
  return { a, lease, questionId: r.questionId };
}

before(async () => {
  if (skip) return;
  db = await createDb();
  await migrate(db);
  await db.exec(`insert into auth.users values ('${A}'), ('${B}'), ('${C}');`);
  const ws = async (who, enabled = true) =>
    (await one(`insert into public.workspaces (user_id, name, agent_enabled) values ($1, 'W', $2) returning id`, [who, enabled])).id;
  WA = await ws(A);
  WA2 = await ws(A);
  WAoff = await ws(A, false);
  WB = await ws(B);
  WC = await ws(C);
  for (const who of [A, B])
    await db.query(`insert into public.agent_settings (user_id, provider, model, api_key_ciphertext, key_hint)
      values ($1, 'anthropic', 'm', 'x', 'abcd')`, [who]);
});

// --- Transition table ------------------------------------------------------------

test("the seeded transition table is T1–T16 and lib/assignments mirrors it", { skip }, async () => {
  const rows = await q("select code, from_state, to_state, actor from public.assignment_transitions order by from_state, to_state, actor");
  const key = (t) => `${t.code}:${t.from}>${t.to}:${t.actor}`;
  assert.deepEqual(rows.map((r) => key({ code: r.code, from: r.from_state, to: r.to_state, actor: r.actor })).sort(),
    TRANSITIONS.map(key).sort());
  assert.deepEqual([...new Set(rows.map((r) => r.code))].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))),
    Array.from({ length: 16 }, (_, i) => `T${i + 1}`));
  assert.equal(rows.filter((r) => ["completed", "canceled"].includes(r.from_state)).length, 0, "terminal states");
  assert.equal(rows.filter((r) => r.from_state === r.to_state).length, 0, "no self-transitions");
});

// --- Create ---------------------------------------------------------------------------

test("create: any item kind may be delegated, with selected context stored as untrusted data", { skip }, async () => {
  for (const kind of ["note", "task", "project", "document", "followup"]) {
    const source = await note(A, WA, kind);
    const r = await create(A, WA, source);
    assert.equal(r.status, "created", kind);
    assert.deepEqual([r.assignment.state, r.assignment.revision, r.assignment.source_note_id, r.assignment.executor_kind],
      ["queued", 1, source, "builtin"]);
  }
  const ctx = [await note(A, WA, "note"), await note(A, WA, "document")];
  await q("update public.notes set title = 'edited' where id = $1", [ctx[1]]);
  const a = await assignment(A, WA, { context: ctx, caps: ["assignment.execute", "workspace.read", "assignment.execute"] });
  assert.deepEqual(a.capabilities, ["assignment.execute", "workspace.read"]);
  const stored = await q("select note_id, position, revision_at_selection, content_role, workspace_id, user_id from public.assignment_context_items where assignment_id = $1 order by position", [a.id]);
  assert.deepEqual(stored.map((s) => [s.note_id, s.position, Number(s.revision_at_selection), s.content_role, s.workspace_id, s.user_id]),
    [[ctx[0], 1, 1, "untrusted_data", WA, A], [ctx[1], 2, 2, "untrusted_data", WA, A]]);
  assert.deepEqual(await events(a.id), [{ type: "state_changed", actor: "user", from_state: null, to_state: "queued",
    payload: { revision: 1, contextCount: 2 }, attempt_id: null }]);
});

test("create: validation, limits and the static capability policy", { skip }, async () => {
  const src = await note(A, WA);
  const ctx = async (count) => Promise.all(Array.from({ length: count }, () => note(A, WA, "note")));
  assert.equal((await create(A, WA, src, { context: await ctx(20) })).status, "created", "20 context items is the cap");
  const s2 = await note(A, WA);
  for (const options of [{ outcome: "" }, { outcome: "   " }, { outcome: "x".repeat(4001) }, { outcome: null },
    { context: await ctx(21) }, { context: [src, src].map(() => s2) }, { kind: "robot" }, { caps: [] }])
    assert.equal((await create(A, WA, await note(A, WA), options)).status, "invalid_payload", JSON.stringify(options).slice(0, 60));
  assert.equal((await create(A, WA, await note(A, WA), { kind: "external" })).status, "capability_denied");
  assert.equal((await create(A, WA, await note(A, WA), { caps: ["item.write"] })).status, "capability_denied");
  assert.equal((await create(A, WA, await note(A, WA), { caps: ["admin"] })).status, "capability_denied");
  assert.equal((await create(A, WAoff, await note(A, WAoff))).status, "agent_disabled", "workspace switch off");
  assert.equal((await create(C, WC, await note(C, WC))).status, "agent_disabled", "no saved model key");
  await assert.rejects(user(null, "select public.create_assignment($1, $2, 'x', '{}', 'builtin', null) r", [WA, src]), /Not signed in/);
});

test("create: cross-account and cross-workspace source and context are refused", { skip }, async () => {
  const bNote = await note(B, WB);
  const a2Note = await note(A, WA2);
  const src = await note(A, WA);
  assert.equal((await create(A, WA, bNote)).status, "not_found", "another account's item");
  assert.equal((await create(A, WB, bNote)).status, "not_found", "another account's workspace");
  assert.equal((await create(A, WA, a2Note)).status, "not_found", "own item, other workspace");
  assert.equal((await create(A, WA, uuid())).status, "not_found", "missing item");
  for (const context of [[bNote], [a2Note], [uuid()], [src]])
    assert.equal((await create(A, WA, src, { context })).status, "invalid_context");
  assert.equal(Number((await one("select count(*) c from public.assignments where source_note_id = $1", [src])).c), 0);
  // The composite keys refuse it even for a direct write that skips the functions.
  const a = await assignment(A, WA);
  await assert.rejects(db.query(`insert into public.assignment_context_items (assignment_id, user_id, workspace_id, note_id, position, revision_at_selection)
    values ($1, $2, $3, $4, 1, 1)`, [a.id, A, WA, a2Note]), /assignment_context_note_fk/);
  await assert.rejects(db.query(`insert into public.assignment_context_items (assignment_id, user_id, workspace_id, note_id, position, revision_at_selection)
    values ($1, $2, $3, $4, 1, 1)`, [a.id, B, WB, bNote]), /assignment_context_assignment_fk/);
  await assert.rejects(db.query(`insert into public.assignments (user_id, workspace_id, source_note_id, requested_outcome)
    values ($1, $2, $3, 'x')`, [A, WA, bNote]), /assignments_source_fk/);
});

test("one active assignment per source item; terminal and failed ones free the slot", { skip }, async () => {
  const ws = await newWs();
  const src = await note(A, ws);
  const first = (await create(A, ws, src)).assignment;
  const dup = await create(A, ws, src);
  assert.deepEqual(dup, { status: "active_assignment_exists", assignmentId: first.id });
  assert.equal((await cancel(A, first.id)).status, "saved");
  const second = (await create(A, ws, src)).assignment;
  const lease = await claim(second.id);
  assert.equal((await fail(lease)).status, "saved");
  const third = (await create(A, ws, src)).assignment;
  assert.ok(third, "a failed assignment does not hold the slot");
  assert.deepEqual(await retry(A, second.id), { status: "active_assignment_exists", assignmentId: third.id },
    "retry is refused while another one is active");
  assert.equal((await row(second.id)).state, "failed");
  await assert.rejects(db.query(`insert into public.assignments (user_id, workspace_id, source_note_id, requested_outcome)
    values ($1, $2, $3, 'x')`, [A, ws, src]), /assignments_one_active_per_source/);
});

// --- Every allowed transition ------------------------------------------------------------

async function expectMove(id, before, to, actor) {
  const r = await row(id);
  assert.equal(r.state, to);
  assert.equal(Number(r.revision), before + 1, "every transition bumps revision");
  const e = (await events(id)).filter((x) => x.type === "state_changed").at(-1);
  assert.deepEqual([e.to_state, e.actor], [to, actor]);
  return r;
}

test("T1 claim, T3 ask, T9 answer, T4 submit, T11 accept: the happy path", { skip }, async () => {
  const ws = await newWs();
  const src = await note(A, ws);
  const ctx = await note(A, ws, "note");
  const a = (await create(A, ws, src, { context: [ctx] })).assignment;
  const lease = await claim(a.id);
  assert.deepEqual([lease.status, lease.attemptNumber], ["claimed", 1]);
  let r = await expectMove(a.id, 1, "running", "executor");
  assert.equal(r.current_attempt_id, lease.attemptId);
  const attempt = await one("select * from public.assignment_attempts where id = $1", [lease.attemptId]);
  assert.deepEqual([attempt.status, attempt.lease_seconds], ["running", 90]);
  assert.ok(attempt.lease_expires_at > new Date(Date.now() + 80_000), "default 90 s lease");

  const hb = await heartbeat(lease, "Reading the selected items");
  assert.equal(hb.status, "ok");
  assert.deepEqual((await lastEvent(a.id)).payload, { text: "Reading the selected items" });

  const asked = await ask(lease);
  assert.equal(asked.status, "asked");
  await expectMove(a.id, 2, "needs_input", "executor");
  assert.equal((await one("select status from public.assignment_attempts where id = $1", [lease.attemptId])).status, "waiting");

  assert.equal((await answer(A, a.id, asked.questionId)).status, "saved");
  await expectMove(a.id, 3, "queued", "user");
  const q1 = await one("select answer, answered_at, closed_at from public.assignment_questions where id = $1", [asked.questionId]);
  assert.equal(q1.answer, "Use the formal tone");

  const lease2 = await claim(a.id);
  assert.equal(lease2.attemptNumber, 2, "an answer starts a new attempt on the next claim");
  const s = await submit(lease2, artifactBody({ source_note_ids: [src, ctx] }));
  assert.equal(s.status, "submitted");
  await expectMove(a.id, 5, "needs_review", "executor");

  const done = await review(A, a.id, s.artifactId, "accept");
  assert.equal(done.status, "saved");
  r = await expectMove(a.id, 6, "completed", "user");
  assert.ok(r.finished_at);
  const types = (await events(a.id)).map((e) => e.type);
  assert.deepEqual(types, ["state_changed", "state_changed", "progress", "question_asked", "state_changed",
    "question_answered", "state_changed", "state_changed", "artifact_submitted", "state_changed", "review_decided", "state_changed"]);
});

test("T2 cancel queued, T8 cancel running, T10 cancel needs_input", { skip }, async () => {
  const q2 = await assignment();
  assert.equal((await cancel(A, q2.id)).status, "saved");
  assert.ok((await expectMove(q2.id, 1, "canceled", "user")).finished_at);

  const { a: r8, lease } = await claimed();
  assert.equal((await cancel(A, r8.id)).status, "saved");
  await expectMove(r8.id, 2, "canceled", "user");
  assert.equal((await one("select status from public.assignment_attempts where id = $1", [lease.attemptId])).status, "canceled");
  assert.ok((await events(r8.id)).some((e) => e.type === "cancel_requested"));

  const { a: r10, questionId } = await needsInput();
  assert.equal((await cancel(A, r10.id)).status, "saved");
  await expectMove(r10.id, 3, "canceled", "user");
  const question = await one("select answered_at, closed_at from public.assignment_questions where id = $1", [questionId]);
  assert.deepEqual([question.answered_at, !!question.closed_at], [null, true], "the open question is closed unanswered");
});

test("T5 executor failure and T14 retry", { skip }, async () => {
  const { a, lease } = await claimed();
  assert.deepEqual(await fail(lease, "timed_out"), { status: "invalid_payload" }, "timed_out is the reaper's");
  assert.deepEqual(await fail(lease, "Error: 401 from provider"), { status: "invalid_payload" }, "raw messages are refused");
  assert.equal((await fail(lease, "budget_exhausted")).status, "saved");
  let r = await expectMove(a.id, 2, "failed", "executor");
  assert.equal(r.error_code, "budget_exhausted");
  assert.equal((await lastEvent(a.id)).payload.errorCode, "budget_exhausted");
  assert.equal((await retry(A, a.id)).status, "saved");
  r = await expectMove(a.id, 3, "queued", "user");
  assert.deepEqual([r.error_code, r.finished_at], [null, null]);
});

test("T6 reaper times out expired leases; T7 is allowed by the table but not used yet", { skip }, async () => {
  const { a, lease } = await claimed();
  const { a: fresh } = await claimed();
  await expire(lease.attemptId);
  assert.deepEqual(await heartbeat(lease), { status: "lease_lost" }, "an expired lease is lost before the reaper runs");
  const result = await reap();
  assert.equal(result.timedOut, 1);
  const r = await expectMove(a.id, 2, "failed", "system");
  assert.equal(r.error_code, "timed_out");
  const attempt = await one("select status, error_code from public.assignment_attempts where id = $1", [lease.attemptId]);
  assert.deepEqual([attempt.status, attempt.error_code], ["expired", "timed_out"]);
  assert.equal((await row(fresh.id)).state, "running", "a live lease is untouched");
  assert.equal((await reap()).timedOut, 0, "repeating the reaper is harmless");

  // T7 (lease expired with attempts remaining) arrives with A-04; the table
  // already allows it for the system actor and nobody else.
  const { a: a7 } = await claimed();
  await assert.rejects(db.query("update public.assignments set state = 'queued' where id = $1", [a7.id]), /invalid_transition/);
  await db.exec(`begin; select set_config('orbit.assignment_actor', 'system', true);
    update public.assignments set state = 'queued' where id = '${a7.id}'; commit;`);
  assert.equal((await row(a7.id)).state, "queued");
});

test("reap on read: only the caller's expired leases", { skip }, async () => {
  const { a: mine, lease: l1 } = await claimed(A);
  const { a: theirs, lease: l2 } = await claimed(B);
  await expire(l1.attemptId);
  await expire(l2.attemptId);
  assert.deepEqual(await user(A, "select public.reap_own_assignment_leases() r"), { timedOut: 1, unavailable: 0 });
  assert.equal((await row(mine.id)).state, "failed");
  assert.equal((await row(theirs.id)).state, "running");
  assert.equal((await reap()).timedOut, 1);
  assert.equal((await row(theirs.id)).error_code, "timed_out");
});

test("T12 request changes, T13 reject, superseded artifacts", { skip }, async () => {
  const { a, artifactId: first } = await inReview();
  assert.deepEqual(await review(A, a.id, first, "request_changes", "  "), { status: "invalid_payload" }, "comment required");
  assert.equal((await review(A, a.id, first, "request_changes", "Shorter, please")).status, "saved");
  await expectMove(a.id, 3, "queued", "user");
  const lease = await claim(a.id);
  const second = (await submit(lease)).artifactId;
  const stale = await review(A, a.id, first, "accept");
  assert.deepEqual(stale, { status: "artifact_superseded" });
  const artifacts = await q("select id, superseded_at from public.assignment_artifacts where assignment_id = $1 order by created_at", [a.id]);
  assert.deepEqual(artifacts.map((x) => [x.id, !!x.superseded_at]), [[first, true], [second, false]]);

  assert.equal((await review(A, a.id, second, "reject")).status, "saved");
  await expectMove(a.id, 6, "canceled", "user");
  const reviews = await q("select decision, comment, artifact_id from public.assignment_reviews where assignment_id = $1 order by decided_at", [a.id]);
  assert.deepEqual(reviews.map((x) => [x.decision, x.comment, x.artifact_id]),
    [["request_changes", "Shorter, please", first], ["reject", null, second]], "reject is canceled with a recorded review");
  assert.equal(Number((await one("select count(*) c from public.assignment_artifacts where assignment_id = $1", [a.id])).c), 2,
    "artifacts are kept after reject");
});

test("T15 and T16 system failures", { skip }, async () => {
  const queued = await assignment();
  assert.equal((await systemFail(queued.id, "executor_unavailable")).status, "saved");
  assert.equal((await expectMove(queued.id, 1, "failed", "system")).error_code, "executor_unavailable");

  const { a: input, questionId } = await needsInput();
  assert.equal((await systemFail(input.id)).status, "saved");
  assert.equal((await expectMove(input.id, 3, "failed", "system")).error_code, "capability_revoked");
  assert.ok((await one("select closed_at from public.assignment_questions where id = $1", [questionId])).closed_at);

  const { a: rev2 } = await inReview();
  assert.equal((await systemFail(rev2.id)).status, "saved");
  await expectMove(rev2.id, 3, "failed", "system");

  const { a: running } = await claimed();
  assert.equal((await systemFail(running.id)).status, "invalid_transition", "running fails through its lease");
  assert.equal((await systemFail(running.id, "timed_out")).status, "invalid_payload");

  // The reaper fails queued built-in work whose executor is unavailable.
  const ws = await newWs();
  const waiting = await assignment(A, ws);
  await q("update public.workspaces set agent_enabled = false where id = $1", [ws]);
  assert.equal((await reap()).unavailable, 1);
  const r = await row(waiting.id);
  assert.deepEqual([r.state, r.error_code], ["failed", "executor_unavailable"]);
});

// --- Forbidden transitions ---------------------------------------------------------------

test("forbidden transitions are refused with the allowed targets", { skip }, async () => {
  const { a: done, artifactId } = await inReview();
  await review(A, done.id, artifactId, "accept");
  assert.deepEqual(await cancel(A, done.id), { status: "invalid_transition", from: "completed", to: "canceled", allowed: [] });
  assert.deepEqual(await retry(A, done.id), { status: "invalid_transition", from: "completed", to: "queued", allowed: [] });

  const canceled = await assignment();
  await cancel(A, canceled.id);
  assert.equal((await retry(A, canceled.id)).status, "invalid_transition", "canceled is terminal");
  assert.equal((await claim(canceled.id)).status, "invalid_transition");

  const queued = await assignment();
  assert.deepEqual(await retry(A, queued.id), { status: "invalid_transition", from: "queued", to: "queued", allowed: ["canceled"] },
    "self-transition");
  assert.equal((await answer(A, queued.id, uuid())).status, "invalid_transition");
  assert.equal((await review(A, queued.id, uuid(), "accept")).status, "invalid_transition");

  const { a: running } = await claimed();
  assert.equal((await claim(running.id)).status, "invalid_transition", "double claim");
  assert.deepEqual(await review(A, running.id, uuid(), "accept"),
    { status: "invalid_transition", from: "running", to: "completed", allowed: ["canceled"] });

  const { a: input } = await needsInput();
  assert.deepEqual(await retry(A, input.id), { status: "invalid_transition", from: "needs_input", to: "queued",
    allowed: ["canceled", "queued"] }, "queued from needs_input is an answer");

  const { a: inReviewA } = await inReview();
  assert.deepEqual(await cancel(A, inReviewA.id), { status: "invalid_transition", from: "needs_review", to: "canceled",
    allowed: ["canceled", "completed", "queued"] }, "declining a result is a reject review, not a bare cancel");
  assert.equal((await row(inReviewA.id)).state, "needs_review");

  const { a: failed, lease } = await claimed();
  await fail(lease);
  assert.equal((await cancel(A, failed.id)).status, "invalid_transition");

  // The trigger is the backstop for any direct write.
  await assert.rejects(db.query("update public.assignments set state = 'completed' where id = $1", [queued.id]), /invalid_transition/);
  await assert.rejects(db.exec(`begin; select set_config('orbit.assignment_actor', 'executor', true);
    update public.assignments set state = 'canceled' where id = '${queued.id}'; commit;`), /invalid_transition/);
  await db.exec("rollback");
  await assert.rejects(db.exec(`begin; select set_config('orbit.assignment_actor', 'user', true);
    update public.assignments set requested_outcome = 'Do something else' where id = '${queued.id}'; commit;`), /assignment_immutable/);
  await db.exec("rollback");
  await assert.rejects(as(db, "service_role", null, "update public.assignments set state = 'canceled' where id = $1", [queued.id]),
    /permission denied/);
  assert.equal((await row(queued.id)).state, "queued");
});

test("stale expected revisions are conflicts", { skip }, async () => {
  const a = await assignment();
  assert.deepEqual(await cancel(A, a.id, 7), { status: "conflict", currentRevision: 1, state: "queued" });
  assert.deepEqual(await user(A, "select public.transition_assignment($1, null, 'canceled', null) r", [a.id]), { status: "invalid_payload" });
  assert.equal((await row(a.id)).state, "queued");
});

// --- Fencing ------------------------------------------------------------------------------

test("lease fencing: after cancel, an old token can't progress, ask, submit or fail", { skip }, async () => {
  const { a, lease } = await claimed();
  await cancel(A, a.id);
  const before = (await events(a.id)).length;
  for (const r of [await heartbeat(lease, "still going"), await ask(lease), await submit(lease), await fail(lease)])
    assert.deepEqual(r, { status: "lease_lost" });
  assert.equal((await events(a.id)).length, before, "nothing was written");
  assert.equal(Number((await one("select count(*) c from public.assignment_questions where assignment_id = $1", [a.id])).c), 0);
  assert.equal(Number((await one("select count(*) c from public.assignment_artifacts where assignment_id = $1", [a.id])).c), 0);
  assert.equal((await row(a.id)).state, "canceled");
});

test("lease fencing: wrong tokens and superseded attempts are lost", { skip }, async () => {
  const { a, lease } = await claimed();
  assert.deepEqual(await heartbeat({ ...lease, leaseToken: uuid() }), { status: "lease_lost" });
  assert.deepEqual(await heartbeat({ attemptId: uuid(), leaseToken: lease.leaseToken }), { status: "lease_lost" });
  const asked = await ask(lease);
  await answer(A, a.id, asked.questionId);
  const lease2 = await claim(a.id);
  assert.deepEqual(await submit(lease), { status: "lease_lost" }, "the first attempt's lease is gone");
  assert.equal((await submit(lease2)).status, "submitted");
});

test("executor checks: workspace concurrency, citations and payload shape", { skip }, async () => {
  const ws = await newWs();
  const first = await assignment(A, ws);
  const second = await assignment(A, ws);
  const lease = await claim(first.id);
  assert.deepEqual(await claim(second.id), { status: "executor_busy" });
  assert.equal((await row(second.id)).state, "queued");
  assert.deepEqual(await claim(second.id, 5), { status: "invalid_payload" });
  const other = await note(A, ws, "note");
  assert.deepEqual(await submit(lease, artifactBody({ source_note_ids: [other] })), { status: "invalid_context" },
    "an item that is not in the selected context can't be cited");
  for (const body of [artifactBody({ kind: "email" }), artifactBody({ title: "" }), artifactBody({ content: "text" }),
    artifactBody({ source_note_ids: ["nope"] }), artifactBody({ title: "x".repeat(201) }), artifactBody({ plain_text: "x".repeat(100001) })])
    assert.deepEqual(await submit(lease, body), { status: "invalid_payload" });
  assert.deepEqual(await heartbeat(lease, "x".repeat(281)), { status: "invalid_payload" });
  assert.deepEqual(await ask(lease, ""), { status: "invalid_payload" });
  assert.equal((await row(first.id)).state, "running", "refused calls change nothing");
  await cancel(A, first.id);
  assert.equal((await claim(second.id)).status, "claimed", "the slot frees on cancel");
  assert.deepEqual(await claim(second.id), { status: "invalid_transition", from: "running", to: "running",
    allowed: ["failed", "needs_input", "needs_review"] }, "allowed targets are the executor's");
  const off = await newWs();
  const disabled = await assignment(A, off);
  await q("update public.workspaces set agent_enabled = false where id = $1", [off]);
  assert.deepEqual(await claim(disabled.id), { status: "agent_disabled" });
  assert.equal((await row(disabled.id)).state, "queued", "claim leaves it for the reaper or the executor (T15)");
});

// --- Item side effects --------------------------------------------------------------------

test("accepting never completes the source item", { skip }, async () => {
  const ws = await newWs();
  const src = await note(A, ws);
  const a = (await create(A, ws, src)).assignment;
  const before = await one("select revision, completed_at, updated_at from public.notes where id = $1", [src]);
  const lease = await claim(a.id);
  const { artifactId } = await submit(lease);
  await review(A, a.id, artifactId, "accept");
  const after = await one("select revision, completed_at, updated_at from public.notes where id = $1", [src]);
  assert.deepEqual(after, before);
  assert.equal(after.completed_at, null);
});

test("artifacts persist after cancel; deleting items detaches them", { skip }, async () => {
  const ws = await newWs();
  const src = await note(A, ws);
  const ctx = await note(A, ws, "note");
  const a = (await create(A, ws, src, { context: [ctx] })).assignment;
  const lease = await claim(a.id);
  const { artifactId } = await submit(lease);
  await review(A, a.id, artifactId, "request_changes", "More detail");
  await cancel(A, a.id);
  assert.equal((await one("select count(*) c from public.assignment_artifacts where id = $1", [artifactId])).c, 1);

  const del = async (id) => (await as(db, "authenticated", A, "select public.delete_note($1, 1, false, false) r", [id]))[0].r;
  assert.equal((await del(ctx)).status, "deleted");
  assert.equal((await del(src)).status, "deleted");
  const r = await row(a.id);
  assert.equal(r.source_note_id, null);
  assert.equal(r.state, "canceled");
  assert.equal((await one("select note_id from public.assignment_context_items where assignment_id = $1", [a.id])).note_id, null);
  assert.equal((await one("select count(*) c from public.assignment_artifacts where id = $1", [artifactId])).c, 1);
});

// Workspace moves (decided by Tony, 2026-10-14): refused while an active
// assignment references the item; finished assignments detach instead.
const move = async (id, ws) => {
  const current = await one("select revision, title, bucket from public.notes where id = $1", [id]);
  return (await as(db, "authenticated", A, "select public.save_notes($1::jsonb, false) r", [JSON.stringify([{
    id, workspace_id: ws, title: current.title, content: { type: "doc" }, plain_text: "", bucket: current.bucket, tags: [],
    completed_at: null, expected_revision: Number(current.revision),
  }])]))[0].r[0];
};
const wsOf = async (id) => (await one("select workspace_id from public.notes where id = $1", [id])).workspace_id;

test("moving an item used by an active assignment is refused, as source or context", { skip }, async () => {
  const ws = await newWs();
  const to = await newWs();
  const src = await note(A, ws);
  const ctx = await note(A, ws, "note");
  const a = (await create(A, ws, src, { context: [ctx] })).assignment;
  const states = [];
  const check = async (label) => {
    for (const id of [src, ctx]) {
      const r = await move(id, to);
      assert.deepEqual([r.status, r.code], ["invalid", "assignment_active"], `${label}: save_notes`);
      assert.equal(await wsOf(id), ws);
      await assert.rejects(as(db, "authenticated", A, "update public.notes set workspace_id = $1 where id = $2", [to, id]),
        /assignment_active/, `${label}: direct update`);
    }
    states.push((await row(a.id)).state);
  };
  await check("queued");
  const lease = await claim(a.id);
  await check("running");
  const asked = await ask(lease);
  await check("needs_input");
  await answer(A, a.id, asked.questionId);
  await submit(await claim(a.id));
  await check("needs_review");
  assert.deepEqual(states, ["queued", "running", "needs_input", "needs_review"]);
  const r = await row(a.id);
  assert.equal(r.source_note_id, src, "nothing was detached");
  assert.equal((await one("select note_id from public.assignment_context_items where assignment_id = $1", [a.id])).note_id, ctx);
  // A finished assignment on the same item does not unblock it.
  const other = await note(A, ws, "note");
  const done = (await create(A, ws, other, { context: [ctx] })).assignment;
  await cancel(A, done.id);
  assert.equal((await move(ctx, to)).code, "assignment_active");
  assert.equal((await one("select note_id from public.assignment_context_items where assignment_id = $1", [done.id])).note_id, ctx,
    "a refused move detaches nothing");
});

test("after completing, canceling or failing, the move succeeds and the assignment detaches", { skip }, async () => {
  const finish = {
    completed: async (a) => { const lease = await claim(a.id); const s = await submit(lease); await review(A, a.id, s.artifactId, "accept"); },
    canceled: async (a) => { const lease = await claim(a.id); const s = await submit(lease);
      await review(A, a.id, s.artifactId, "request_changes", "More"); await cancel(A, a.id); },
    failed: async (a) => { const lease = await claim(a.id); await ask(lease).then(({ questionId }) => answer(A, a.id, questionId));
      await fail(await claim(a.id)); },
  };
  for (const [state, run] of Object.entries(finish)) {
    const ws = await newWs();
    const to = await newWs();
    const src = await note(A, ws);
    const ctx = await note(A, ws, "note");
    const kept = await note(A, ws, "note");
    const a = (await create(A, ws, src, { context: [ctx, kept] })).assignment;
    await run(a);
    const before = await row(a.id);
    assert.equal(before.state, state);
    const counts = async () => (await q(`select
      (select count(*)::int from public.assignment_events where assignment_id = $1) events,
      (select count(*)::int from public.assignment_artifacts where assignment_id = $1) artifacts,
      (select count(*)::int from public.assignment_attempts where assignment_id = $1) attempts,
      (select count(*)::int from public.assignment_questions where assignment_id = $1) questions,
      (select count(*)::int from public.assignment_reviews where assignment_id = $1) reviews`, [a.id]))[0];
    const had = await counts();

    assert.equal((await move(src, to)).status, "saved", `${state}: source moves`);
    assert.equal((await move(ctx, to)).status, "saved", `${state}: context moves`);
    assert.deepEqual([await wsOf(src), await wsOf(ctx)], [to, to]);

    const after = await row(a.id);
    assert.deepEqual([after.state, after.source_note_id, after.requested_outcome, after.error_code, after.workspace_id],
      [state, null, before.requested_outcome, before.error_code, ws], `${state}: detached, history kept`);
    assert.equal(Number(after.revision), Number(before.revision) + 1);
    const context = await q("select note_id, position, revision_at_selection from public.assignment_context_items where assignment_id = $1 order by position", [a.id]);
    assert.deepEqual(context.map((c) => [c.note_id, c.position, Number(c.revision_at_selection)]), [[null, 1, 1], [kept, 2, 1]],
      `${state}: context row kept without its link; other context untouched`);
    const now = await counts();
    assert.deepEqual(now, { ...had, events: had.events + 2 }, `${state}: artifacts and history kept`);
    const detached = (await events(a.id)).filter((e) => e.type === "item_detached");
    assert.deepEqual(detached.map((e) => [e.actor, e.payload]),
      [["system", { noteId: src, role: "source" }], ["system", { noteId: ctx, role: "context" }]]);
    // The owner can still read the whole detail through RLS.
    for (const table of TABLES.slice(1))
      assert.equal((await as(db, "authenticated", A, `select 1 from public.${table} where assignment_id = $1`, [a.id])).length,
        table === "assignment_events" ? now.events : table === "assignment_context_items" ? 2
          : now[table.replace("assignment_", "")], `${state}: ${table}`);
    // The moved item can be delegated again in its new workspace.
    assert.equal((await create(A, to, src, { context: [ctx] })).status, "created");
  }
});

// --- RLS, grants, append-only ---------------------------------------------------------------

const TABLES = ["assignments", "assignment_context_items", "assignment_events", "assignment_questions",
  "assignment_artifacts", "assignment_reviews"];

test("RLS: owners read only their own rows; nobody writes directly", { skip }, async () => {
  const ws = await newWs(B);
  const { a, lease } = await claimed(B, ws, { context: [await note(B, ws, "note")] });
  const asked = await ask(lease);
  await answer(B, a.id, asked.questionId);
  const { artifactId } = await submit(await claim(a.id));
  await review(B, a.id, artifactId, "request_changes", "Shorter");
  await submit(await claim(a.id));
  for (const table of TABLES) {
    const col = table === "assignments" ? "id" : "assignment_id";
    assert.ok((await as(db, "authenticated", B, `select ${col} from public.${table} where ${col} = $1`, [a.id])).length > 0, table);
    assert.equal((await as(db, "authenticated", A, `select ${col} from public.${table} where ${col} = $1`, [a.id])).length, 0, table);
    await assert.rejects(as(db, "anon", null, `select id from public.${table}`), /permission denied/, `anon ${table}`);
    await assert.rejects(as(db, "authenticated", B, `delete from public.${table}`), /permission denied/, `delete ${table}`);
  }
  assert.equal((await as(db, "authenticated", A, "select id from public.assignment_attempts where assignment_id = $1", [a.id])).length, 0);
  assert.equal((await as(db, "authenticated", B, "select id, status from public.assignment_attempts where assignment_id = $1", [a.id])).length, 3, "three attempts");
  await assert.rejects(as(db, "authenticated", B, "select lease_token from public.assignment_attempts"), /permission denied/,
    "lease tokens are never readable by browsers");
  await assert.rejects(as(db, "authenticated", B, "update public.assignments set state = 'completed' where id = $1", [a.id]), /permission denied/);
  await assert.rejects(as(db, "authenticated", B, `insert into public.assignments (user_id, workspace_id, requested_outcome) values ($1, $2, 'x')`, [B, WB]),
    /permission denied/);
  await assert.rejects(as(db, "authenticated", B, "insert into public.assignment_transitions values ('failed', 'completed', 'user', 'T99')"),
    /permission denied/);
  assert.equal((await as(db, "authenticated", A, "select * from public.assignment_transitions")).length, 17);
  // Other users' rows are invisible through the functions too.
  assert.deepEqual(await cancel(A, a.id, 3), { status: "not_found" });
  assert.deepEqual(await review(A, a.id, uuid(), "accept", null, 3), { status: "not_found" });
  assert.deepEqual(await answer(A, a.id, uuid(), "x", 3), { status: "not_found" });
  assert.equal((await row(a.id)).state, "needs_review");
});

test("grants: anon refused; authenticated can't call executor or system functions", { skip }, async () => {
  const a = await assignment();
  const lease = { attemptId: uuid(), leaseToken: uuid() };
  const executor = [
    ["select public.claim_assignment($1, null)", [a.id]],
    ["select public.heartbeat_assignment($1, $2, null)", [lease.attemptId, lease.leaseToken]],
    ["select public.ask_assignment_question($1, $2, 'q')", [lease.attemptId, lease.leaseToken]],
    ["select public.submit_assignment_artifact($1, $2, '{}')", [lease.attemptId, lease.leaseToken]],
    ["select public.fail_assignment_attempt($1, $2, 'internal')", [lease.attemptId, lease.leaseToken]],
    ["select public.fail_assignment_system($1, 'internal')", [a.id]],
    ["select public.reap_assignment_leases()", []],
  ];
  const userFns = [
    ["select public.create_assignment($1, $2, 'x', '{}', 'builtin', null)", [WA, uuid()]],
    ["select public.transition_assignment($1, 1, 'canceled', null)", [a.id]],
    ["select public.answer_assignment_question($1, 1, $2, 'x')", [a.id, uuid()]],
    ["select public.review_assignment_artifact($1, 1, $2, 'accept', null)", [a.id, uuid()]],
    ["select public.reap_own_assignment_leases()", []],
  ];
  const internal = [
    ["select public.assignment_reap(null)", []],
    ["select public.assignment_move($1, 'canceled', 'user')", [a.id]],
    ["select public.assignment_lease($1, $2)", [lease.attemptId, lease.leaseToken]],
  ];
  for (const [sql, params] of [...executor, ...userFns, ...internal])
    await assert.rejects(as(db, "anon", null, sql, params), /permission denied/, `anon: ${sql}`);
  for (const [sql, params] of [...executor, ...internal])
    await assert.rejects(as(db, "authenticated", A, sql, params), /permission denied/, `authenticated: ${sql}`);
  for (const [sql, params] of [...userFns, ...internal])
    await assert.rejects(as(db, "service_role", null, sql, params), /permission denied/, `service_role: ${sql}`);
  assert.equal((await row(a.id)).state, "queued");
});

test("events are append-only for every role; they go only with their assignment", { skip }, async () => {
  const { a } = await inReview();
  const count = async () => Number((await one("select count(*) c from public.assignment_events where assignment_id = $1", [a.id])).c);
  const total = await count();
  assert.ok(total >= 4);
  for (const role of ["service_role", "authenticated"]) {
    await assert.rejects(as(db, role, A, "update public.assignment_events set payload = '{}' where assignment_id = $1", [a.id]), /permission denied/);
    await assert.rejects(as(db, role, A, "delete from public.assignment_events where assignment_id = $1", [a.id]), /permission denied/);
  }
  await assert.rejects(as(db, "service_role", null, "insert into public.assignment_events (assignment_id, user_id, workspace_id, type, actor) values ($1, $2, $3, 'progress', 'executor')", [a.id, A, WA]),
    /permission denied/);
  // Even the table owner.
  await assert.rejects(db.query("update public.assignment_events set payload = '{}' where assignment_id = $1", [a.id]), /assignment_events_append_only/);
  await assert.rejects(db.query("delete from public.assignment_events where assignment_id = $1", [a.id]), /assignment_events_append_only/);
  await assert.rejects(db.query("truncate public.assignment_events"), /assignment_events_append_only/);
  await assert.rejects(db.query("delete from public.assignment_attempts where assignment_id = $1", [a.id]), /assignment_events_append_only/,
    "deleting an attempt can't rewrite events");
  assert.equal(await count(), total);
  await db.query("delete from public.assignments where id = $1", [a.id]);
  assert.equal(await count(), 0, "cascade from the assignment");
});

test("deleting a workspace or an account removes its assignments", { skip }, async () => {
  const D = "dddddddd-0000-4000-8000-000000000004";
  await db.query("insert into auth.users values ($1)", [D]);
  await db.query(`insert into public.agent_settings (user_id, provider, model, api_key_ciphertext, key_hint) values ($1, 'anthropic', 'm', 'x', 'abcd')`, [D]);
  const ws = async () => (await one(`insert into public.workspaces (user_id, name, agent_enabled) values ($1, 'W', true) returning id`, [D])).id;
  const W1 = await ws();
  const W2 = await ws();
  const { a: a1 } = await inReview(D, W1, { context: [await note(D, W1, "note")] });
  const { a: a2 } = await inReview(D, W2);
  await db.query("delete from public.workspaces where id = $1", [W1]);
  assert.equal(await row(a1.id), undefined);
  for (const table of TABLES.slice(1))
    assert.equal(Number((await one(`select count(*) c from public.${table} where assignment_id = $1`, [a1.id])).c), 0, table);
  assert.ok(await row(a2.id));
  await db.query("delete from auth.users where id = $1", [D]);
  assert.equal(await row(a2.id), undefined);
  assert.equal(Number((await one("select count(*) c from public.assignment_events where user_id = $1", [D])).c), 0);
});
