import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as notesModule from "../../../../../lib/notes.ts";
import * as remindersModule from "../../../../../lib/reminders.ts";
import { loadTs } from "../../../../../tests/load-ts.mjs";

// Reminder routes with in-memory doubles for auth and the
// create_note_reminder / change_note_reminder functions. The doubles return
// what the SQL contract returns; the functions themselves are exercised
// against Postgres in supabase/tests/note-reminders.test.mjs.
const db = loadTs(new URL("../../../../../lib/reminders-db.ts", import.meta.url), { "./reminders": remindersModule });
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const NOTE = "11111111-1111-4111-8111-111111111111";
const OTHER_NOTE = "22222222-2222-4222-8222-222222222222";
const REM = "33333333-3333-4333-8333-333333333333";
const WS = "12345678-1234-4234-8234-123456789abc";
const json = (body, status = 200) => Response.json(body, { status });
const row = (patch = {}) => ({
  id: REM, note_id: NOTE, workspace_id: WS, local_date: "2097-01-10", local_time: "09:00",
  timezone: "America/Chicago", fire_at: "2097-01-10T15:00:00+00:00", status: "scheduled", revision: 1,
  created_at: "2026-10-14T00:00:00+00:00", updated_at: "2026-10-14T00:00:00+00:00", ...patch,
});

let calls, notes, reminders, rpcResult, signedOut;
beforeEach(() => {
  calls = [];
  notes = new Set([NOTE, OTHER_NOTE]);
  reminders = [row({ local_time: "09:00:00" }), row({ id: "44444444-4444-4444-8444-444444444444", status: "canceled",
    created_at: "2026-10-13T00:00:00+00:00" })];
  rpcResult = null;
  signedOut = false;
});

function from(table) {
  const filters = [];
  const builder = {
    select: (columns) => (calls.push(["select", table, columns]), builder),
    eq: (column, value) => (filters.push([column, value]), calls.push(["eq", table, column, value]), builder),
    order: () => builder,
    limit: () => builder,
    returns: async () => ({ data: reminders.filter((r) => filters.every(([c, v]) => c === "user_id" || r[c] === v)), error: null }),
    maybeSingle: async () => {
      if (table === "notes") {
        const id = filters.find(([c]) => c === "id")[1];
        return { data: notes.has(id) ? { id } : null, error: null };
      }
      return { data: reminders.find((r) => filters.every(([c, v]) => c === "user_id" || r[c] === v)) ?? null, error: null };
    },
  };
  return builder;
}
const supabase = {
  from,
  rpc: async (name, args) => {
    calls.push(["rpc", name, args]);
    return typeof rpcResult === "function" ? rpcResult(name, args) : { data: rpcResult, error: null };
  },
};
const imports = {
  "@/lib/supabase/route-auth": {
    routeUser: async () => (signedOut ? { error: json({ error: "Signed out" }, 401) } : { user: { id: USER }, supabase }),
    json,
  },
  "@/lib/notes": notesModule,
  "@/lib/reminders": remindersModule,
  "@/lib/reminders-db": db,
};
const list = loadTs(new URL("./route.ts", import.meta.url), imports);
const one = loadTs(new URL("./[reminderId]/route.ts", import.meta.url), imports);
const ctx = (id = NOTE, reminderId = REM) => ({ params: Promise.resolve({ id, reminderId }) });
const req = (method, body) => new Request(`http://localhost/api/notes/${NOTE}/reminders`, {
  method, body: typeof body === "string" ? body : JSON.stringify(body),
});
const rpcs = () => calls.filter((c) => c[0] === "rpc");

