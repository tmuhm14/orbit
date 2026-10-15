import { test } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, skip } from "./harness.mjs";

// Data follow-up: note_link_error() maps the workspace-move trigger's
// `assignment_active` to its own code, so save_notes reports it instead of
// `invalid_note`. Proof that nothing else changes: note_link_error() changes
// only inputs it used to map to null, and every caller (save_notes, the agent
// functions and undo) gives the same results, rows and audit rows on a
// database without the migration and on one with every migration. The only
// difference is the refused move's code.
const MIGRATION = "20261018000100_note_assignment_active_code.sql";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const MESSAGES = [null, "", "invalid_project_link", "project_cycle", "project_depth_exceeded",
  "project_has_linked_items", "linked_item_move", "assignment_active", "Assignment_Active",
  "new row violates check constraint", "invalid_note", "not_found"];
const CONSTRAINTS = [null, "", "notes_project_not_self", "notes_project_fk", "notes_bucket_check",
  "notes_id_workspace_user_key"];

async function database(until) {
  const db = await createDb();
  await migrate(db, { until });
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  return db;
}

async function linkErrors(db) {
  const out = [];
  for (const message of MESSAGES)
    for (const constraint of CONSTRAINTS)
      out.push([message, constraint, (await db.query("select public.note_link_error($1, $2) r", [message, constraint])).rows[0].r]);
  return out;
}

test("note_link_error() changes only for assignment_active", { skip }, async () => {
  const before = await linkErrors(await database(MIGRATION));
  const after = await linkErrors(await database());
  assert.equal(before.length, MESSAGES.length * CONSTRAINTS.length);
  for (let i = 0; i < before.length; i++) {
    const [message, constraint] = before[i];
    // Constraint-based codes still win, so only former nulls change.
    if (message === "assignment_active" && before[i][2] === null)
      assert.equal(after[i][2], "assignment_active", `mapped with constraint ${constraint}`);
    else assert.deepEqual(after[i], before[i]);
  }
  const changed = after.filter((r, i) => r[2] !== before[i][2]);
  assert.deepEqual(changed.map(([, c]) => c), [null, "", "notes_bucket_check", "notes_id_workspace_user_key"]);
  // Spot checks that the other branches still apply.
  const at = (rows, m, c) => rows.find(([x, y]) => x === m && y === c)[2];
  assert.equal(at(after, "project_cycle", null), "project_cycle");
  assert.equal(at(after, null, "notes_project_fk"), "linked_item_move");
  assert.equal(at(after, "", "notes_project_not_self"), "invalid_project_link");
  assert.equal(at(after, "invalid_note", "notes_bucket_check"), null);
});

test("the function keeps its signature and stays closed to API roles", { skip }, async () => {
  const db = await database();
  const fns = (await db.query(`select pg_get_function_identity_arguments(p.oid) args, p.provolatile v
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname = 'note_link_error'`)).rows;
  assert.deepEqual(fns, [{ args: "p_message text, p_constraint text", v: "i" }]);
  for (const role of ["anon", "authenticated", "service_role"])
    assert.equal((await db.query("select has_function_privilege($1, 'public.note_link_error(text, text)', 'execute') ok", [role])).rows[0].ok,
      false, role);
});

/**
 * Every caller of note_link_error() with payloads as current main sends
 * them, plus a move refused by an open assignment. Returns normalized
 * results, rows and audit rows.
 */
