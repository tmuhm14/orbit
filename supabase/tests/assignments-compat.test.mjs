import { test } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, skip } from "./harness.mjs";

// A-01 adds a trigger on public.notes (refuse or detach on workspace moves).
// Proof that it changes nothing for today's writers: every D-01/D-02/D-03
// write path, with payloads as the deployed code sends them and including
// workspace moves, gives the same results, rows, reminders and audit rows on
// a database without the A-01 migration and on one with every migration.
const A01 = "20261017000000_assignments.sql";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

async function scenario(until) {
  const db = await createDb();
  await migrate(db, { until });
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  const save = async (user, items, require = false) =>
    (await as(db, "authenticated", user, "select public.save_notes($1::jsonb, $2) r", [JSON.stringify(items), require]))[0].r;
  const del = async (id, rev, unlink = false) =>
    (await as(db, "authenticated", A, "select public.delete_note($1, $2, false, $3) r", [id, rev, unlink]))[0].r;
  const rpc = async (role, sql, params) => (await as(db, role, role === "authenticated" ? A : null, sql, params))[0].r;
  const ws = async (name) => (await db.query(`insert into public.workspaces (user_id, name, agent_enabled) values ($1, $2, true) returning id`, [A, name])).rows[0].id;
  const W1 = await ws("one");
  const W2 = await ws("two");
  const run = (await db.query(`insert into public.agent_runs (user_id, workspace_id, trigger, mode, provider, model)
    values ($1, $2, 'manual', 'organize', 'anthropic', 'm') returning id`, [A, W1])).rows[0].id;
  const ids = Array.from({ length: 9 }, (_, i) => `33333333-0000-4000-8000-00000000000${i + 1}`);
  const [N, M, P, C, F, R, K, Z, D] = ids;
  const known = new Set(ids);
  // Workspace ids are random per database; compare them by name.
  const names = new Map([[W1, "W1"], [W2, "W2"]]);
  const norm = (value) => JSON.parse(JSON.stringify(value, (k, v) =>
    ["updatedAt", "updated_at", "created_at", "actionId", "undone", "fire_at", "fireAt"].includes(k)
      || (k === "id" && typeof v === "string" && !known.has(v)) ? "*" : names.get(v) ?? v));
  const note = (id, w, patch = {}) => ({ id, workspace_id: w, title: "t", content: { type: "doc" }, plain_text: "",
    bucket: "inbox", tags: [], created_at: "2026-10-13T00:00:00.000Z", completed_at: null, ...patch });
  const out = [];
  const push = (label, value) => out.push([label, norm(value)]);

  // D-01: create, conflicts, legacy and enforced writes.
  push("create", await save(A, [{ ...note(N, W1), expected_revision: null }, { ...note(M, W1), expected_revision: null }]));
  push("update", await save(A, [{ ...note(N, W1, { title: "a", due_date: "2026-12-01" }), expected_revision: 1 }]));
  push("stale", await save(A, [{ ...note(N, W1, { title: "b" }), expected_revision: 1 }]));
  push("legacy", await save(A, [note(N, W1, { title: "c" })]));
  push("enforce", await save(A, [note(N, W1, { title: "d" })], true));
  push("bad", await save(A, [{ ...note(Z, W1, { bucket: "nope" }), expected_revision: null }]));
  push("other-user", await save(B, [{ ...note(N, W1), expected_revision: 3 }]));
  // Workspace moves: plain (with a due date), by save and by direct update.
  push("move", await save(A, [{ ...note(N, W2, { title: "c", due_date: "2026-12-01" }), expected_revision: 3 }]));
  push("move-back", await save(A, [{ ...note(N, W1, { title: "c" }), expected_revision: 4 }]));
  push("move-stale", await save(A, [{ ...note(N, W2, { title: "c" }), expected_revision: 4 }]));
  await as(db, "authenticated", A, "update public.notes set workspace_id = $1 where id = $2", [W2, M]);
  // D-02: kinds and project links; a linked move is refused.
  push("project", await save(A, [{ ...note(P, W1, { kind: "project", bucket: "projects" }), expected_revision: null }]));
  push("child", await save(A, [{ ...note(C, W1, { kind: "task", project_id: P }), expected_revision: null }]));
  push("move-linked", await save(A, [{ ...note(C, W2, { kind: "task", project_id: P }), expected_revision: 1 }]));
  push("move-project", await save(A, [{ ...note(P, W2, { kind: "project", bucket: "projects" }), expected_revision: 1 }]));
  push("unlink-move", await save(A, [{ ...note(C, W2, { kind: "task", project_id: null }), expected_revision: 1 }]));
  // D-03: follow-up fields and reminders; a reminder follows its item's move.
  push("followup", await save(A, [{ ...note(F, W1, { kind: "followup", bucket: "waiting", waiting_on: "Dana",
    waiting_for: "Quote", next_check_on: "2026-10-27" }), expected_revision: null }]));
  const reminder = await rpc("authenticated", "select public.create_note_reminder($1, '2097-01-10', '09:00', 'America/Chicago') r", [F]);
  push("reminder", reminder);
  push("move-followup", await save(A, [{ ...note(F, W2, { kind: "followup", bucket: "waiting" }), expected_revision: 1 }]));
  push("snooze", await rpc("authenticated", "select public.change_note_reminder($1, 1, 'snooze', '2097-01-11', null, null) r", [reminder.reminder.id]));
  push("reminder-ws", (await db.query("select workspace_id, status from public.note_reminders")).rows);
  // Agent writes, audit and undo.
  push("agent-create", await rpc("service_role", "select public.agent_create_note($1, $2::jsonb, 'r') r",
    [run, JSON.stringify({ title: "made", content: { type: "doc" }, plain_text: "", bucket: "next", tags: [] })]));
  await save(A, [{ ...note(K, W1), expected_revision: null }]);
  const applied = await rpc("service_role", "select public.agent_apply_note_change($1, $2, 1, $3::jsonb, 'why') r",
    [run, K, JSON.stringify({ bucket: "next", waiting_on: "Sam" })]);
  push("apply", applied);
  push("undo", await rpc("authenticated", "select public.undo_agent_action($1) r", [applied.actionId]));
  // Deletes, including a moved item and one with a reminder.
  await save(A, [{ ...note(D, W1), expected_revision: null }, { ...note(R, W1), expected_revision: null }]);
  push("delete", await del(D, 1));
  push("delete-moved", await del(N, 4));
  push("delete-followup", await del(F, 2));
  push("delete-project", await del(P, 2, true));
  // Workspace delete cascades.
  const W3 = await ws("three");
  names.set(W3, "W3");
  await save(A, [{ ...note(R, W3), expected_revision: 1 }]);
  await db.query("delete from public.workspaces where id = $1", [W3]);

  const rows = (await db.query(`select id, workspace_id, title, bucket, tags, revision, due_date, kind, project_id,
    waiting_on, waiting_for, next_check_on, completed_at, triage_status from public.notes order by title, id`)).rows

  const reminders = (await db.query(`select note_id, workspace_id, local_date, local_time, timezone, fire_at, status, revision
    from public.note_reminders order by created_at`)).rows;
  const actions = (await db.query(`select kind, before, after, revision_before, revision_after, undone_at is not null as undone
    from public.agent_actions order by kind, after::text`)).rows;
  return { out, rows: norm(rows), reminders: norm(reminders), actions: norm(actions) };
}

test("D-01, D-02 and D-03 writes, including workspace moves, are unchanged by the A-01 migration", { skip }, async () => {
  const before = await scenario(A01);
  const after = await scenario();
  assert.ok(before.out.length >= 25);
  assert.ok(before.out.some(([label, r]) => label === "move" && r[0].status === "saved"), "moves were exercised");
  assert.ok(before.rows.some((r) => r.workspace_id !== before.rows[0].workspace_id), "rows span workspaces");
  const result = (label) => before.out.find(([l]) => l === label)[1];
  assert.deepEqual([result("move-linked")[0].code, result("unlink-move")[0].status, result("move-followup")[0].status],
    ["linked_item_move", "saved", "saved"]);
  assert.deepEqual(result("reminder-ws"), [{ workspace_id: "W2", status: "snoozed" }], "the reminder followed its item");
  assert.deepEqual(after.out, before.out);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.reminders, before.reminders);
  assert.deepEqual(after.actions, before.actions);
});
