import { test } from "node:test";
import assert from "node:assert/strict";
import * as notesModule from "../../../../../../lib/notes.ts";
import { loadTs } from "../../../../../../tests/load-ts.mjs";

// The undo decisions (revision and value checks, 90-day window) live in
// undo_agent_action(); see supabase/tests/note-functions.test.mjs. This covers
// the route: it calls the function with the user's session and maps results.
const ACTION = "33333333-3333-4333-8333-333333333333";
const json = (body, status = 200) => Response.json(body, { status });
function route(result, error = null) {
  const calls = [];
  const auth = { user: { id: "u" }, supabase: { rpc: async (name, args) => (calls.push([name, args]), { data: result, error }) } };
  const handlers = loadTs(new URL("./route.ts", import.meta.url), {
    "@/lib/supabase/route-auth": { routeUser: async () => auth, json },
    "@/lib/notes": notesModule,
  });
  const undo = async (id = ACTION) => {
    const response = await handlers.POST(new Request(`http://localhost/api/agent/actions/${id}/undo`, { method: "POST" }), { params: Promise.resolve({ id }) });
    return { status: response.status, body: await response.json() };
  };
  return { undo, calls };
}

test("undo calls the safe-undo function as the signed-in user", async () => {
  const { undo, calls } = route({ status: "undone", undone: ACTION, revision: 5 });
  assert.deepEqual(await undo(), { status: 200, body: { undone: ACTION, revision: 5 } });
  assert.deepEqual(calls, [["undo_agent_action", { p_action_id: ACTION }]]);
  assert.equal((await route({ status: "undone" }).undo("not-a-uuid")).status, 400);
});

test("undo refuses after an intervening edit and names only the fields", async () => {
  const { undo } = route({ status: "undo_conflict", fields: ["title"] });
  const response = await undo();
  assert.deepEqual([response.status, response.body.code, response.body.fields], [409, "undo_conflict", ["title"]]);
  const edited = await route({ status: "edited_since_created" }).undo();
  assert.deepEqual([edited.status, edited.body.code], [409, "edited_since_created"]);
});

test("undo window, repeats and missing notes map to their own statuses", async () => {
  const cases = [
    ["undo_expired", 410], ["already_undone", 409], ["note_deleted", 404],
    ["not_found", 404], ["project_has_linked_items", 409],
  ];
  for (const [status, http] of cases) {
    const response = await route({ status }).undo();
    assert.deepEqual([response.status, response.body.code], [http, status], status);
  }
  const gone = await route({ status: "undone", undone: ACTION, revision: null, alreadyDeleted: true }).undo();
  assert.deepEqual(gone, { status: 200, body: { undone: ACTION, revision: null, alreadyDeleted: true } });
  assert.equal((await route(null, { message: "db down" }).undo()).status, 500);
  assert.equal((await route({ status: "surprise" }).undo()).status, 500);
});
