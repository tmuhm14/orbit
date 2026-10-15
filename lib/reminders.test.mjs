import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalTimeZone,
  isLocalDate,
  isLocalTime,
  isTimeZone,
  localDateTimeParts,
  localToday,
  nextFireAt,
  parseReminderTime,
  reminderFireAt,
} from "./reminders.ts";

// Pure reminder helpers (D-03). The database computes fire_at with the same
// rules; supabase/tests/note-reminders.test.mjs compares the two.
const CHI = "America/Chicago";

test("Chicago spring forward: a nonexistent time fires when the clocks jump", () => {
  // 2026-03-08 02:00 CST becomes 03:00 CDT at 08:00Z.
  assert.equal(reminderFireAt("2026-03-08", "01:59", CHI), "2026-03-08T07:59:00.000Z");
  assert.equal(reminderFireAt("2026-03-08", "02:00", CHI), "2026-03-08T08:00:00.000Z");
  assert.equal(reminderFireAt("2026-03-08", "02:30", CHI), "2026-03-08T08:00:00.000Z");
  assert.equal(reminderFireAt("2026-03-08", "02:59", CHI), "2026-03-08T08:00:00.000Z");
  assert.equal(reminderFireAt("2026-03-08", "03:00", CHI), "2026-03-08T08:00:00.000Z");
  assert.equal(reminderFireAt("2026-03-08", "03:30", CHI), "2026-03-08T08:30:00.000Z");
});

test("Chicago fall back: an ambiguous time fires at its first occurrence", () => {
  // 2026-11-01 02:00 CDT becomes 01:00 CST at 07:00Z; 01:xx happens twice.
  assert.equal(reminderFireAt("2026-11-01", "00:59", CHI), "2026-11-01T05:59:00.000Z");
  assert.equal(reminderFireAt("2026-11-01", "01:00", CHI), "2026-11-01T06:00:00.000Z");
  assert.equal(reminderFireAt("2026-11-01", "01:30", CHI), "2026-11-01T06:30:00.000Z", "CDT, not CST (07:30Z)");
  assert.equal(reminderFireAt("2026-11-01", "01:59", CHI), "2026-11-01T06:59:00.000Z");
  assert.equal(reminderFireAt("2026-11-01", "02:00", CHI), "2026-11-01T08:00:00.000Z");
});

test("zones without DST and fractional offsets map one to one", () => {
  assert.equal(reminderFireAt("2026-03-08", "02:30", "Asia/Kolkata"), "2026-03-07T21:00:00.000Z");
  assert.equal(reminderFireAt("2026-11-01", "01:30", "Asia/Tokyo"), "2026-10-31T16:30:00.000Z");
  assert.equal(reminderFireAt("2026-03-08", "02:30", "America/Phoenix"), "2026-03-08T09:30:00.000Z");
  assert.equal(reminderFireAt("2026-03-08", "02:30", "UTC"), "2026-03-08T02:30:00.000Z");
  assert.equal(reminderFireAt("2026-01-01", "00:00", "Asia/Kathmandu"), "2025-12-31T18:15:00.000Z");
  // A day boundary: 23:30 in Los Angeles is the next day in UTC.
  assert.equal(reminderFireAt("2026-12-31", "23:30", "America/Los_Angeles"), "2027-01-01T07:30:00.000Z");
});

test("the wall-clock fields round-trip through the computed instant", () => {
  for (const zone of [CHI, "Europe/London", "Australia/Sydney", "Asia/Kolkata", "Pacific/Auckland"])
    for (const [date, time] of [["2026-06-15", "09:05"], ["2026-12-15", "18:40"], ["2027-02-28", "00:00"]]) {
      const parts = localDateTimeParts(new Date(reminderFireAt(date, time, zone)), zone);
      assert.deepEqual(
        [parts.year, parts.month, parts.day, parts.hour, parts.minute],
        [...date.split("-").map(Number), ...time.split(":").map(Number)],
        `${zone} ${date} ${time}`,
      );
    }
});

