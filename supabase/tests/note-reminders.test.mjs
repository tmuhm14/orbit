import { test, before } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, skip } from "./harness.mjs";
import { reminderFireAt } from "../../lib/reminders.ts";

// D-03: the reminder contract (ADR 001 §4) against PGlite. The database
// derives fire_at from the wall-clock fields for every writer; lib/reminders
// implements the same rules with Intl, and the two are compared here. No
// dispatch or recurrence (D-04).
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
let n = 0;
const uuid = () => `ffffffff-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const CHI = "America/Chicago";

let db, WA, WA2, WB;
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const fireAt = async (date, time, zone) =>
  (await q("select public.reminder_fire_at($1::date, $2::time, $3) a", [date, time, zone]))[0].a.toISOString();
const create = async (user, note, date, time, zone) =>
  (await as(db, "authenticated", user, "select public.create_note_reminder($1, $2::date, $3::time, $4) r",
    [note, date, time, zone]))[0].r;
const change = async (user, id, rev, action, date = null, time = null, zone = null) =>
  (await as(db, "authenticated", user, "select public.change_note_reminder($1, $2, $3, $4::date, $5::time, $6) r",
    [id, rev, action, date, time, zone]))[0].r;
const reminder = async (id) => (await q("select * from public.note_reminders where id = $1", [id]))[0];
const noteRevision = async (id) => Number((await q("select revision from public.notes where id = $1", [id]))[0].revision);
async function note(user, ws) {
  const id = uuid();
  const [r] = (await as(db, "authenticated", user, "select public.save_notes($1::jsonb, false) r", [JSON.stringify([{
    id, workspace_id: ws, title: "t", content: { type: "doc" }, plain_text: "", bucket: "waiting", tags: [],
    created_at: "2026-10-13T00:00:00.000Z", completed_at: null, expected_revision: null,
  }])]))[0].r;
  assert.equal(r.status, "saved");
  return id;
}

before(async () => {
  if (skip) return;
  db = await createDb();
  await migrate(db);
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  const ws = async (user) => (await q(`insert into public.workspaces (user_id, name) values ($1, 'W') returning id`, [user]))[0].id;
  WA = await ws(A);
  WA2 = await ws(A);
  WB = await ws(B);
});

// --- Time zone rules ----------------------------------------------------------------

test("fire_at: America/Chicago spring-forward gap shifts to the jump, fall-back uses the first occurrence", { skip }, async () => {
  const cases = [
    // 2026-03-08: clocks go 02:00 CST → 03:00 CDT (08:00Z).
    ["2026-03-08", "01:59", "2026-03-08T07:59:00.000Z"],
    ["2026-03-08", "02:00", "2026-03-08T08:00:00.000Z"],
    ["2026-03-08", "02:30", "2026-03-08T08:00:00.000Z"],
    ["2026-03-08", "02:59", "2026-03-08T08:00:00.000Z"],
    ["2026-03-08", "03:00", "2026-03-08T08:00:00.000Z"],
    ["2026-03-08", "03:01", "2026-03-08T08:01:00.000Z"],
    // 2026-11-01: clocks go 02:00 CDT → 01:00 CST; 01:00–01:59 happens twice.
    ["2026-11-01", "00:59", "2026-11-01T05:59:00.000Z"],
    ["2026-11-01", "01:00", "2026-11-01T06:00:00.000Z"],
    ["2026-11-01", "01:30", "2026-11-01T06:30:00.000Z"],
    ["2026-11-01", "01:59", "2026-11-01T06:59:00.000Z"],
    ["2026-11-01", "02:00", "2026-11-01T08:00:00.000Z"],
    // Ordinary days either side.
    ["2026-07-04", "09:00", "2026-07-04T14:00:00.000Z"],
    ["2026-12-24", "09:00", "2026-12-24T15:00:00.000Z"],
  ];
  for (const [date, time, expected] of cases) {
    assert.equal(await fireAt(date, time, CHI), expected, `${date} ${time} (database)`);
    assert.equal(reminderFireAt(date, time, CHI), expected, `${date} ${time} (lib/reminders)`);
  }
});

test("fire_at: zones without DST, half-hour zones and the southern hemisphere", { skip }, async () => {
  const cases = [
    ["2026-03-08", "02:30", "Asia/Kolkata", "2026-03-07T21:00:00.000Z"],
    ["2026-11-01", "01:30", "Asia/Tokyo", "2026-10-31T16:30:00.000Z"],
    ["2026-03-08", "02:30", "UTC", "2026-03-08T02:30:00.000Z"],
    ["2026-03-08", "02:30", "America/Phoenix", "2026-03-08T09:30:00.000Z"],
    // Lord Howe moves by 30 minutes: 02:00 → 02:30 on 2026-10-04.
    ["2026-10-04", "02:15", "Australia/Lord_Howe", "2026-10-03T15:30:00.000Z"],
    ["2026-04-05", "01:45", "Australia/Lord_Howe", "2026-04-04T14:45:00.000Z"],
    // Sydney: 02:00 → 03:00 on 2026-10-04; 03:00 → 02:00 on 2026-04-05.
    ["2026-10-04", "02:30", "Australia/Sydney", "2026-10-03T16:00:00.000Z"],
    ["2026-04-05", "02:30", "Australia/Sydney", "2026-04-04T15:30:00.000Z"],
  ];
  for (const [date, time, zone, expected] of cases) {
    assert.equal(await fireAt(date, time, zone), expected, `${zone} ${date} ${time} (database)`);
    assert.equal(reminderFireAt(date, time, zone), expected, `${zone} ${date} ${time} (lib/reminders)`);
  }
});

test("fire_at: lib/reminders matches the database across whole transition days", { skip }, async () => {
  const days = [
    ["2026-03-08", CHI], ["2026-11-01", CHI], ["2026-03-29", "Europe/London"], ["2026-10-25", "Europe/Berlin"],
    ["2026-10-04", "Australia/Lord_Howe"], ["2026-04-05", "Australia/Sydney"], ["2026-09-06", "America/Santiago"],
  ];
  for (const [date, zone] of days) {
    const rows = await q(`select to_char(t, 'HH24:MI') hm, public.reminder_fire_at($1::date, t::time, $2) a
      from generate_series(timestamp '2000-01-01 00:00', timestamp '2000-01-01 23:45', interval '15 minutes') t`, [date, zone]);
    for (const row of rows)
      assert.equal(reminderFireAt(date, row.hm, zone), row.a.toISOString(), `${zone} ${date} ${row.hm}`);
  }
});

test("time zones are validated against the tz database", { skip }, async () => {
  const valid = async (zone) => (await q("select public.is_time_zone($1) v", [zone]))[0].v;
  for (const zone of [CHI, "UTC", "Asia/Kolkata", "US/Central"]) assert.equal(await valid(zone), true, zone);
  for (const zone of ["Nope/Zone", "CST", "", null, "x".repeat(65)]) assert.equal(await valid(zone), false, String(zone));
});

// --- Create, change, ownership --------------------------------------------------------

test("create: derives fire_at, scopes to the item's owner and workspace, one waiting per item", { skip }, async () => {
  const N = await note(A, WA);
  const r = await create(A, N, "2097-03-10", "02:30", CHI);
  assert.equal(r.status, "created");
  assert.deepEqual(
    [r.reminder.note_id, r.reminder.workspace_id, r.reminder.local_date, r.reminder.local_time, r.reminder.timezone,
      r.reminder.status, r.reminder.revision],
    [N, WA, "2097-03-10", "02:30", CHI, "scheduled", 1]);
  assert.equal(new Date(r.reminder.fire_at).toISOString(), "2097-03-10T08:00:00.000Z", "spring-forward gap");
  assert.equal(await noteRevision(N), 1, "a reminder never bumps the item's revision");
  const again = await create(A, N, "2097-04-01", "09:00", CHI);
  assert.deepEqual([again.status, again.reminder.id], ["reminder_exists", r.reminder.id]);
  assert.deepEqual(await create(A, N, "2026-10-01", "09:00", CHI), { status: "reminder_in_past" });
  assert.deepEqual(await create(A, await note(A, WA), "2097-01-01", "09:00", "Nope/Zone"), { status: "invalid_timezone" });
  assert.deepEqual(await create(A, await note(A, WA), "2097-01-01", "09:00", "CST"), { status: "invalid_timezone" });
  assert.deepEqual(await create(A, uuid(), "2097-01-01", "09:00", CHI), { status: "not_found" });
  assert.deepEqual(await create(B, N, "2097-01-01", "09:00", CHI), { status: "not_found" }, "another user's item");
  await assert.rejects(as(db, "anon", null, "select public.create_note_reminder($1, '2097-01-01', '09:00', 'UTC')", [N]));
  await assert.rejects(as(db, "authenticated", null, "select public.create_note_reminder($1, '2097-01-01', '09:00', 'UTC')", [N]),
    /Not signed in/);
});

test("change: update, snooze and cancel at the expected revision", { skip }, async () => {
  const N = await note(A, WA);
  const { reminder: r } = await create(A, N, "2097-01-10", "09:00", CHI);
  assert.deepEqual(await change(A, r.id, null, "update", "2097-01-11"), { status: "precondition_required" });
  const stale = await change(A, r.id, 5, "update", "2097-01-11");
  assert.deepEqual([stale.status, stale.currentRevision, stale.current.id], ["conflict", 1, r.id]);
  assert.deepEqual(await change(A, r.id, 1, "dismiss"), { status: "invalid_action" });
  let s = await change(A, r.id, 1, "update", null, "17:45");
  assert.deepEqual([s.status, s.reminder.revision, s.reminder.local_date, s.reminder.local_time, s.reminder.status],
    ["saved", 2, "2097-01-10", "17:45", "scheduled"], "absent fields keep their value");
  assert.equal(new Date(s.reminder.fire_at).toISOString(), "2097-01-10T23:45:00.000Z");
  s = await change(A, r.id, 2, "update", null, null, "Asia/Kolkata");
  assert.equal(new Date(s.reminder.fire_at).toISOString(), "2097-01-10T12:15:00.000Z", "same wall clock, new zone");
  assert.deepEqual(await change(A, r.id, 3, "update", null, null, "Nope/Zone"), { status: "invalid_timezone" });
  assert.deepEqual(await change(A, r.id, 3, "snooze", "2026-01-01", "09:00"), { status: "reminder_in_past" });
  s = await change(A, r.id, 3, "snooze", "2097-01-12", "08:00");
  assert.deepEqual([s.status, s.reminder.status, s.reminder.revision], ["saved", "snoozed", 4]);
  assert.equal((await create(A, N, "2097-02-01", "09:00", CHI)).status, "reminder_exists", "a snoozed reminder is still waiting");
  assert.deepEqual(await change(B, r.id, 4, "cancel"), { status: "not_found" }, "another user");
  s = await change(A, r.id, 4, "cancel");
  assert.deepEqual([s.status, s.reminder.status, s.reminder.revision], ["saved", "canceled", 5]);
  assert.deepEqual(await change(A, r.id, 5, "update", "2097-02-01"), { status: "reminder_closed" });
  assert.deepEqual(await change(A, r.id, 5, "cancel"), { status: "reminder_closed" });
  assert.equal((await create(A, N, "2097-02-01", "09:00", CHI)).status, "created", "a new one after canceling");
  assert.equal(await noteRevision(N), 1, "the item's revision never moved");
});

test("RLS: owners only, and a reminder can't point at another workspace or user", { skip }, async () => {
  const N = await note(A, WA);
  const { reminder: r } = await create(A, N, "2097-05-01", "09:00", CHI);
  assert.deepEqual(await as(db, "authenticated", B, "select id from public.note_reminders where id = $1", [r.id]), []);
  assert.equal((await as(db, "authenticated", B, "update public.note_reminders set status = 'canceled' where id = $1 returning id", [r.id])).length, 0);
  assert.equal((await as(db, "authenticated", B, "delete from public.note_reminders where id = $1 returning id", [r.id])).length, 0);
  assert.equal((await as(db, "authenticated", A, "select id from public.note_reminders where id = $1", [r.id])).length, 1);
  const insert = (user, ws, noteId, owner = user) => as(db, "authenticated", user,
    `insert into public.note_reminders (user_id, workspace_id, note_id, local_date, local_time, timezone, fire_at)
     values ($1, $2, $3, '2097-06-01', '09:00', 'UTC', now()) returning *`, [owner, ws, noteId]);
  const M = await note(A, WA);
  await assert.rejects(insert(A, WA2, M), /note_reminders_note_fk/, "item in another workspace of the same user");
  await assert.rejects(insert(B, WB, M), /note_reminders_note_fk/, "another user's item");
  await assert.rejects(insert(B, WA, M, A), /row-level security/, "on behalf of another user");
  // Direct writes still get a derived fire_at and a valid zone.
  const [direct] = await insert(A, WA, M);
  assert.equal(direct.fire_at.toISOString(), "2097-06-01T09:00:00.000Z", "fire_at is derived, not taken from the writer");
  await as(db, "authenticated", A, "update public.note_reminders set fire_at = now() where id = $1", [direct.id]);
  assert.equal((await reminder(direct.id)).fire_at.toISOString(), "2097-06-01T09:00:00.000Z");
  assert.equal(Number((await reminder(direct.id)).revision), 1, "no wall-clock change, no revision");
  await assert.rejects(as(db, "authenticated", A, "update public.note_reminders set timezone = 'CST' where id = $1", [direct.id]),
    /invalid_timezone/);
  await assert.rejects(as(db, "authenticated", A, "update public.note_reminders set note_id = $1 where id = $2", [N, direct.id]),
    /reminder_moved/);
  // The workspace is filled from the item when a writer omits it.
  const L = await note(A, WA2);
  const [filled] = await as(db, "authenticated", A,
    `insert into public.note_reminders (note_id, local_date, local_time, timezone, fire_at)
     values ($1, '2097-06-01', '09:00', 'UTC', now()) returning workspace_id, user_id`, [L]);
  assert.deepEqual([filled.workspace_id, filled.user_id], [WA2, A]);
});

test("reminders follow their item to another workspace and are deleted with it", { skip }, async () => {
  const N = await note(A, WA);
  const { reminder: r } = await create(A, N, "2097-05-01", "09:00", CHI);
  const [saved] = (await as(db, "authenticated", A, "select public.save_notes($1::jsonb, false) r", [JSON.stringify([{
    id: N, workspace_id: WA2, title: "t", content: { type: "doc" }, plain_text: "", bucket: "waiting", tags: [],
    created_at: "2026-10-13T00:00:00.000Z", completed_at: null, expected_revision: 1,
  }])]))[0].r;
  assert.equal(saved.status, "saved");
  const moved = await reminder(r.id);
  assert.deepEqual([moved.workspace_id, Number(moved.revision)], [WA2, 1], "moved without a reminder revision");
  assert.equal((await as(db, "authenticated", A, "select public.delete_note($1, 2, false) r", [N]))[0].r.status, "deleted");
  assert.equal(await reminder(r.id), undefined);
});

test("the due index and policies are in place; nothing dispatches", { skip }, async () => {
  const indexes = (await q(`select indexname, indexdef from pg_indexes where tablename = 'note_reminders' order by 1`))
    .map((r) => r.indexname);
  assert.deepEqual(indexes, ["note_reminders_due_idx", "note_reminders_note_idx", "note_reminders_one_active", "note_reminders_pkey"]);
  const policies = (await q(`select cmd from pg_policies where tablename = 'note_reminders' order by cmd`)).map((r) => r.cmd);
  assert.deepEqual(policies, ["DELETE", "INSERT", "SELECT", "UPDATE"]);
  const fns = (await q(`select proname, prosecdef from pg_proc where proname in
    ('create_note_reminder', 'change_note_reminder') order by 1`)).map((r) => [r.proname, r.prosecdef]);
  assert.deepEqual(fns, [["change_note_reminder", true], ["create_note_reminder", true]]);
});
