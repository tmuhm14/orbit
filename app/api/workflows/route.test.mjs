import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../../../lib/workflows/db.ts";
import { starterDefinition } from "../../../lib/workflows/model.ts";
import { loadTs } from "../../../tests/load-ts.mjs";

// /api/workflows with in-memory doubles: workspace scoping, input checks,
// limits, and optimistic concurrency on save.
const WS = "12345678-1234-4234-8234-123456789abc";
const ID = "87654321-4321-4321-8321-cba987654321";
const json = (body, status = 200) => Response.json(body, { status });
const row = (patch = {}) => ({
  id: ID, workspace_id: WS, name: "Weekly digest", description: "", definition: starterDefinition(),
  revision: 3, created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z", ...patch,
});

/** A chainable query whose terminal calls resolve to `result(calls)`. */
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
  });
}

const post = (body) => new Request("http://localhost/api/workflows", { method: "POST", body: JSON.stringify(body) });
const patch = (body) => new Request(`http://localhost/api/workflows/${ID}`, { method: "PATCH", body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: ID }) };

test("GET lists one workspace's workflows and requires a workspace", async () => {
  const { client, calls } = supabase(() => ({ data: [row()], error: null }));
  const route = load("./route.ts", client);
  assert.equal((await route.GET(new Request("http://localhost/api/workflows"))).status, 400);
  const response = await route.GET(new Request(`http://localhost/api/workflows?workspaceId=${WS}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.workflows[0].workspaceId, WS);
  assert.equal(body.workflows[0].definition.nodes.length, 3);
  assert.ok(calls.some((c) => c[1] === "eq" && c[2] === "workspace_id" && c[3] === WS));
});

test("POST validates input, applies the limit, and seeds a starter graph", async () => {
  let count = 0;
  const { client, calls } = supabase((_, calls) =>
    calls.at(-1)[1] === "single" ? { data: row({ revision: 1 }), error: null } : { count, error: null });
  const route = load("./route.ts", client);
  assert.equal((await route.POST(post({ workspaceId: "nope", name: "x" }))).status, 400);
  assert.equal((await route.POST(post({ workspaceId: WS, name: " " }))).status, 400);
  assert.equal((await route.POST(post({ workspaceId: WS, name: "x", definition: { version: 1 } }))).status, 400);
  const created = await route.POST(post({ workspaceId: WS, name: "  Weekly digest " }));
  assert.equal(created.status, 201);
  const insert = calls.find((c) => c[1] === "insert")[2];
  assert.equal(insert.name, "Weekly digest");
  assert.equal(insert.user_id, "u");
  assert.equal(insert.definition.nodes.length, 3);
  count = 50;
  assert.equal((await route.POST(post({ workspaceId: WS, name: "one more" }))).status, 400);
});

test("PATCH saves against the read revision and reports conflicts with the current copy", async () => {
  let stale = false;
  const { client, calls } = supabase((_, calls) => {
    const updating = calls.some((c) => c[1] === "update") && calls.filter((c) => c[1] === "maybeSingle").length === 1;
    if (updating && stale) return { data: null, error: null };
    return { data: row({ revision: updating ? 4 : 5 }), error: null };
  });
  const route = load("./[id]/route.ts", client);
  assert.equal((await route.PATCH(patch({ name: "x" }), params)).status, 400, "revision required");
  assert.equal((await route.PATCH(patch({ revision: 3 }), params)).status, 400, "nothing to change");
  const saved = await route.PATCH(patch({ revision: 3, name: "Renamed" }), params);
  assert.equal(saved.status, 200);
  const update = calls.find((c) => c[1] === "update")[2];
  assert.equal(update.revision, 4);
  assert.equal(update.name, "Renamed");
  assert.ok(calls.some((c) => c[1] === "eq" && c[2] === "revision" && c[3] === 3));

  calls.length = 0;
  stale = true;
  const conflict = await route.PATCH(patch({ revision: 3, name: "Again" }), params);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).workflow.revision, 5);
});

test("GET and DELETE treat unknown ids as not found", async () => {
  const { client } = supabase(() => ({ data: null, error: null }));
  const route = load("./[id]/route.ts", client);
  const bad = { params: Promise.resolve({ id: "not-a-uuid" }) };
  assert.equal((await route.GET(new Request("http://localhost/x"), bad)).status, 404);
  assert.equal((await route.GET(new Request("http://localhost/x"), params)).status, 404);
  assert.equal((await route.DELETE(new Request("http://localhost/x", { method: "DELETE" }), params)).status, 404);
});
