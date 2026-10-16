import { test } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, migrationFiles, skip } from "./harness.mjs";

// A-04's migration is applied to production before the code that uses it.
// Proof that it changes nothing for the deployed app:
// 1. Catalog: every function, trigger, policy, table, column, grant,
//    constraint and index that existed before is byte-for-byte the same
//    afterwards. The only additions are the jobs and job_steps tables (with
//    their own columns, constraints and indexes, RLS on and no policies) and
//    the new job functions.
// 2. Behavior: the assignment paths (create, claim, heartbeat, ask, answer,
//    submit, review, cancel, retry, fail, system fail, both reapers) and the
//    note write paths give the same results, rows and events on a database
//    without the migration and on one with every migration.
const MIGRATION = "20261020000000_durable_jobs.sql";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW_TABLES = ["job_steps", "jobs"];
const NEW_FUNCTIONS = [
  "cancel_job(p_job_id uuid, p_kind text, p_idempotency_key text)",
  "claim_jobs(p_worker text, p_lease_seconds integer, p_batch_size integer, p_kinds text[], p_job_id uuid)",
  "complete_job(p_job_id uuid, p_lease_token uuid)",
  "enqueue_job(p_kind text, p_idempotency_key text, p_payload jsonb, p_run_at timestamp with time zone, p_max_attempts integer, p_backoff_base_seconds integer, p_backoff_max_seconds integer)",
  "fail_job(p_job_id uuid, p_lease_token uuid, p_error_code text, p_retryable boolean)",
  "heartbeat_job(p_job_id uuid, p_lease_token uuid, p_lease_seconds integer)",
  "job_backoff_seconds(p_attempts integer, p_base integer, p_max integer)",
  "job_lease(p_job_id uuid, p_lease_token uuid)",
  "job_payload_valid(p jsonb)",
  "purge_jobs()",
  "reap_jobs()",
  "release_job(p_job_id uuid, p_lease_token uuid, p_delay_seconds integer)",
  "save_job_step(p_job_id uuid, p_lease_token uuid, p_name text, p_status text, p_result jsonb)",
];

