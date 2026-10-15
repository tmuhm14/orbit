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
      // Rows without a workspace_id belong to the run's workspace.
      eq: (column, value) => (filters.push((r) => column === "user_id" ||
        (column === "workspace_id" ? (r.workspace_id ?? value) === value : r[column] === value)), builder),
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
  assert.deepEqual(await busyStore.update(NOTE, { bucket: "next" }, ""), { refused: "conflict" });
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

// --- D-02: kinds and project links (ADR 001 §3a) ---------------------------

const PROJECT = "33333333-3333-4333-8333-333333333333";
const ELSEWHERE = "44444444-4444-4444-8444-444444444444";
const tool = (store, name, input) =>
  agentModule.executeTool(store, { id: "c", name, input }, { writes: 0, maxWrites: 10 }).then(JSON.parse);

test("a second conflict reaches the model as a conflict, not a missing note", async () => {
  const busy = fakeAdmin({ beforeApply: (row) => { row.revision += 1; } });
  const result = await tool(supabaseAgentStore(busy.admin, scope), "update_note", { id: NOTE, bucket: "next", reason: "r" });
  assert.deepEqual(result, { error: "That note just changed. Read it again before changing it." });
  assert.equal(busy.actions.length, 0);
});

test("kind and project_id go through the audited change; links stay in the workspace", async () => {
  const { admin, notes, log } = fakeAdmin();
  notes.set(PROJECT, { ...notes.get(NOTE), id: PROJECT, kind: "project", project_id: null, triage_status: "none" });
  notes.set(ELSEWHERE, { ...notes.get(NOTE), id: ELSEWHERE, kind: "project", workspace_id: "ws-2" });
  const store = supabaseAgentStore(admin, scope);
  const listed = await store.list({ limit: 10, kind: "project" });
  assert.ok(listed.some((n) => n.id === PROJECT && n.kind === "project" && n.projectId === null));
  assert.equal((await store.get(NOTE)).kind, "note", "rows without kind read as notes");
  assert.deepEqual(await tool(store, "update_note", { id: NOTE, kind: "task", project_id: PROJECT, reason: "Filed" }), { ok: true });
  const call = log.filter((l) => l[1] === "agent_apply_note_change").at(-1)[2];
  assert.deepEqual([call.p_after.kind, call.p_after.project_id], ["task", PROJECT]);
  assert.deepEqual(await tool(store, "update_note", { id: NOTE, project_id: ELSEWHERE, reason: "x" }), { error: "Project not found" });
  assert.deepEqual(await tool(store, "update_note", { id: NOTE, project_id: NOTE, reason: "x" }), { error: "Project not found" },
    "only kind=project notes resolve");
  assert.match((await tool(store, "update_note", { id: NOTE, project_id: "nope", reason: "x" })).error, /project_id must be/);
  assert.match((await tool(store, "update_note", { id: NOTE, kind: "epic", reason: "x" })).error, /kind must be one of/);
  assert.equal(log.filter((l) => l[1] === "agent_apply_note_change").length, 1, "refused before any write");
  assert.deepEqual(await tool(store, "update_note", { id: NOTE, project_id: "", reason: "Unlink" }), { ok: true });
  assert.equal(log.filter((l) => l[1] === "agent_apply_note_change").at(-1)[2].p_after.project_id, null);
  await tool(store, "create_note", { title: "Plan", bucket: "projects", kind: "project", project_id: PROJECT, reason: "r" });
  const created = log.find((l) => l[1] === "agent_create_note")[2].p_note;
  assert.deepEqual([created.kind, created.project_id], ["project", PROJECT]);
  assert.deepEqual(await tool(store, "create_note", { title: "X", bucket: "next", project_id: ELSEWHERE, reason: "r" }),
    { error: "Project not found" });
  await tool(store, "create_note", { title: "Plain", bucket: "next", reason: "r" });
  const plain = log.filter((l) => l[1] === "agent_create_note").at(-1)[2].p_note;
  assert.equal(Object.hasOwn(plain, "kind") || Object.hasOwn(plain, "project_id"), false, "D-01 payload when not asked");
});

test("server refusals become short tool errors with no content", async () => {
  const cases = [
    [{ status: "kind_not_allowed" }, "Suggest this kind change in your summary instead"],
    [{ status: "invalid", code: "project_cycle" }, "That would put a project inside itself"],
    [{ status: "invalid", code: "project_depth_exceeded" }, "Projects can be nested at most 5 levels deep"],
    [{ status: "invalid", code: "invalid_project_link" }, "Project not found"],
  ];
  for (const [data, message] of cases) {
    const { admin } = fakeAdmin();
    const real = admin.rpc;
    admin.rpc = async (name, args) => (name === "agent_apply_note_change" ? { data, error: null } : real(name, args));
    const result = await tool(supabaseAgentStore(admin, scope), "update_note", { id: NOTE, kind: "task", reason: "r" });
    assert.deepEqual(result, { error: message });
    assert.doesNotMatch(JSON.stringify(result), /Call vendor|line/);
  }
  const { admin } = fakeAdmin();
  admin.rpc = async () => ({ data: { status: "invalid", code: "project_cycle" }, error: null });
  assert.deepEqual(await tool(supabaseAgentStore(admin, scope), "create_note", { title: "P", bucket: "projects", reason: "r" }),
    { error: "That would put a project inside itself" });
});