async function scenario(until) {
  const db = await database(until);
  const save = async (user, items, require = false) =>
    (await as(db, "authenticated", user, "select public.save_notes($1::jsonb, $2) r", [JSON.stringify(items), require]))[0].r;
  const rpc = async (role, sql, params) => (await as(db, role, role === "authenticated" ? A : null, sql, params))[0].r;
  const ws = async (name) => (await db.query(`insert into public.workspaces (user_id, name, agent_enabled) values ($1, $2, true) returning id`, [A, name])).rows[0].id;
  const W1 = await ws("one");
  const W2 = await ws("two");
  await db.query(`insert into public.agent_settings (user_id, provider, model, api_key_ciphertext, key_hint)
    values ($1, 'anthropic', 'm', 'x', 'abcd')`, [A]);
  const run = (await db.query(`insert into public.agent_runs (user_id, workspace_id, trigger, mode, provider, model)
    values ($1, $2, 'manual', 'organize', 'anthropic', 'm') returning id`, [A, W1])).rows[0].id;
  const ids = Array.from({ length: 9 }, (_, i) => `44444444-0000-4000-8000-00000000000${i + 1}`);
  const [N, P, C, S, K, T, X, F, Z] = ids;
  const known = new Set(ids);
  const names = new Map([[W1, "W1"], [W2, "W2"]]);
  const norm = (value) => JSON.parse(JSON.stringify(value, (k, v) =>
    ["updatedAt", "updated_at", "created_at", "actionId", "undone", "assignmentId", "assignment"].includes(k)
      || (k === "id" && typeof v === "string" && !known.has(v)) ? "*" : names.get(v) ?? v));
  const note = (id, w, patch = {}) => ({ id, workspace_id: w, title: "t", content: { type: "doc" }, plain_text: "",
    bucket: "inbox", tags: [], created_at: "2026-10-13T00:00:00.000Z", completed_at: null, ...patch });
  const out = [];
  const push = (label, value) => out.push([label, norm(value)]);

  // save_notes: saved, invalid (generic and every link code), moves.
  push("create", await save(A, [{ ...note(N, W1), expected_revision: null }]));
  push("bad", await save(A, [{ ...note(Z, W1, { bucket: "nope" }), expected_revision: null }]));
  push("project", await save(A, [{ ...note(P, W1, { kind: "project", bucket: "projects" }), expected_revision: null }]));
  push("child", await save(A, [{ ...note(C, W1, { kind: "task", project_id: P }), expected_revision: null }]));
  push("sub", await save(A, [{ ...note(S, W1, { kind: "project", project_id: P }), expected_revision: null }]));
  push("self", await save(A, [{ ...note(K, W1, { kind: "project", project_id: K }), expected_revision: null }]));
  push("cycle", await save(A, [{ ...note(P, W1, { kind: "project", project_id: S }), expected_revision: 1 }]));
  push("not-project", await save(A, [{ ...note(K, W1, { project_id: C }), expected_revision: null }]));
  push("move-linked", await save(A, [{ ...note(C, W2, { kind: "task", project_id: P }), expected_revision: 1 }]));
  push("unkind", await save(A, [{ ...note(P, W1, { kind: "task" }), expected_revision: 1 }]));
  push("move", await save(A, [{ ...note(N, W2), expected_revision: 1 }]));
  push("move-back", await save(A, [{ ...note(N, W1), expected_revision: 2 }]));
  push("other-user", await save(B, [{ ...note(N, W1), expected_revision: 3 }]));
  // A move refused by an open assignment, as source and as context.
  push("task", await save(A, [{ ...note(T, W1, { kind: "task", bucket: "next" }), expected_revision: null },
    { ...note(X, W1), expected_revision: null }]));
  push("assign", await rpc("authenticated", "select public.create_assignment($1, $2, 'Draft it', $3::uuid[], 'builtin', null) r", [W1, T, [X]]));
  push("move-active", await save(A, [{ ...note(T, W2, { kind: "task", bucket: "next" }), expected_revision: 1 },
    { ...note(X, W2), expected_revision: 1 }, { ...note(N, W2), expected_revision: 3 }]));
  await assert.rejects(as(db, "authenticated", A, "update public.notes set workspace_id = $1 where id = $2", [W2, T]), /assignment_active/);
  // Agent functions: refused link changes come back as codes; other errors raise.
  push("agent-link", await rpc("service_role", "select public.agent_apply_note_change($1, $2, 1, $3::jsonb, 'why') r",
    [run, K, JSON.stringify({ kind: "task" })]));
  await save(A, [{ ...note(F, W1), expected_revision: null }]);
  await db.query("update public.notes set triage_status = 'pending' where id = $1", [F]);
  push("agent-cycle", await rpc("service_role", "select public.agent_apply_note_change($1, $2, 1, $3::jsonb, 'why') r",
    [run, F, JSON.stringify({ kind: "task", project_id: C })]));
  const applied = await rpc("service_role", "select public.agent_apply_note_change($1, $2, 1, $3::jsonb, 'why') r",
    [run, F, JSON.stringify({ kind: "task", project_id: P, triage_status: "done" })]);
  push("agent-apply", applied);
  await assert.rejects(rpc("service_role", "select public.agent_apply_note_change($1, $2, 2, $3::jsonb, 'why') r",
    [run, F, JSON.stringify({ bucket: "bogus" })]));
  push("agent-create-linked", await rpc("service_role", "select public.agent_create_note($1, $2::jsonb, 'r') r",
    [run, JSON.stringify({ title: "c", content: { type: "doc" }, bucket: "next", tags: [], project_id: C })]));
  push("agent-create", await rpc("service_role", "select public.agent_create_note($1, $2::jsonb, 'r') r",
    [run, JSON.stringify({ title: "made", content: { type: "doc" }, bucket: "next", tags: [], project_id: P })]));
  // Undo that would recreate a refused link reports it.
  await save(A, [{ ...note(P, W1, { kind: "project", bucket: "projects", title: "p2" }), expected_revision: 1 }]);
  push("undo", await rpc("authenticated", "select public.undo_agent_action($1) r", [applied.actionId]));

  const rows = (await db.query(`select id, workspace_id, title, bucket, revision, kind, project_id, triage_status
    from public.notes order by title, id`)).rows;
  const actions = (await db.query(`select kind, before, after, revision_before, revision_after, undone_at is not null as undone
    from public.agent_actions order by kind, after::text`)).rows;
  const assignments = (await db.query(`select a.state, a.source_note_id, c.note_id context
    from public.assignments a left join public.assignment_context_items c on c.assignment_id = a.id`)).rows;
  return { out, rows: norm(rows), actions: norm(actions), assignments: norm(assignments) };
}

