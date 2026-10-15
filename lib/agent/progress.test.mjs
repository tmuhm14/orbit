import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "./agent.ts";

test("progress is ordered around real work and does not contain tool inputs or results", async () => {
  const events = [];
  let calls = 0;
  const result = await runAgent({
    provider: { chat: async () => ++calls === 1
      ? { text: "I will review the notes.", calls: [{ id: "c1", name: "list_notes", input: { query: "private search" } }] }
      : { text: "Review complete.", calls: [] } },
    store: { list: async () => { assert.equal(events.at(-1).text, "Finding relevant notes"); return [{ title: "private result" }]; } },
    workspaceName: "Test", task: "Review",
    onProgress: async (event) => events.push(event),
  });
  assert.deepEqual(events.map(({ kind, text }) => [kind, text]), [
    ["status", "Reviewing your request"], ["message", "I will review the notes."],
    ["tool", "Finding relevant notes"], ["status", "Planning the next step"],
  ]);
  assert.ok(events.every((event) => Number.isFinite(Date.parse(event.at))));
  assert.doesNotMatch(JSON.stringify(events), /private/);
  assert.equal(result.summary, "Review complete.");
});

test("failed progress persistence stops execution before a model call or write", async () => {
  await assert.rejects(runAgent({
    provider: { chat: async () => assert.fail("must not call provider") },
    store: {}, workspaceName: "Test", task: "Review",
    onProgress: async () => { throw new Error("Storage unavailable"); },
  }), /Storage unavailable/);
});

test("commentary is bounded and a failed tool preserves its attempted step", async () => {
  const events = [];
  await assert.rejects(runAgent({
    provider: { chat: async () => ({ text: "x".repeat(3000), calls: [{ id: "c", name: "list_notes", input: {} }] }) },
    store: { list: async () => { throw new Error("Read failed"); } },
    workspaceName: "Test", task: "Review", onProgress: async (event) => events.push(event),
  }), /Read failed/);
  assert.equal(events[1].text.length, 2000);
  assert.equal(events.at(-1).text, "Finding relevant notes");
});