test("GET lists the item's reminders with the display instant; 404 for another user's item", async () => {
  const response = await list.GET(new Request("http://localhost"), ctx());
  assert.equal(response.status, 200);
  const { reminders: out } = await response.json();
  assert.deepEqual(out.map((r) => [r.localTime, r.status, r.nextFireAt]),
    [["09:00", "scheduled", "2097-01-10T15:00:00.000Z"], ["09:00", "canceled", null]]);
  assert.deepEqual(Object.keys(out[0]).sort(), ["createdAt", "fireAt", "id", "localDate", "localTime", "nextFireAt",
    "noteId", "revision", "status", "timezone", "updatedAt", "workspaceId"]);
  assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "note_reminders" && c[2] === "user_id" && c[3] === USER));
  notes.delete(NOTE);
  const missing = await list.GET(new Request("http://localhost"), ctx());
  assert.deepEqual([missing.status, (await missing.json()).code], [404, "not_found"]);
  assert.equal((await list.GET(new Request("http://localhost"), ctx("nope"))).status, 400);
  signedOut = true;
  assert.equal((await list.GET(new Request("http://localhost"), ctx())).status, 401);
});

test("POST validates wall-clock input before calling the database", async () => {
  const cases = [
    [{ localDate: "2097-01-10", localTime: "09:00" }, 400, "invalid_payload"],
    [{ localDate: "2097-02-30", localTime: "09:00", timezone: "UTC" }, 400, "invalid_payload"],
    [{ localDate: "2097-01-10", localTime: "9:00", timezone: "UTC" }, 400, "invalid_payload"],
    [{ localDate: "2097-01-10", localTime: "09:00", timezone: "UTC", fireAt: "2097-01-10T00:00:00Z" }, 400, "invalid_payload"],
    [{ localDate: "2097-01-10", localTime: "09:00", timezone: "CST" }, 422, "invalid_timezone"],
    [[], 400, "invalid_payload"],
    ["{", 400, "invalid_payload"],
  ];
  for (const [body, status, code] of cases) {
    const response = await list.POST(req("POST", body), ctx());
    assert.deepEqual([response.status, (await response.json()).code], [status, code], JSON.stringify(body));
  }
  assert.equal(rpcs().length, 0, "fire_at is never taken from the client");
});

test("POST creates through the function and maps its results", async () => {
  rpcResult = { status: "created", reminder: row() };
  let response = await list.POST(req("POST", { localDate: "2097-01-10", localTime: "09:00", timezone: "america/chicago" }), ctx());
  assert.equal(response.status, 201);
  const { reminder } = await response.json();
  assert.deepEqual([reminder.fireAt, reminder.nextFireAt, reminder.revision], ["2097-01-10T15:00:00.000Z", "2097-01-10T15:00:00.000Z", 1]);
  assert.deepEqual(rpcs()[0], ["rpc", "create_note_reminder", { p_note_id: NOTE, p_local_date: "2097-01-10",
    p_local_time: "09:00", p_timezone: "America/Chicago" }], "zone sent in canonical form");
  const results = [
    [{ status: "reminder_exists", reminder: row() }, 409, "reminder_exists"],
    [{ status: "reminder_in_past" }, 422, "reminder_in_past"],
    [{ status: "invalid_timezone" }, 422, "invalid_timezone"],
    [{ status: "not_found" }, 404, "not_found"],
  ];
  for (const [data, status, code] of results) {
    rpcResult = data;
    response = await list.POST(req("POST", { localDate: "2097-01-10", localTime: "09:00", timezone: "UTC" }), ctx());
    const body = await response.json();
    assert.deepEqual([response.status, body.code], [status, code]);
    if (code === "reminder_exists") assert.equal(body.reminder.id, REM, "the waiting reminder, for the UI");
  }
  rpcResult = () => ({ data: null, error: { message: "secret detail" } });
  response = await list.POST(req("POST", { localDate: "2097-01-10", localTime: "09:00", timezone: "UTC" }), ctx());
  assert.deepEqual([response.status, await response.json()], [500, { error: "Could not save reminder", code: "save_failed" }]);
});