test("invalid zones, dates and times are refused", () => {
  assert.equal(reminderFireAt("2026-10-20", "09:00", "Nope/Zone"), null);
  assert.equal(reminderFireAt("2026-10-20", "09:00", "CST"), null, "abbreviations are not IANA names");
  assert.equal(reminderFireAt("2026-02-30", "09:00", CHI), null);
  assert.equal(reminderFireAt("2026-10-20", "24:00", CHI), null);
  for (const zone of [CHI, "UTC", "Europe/Berlin", "America/Argentina/Buenos_Aires", "Etc/GMT+5"])
    assert.equal(isTimeZone(zone), true, zone);
  for (const zone of ["Nope/Zone", "CST", "EST5EDT", "+05:00", "", " America/Chicago", null, 3, "x/".repeat(40)])
    assert.equal(isTimeZone(zone), false, String(zone));
  assert.equal(canonicalTimeZone("america/chicago"), CHI, "canonical casing");
  assert.equal(canonicalTimeZone("US/Central") !== null, true, "tz links are accepted");
  for (const ok of ["00:00", "09:05", "23:59"]) assert.equal(isLocalTime(ok), true, ok);
  for (const bad of ["9:05", "24:00", "12:60", "12:00:00", ""]) assert.equal(isLocalTime(bad), false, bad);
  for (const ok of ["2026-10-20", "0001-01-01", "9999-12-31", "2028-02-29"]) assert.equal(isLocalDate(ok), true, ok);
  for (const bad of ["2026-02-29", "0000-01-01", "2026-1-01", "20261020"]) assert.equal(isLocalDate(bad), false, bad);
});

test("localToday is the calendar date in the zone, not in UTC", () => {
  const now = new Date("2026-10-15T03:30:00.000Z");
  assert.equal(localToday(CHI, now), "2026-10-14");
  assert.equal(localToday("UTC", now), "2026-10-15");
  assert.equal(localToday("Pacific/Kiritimati", new Date("2026-10-14T10:00:00.000Z")), "2026-10-15");
  assert.equal(localToday(CHI, new Date("2026-11-01T06:30:00.000Z")), "2026-11-01", "inside the fall-back overlap");
});

test("nextFireAt is the fire instant only while the reminder is waiting", () => {
  const fireAt = "2027-01-10T15:00:00.000Z";
  assert.equal(nextFireAt({ status: "scheduled", fireAt }), fireAt);
  assert.equal(nextFireAt({ status: "snoozed", fireAt }), fireAt);
  assert.equal(nextFireAt({ status: "fired", fireAt }), null);
  assert.equal(nextFireAt({ status: "canceled", fireAt }), null);
});

test("parseReminderTime validates wall-clock input and canonicalizes the zone", () => {
  assert.deepEqual(parseReminderTime({ localDate: "2027-01-10", localTime: "09:00", timezone: "america/chicago" }),
    { ok: true, value: { localDate: "2027-01-10", localTime: "09:00", timezone: CHI } });
  assert.deepEqual(parseReminderTime({ localDate: "2027-01-10", localTime: "09:00" }), { ok: false, code: "invalid_payload" });
  assert.deepEqual(parseReminderTime({ localDate: "2027-01-10", localTime: "9am", timezone: CHI }), { ok: false, code: "invalid_payload" });
  assert.deepEqual(parseReminderTime({ localDate: "2027-01-10", localTime: "09:00", timezone: "Mars/Base" }),
    { ok: false, code: "invalid_timezone" });
  assert.deepEqual(parseReminderTime(null), { ok: false, code: "invalid_payload" });
  assert.deepEqual(parseReminderTime({ localTime: "10:00" }, { partial: true }), { ok: true, value: { localTime: "10:00" } });
  assert.deepEqual(parseReminderTime({}, { partial: true }), { ok: true, value: {} });
});
