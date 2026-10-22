import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../../../lib/workflows/db.ts";
import * as runs from "../../../lib/workflows/runs.ts";
import { loadTs } from "../../../tests/load-ts.mjs";

// /api/workflow-runs with in-memory doubles: workspace scoping, filters and
// paging, recording test runs against the stored workflow, and source items.
const WS = "12345678-1234-4234-8234-123456789abc";
const WF = "87654321-4321-4321-8321-cba987654321";
const ITEM = "11111111-2222-4333-8444-555555555555";
const RUN = "99999999-8888-4777-8666-555555555555";
const json = (body, status = 200) => Response.json(body, { status });
const row = (patch = {}) => ({
  id: RUN, workspace_id: WS, workflow_id: WF, workflow_name: "Weekly digest", workflow_revision: 3, mode: "test",
  trigger: "manual", status: "completed", error_code: null, started_at: "2026-10-22T12:00:00.000Z",
  finished_at: "2026-10-22T12:00:04.000Z", workflow_run_items: [], ...patch,
});

/** A chainable query; `result(table, calls)` answers awaits and single()/maybeSingle(). */
function supabase(result) {
  const calls = [];
  const query = (table) => {
    const q = new Proxy({}, {
      get(_, method) {
        if (method === "then") {
          const value = result(table, calls);
          return (resolve) => resolve(value);
        }
        return (...args) => {
          calls.push([table, method, ...args]);
          if (method === "single" || method === "maybeSingle") return Promise.resolve(result(table, calls));
          return q;
        };
      },
    });
    return q;
  };
  return { client: { from: query }, calls };
}

function load(path, client) {
  return loadTs(new URL(path, import.meta.url), {
    "@/lib/supabase/route-auth": { routeUser: async () => ({ user: { id: "u" }, supabase: client }), json },
    "@/lib/workflows/db": db,
    "@/lib/workflows/runs": runs,
  });
}

const get = (query) => new Request(`http://localhost/api/workflow-runs?${query}`);
const post = (body) => new Request("http://localhost/api/workflow-runs", { method: "POST", body: JSON.stringify(body) });
const now = Date.now();
const record = (patch = {}) => ({
  workflowId: WF, status: "failed", errorCode: "step_failed", startedAt: now - 3000, finishedAt: now - 1000,
  steps: [{ nodeId: "t", kind: "trigger", label: "Start", status: "succeeded", port: "next", startedAt: now - 3000, finishedAt: now - 2900 }],
  ...patch,
});
const has = (calls, ...match) => calls.some((c) => match.every((m, i) => c[i] === m));

