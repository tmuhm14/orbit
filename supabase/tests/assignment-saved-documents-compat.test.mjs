import { test } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, skip } from "./harness.mjs";

// U-05's migration is applied to production before the code that uses it.
// Proof that it changes nothing for the deployed app:
// 1. Catalog: every function, trigger, policy, table grant and constraint
//    that existed before is byte-for-byte the same afterwards, except the
//    assignment_events type check, which only gains 'artifact_saved'. The
//    only additions are the new function and index.
// 2. Behavior: every assignment path (create, claim, heartbeat, ask, answer,
//    submit, review, cancel, retry, fail, system fail, reap, workspace moves
//    and deletes of referenced items) and the note write paths give the same
//    results, rows and events on a database without the migration and on
//    one with every migration.
const MIGRATION = "20261019000000_assignment_saved_documents.sql";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

async function database(until) {
  const db = await createDb();
  await migrate(db, { until });
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  return db;
}

async function catalog(db) {
  const rows = async (sql) => (await db.query(sql)).rows;
  return {
    functions: await rows(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' k,
        pg_get_functiondef(p.oid) d, p.prosecdef, p.proconfig, p.proacl::text acl
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' order by 1`),
    triggers: await rows(`select tgrelid::regclass::text t, tgname, pg_get_triggerdef(oid) d
      from pg_trigger where not tgisinternal order by 1, 2`),
    policies: await rows(`select tablename, policyname, cmd, roles::text, qual, with_check
      from pg_policies where schemaname = 'public' order by 1, 2`),
    tables: await rows(`select relname, relacl::text acl, relrowsecurity from pg_class c
      join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and relkind = 'r' order by 1`),
    columns: await rows(`select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'public' order by 1, 2`),
    constraints: await rows(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d
      from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await rows(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by 1`),
  };
}

test("catalog: nothing existing changes; one function, one index and one event type are added", { skip }, async () => {
  const before = await catalog(await database(MIGRATION));
  const after = await catalog(await database());
  assert.ok(before.functions.length > 40);
  for (const key of ["triggers", "policies", "tables", "columns"]) assert.deepEqual(after[key], before[key], key);
  const added = after.functions.filter((f) => !before.functions.some((b) => b.k === f.k));
  assert.deepEqual(added.map((f) => f.k), ["save_assignment_artifact_as_note(p_id uuid, p_expected_revision bigint, p_artifact_id uuid, p_options jsonb)"]);
  assert.deepEqual(after.functions.filter((f) => !added.includes(f)), before.functions);
  assert.deepEqual(after.indexes.filter((i) => i.indexname !== "assignment_artifacts_saved_note_idx"), before.indexes);
  assert.equal(after.indexes.length, before.indexes.length + 1);
  const typeCheck = (c) => c.conname === "assignment_events_type_check";
  assert.deepEqual(after.constraints.filter((c) => !typeCheck(c)), before.constraints.filter((c) => !typeCheck(c)));
  const types = (c) => [...c.find(typeCheck).d.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(types(after.constraints), [...types(before.constraints), "artifact_saved"]);
});

async function scenario(until) {
  const db = await database(until);
  const known = new Set();
  const names = new Map();
  const norm = (value) => JSON.parse(JSON.stringify(value, (k, v) => {
    if (["created_at", "updated_at", "state_changed_at", "finished_at", "leaseExpiresAt", "lease_expires_at", "heartbeat_at",
      "asked_at", "answered_at", "closed_at", "decided_at", "started_at", "superseded_at", "updatedAt", "createdAt"].includes(k))
      return v === null ? null : "*";
    if (typeof v === "string" && names.has(v)) return names.get(v);
    return v;
  }));
  // Random ids (assignments, attempts, artifacts, ...) get stable names in order of appearance.
  const name = (id, label) => (id && !names.has(id) && names.set(id, `${label}${names.size}`), id);
  const user = async (who, sql, params = []) => (await as(db, "authenticated", who, sql, params))[0]?.r;
  const svc = async (sql, params = []) => (await as(db, "service_role", null, sql, params))[0]?.r;
  const ws = async (enabled = true, who = A) =>
    name((await db.query(`insert into public.workspaces (user_id, name, agent_enabled) values ($1, 'W', $2) returning id`, [who, enabled])).rows[0].id, "W");
  for (const who of [A, B])
    await db.query(`insert into public.agent_settings (user_id, provider, model, api_key_ciphertext, key_hint)
      values ($1, 'anthropic', 'm', 'x', 'abcd')`, [who]);
  let n = 0;
  const note = async (w, kind = "task", projectId = null, who = A) => {
    const id = `77777777-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    known.add(id);
    const r = await user(who, "select public.save_notes($1::jsonb, false) r", [JSON.stringify([{ id, workspace_id: w,
      title: "t", content: { type: "doc" }, plain_text: "", bucket: "next", tags: [], kind, project_id: projectId,
      created_at: "2026-10-13T00:00:00.000Z", completed_at: null, expected_revision: null }])]);
    assert.equal(r[0].status, "saved");
    return id;
  };
  const out = [];
  const push = (label, value) => out.push([label, norm(value)]);
  const rev = async (id) => Number((await db.query("select revision from public.assignments where id = $1", [id])).rows[0].revision);
  const create = async (w, source, context = [], who = A) => {
    const r = await user(who, "select public.create_assignment($1, $2, 'Outcome', $3::uuid[], 'builtin', null) r", [w, source, context]);
    name(r.assignment?.id, "A");
    return r;
  };
  const claim = async (id) => {
    const r = await svc("select public.claim_assignment($1, 90) r", [id]);
    name(r.attemptId, "T");
    name(r.leaseToken, "L");
    return r;
  };
  const submit = async (lease, patch = {}) => {
    const r = await svc("select public.submit_assignment_artifact($1, $2, $3::jsonb) r", [lease.attemptId, lease.leaseToken,
      JSON.stringify({ kind: "draft", title: "R", content: { type: "doc" }, plain_text: "md", source_note_ids: [], ...patch })]);
    name(r.artifactId, "R");
    return r;
  };
  const review = async (id, artifact, decision, comment = null) => {
    const r = await user(A, "select public.review_assignment_artifact($1, $2, $3, $4, $5) r", [id, await rev(id), artifact, decision, comment]);
    name(r.reviewId, "V");
    return r;
  };
  const transition = async (id, to) => user(A, "select public.transition_assignment($1, $2, $3, null) r", [id, await rev(id), to]);

  const W1 = await ws();
  const W2 = await ws();
  const Woff = await ws(false);
  const WB = await ws(true, B);
  const P = await note(W1, "project");
  const S1 = await note(W1, "task", P);
  const C1 = await note(W1, "note");
  // Create: success, every refusal.
  const a1 = await create(W1, S1, [C1]);
  push("create", a1);
  push("create-dup", await create(W1, S1));
  push("create-bad-context", await create(W1, await note(W1), [await note(W2)]));
  push("create-off", await create(Woff, await note(Woff)));
  push("create-other", await create(W1, await note(WB, "task", null, B)));
  push("create-payload", await user(A, "select public.create_assignment($1, $2, '  ', '{}', 'builtin', null) r", [W1, S1]));
  push("create-cap", await user(A, "select public.create_assignment($1, $2, 'x', '{}', 'builtin', '{item.write}') r", [W1, await note(W1)]));
  const id1 = a1.assignment.id;
  // Executor: claim, heartbeat, ask, answer, re-claim, submit, request changes, submit, accept.
  const l1 = await claim(id1);
  push("claim", l1);
  push("claim-again", await claim(id1));
  push("heartbeat", await svc("select public.heartbeat_assignment($1, $2, 'Drafting') r", [l1.attemptId, l1.leaseToken]));
  push("heartbeat-bad", await svc("select public.heartbeat_assignment($1, $2, null) r", [l1.attemptId, A]));
  const asked = await svc("select public.ask_assignment_question($1, $2, 'Which tone?') r", [l1.attemptId, l1.leaseToken]);
  name(asked.questionId, "Q");
  push("ask", asked);
  push("answer-stale", await user(A, "select public.answer_assignment_question($1, 1, $2, 'Formal') r", [id1, asked.questionId]));
  push("answer", await user(A, "select public.answer_assignment_question($1, $2, $3, 'Formal') r", [id1, await rev(id1), asked.questionId]));
  const l2 = await claim(id1);
  push("submit-bad-cite", await submit(l2, { source_note_ids: [await note(W1)] }));
  const r1 = await submit(l2, { source_note_ids: [S1, C1] });
  push("submit", r1);
  push("submit-after", await submit(l2));
  push("review-changes", await review(id1, r1.artifactId, "request_changes", "Shorter"));
  const l3 = await claim(id1);
  const r2 = await submit(l3);
  push("review-superseded", await review(id1, r1.artifactId, "accept"));
  push("review-accept", await review(id1, r2.artifactId, "accept"));
  push("cancel-completed", await transition(id1, "canceled"));
  // Cancel while running (fencing), reject, retry after failure, system failure, reaper.
  const a2 = await create(W1, await note(W1));
  const l4 = await claim(a2.assignment.id);
  push("cancel-running", await transition(a2.assignment.id, "canceled"));
  push("fenced", await submit(l4));
  const a3 = await create(W2, await note(W2));
  const l5 = await claim(a3.assignment.id);
  const r3 = await submit(l5);
  push("reject", await review(a3.assignment.id, r3.artifactId, "reject"));
  const a4 = await create(W2, await note(W2));
  const l6 = await claim(a4.assignment.id);
  push("fail", await svc("select public.fail_assignment_attempt($1, $2, 'provider_auth') r", [l6.attemptId, l6.leaseToken]));
  push("retry", await transition(a4.assignment.id, "queued"));
  push("system-fail", await svc("select public.fail_assignment_system($1, 'executor_unavailable') r", [a4.assignment.id]));
  const a5 = await create(W2, await note(W2));
  const l7 = await claim(a5.assignment.id);
  await db.query("update public.assignment_attempts set lease_expires_at = now() - interval '1 second' where id = $1", [l7.attemptId]);
  push("reap", await svc("select public.reap_assignment_leases() r"));
  push("reap-own", await user(A, "select public.reap_own_assignment_leases() r"));
  // Items referenced by assignments: refused move while active, detach when finished, delete.
  const S6 = await note(W1);
  const a6 = await create(W1, S6);
  const move = (id, w, expected) => user(A, "select public.save_notes($1::jsonb, false) r", [JSON.stringify([{ id, workspace_id: w,
    title: "t", content: { type: "doc" }, plain_text: "", bucket: "next", tags: [], created_at: "2026-10-13T00:00:00.000Z",
    completed_at: null, expected_revision: expected }])]);
  push("move-active", await move(S6, W2, 1));
  await transition(a6.assignment.id, "canceled");
  push("move-finished", await move(S6, W2, 1));
  push("delete-source", await user(A, "select public.delete_note($1, null, false) r", [C1]));
  push("delete-project", await user(A, "select public.delete_note($1, 1, false, true) r", [P]));

  const table = async (sql) => norm((await db.query(sql)).rows);
  return {
    out,
    assignments: await table(`select id, workspace_id, source_note_id, state, revision, current_attempt_id, error_code,
      finished_at from public.assignments order by created_at, id`),
    events: await table(`select assignment_id, attempt_id, type, actor, from_state, to_state, payload
      from public.assignment_events order by id`),
    artifacts: await table(`select id, assignment_id, title, plain_text, source_note_ids, saved_note_id, superseded_at
      from public.assignment_artifacts order by created_at, id`),
    attempts: await table(`select t.assignment_id, t.attempt_number, t.status, t.error_code
      from public.assignment_attempts t join public.assignments a on a.id = t.assignment_id
      order by a.created_at, t.attempt_number`),
    notes: await table(`select id, workspace_id, kind, project_id, revision from public.notes order by id`),
  };
}

test("behavior: every assignment and note path gives the same results before and after", { skip }, async () => {
  const before = await scenario(MIGRATION);
  const after = await scenario();
  assert.ok(before.out.length >= 30);
  const result = (label) => before.out.find(([l]) => l === label)[1];
  assert.equal(result("review-accept").assignment.state, "completed");
  assert.equal(result("fenced").status, "lease_lost");
  assert.equal(result("move-active")[0].code, "assignment_active");
  assert.deepEqual(result("reap"), { timedOut: 1, unavailable: 0 });
  assert.ok(before.events.length > 30);
  assert.deepEqual(after.out, before.out);
  for (const key of ["assignments", "events", "artifacts", "attempts", "notes"]) assert.deepEqual(after[key], before[key], key);
});
