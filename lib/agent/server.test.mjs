import { test } from "node:test";
import assert from "node:assert/strict";
import * as notesModule from "../notes.ts";
import * as agentModule from "./agent.ts";
import * as providersModule from "./providers.ts";
import * as secretModule from "./secret.ts";
import { loadTs } from "../../tests/load-ts.mjs";

const { supabaseAgentStore } = loadTs(new URL("./server.ts", import.meta.url), {
  "../notes": notesModule,
  "./agent": agentModule,
  "./providers": providersModule,
  "./secret": secretModule,
});
const scope = { userId: "user-1", workspaceId: "ws-1", runId: "run-1" };
const NOTE = "11111111-1111-4111-8111-111111111111";

/**
 * Admin client double. Notes live in memory; agent_apply_note_change and
 * agent_create_note follow the SQL contract (apply only at the expected
 * revision, audit in the same call). `beforeApply` lets a test change the note
 * between the store's read and its write, like a person typing.
 */
function fakeAdmin({ beforeApply } = {}) {
  const notes = new Map([[NOTE, {
    id: NOTE, title: "Call vendor", bucket: "inbox", tags: [], source: "slack",
    plain_text: "line", content: { type: "doc", content: [] }, origin: null,
    created_at: "2026-10-01T00:00:00Z", completed_at: null, triage_status: "pending", revision: 1,
  }]]);
  const actions = [];
  const log = [];
  const query = (table) => {
    log.push(["from", table]);
    const filters = [];
    const builder = {
      select: () => builder,
      eq: (column, value) => (filters.push((r) => column === "user_id" || column === "workspace_id" || r[column] === value), builder),
      is: () => builder, contains: () => builder, or: () => builder, order: () => builder, limit: () => builder,
      returns: async () => ({ data: [...notes.values()].filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }),
      maybeSingle: async () => ({ data: [...notes.values()].find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      insert: () => { throw new Error("agent writes must go through RPCs"); },
      update: () => { throw new Error("agent writes must go through RPCs"); },
    };
    return builder;
  };
  const rpc = async (name, args) => {
    log.push(["rpc", name, args]);
    if (name === "agent_apply_note_change") {
      beforeApply?.(notes.get(args.p_note_id), log.filter((l) => l[1] === name).length);
      const row = notes.get(args.p_note_id);
      if (!row) return { data: { status: "not_found" }, error: null };
      if (row.revision !== args.p_expected_revision)
        return { data: { status: "conflict", currentRevision: row.revision }, error: null };
      const before = Object.fromEntries(Object.keys(args.p_after).map((k) => [k, row[k]]));
      const tracked = Object.keys(args.p_after).some((k) => k !== "triage_status");
      Object.assign(row, args.p_after, { revision: row.revision + (tracked ? 1 : 0) });
      actions.push({ run_id: args.p_run_id, note_id: row.id, kind: "update", before, after: args.p_after,
        reason: args.p_reason, revision_before: args.p_expected_revision, revision_after: row.revision });
      return { data: { status: "applied", revision: row.revision }, error: null };
    }
    if (name === "agent_create_note") {
      const id = "22222222-2222-4222-8222-222222222222";
      notes.set(id, { id, ...args.p_note, revision: 1, triage_status: "none" });
      actions.push({ run_id: args.p_run_id, note_id: id, kind: "create", before: null, after: args.p_note, revision_after: 1 });
      return { data: { status: "created", id, revision: 1 }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  };
  return { admin: { from: query, rpc }, notes, actions, log };
}

test("agent changes and their audit are written in one call, at the revision read", async () => {
  const { admin, notes, actions, log } = fakeAdmin();
  const store = supabaseAgentStore(admin, scope);
  const read = await store.get(NOTE);
  assert.equal(Object.hasOwn(read, "revision"), false, "revisions are not shown to the model");
  assert.equal(await store.update(NOTE, { bucket: "next", appendText: "more" }, "Filed"), true);
  const call = log.find((l) => l[1] === "agent_apply_note_change")[2];
  assert.deepEqual([call.p_run_id, call.p_expected_revision, call.p_reason], ["run-1", 1, "Filed"]);
  assert.deepEqual(Object.keys(call.p_after).sort(), ["bucket", "content", "plain_text", "triage_status"]);
  assert.equal(notes.get(NOTE).plain_text, "line\nmore");
  assert.equal(actions.length, 1);
  assert.deepEqual([actions[0].revision_before, actions[0].revision_after], [1, 2]);
  assert.ok(!log.some((l) => l[0] === "from" && l[1] === "agent_actions"), "no separate audit insert");
  const id = await store.create({ title: "Follow up", body: "Text", bucket: "next", tags: ["x"] }, "Split");
  assert.equal(actions[1].kind, "create");
  assert.deepEqual(actions[1].after.tags, ["x", "agent"]);
  assert.equal(notes.get(id).revision, 1);
});

test("on a conflict the store re-reads once and recomputes against the new content", async () => {
  const { admin, notes, actions, log } = fakeAdmin({
    beforeApply: (row, attempt) => {
      // A person edits the note between the agent's first read and write.
      if (attempt === 1) Object.assign(row, { plain_text: "line\nhuman edit", revision: row.revision + 1 });
    },
  });
  const store = supabaseAgentStore(admin, scope);
  await store.get(NOTE);
  assert.equal(await store.update(NOTE, { appendText: "agent" }, ""), true);
  const applies = log.filter((l) => l[1] === "agent_apply_note_change").map((l) => l[2]);
  assert.deepEqual(applies.map((a) => a.p_expected_revision), [1, 2]);
  assert.equal(notes.get(NOTE).plain_text, "line\nhuman edit\nagent", "the human edit survives");
  assert.equal(actions.length, 1);
});

test("a stale read is recomputed once; a second conflict writes nothing", async () => {
  const stale = fakeAdmin();
  const store = supabaseAgentStore(stale.admin, scope);
  await store.get(NOTE);
  // Changed after the model read it: the first attempt is already a conflict.
  Object.assign(stale.notes.get(NOTE), { title: "Renamed by me", revision: 2 });
  assert.equal(await store.update(NOTE, { bucket: "next" }, ""), true);
  assert.deepEqual(stale.log.filter((l) => l[1] === "agent_apply_note_change").map((l) => l[2].p_expected_revision), [2]);
  assert.equal(stale.notes.get(NOTE).title, "Renamed by me");

  const busy = fakeAdmin({ beforeApply: (row) => { row.revision += 1; } });
  const busyStore = supabaseAgentStore(busy.admin, scope);
  assert.equal(await busyStore.update(NOTE, { bucket: "next" }, ""), false);
  assert.equal(busy.log.filter((l) => l[1] === "agent_apply_note_change").length, 2, "exactly one re-read");
  assert.equal(busy.actions.length, 0);
  assert.equal(busy.notes.get(NOTE).bucket, "inbox");
});

test("an inactive run or failed call writes nothing and stops the tool", async () => {
  const { admin } = fakeAdmin();
  admin.rpc = async () => ({ data: { status: "run_not_active" }, error: null });
  const store = supabaseAgentStore(admin, scope);
  await assert.rejects(store.update(NOTE, { bucket: "next" }, ""), /no longer active/);
  await assert.rejects(store.create({ title: "x", body: "", bucket: "inbox", tags: [] }, ""), /Could not create note/);
  admin.rpc = async () => ({ data: null, error: { message: "boom" } });
  await assert.rejects(store.update(NOTE, { bucket: "next" }, ""), (e) => e.message === "Could not update note");
});
