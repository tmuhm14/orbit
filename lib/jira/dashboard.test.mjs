import { test } from "node:test";
import assert from "node:assert/strict";
import { MINE_JQL, buildJiraDashboard, currentSprint, teamJql, teamProjects, toIssue } from "./dashboard.ts";

const SITE = "https://acme.atlassian.net";
const credentials = { jiraSite: SITE, jiraEmail: "me@acme.test", jiraToken: "secret-token" };
const raw = (key, fields = {}) => ({
  key,
  fields: {
    summary: `Summary of ${key}`, status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    issuetype: { name: "Task" }, priority: { name: "High" }, project: { key: key.split("-")[0] },
    assignee: { accountId: "acct-other", displayName: "Dana Reyes" }, updated: "2026-10-21T10:00:00.000-0500",
    resolutiondate: null, duedate: null, ...fields,
  },
});

/** A Jira double: routes by path and JQL, and records every request. */
function jiraDouble({ search = () => ({ issues: [], isLast: true }), fields = [], myself = { accountId: "acct-me" } } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body, headers: init.headers });
    const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/rest/api/3/field") return typeof fields === "number" ? reply({}, fields) : reply(fields);
    if (path === "/rest/api/3/myself") return reply(myself);
    if (path === "/rest/api/3/search/jql") {
      const result = search(body);
      return typeof result === "number" ? reply({ errorMessages: ["x"] }, result) : reply(result);
    }
    return reply({}, 404);
  };
  return { fetcher, calls };
}

test("issues keep display fields only and drop anything malformed", () => {
  const issue = toIssue(raw("SPEC-1", {
    parent: { key: "SPEC-9", fields: { summary: "Walgreens implementation" } },
    duedate: "2026-11-01",
    customfield_10020: [{ name: "Sprint 15", state: "closed" }, { name: "Sprint 16", state: "active", endDate: "2026-11-05T05:00:00.000Z" }],
    description: "never copied",
  }), SITE, "customfield_10020", "acct-other");
  assert.deepEqual(issue, {
    key: "SPEC-1", url: `${SITE}/browse/SPEC-1`, summary: "Summary of SPEC-1", status: "In Progress", category: "doing",
    type: "Task", priority: "High", project: "SPEC", assignee: "Dana Reyes", assignedToMe: true,
    updated: "2026-10-21T10:00:00.000-0500", resolved: null, due: "2026-11-01",
    epic: { key: "SPEC-9", summary: "Walgreens implementation" },
    sprint: { name: "Sprint 16", state: "active", end: "2026-11-05T05:00:00.000Z" },
  });
  assert.equal(toIssue(raw("not a key"), SITE, null, null), null);
  assert.equal(toIssue(raw("A-1", { updated: "yesterday" }), SITE, null, null), null);
  assert.equal(toIssue({ key: "A-1" }, SITE, null, null), null);
  const sparse = toIssue({ key: "A-2", fields: { updated: "2026-10-21T00:00:00Z", status: { statusCategory: { key: "done" } } } }, SITE, null, null);
  assert.equal(sparse.summary, "A-2");
  assert.equal(sparse.category, "done");
  assert.equal(sparse.assignee, null);
  assert.equal(sparse.assignedToMe, false);
  assert.equal(toIssue(raw("A-3", { duedate: "Nov 1" }), SITE, null, null).due, null);
  assert.equal(toIssue(raw("A-4", { summary: "x".repeat(1000) }), SITE, null, null).summary.length, 300);
});

test("current sprint is the active one, else the earliest future one", () => {
  assert.equal(currentSprint(undefined), null);
  assert.equal(currentSprint([{ name: "Old", state: "closed" }]), null);
  assert.deepEqual(currentSprint([
    { name: "Later", state: "future", startDate: "2026-12-01T00:00:00Z" },
    { name: "Next", state: "future", startDate: "2026-11-05T00:00:00Z" },
  ]), { name: "Next", state: "future", end: null });
  assert.equal(currentSprint([{ name: "Next", state: "future" }, { name: "Now", state: "active" }]).name, "Now");
});

test("team projects come from assignments and debrief keys, never free text", () => {
  const assigned = [{ project: "SPEC" }, { project: "PM" }, { project: "SPEC" }];
  assert.deepEqual(teamProjects([" OPS ", "ops", "Specialty", "Patient Management", "x\") OR 1=1", ""], assigned), ["OPS", "PM", "SPEC"]);
  assert.deepEqual(teamProjects([], []), []);
  assert.equal(teamProjects(Array.from({ length: 30 }, (_, i) => `P${i}X`), []).length, 20);
});