// --- D-03: follow-ups (ADR 001 §4, §8) ----------------------------------------

test("follow-ups go through the audited change; lists carry only the check date", async () => {
  const { admin, notes, log, actions } = fakeAdmin();
  Object.assign(notes.get(NOTE), { waiting_on: null, waiting_for: null, next_check_on: null, triage_status: "none" });
  const store = supabaseAgentStore(admin, scope);
  assert.deepEqual(await tool(store, "update_note",
    { id: NOTE, waiting_on: "  Dana ", waiting_for: "Signed quote", next_check_on: "2026-10-20", reason: "Waiting" }), { ok: true });
  const call = log.filter((l) => l[1] === "agent_apply_note_change").at(-1)[2];
  assert.deepEqual(call.p_after, { waiting_on: "Dana", waiting_for: "Signed quote", next_check_on: "2026-10-20" });
  assert.deepEqual(actions.at(-1).before, { waiting_on: null, waiting_for: null, next_check_on: null }, "audited in the same call");
  const read = await store.get(NOTE);
  assert.deepEqual([read.waitingOn, read.waitingFor, read.nextCheckOn], ["Dana", "Signed quote", "2026-10-20"]);
  const [listed] = await store.list({ limit: 10 });
  assert.equal(listed.nextCheckOn, "2026-10-20");
  assert.equal(Object.hasOwn(listed, "waitingOn") || Object.hasOwn(listed, "waitingFor"), false,
    "follow-up text only when a note is read (minimum necessary)");
  // Unchanged values are not a write; empty strings clear.
  const writes = log.filter((l) => l[1] === "agent_apply_note_change").length;
  assert.deepEqual(await tool(store, "update_note", { id: NOTE, waiting_on: "Dana", reason: "r" }), { ok: true });
  assert.equal(log.filter((l) => l[1] === "agent_apply_note_change").length, writes);
  assert.deepEqual(await tool(store, "update_note", { id: NOTE, waiting_on: "", next_check_on: "", reason: "Clear" }), { ok: true });
  assert.deepEqual(log.filter((l) => l[1] === "agent_apply_note_change").at(-1)[2].p_after, { waiting_on: null, next_check_on: null });
});

test("follow-up tool input is validated before any write, without echoing it", async () => {
  const { admin, log } = fakeAdmin();
  const store = supabaseAgentStore(admin, scope);
  const cases = [
    [{ waiting_on: "x".repeat(201) }, /waiting_on must be one line of at most 200 characters/],
    [{ waiting_for: "line one\nline two" }, /waiting_for must be one line/],
    [{ waiting_on: 42 }, /waiting_on must be text/],
    [{ next_check_on: "next week" }, /next_check_on must be a date/],
    [{ next_check_on: "2026-02-30" }, /next_check_on must be a date/],
  ];
  for (const [input, message] of cases) {
    const result = await tool(store, "update_note", { id: NOTE, ...input, reason: "r" });
    assert.match(result.error, message);
    assert.doesNotMatch(result.error, /line one|next week|xxxx/);
  }
  assert.equal(log.filter((l) => l[1] === "agent_apply_note_change").length, 0);
  // create_note sends them only when given, so plain creates stay D-02 payloads.
  await tool(store, "create_note", { title: "Chase", bucket: "waiting", kind: "followup", waiting_on: "Ops",
    next_check_on: "2026-10-30", reason: "r" });
  const created = log.find((l) => l[1] === "agent_create_note")[2].p_note;
  assert.deepEqual([created.waiting_on, created.next_check_on, Object.hasOwn(created, "waiting_for")], ["Ops", "2026-10-30", false]);
  await tool(store, "create_note", { title: "Plain", bucket: "next", waiting_on: "", reason: "r" });
  const plain = log.filter((l) => l[1] === "agent_create_note").at(-1)[2].p_note;
  assert.equal(["waiting_on", "waiting_for", "next_check_on"].some((k) => Object.hasOwn(plain, k)), false);
  const update = agentModule.AGENT_TOOLS.find((t) => t.name === "update_note").parameters.properties;
  assert.deepEqual([update.waiting_on.maxLength, update.waiting_for.maxLength], [200, 2000]);
  assert.match(agentModule.agentSystemPrompt("W"), /waiting_on \(who\)/);
});

test("undo is offered only inside the 90-day window", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  const at = (days) => new Date(now - days * day).toISOString();
  assert.equal(agentModule.isUndoable({ created_at: at(1), undone_at: null, after: {} }, now), true);
  assert.equal(agentModule.isUndoable({ created_at: at(90), undone_at: null, after: {} }, now), true);
  assert.equal(agentModule.isUndoable({ created_at: at(91), undone_at: null, after: {} }, now), false);
  assert.equal(agentModule.isUndoable({ created_at: at(1), undone_at: at(0), after: {} }, now), false);
  assert.equal(agentModule.isUndoable({ created_at: at(1), undone_at: null, after: null }, now), false, "values purged");
});