async function database(until) {
  const db = await createDb();
  await migrate(db, { until });
  await db.exec(`insert into auth.users values ('${A}');`);
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
    indexes: await rows(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 2`),
    types: await rows(`select typname from pg_type t join pg_namespace s on s.oid = t.typnamespace
      where s.nspname = 'public' order by 1`),
  };
}

test("catalog: nothing existing changes; only the job tables and functions are added", { skip }, async () => {
  const before = await catalog(await database(MIGRATION));
  // Up to and including this migration only: later migrations (A-05) have their own test.
  const after = await catalog(await database(migrationFiles().find((f) => f > MIGRATION)));
  assert.ok(before.functions.length > 40);
  const isNew = (table) => NEW_TABLES.includes(table);
  assert.deepEqual(after.functions.filter((f) => !NEW_FUNCTIONS.includes(f.k)), before.functions);
  assert.deepEqual(after.functions.filter((f) => NEW_FUNCTIONS.includes(f.k)).map((f) => f.k), NEW_FUNCTIONS);
  assert.deepEqual(after.triggers, before.triggers, "no triggers added or changed");
  assert.deepEqual(after.policies, before.policies, "no policies added or changed");
  assert.deepEqual(after.tables.filter((t) => !isNew(t.relname)), before.tables);
  assert.deepEqual(after.tables.filter((t) => isNew(t.relname)).map((t) => [t.relname, t.relrowsecurity]),
    [["job_steps", true], ["jobs", true]]);
  assert.deepEqual(after.columns.filter((c) => !isNew(c.table_name)), before.columns);
  assert.deepEqual(after.constraints.filter((c) => !isNew(c.t)), before.constraints);
  assert.deepEqual(after.indexes.filter((i) => !isNew(i.tablename)), before.indexes);
  assert.deepEqual(after.types.filter((t) => !/^_?(jobs|job_steps)$/.test(t.typname)), before.types);
  // New functions: security definer service_role entry points, internal helpers revoked from everyone.
  for (const f of after.functions.filter((x) => NEW_FUNCTIONS.includes(x.k))) {
    assert.deepEqual(f.proconfig, ["search_path=\"\""], f.k);
    assert.ok(!/anon=|authenticated=|(^|[{,])=X\//.test(f.acl), `${f.k} is not callable by anon, authenticated or public: ${f.acl}`);
    const helper = /^job_(lease|payload_valid|backoff_seconds)\(/.test(f.k);
    assert.equal(f.prosecdef, !helper, f.k);
    assert.equal(/service_role=X/.test(f.acl), !helper, f.k);
  }
});

async function scenario(until) {
  const db = await database(until);
  const names = new Map();
  const norm = (value) => JSON.parse(JSON.stringify(value, (k, v) => {
    if (/(_at|At)$/.test(k)) return v === null ? null : "*";
    if (typeof v === "string" && names.has(v)) return names.get(v);
    return v;
  }));
  const name = (id, label) => (id && !names.has(id) && names.set(id, `${label}${names.size}`), id);
  const user = async (sql, params = []) => (await as(db, "authenticated", A, sql, params))[0]?.r;
  const svc = async (sql, params = []) => (await as(db, "service_role", null, sql, params))[0]?.r;
  const ws = async () =>
    name((await db.query(`insert into public.workspaces (user_id, name, agent_enabled) values ($1, 'W', true) returning id`, [A])).rows[0].id, "W");
  await db.query(`insert into public.agent_settings (user_id, provider, model, api_key_ciphertext, key_hint)
    values ($1, 'anthropic', 'm', 'x', 'abcd')`, [A]);
  let n = 0;
  const note = async (w) => {
    const id = `77777777-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const r = await user("select public.save_notes($1::jsonb, false) r", [JSON.stringify([{ id, workspace_id: w, title: "t",
      content: { type: "doc" }, plain_text: "", bucket: "next", tags: [], kind: "task", created_at: "2026-10-13T00:00:00.000Z",
      completed_at: null, expected_revision: null }])]);
    assert.equal(r[0].status, "saved");
    return id;
  };
  const out = [];
  const push = (label, value) => out.push([label, norm(value)]);
  const rev = async (id) => Number((await db.query("select revision from public.assignments where id = $1", [id])).rows[0].revision);
  const create = async (w, source) => {
    const r = await user("select public.create_assignment($1, $2, 'Outcome', '{}'::uuid[], 'builtin', null) r", [w, source]);
    name(r.assignment?.id, "A");
    return r;
  };
  const claim = async (id) => {
    const r = await svc("select public.claim_assignment($1, 90) r", [id]);
    name(r.attemptId, "T");
    name(r.leaseToken, "L");
    return r;
  };
  const submit = async (l) => {
    const r = await svc("select public.submit_assignment_artifact($1, $2, $3::jsonb) r", [l.attemptId, l.leaseToken,
      JSON.stringify({ kind: "draft", title: "R", content: { type: "doc" }, plain_text: "md", source_note_ids: [] })]);
    name(r.artifactId, "R");
    return r;
  };
  const transition = async (id, to) => user("select public.transition_assignment($1, $2, $3, null) r", [id, await rev(id), to]);

  const W1 = await ws();
  const W2 = await ws();
  const a1 = await create(W1, await note(W1));
  push("create", a1);
  const id1 = a1.assignment.id;
  const l1 = await claim(id1);
  push("claim", l1);
  push("claim-again", await claim(id1));
  push("heartbeat", await svc("select public.heartbeat_assignment($1, $2, 'Drafting') r", [l1.attemptId, l1.leaseToken]));
  const asked = await svc("select public.ask_assignment_question($1, $2, 'Which tone?') r", [l1.attemptId, l1.leaseToken]);
  name(asked.questionId, "Q");
  push("ask", asked);
  push("answer", await user("select public.answer_assignment_question($1, $2, $3, 'Formal') r", [id1, await rev(id1), asked.questionId]));
  const l2 = await claim(id1);
  const r1 = await submit(l2);
  push("submit", r1);
  const review = async (id, artifact, decision, comment = null) => {
    const r = await user("select public.review_assignment_artifact($1, $2, $3, $4, $5) r", [id, await rev(id), artifact, decision, comment]);
    name(r.reviewId, "V");
    return r;
  };
  push("review-changes", await review(id1, r1.artifactId, "request_changes", "Shorter"));
  const r2 = await submit(await claim(id1));
  push("review-accept", await review(id1, r2.artifactId, "accept"));
  const a2 = await create(W1, await note(W1));
  const l4 = await claim(a2.assignment.id);
  push("cancel-running", await transition(a2.assignment.id, "canceled"));
  push("fenced", await submit(l4));
  const a3 = await create(W2, await note(W2));
  const l5 = await claim(a3.assignment.id);
  push("fail", await svc("select public.fail_assignment_attempt($1, $2, 'provider_auth') r", [l5.attemptId, l5.leaseToken]));
  push("retry", await transition(a3.assignment.id, "queued"));
  push("system-fail", await svc("select public.fail_assignment_system($1, 'executor_unavailable') r", [a3.assignment.id]));
  const a4 = await create(W2, await note(W2));
  const l6 = await claim(a4.assignment.id);
  await db.query("update public.assignment_attempts set lease_expires_at = now() - interval '1 second' where id = $1", [l6.attemptId]);
  push("reap", await svc("select public.reap_assignment_leases() r"));
  push("reap-own", await user("select public.reap_own_assignment_leases() r"));
  const S = await note(W1);
  push("delete-note", await user("select public.delete_note($1, null, false) r", [S]));

  const table = async (sql) => norm((await db.query(sql)).rows);
  return {
    out,
    assignments: await table(`select id, workspace_id, state, revision, current_attempt_id, error_code from public.assignments order by created_at, id`),
    events: await table(`select assignment_id, attempt_id, type, actor, from_state, to_state, payload from public.assignment_events order by id`),
    attempts: await table(`select t.assignment_id, t.attempt_number, t.status, t.error_code from public.assignment_attempts t
      join public.assignments a on a.id = t.assignment_id order by a.created_at, t.attempt_number`),
    notes: await table(`select id, workspace_id, kind, revision from public.notes order by id`),
  };
}

test("behavior: the assignment and note paths give the same results before and after", { skip }, async () => {
  const before = await scenario(MIGRATION);
  const after = await scenario();
  assert.equal(before.out.length, 17);
  const result = (label) => before.out.find(([l]) => l === label)[1];
  assert.equal(result("review-accept").assignment.state, "completed");
  assert.equal(result("fenced").status, "lease_lost");
  assert.deepEqual(result("reap"), { timedOut: 1, unavailable: 0 });
  assert.ok(before.events.length > 20);
  assert.deepEqual(after.out, before.out);
  for (const key of ["assignments", "events", "attempts", "notes"]) assert.deepEqual(after[key], before[key], key);
});
