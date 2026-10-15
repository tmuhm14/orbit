import { test } from "node:test";
import assert from "node:assert/strict";
import { errorCode, recordInitialLoadFailure } from "./initial-load.ts";
import { loadTs } from "../tests/load-ts.mjs";

const { loadWorkspaces } = loadTs(new URL("./workspaces-db.ts", import.meta.url));

test("initial load failures log the part and error code only", () => {
  const lines = [];
  recordInitialLoadFailure(
    "notes",
    { code: "PGRST301", message: "JWT for someone@example.com", details: "note title" },
    (line) => lines.push(line),
  );
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { event: "initial_load_failed", part: "notes", code: "PGRST301" },
  ]);
  assert.doesNotMatch(lines[0], /example\.com|title/);
});

test("error codes that are missing or not code-shaped are logged as unknown", () => {
  assert.equal(errorCode({ code: "42501" }), "42501");
  for (const error of [null, undefined, "PGRST301", {}, { code: 42501 },
    { code: "someone@example.com" }, { code: "A".repeat(40) }])
    assert.equal(errorCode(error), "unknown");
});

// A Supabase client double: each query resolves to the next queued result.
function fakeClient(results) {
  const calls = [];
  const client = {
    from(table) {
      const query = {
        select: () => query,
        order: () => query,
        insert: (row) => (calls.push(["insert", table, row]), query),
        returns: () => query,
        then(resolve, reject) {
          calls.push(["read", table]);
          return Promise.resolve(results.shift()).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { client, calls };
}
const space = { id: "w1", name: "Personal", position: 0, color: null, isDefault: true };
const failure = (code) => ({ data: null, error: { code, message: "private" } });

test("workspaces load reports which step failed", async () => {
  for (const [results, code] of [
    [[failure("PGRST301")], "PGRST301"],
    [[{ data: [], error: null }, { data: null, error: { code: "23505" } }, { data: [], error: null }], "23505"],
    [[{ data: [space], error: null }, failure("42501")], "42501"],
  ]) {
    const { client } = fakeClient(results);
    const reported = [];
    assert.equal(await loadWorkspaces(client, (error) => reported.push(errorCode(error))), null);
    assert.deepEqual(reported, [code]);
  }
});

test("workspaces load creates Personal on first use and reports nothing when it works", async () => {
  const { client, calls } = fakeClient([
    { data: [], error: null },
    { data: null, error: null },
    { data: [space], error: null },
    { data: [{ slack_team_id: "T", slack_team_name: null, slack_user_id: "U", workspace_id: "w1" }], error: null },
  ]);
  const reported = [];
  const result = await loadWorkspaces(client, (error) => reported.push(error));
  assert.deepEqual(reported, []);
  assert.deepEqual(result, {
    workspaces: [space],
    slack: [{ teamId: "T", teamName: null, slackUserId: "U", workspaceId: "w1" }],
  });
  assert.deepEqual(calls.filter(([kind]) => kind === "insert"),
    [["insert", "workspaces", { name: "Personal", is_default: true }]]);
});
