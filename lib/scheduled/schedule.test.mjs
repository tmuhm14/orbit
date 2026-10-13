import test from "node:test";
import assert from "node:assert/strict";
import { dueReportDate, reportWindow } from "./schedule.ts";
import { parseTaskInput } from "./validation.ts";
import { buildDebrief } from "./debrief.ts";

test("Chicago debrief runs ahead of 6am in summer and winter", () => {
  const task = { timezone: "America/Chicago", delivery_hour: 6, cadence: "daily" };
  assert.equal(dueReportDate(task, new Date("2026-10-11T09:30:00Z")), "2026-10-10");
  assert.equal(dueReportDate(task, new Date("2026-12-11T10:30:00Z")), "2026-12-10");
  assert.equal(dueReportDate(task, new Date("2026-10-11T10:30:00Z")), null);
});

test("report windows span the actual local day at DST transitions", () => {
  assert.deepEqual(reportWindow("2026-03-08", "America/Chicago"), {
    start: "2026-03-08T06:00:00.000Z",
    end: "2026-03-09T05:00:00.000Z",
  });
  assert.deepEqual(reportWindow("2026-11-01", "America/Chicago"), {
    start: "2026-11-01T05:00:00.000Z",
    end: "2026-11-02T06:00:00.000Z",
  });
});

test("task validation rejects unsafe project and repository selectors", () => {
  const valid = {
    name: "Nightly debrief", kind: "team_debrief", enabled: true,
    timezone: "America/Chicago", delivery_hour: 6, cadence: "daily",
    jira_projects: ["Specialty", "Patient Management"], github_repos: ["acme/patient-mgmt"],
  };
  assert.ok(parseTaskInput(valid));
  assert.equal(parseTaskInput({ ...valid, jira_projects: ['Specialty") OR project in ("ALL'] }), null);
  assert.equal(parseTaskInput({ ...valid, github_repos: ["https://example.com/a/b"] }), null);
  assert.equal(parseTaskInput({ ...valid, delivery_hour: 24 }), null);
});

test("debrief keeps linked metadata in the reporting window and omits bodies", async () => {
  const requested = [];
  const fetcher = async (url, init) => {
    requested.push({ url, init });
    if (url.includes("search/jql")) return Response.json({ issues: [
      { key: "SPEC-12", fields: { updated: "2026-10-10T15:00:00.000Z", status: { name: "Done" }, issuetype: { name: "Story" }, summary: "patient name" } },
      { key: "SPEC-11", fields: { updated: "2026-10-11T06:00:00.000Z", status: { name: "Open" } } },
    ], isLast: true });
    if (url.includes("/pulls?")) return Response.json([
      { number: 7, updated_at: "2026-10-10T17:00:00Z", merged_at: "2026-10-10T17:00:00Z", state: "closed", user: { login: "teammate" }, title: "sensitive title" },
    ]);
    if (url.includes("/commits?")) return Response.json([
      { sha: "a".repeat(40), author: { login: "teammate" }, commit: { author: { name: "teammate" }, committer: { date: "2026-10-10T18:00:00Z" }, message: "sensitive message" } },
    ]);
    throw new Error("unexpected URL");
  };
  const report = await buildDebrief(
    { timezone: "America/Chicago", jira_projects: ["Specialty"], github_repos: ["acme/patient-mgmt"] },
    { jiraSite: "https://acme.atlassian.net", jiraEmail: "user@example.com", jiraToken: "jira-secret", githubToken: "github-secret" },
    "2026-10-10", fetcher,
  );
  assert.equal(report.jira.issues.length, 1);
  assert.equal(report.github.prs[0].state, "merged");
  assert.equal(report.github.commits[0].sha, "aaaaaaa");
  assert.ok(!JSON.stringify(report).includes("sensitive"));
  assert.equal(JSON.parse(requested[0].init.body).fields.includes("summary"), false);
});

test("a Jira outage leaves GitHub activity available without leaking the response", async () => {
  const fetcher = async (url) => {
    if (url.includes("search/jql")) return new Response("patient data", { status: 500 });
    if (url.includes("/pulls?")) return Response.json([]);
    if (url.includes("/commits?")) return Response.json([]);
    throw new Error("unexpected URL");
  };
  const report = await buildDebrief(
    { timezone: "America/Chicago", jira_projects: ["Specialty"], github_repos: ["acme/patient-mgmt"] },
    { jiraSite: "https://acme.atlassian.net", jiraEmail: "user@example.com", jiraToken: "jira-secret", githubToken: "github-secret" },
    "2026-10-10", fetcher,
  );
  assert.equal(report.jira.error, "Jira activity could not be loaded");
  assert.deepEqual(report.github.errors, []);
  assert.ok(!JSON.stringify(report).includes("patient data"));
});