test("save_notes reports assignment_active; every other result is unchanged", { skip }, async () => {
  const before = await scenario(MIGRATION);
  const after = await scenario();
  const result = (run, label) => run.out.find(([l]) => l === label)[1];
  assert.equal(result(before, "assign").status, "created");
  // The codes current main already handles are exercised.
  assert.deepEqual(
    ["bad", "self", "cycle", "not-project", "move-linked", "unkind"].map((l) => result(after, l)[0].code),
    ["invalid_note", "invalid_project_link", "project_cycle", "invalid_project_link", "linked_item_move", "project_has_linked_items"]);
  assert.equal(result(after, "agent-cycle").status, "invalid");
  // The one difference: the refused move's code. The rest of the batch saves.
  const moveBefore = result(before, "move-active");
  const moveAfter = result(after, "move-active");
  assert.deepEqual(moveBefore.map((r) => [r.status, r.code]), [["invalid", "invalid_note"], ["invalid", "invalid_note"], ["saved", undefined]]);
  assert.deepEqual(moveAfter.map((r) => [r.status, r.code]), [["invalid", "assignment_active"], ["invalid", "assignment_active"], ["saved", undefined]]);
  const strip = (run) => run.out.filter(([l]) => l !== "move-active");
  assert.deepEqual(strip(after), strip(before));
  assert.deepEqual(moveAfter.map(({ code: _c, ...r }) => r), moveBefore.map(({ code: _c, ...r }) => r));
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.actions, before.actions);
  assert.deepEqual(after.assignments, before.assignments);
  assert.deepEqual(after.assignments, [{ state: "queued", source_note_id: "44444444-0000-4000-8000-000000000006",
    context: "44444444-0000-4000-8000-000000000007" }], "nothing was detached");
  assert.ok(after.rows.filter((r) => ["44444444-0000-4000-8000-000000000006", "44444444-0000-4000-8000-000000000007"].includes(r.id))
    .every((r) => r.workspace_id === "W1"), "refused items stayed put");
});
