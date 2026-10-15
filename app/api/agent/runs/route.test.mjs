import { test } from "node:test";
import assert from "node:assert/strict";
import * as notesModule from "../../../../lib/notes.ts";
import * as agentModule from "../../../../lib/agent/agent.ts";
import { loadTs } from "../../../../tests/load-ts.mjs";

// GET /api/agent/runs with in-memory doubles: each action says whether the UI
// may offer undo (ADR 002 §5: not after undo, not past 90 days, not purged).
const WS = "12345678-1234-4234-8234-123456789abc";
const json = (body, status = 200) => Response.json(body, { status });
const day = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * day).toISOString();

function table(rows) {
  const q = {
    select: () => q, eq: () => q, in: () => q, order: () => q, update: () => q, lt: () => q,
    limit: async () => ({ data: rows, error: null }),
    then: (resolve) => resolve({ data: rows, error: null }),
  };
  return q;
}

test("runs list marks expired, undone and purged actions as not undoable", async () => {
  const runs = [{ id: "run-1", workspace_id: WS }];
  const actions = [
    { id: "a1", run_id: "run-1", kind: "update", before: {}, after: { bucket: "next" }, created_at: ago(1), undone_at: null },
    { id: "a2", run_id: "run-1", kind: "update", before: {}, after: { bucket: "next" }, created_at: ago(91), undone_at: null },
    { id: "a3", run_id: "run-1", kind: "update", before: {}, after: { bucket: "next" }, created_at: ago(2), undone_at: ago(1) },
    { id: "a4", run_id: "run-1", kind: "update", before: null, after: null, created_at: ago(120), undone_at: null },
  ];
  const auth = {
    user: { id: "u" },
    supabase: { from: (name) => table(name === "agent_runs" ? runs : actions) },
  };
  const route = loadTs(new URL("./route.ts", import.meta.url), {
    "next/server": { after: () => {} },
    "@/lib/supabase/route-auth": { routeUser: async () => auth, json },
    "@/lib/supabase/admin": { createAdminClient: () => null },
    "@/lib/notes": notesModule,
    "@/lib/agent/server": { RUN_COLUMNS: "id", RUN_TIMEOUT_MS: 1, createRun: () => {}, executeRun: () => {} },
    "@/lib/agent/agent": agentModule,
  });
  const response = await route.GET(new Request(`http://localhost/api/agent/runs?workspaceId=${WS}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.runs[0].actions.map((a) => [a.id, a.undoable]),
    [["a1", true], ["a2", false], ["a3", false], ["a4", false]]);
});

function postRoute(parent) {
  const filters = [];
  const created = [];
  const scheduled = [];
  const admin = { from: () => {
    const q = { select: () => q, eq: (key, value) => { filters.push([key, value]); return q; },
      gte: async () => ({ count: 0 }), maybeSingle: async () => ({ data: parent, error: null }) };
    return q;
  } };
  const route = loadTs(new URL("./route.ts", import.meta.url), {
    "next/server": { after: (fn) => scheduled.push(fn) },
    "@/lib/supabase/route-auth": { routeUser: async () => ({ user: { id: "u" }, supabase: {} }), json },
    "@/lib/supabase/admin": { createAdminClient: () => admin },
    "@/lib/notes": notesModule,
    "@/lib/agent/server": { RUN_COLUMNS: "id", RUN_TIMEOUT_MS: 1000,
      createRun: async (_, request) => { created.push(request); return { runId: "new" }; }, executeRun: () => {} },
    "@/lib/agent/agent": agentModule,
  });
  return { route, filters, created, scheduled };
}
const PARENT = "12345678-1234-4234-8234-123456789abd";
const post = (route, parentRunId = PARENT) => route.POST(new Request("http://localhost/api/agent/runs", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ workspaceId: WS, mode: "organize", instruction: "Expand the plan", parentRunId }),
}));

test("follow-ups load only the owner's workspace run and carry its context", async () => {
  const { route, filters, created, scheduled } = postRoute({ instruction: "Make a plan", summary: "Created a plan note", status: "done" });
  assert.equal((await post(route)).status, 200);
  assert.ok(filters.some(([k,v]) => k === "user_id" && v === "u"));
  assert.ok(filters.some(([k,v]) => k === "workspace_id" && v === WS));
  assert.ok(filters.some(([k,v]) => k === "id" && v === PARENT));
  assert.equal(created[0].parentRunId, PARENT);
  assert.match(created[0].previousContext, /Created a plan note/);
  assert.equal(scheduled.length, 1);
});

test("follow-ups reject missing, active and invalid parent runs before scheduling", async () => {
  for (const [parent, id, status] of [[null, PARENT, 404], [{ status: "running" }, PARENT, 409], [null, "bad-id", 400]]) {
    const { route, created, scheduled } = postRoute(parent);
    assert.equal((await post(route, id)).status, status);
    assert.equal(created.length, 0);
    assert.equal(scheduled.length, 0);
  }
});
