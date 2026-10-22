import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activityPeople, addDays, groupMine, initials, isUrgent, jiraUrl, relativeTime, splitActivity, upcomingGroups,
} from "./view.ts";

const issue = (key, patch = {}) => ({
  key, url: `https://acme.atlassian.net/browse/${key}`, summary: key, status: "To Do", category: "todo",
  type: "Task", priority: "Medium", project: key.split("-")[0], assignee: "Dana Reyes", assignedToMe: false,
  updated: "2026-10-20T12:00:00.000Z", resolved: null, due: null, epic: null, sprint: null, ...patch,
});

test("assigned to me puts work in progress first, then by priority and most recent touch", () => {
  const low = issue("A-1", { priority: "Low", category: "doing" });
  const high = issue("A-2", { priority: "High", category: "doing", updated: "2026-10-01T00:00:00Z" });
  const newer = issue("A-3", { priority: "High", category: "doing", updated: "2026-10-21T00:00:00Z" });
  const todo = issue("A-4");
  const unknown = issue("A-5", { priority: null });
  const groups = groupMine([low, todo, high, unknown, newer]);
  assert.deepEqual(groups.doing.map((i) => i.key), ["A-3", "A-2", "A-1"]);
  // A missing priority sorts like Medium; ties keep the most recently touched first.
  assert.deepEqual(groups.todo.map((i) => i.key), ["A-4", "A-5"]);
  assert.equal(isUrgent(high), true);
  assert.equal(isUrgent(issue("A-6", { priority: "Highest" })), true);
  assert.equal(isUrgent(low), false);
});

test("upcoming groups each open issue once, in reading order", () => {
  const today = "2026-10-22";
  const issues = [
    issue("S-1", { due: "2026-10-20" }),
    issue("S-2", { due: "2026-11-05", status: "Ready for Release" }),
    issue("S-3", { due: "2026-12-01", status: "Ready for Development" }),
    issue("S-4", { status: "ready for release", category: "doing" }),
    issue("P-1", { sprint: { name: "PM Sprint 16", state: "active", end: "2026-11-05T05:00:00.000Z" } }),
    issue("P-2", { category: "doing", sprint: { name: "PM Sprint 16", state: "active", end: null } }),
    issue("P-3", { sprint: { name: "PM Sprint 17", state: "future", end: null } }),
    issue("S-5", { status: "Ready for Development" }),
    issue("S-6", { due: "2026-10-01", category: "done" }),
  ];
  const groups = upcomingGroups(issues, today);
  assert.deepEqual(groups.map((g) => [g.id, g.issues.map((i) => i.key)]), [
    ["overdue", ["S-1"]],
    ["due", ["S-2"]],
    ["shipping", ["S-4"]],
    ["sprint:PM Sprint 16", ["P-1"]],
    ["queued", ["S-3", "S-5"]],
    ["future:PM Sprint 17", ["P-3"]],
  ]);
  assert.equal(groups[3].label, "PM Sprint 16");
  assert.equal(groups[3].detail, "Not started · ends Nov 5");
  assert.equal(groups[5].detail, "Next sprint");
  // In progress in the current sprint isn't "coming up"; it's in motion.
  assert.ok(!groups.flatMap((g) => g.issues).some((i) => i.key === "P-2"));
  assert.deepEqual(upcomingGroups([], today), []);
});

test("due-soon counts two weeks of calendar days, across months and years", () => {
  assert.equal(addDays("2026-10-22", 14), "2026-11-05");
  assert.equal(addDays("2026-12-25", 14), "2027-01-08");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  const groups = upcomingGroups([issue("A-1", { due: "2026-11-05" }), issue("A-2", { due: "2026-11-06" })], "2026-10-22");
  assert.deepEqual(groups.map((g) => [g.id, g.issues.length]), [["due", 1]]);
});

test("team activity ranks people and splits finished from still moving", () => {
  const issues = [
    issue("A-1", { category: "done", assignee: "Prasad Morye" }),
    issue("A-2", { category: "doing", assignee: "Prasad Morye" }),
    issue("A-3", { category: "doing", assignee: "Tony Muhm", assignedToMe: true }),
    issue("A-4", { assignee: null }),
    issue("A-5", { category: "done", assignee: "David Scheuermann" }),
    issue("A-6", { category: "doing", assignee: "David Scheuermann" }),
  ];
  assert.deepEqual(activityPeople(issues), [
    { name: "David Scheuermann", total: 2, completed: 1, me: false },
    { name: "Prasad Morye", total: 2, completed: 1, me: false },
    { name: "Tony Muhm", total: 1, completed: 0, me: true },
    { name: "Unassigned", total: 1, completed: 0, me: false },
  ]);
  const everyone = splitActivity(issues, null);
  assert.deepEqual(everyone.completed.map((i) => i.key), ["A-1", "A-5"]);
  assert.deepEqual(everyone.moving.map((i) => i.key), ["A-2", "A-3", "A-4", "A-6"]);
  const one = splitActivity(issues, "Prasad Morye");
  assert.deepEqual([one.completed.length, one.moving.length], [1, 1]);
  assert.deepEqual(splitActivity(issues, "Unassigned").moving.map((i) => i.key), ["A-4"]);
  assert.deepEqual(splitActivity(issues, "Nobody"), { completed: [], moving: [] });
});

test("relative times, initials and link checks", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(relativeTime(ago(10_000), now), "just now");
  assert.equal(relativeTime(ago(5 * 60_000), now), "5m ago");
  assert.equal(relativeTime(ago(3 * 3_600_000), now), "3h ago");
  assert.equal(relativeTime(ago(26 * 3_600_000), now), "yesterday");
  assert.equal(relativeTime(ago(4 * 86_400_000), now), "4d ago");
  assert.equal(relativeTime(ago(21 * 86_400_000), now), "3w ago");
  assert.match(relativeTime("2026-06-01T12:00:00Z", now), /^Jun \d+$/);
  assert.equal(relativeTime("nope", now), "");
  assert.equal(relativeTime(new Date(now + 60_000).toISOString(), now), "just now");
  assert.equal(initials("David Scheuermann"), "DS");
  assert.equal(initials("  cher "), "C");
  assert.equal(initials("Mary Ann van Dyke"), "MD");
  assert.equal(initials(null), "?");
  assert.equal(jiraUrl("https://acme.atlassian.net/browse/A-1"), "https://acme.atlassian.net/browse/A-1");
  for (const bad of ["http://acme.atlassian.net/browse/A-1", "https://evil.example/browse/A-1", "javascript:alert(1)", "not a url"])
    assert.equal(jiraUrl(bad), undefined);
});