test("GET requires a workspace, applies filters, and pages with one extra row", async () => {
  const rows = Array.from({ length: runs.RUN_PAGE_SIZE + 1 }, (_, i) => row({ id: `r${i}` }));
  const { client, calls } = supabase(() => ({ data: rows, error: null }));
  const route = load("./route.ts", client);
  assert.equal((await route.GET(get(""))).status, 400);
  assert.equal((await route.GET(get(`workspaceId=${WS}&status=nope`))).status, 400);
  const response = await route.GET(get(`workspaceId=${WS}&workflowId=${WF}&status=completed&before=2026-10-23T00:00:00Z`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.runs.length, runs.RUN_PAGE_SIZE);
  assert.equal(body.more, true);
  assert.equal(body.runs[0].workflowName, "Weekly digest");
  assert.ok(has(calls, "workflow_runs", "eq", "workspace_id", WS));
  assert.ok(has(calls, "workflow_runs", "eq", "workflow_id", WF));
  assert.ok(has(calls, "workflow_runs", "eq", "status", "completed"));
  assert.ok(has(calls, "workflow_runs", "lt", "started_at", "2026-10-23T00:00:00.000Z"));
  assert.ok(has(calls, "workflow_runs", "limit", runs.RUN_PAGE_SIZE + 1));
  assert.equal(calls.some((c) => c[1] === "select" && String(c[2]).includes("steps")), false, "lists leave steps out");
});

test("GET ?itemId= finds the item's runs through workflow_run_items", async () => {
  let links = [{ run_id: RUN }, { run_id: RUN }];
  const { client, calls } = supabase((table) =>
    table === "workflow_run_items" ? { data: links, error: null } : { data: [row({ workflow_run_items: [{ item_id: ITEM, role: "source" }] })], error: null });
  const route = load("./route.ts", client);
  const body = await (await route.GET(get(`workspaceId=${WS}&itemId=${ITEM}`))).json();
  assert.equal(body.runs[0].items[0].itemId, ITEM);
  assert.ok(has(calls, "workflow_run_items", "eq", "item_id", ITEM));
  assert.deepEqual(calls.find((c) => c[1] === "in"), ["workflow_runs", "in", "id", [RUN]]);

  links = [];
  calls.length = 0;
  const empty = await (await route.GET(get(`workspaceId=${WS}&itemId=${ITEM}`))).json();
  assert.deepEqual(empty, { runs: [], more: false });
  assert.equal(calls.some((c) => c[0] === "workflow_runs"), false, "no run query without links");
});

test("POST records a test run with the stored workflow's space, name and revision", async () => {
  const { client, calls } = supabase((table, calls) => {
    if (table === "workflows") return { data: { id: WF, workspace_id: WS, name: "Weekly digest", revision: 7 }, error: null };
    return { data: row({ status: "failed" }), error: null };
  });
  const route = load("./route.ts", client);
  assert.equal((await route.POST(post({ ...record(), status: "running" }))).status, 400);
  const created = await route.POST(post(record({ workspaceId: "ignored" })));
  assert.equal(created.status, 201);
  const insert = calls.find((c) => c[0] === "workflow_runs" && c[1] === "insert")[2];
  assert.equal(insert.workspace_id, WS);
  assert.equal(insert.workflow_name, "Weekly digest");
  assert.equal(insert.workflow_revision, 7);
  assert.equal(insert.mode, "test");
  assert.equal(insert.user_id, "u");
  assert.equal(insert.error_code, "step_failed");
  assert.equal(insert.steps[0].startedAt, new Date(now - 3000).toISOString());
  assert.equal(calls.some((c) => c[0] === "workflow_run_items"), false);
});

test("POST 404s for an unknown workflow and rejects a source item from another space", async () => {
  let workflow = null;
  let item = null;
  const { client } = supabase((table) =>
    table === "workflows" ? { data: workflow, error: null } : table === "notes" ? { data: item, error: null } : { data: row(), error: null });
  const route = load("./route.ts", client);
  assert.equal((await route.POST(post(record()))).status, 404);
  workflow = { id: WF, workspace_id: WS, name: "W", revision: 1 };
  assert.equal((await route.POST(post(record({ sourceItemId: ITEM })))).status, 400);
});

test("POST links the source item, and undoes the run if the link fails", async () => {
  let linkError = null;
  const { client, calls } = supabase((table) => {
    if (table === "workflows") return { data: { id: WF, workspace_id: WS, name: "W", revision: 1 }, error: null };
    if (table === "notes") return { data: { id: ITEM }, error: null };
    if (table === "workflow_run_items") return { error: linkError };
    return { data: row(), error: null };
  });
  const route = load("./route.ts", client);
  const created = await route.POST(post(record({ sourceItemId: ITEM })));
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).run.items, [{ itemId: ITEM, role: "source" }]);
  const link = calls.find((c) => c[0] === "workflow_run_items" && c[1] === "insert")[2];
  assert.deepEqual(link, { run_id: RUN, item_id: ITEM, workspace_id: WS, user_id: "u", role: "source" });
  assert.ok(has(calls, "notes", "eq", "workspace_id", WS));

  calls.length = 0;
  linkError = { message: "fk" };
  assert.equal((await route.POST(post(record({ sourceItemId: ITEM })))).status, 500);
  assert.ok(has(calls, "workflow_runs", "delete"));
  assert.ok(has(calls, "workflow_runs", "eq", "id", RUN));
});

test("GET /[id] returns steps and treats unknown ids as not found", async () => {
  let data = row({ steps: [{ nodeId: "t", kind: "trigger", label: "Start", status: "succeeded", port: "next", startedAt: "a", finishedAt: "b" }] });
  const { client, calls } = supabase(() => ({ data, error: null }));
  const route = load("./[id]/route.ts", client);
  const params = (id) => ({ params: Promise.resolve({ id }) });
  const found = await route.GET(new Request("http://localhost/x"), params(RUN));
  assert.equal((await found.json()).run.steps.length, 1);
  assert.ok(calls.some((c) => c[1] === "select" && String(c[2]).endsWith(",steps")));
  assert.equal((await route.GET(new Request("http://localhost/x"), params("nope"))).status, 404);
  data = null;
  assert.equal((await route.GET(new Request("http://localhost/x"), params(RUN))).status, 404);
});