test("team searches quote project keys and use the chosen window", () => {
  const jql = teamJql(["PM", "SPEC"], 14);
  assert.match(jql.activity, /^project in \("PM", "SPEC"\) AND \(status CHANGED AFTER -14d OR resolved >= -14d/);
  assert.match(jql.upcoming, /duedate <= 14d OR \(statusCategory = "To Do" AND \(sprint in openSprints\(\)/);
  assert.match(jql.upcoming, /status in \("Ready for Release", "Ready for Development"\)/);
  const bare = teamJql(["PM"], 7, { sprints: false, pipeline: false });
  assert.doesNotMatch(bare.upcoming, /sprint|status in/);
  assert.match(MINE_JQL, /^assignee = currentUser\(\) AND statusCategory != Done/);
});

test("builds all three sections from live searches", async () => {
  const { fetcher, calls } = jiraDouble({
    fields: [{ id: "summary" }, { id: "customfield_10020", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } }],
    search: (body) => {
      if (body.jql === MINE_JQL)
        return { issues: [raw("SPEC-1", { assignee: { accountId: "acct-me", displayName: "Me" } }), raw("PM-2")], isLast: true };
      if (body.jql.includes("CHANGED"))
        return { issues: [raw("PM-3", { assignee: { accountId: "acct-me", displayName: "Me" } }), raw("SPEC-4")], isLast: true };
      return { issues: [raw("PM-5", { customfield_10020: [{ name: "PM Sprint 16", state: "active" }] })], isLast: true };
    },
  });
  const dashboard = await buildJiraDashboard(credentials, { days: 7, configuredProjects: [] }, fetcher, () => {});
  assert.deepEqual(dashboard.projects, ["PM", "SPEC"]);
  assert.deepEqual(dashboard.mine.map((i) => [i.key, i.assignedToMe]), [["SPEC-1", true], ["PM-2", true]]);
  assert.deepEqual(dashboard.activity.map((i) => [i.key, i.assignedToMe]), [["PM-3", true], ["SPEC-4", false]]);
  assert.equal(dashboard.upcoming[0].sprint.name, "PM Sprint 16");
  assert.deepEqual(dashboard.errors, []);
  assert.deepEqual(dashboard.truncated, { mine: false, activity: false, upcoming: false });
  assert.ok(dashboard.links.activity.startsWith(`${SITE}/issues/?jql=project%20in`));
  const searches = calls.filter((c) => c.path === "/rest/api/3/search/jql");
  assert.equal(searches.length, 3);
  assert.ok(searches.every((c) => c.body.fields.includes("customfield_10020") && !c.body.fields.includes("description")));
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from("me@acme.test:secret-token").toString("base64")}`);
});

test("pages are capped and flagged as truncated", async () => {
  let pages = 0;
  const { fetcher } = jiraDouble({
    search: (body) => {
      if (body.jql === MINE_JQL) return { issues: [raw("SPEC-1")], nextPageToken: "more", isLast: false };
      if (body.jql.includes("CHANGED")) { pages++; return { issues: [raw(`PM-${pages}`)], nextPageToken: `p${pages}`, isLast: false }; }
      return { issues: [], isLast: true };
    },
  });
  const dashboard = await buildJiraDashboard({ ...credentials, jiraSite: "https://capped.atlassian.net" },
    { days: 30, configuredProjects: [] }, fetcher, () => {});
  assert.equal(pages, 3);
  assert.equal(dashboard.activity.length, 3);
  assert.deepEqual(dashboard.truncated, { mine: true, activity: true, upcoming: false });
});

test("a site without the pipeline statuses gets Upcoming without them", async () => {
  const upcoming = [];
  const { fetcher } = jiraDouble({
    search: (body) => {
      if (body.jql === MINE_JQL) return { issues: [raw("SPEC-1")], isLast: true };
      if (body.jql.includes("CHANGED")) return { issues: [], isLast: true };
      upcoming.push(body.jql);
      return body.jql.includes("status in") ? 400 : { issues: [raw("SPEC-2", { duedate: "2026-10-30" })], isLast: true };
    },
  });
  const dashboard = await buildJiraDashboard({ ...credentials, jiraSite: "https://plain.atlassian.net" },
    { days: 7, configuredProjects: [] }, fetcher, () => {});
  assert.equal(upcoming.length, 2);
  // No Sprint field on this site, so no sprint clauses either.
  assert.doesNotMatch(upcoming[1], /status in|sprint/);
  assert.deepEqual(dashboard.upcoming.map((i) => i.key), ["SPEC-2"]);
  assert.ok(!decodeURIComponent(dashboard.links.upcoming).includes("status in"));
  assert.deepEqual(dashboard.errors, []);
});

test("failures stay per section, with content-free logs and plain messages", async () => {
  const lines = [];
  const { fetcher } = jiraDouble({
    fields: 500,
    search: (body) => (body.jql === MINE_JQL ? { issues: [raw("SPEC-1")], isLast: true } : body.jql.includes("CHANGED") ? 503 : 401),
  });
  const dashboard = await buildJiraDashboard({ ...credentials, jiraSite: "https://flaky.atlassian.net" },
    { days: 7, configuredProjects: [] }, fetcher, (line) => lines.push(line));
  assert.equal(dashboard.mine.length, 1);
  assert.deepEqual(dashboard.errors.map((e) => e.section).sort(), ["activity", "upcoming"]);
  assert.match(dashboard.errors.find((e) => e.section === "upcoming").message, /credentials/);
  assert.match(dashboard.errors.find((e) => e.section === "activity").message, /couldn’t be reached/);
  assert.deepEqual(lines.map((line) => JSON.parse(line)).sort((a, b) => a.section.localeCompare(b.section)), [
    { event: "jira_dashboard.failed", section: "activity", status: 503 },
    { event: "jira_dashboard.failed", section: "upcoming", status: 401 },
  ]);
  assert.ok(lines.every((line) => !line.includes("secret-token") && !line.includes("SPEC")));
});

test("with no assignments and no debrief projects, only Assigned to you is searched", async () => {
  const { fetcher, calls } = jiraDouble();
  const dashboard = await buildJiraDashboard({ ...credentials, jiraSite: "https://empty.atlassian.net" },
    { days: 7, configuredProjects: ["Specialty"] }, fetcher, () => {});
  assert.deepEqual(dashboard.projects, []);
  assert.equal(calls.filter((c) => c.path === "/rest/api/3/search/jql").length, 1);
  assert.equal(dashboard.links.activity, "");
});