test("PATCH requires the expected revision and a reminder of this item", async () => {
  const patch = (body, c = ctx()) => one.PATCH(req("PATCH", body), c);
  let response = await patch({ localTime: "10:00" });
  assert.deepEqual([response.status, (await response.json()).code], [428, "precondition_required"]);
  for (const body of [{ expectedRevision: 1 }, { expectedRevision: 1, action: "snooze" }, { expectedRevision: 0, localTime: "10:00" },
    { expectedRevision: 1, action: "dismiss" }, { expectedRevision: 1, localTime: "10:00", status: "fired" }])
    assert.equal((await patch(body)).status, 400, JSON.stringify(body));
  response = await patch({ expectedRevision: 1, timezone: "Mars/Base" });
  assert.deepEqual([response.status, (await response.json()).code], [422, "invalid_timezone"]);
  response = await patch({ expectedRevision: 1, localTime: "10:00" }, ctx(OTHER_NOTE));
  assert.deepEqual([response.status, (await response.json()).code], [404, "not_found"], "reminder of another item");
  assert.equal(rpcs().length, 0);
});

test("PATCH update, snooze and cancel go through the function with the revision", async () => {
  rpcResult = (name, args) => ({ data: { status: "saved", reminder: row({
    revision: 2, status: args.p_action === "cancel" ? "canceled" : args.p_action === "snooze" ? "snoozed" : "scheduled" }) }, error: null });
  let response = await one.PATCH(req("PATCH", { expectedRevision: 1, localTime: "10:00" }), ctx());
  assert.equal(response.status, 200);
  assert.deepEqual(rpcs().at(-1)[2], { p_id: REM, p_expected_revision: 1, p_action: "update", p_local_date: null,
    p_local_time: "10:00", p_timezone: null });
  response = await one.PATCH(req("PATCH", { action: "snooze", expectedRevision: 1, localDate: "2097-01-11", localTime: "08:00" }), ctx());
  assert.equal((await response.json()).reminder.status, "snoozed");
  response = await one.PATCH(req("PATCH", { action: "cancel", expectedRevision: 1, localTime: "10:00" }), ctx());
  const canceled = (await response.json()).reminder;
  assert.deepEqual([canceled.status, canceled.nextFireAt], ["canceled", null]);
  assert.deepEqual(rpcs().at(-1)[2], { p_id: REM, p_expected_revision: 1, p_action: "cancel", p_local_date: null,
    p_local_time: null, p_timezone: null }, "cancel ignores wall-clock fields");
  rpcResult = { status: "conflict", currentRevision: 3, current: row({ revision: 3 }) };
  response = await one.PATCH(req("PATCH", { expectedRevision: 1, localTime: "10:00" }), ctx());
  const conflict = await response.json();
  assert.deepEqual([response.status, conflict.code, conflict.currentRevision, conflict.current.revision], [409, "revision_conflict", 3, 3]);
  rpcResult = { status: "reminder_closed" };
  response = await one.PATCH(req("PATCH", { expectedRevision: 3, localTime: "10:00" }), ctx());
  assert.deepEqual([response.status, (await response.json()).code], [409, "reminder_closed"]);
  rpcResult = { status: "surprise" };
  assert.equal((await one.PATCH(req("PATCH", { expectedRevision: 3, localTime: "10:00" }), ctx())).status, 500);
});

test("reminder error bodies are fixed messages with known codes", () => {
  for (const status of ["not_found", "invalid_timezone", "reminder_in_past", "reminder_exists", "reminder_closed", "conflict",
    "precondition_required", "invalid_action"]) {
    const result = db.reminderResponse({ status, currentRevision: 2 });
    assert.ok(remindersModule.REMINDER_ERROR_CODES.includes(result.body.code), status);
    assert.equal(typeof result.body.error, "string");
  }
  assert.equal(db.reminderResponse(null), null);
  assert.equal(db.reminderResponse({ status: "created" }), null, "a result without its reminder is a failure");
});
