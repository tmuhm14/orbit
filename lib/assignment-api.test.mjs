import { test } from "node:test";
import assert from "node:assert/strict";
import { assignmentApi, savedNoteIdOf } from "./assignment-api.ts";
import { AssignmentApiError } from "./assignments/client.ts";

// The U-05 adapter against a fetch double (the backend routes are mocked).
const ID = "33333333-3333-4333-8333-333333333333";
const WS = "11111111-1111-4111-8111-111111111111";

function fakeFetch(responses) {
  const sent = [];
  const fetcher = async (path, init = {}) => {
    sent.push({
      path,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
      credentials: init.credentials,
      contentType: init.headers?.["Content-Type"],
    });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
    });
  };
  return { fetcher, sent };
}

test("list sends sourceNoteId, states and limit", async () => {
  const { fetcher, sent } = fakeFetch([{ body: { assignments: [{ id: ID }] } }, { body: { assignments: [] } }]);
  const api = assignmentApi(fetcher);
  assert.deepEqual(await api.list(WS, { sourceNoteId: "n1", states: ["queued", "running"], limit: 20 }), [{ id: ID }]);
  await api.list(WS);
  assert.equal(sent[0].path, `/api/assignments?workspaceId=${WS}&sourceNoteId=n1&state=queued%2Crunning&limit=20`);
  assert.equal(sent[0].credentials, "same-origin");
  assert.equal(sent[1].path, `/api/assignments?workspaceId=${WS}`);
});

test("availability parses the body and treats surprises as unknown", async () => {
  const { fetcher, sent } = fakeFetch([
    { body: { available: false, reason: "agent_disabled" } },
    { body: { available: true } },
    { body: { nope: 1 } },
    { status: 404, body: { error: "Not found", code: "not_found" } },
  ]);
  const api = assignmentApi(fetcher);
  assert.deepEqual(await api.availability(WS), { available: false, reason: "agent_disabled" });
  assert.deepEqual(await api.availability(WS), { available: true });
  assert.equal(await api.availability(WS), null);
  await assert.rejects(api.availability(WS), (e) => e instanceof AssignmentApiError && e.code === "not_found");
  assert.equal(sent[0].path, `/api/assignments/availability?workspaceId=${WS}`);
});

test("saveDocument posts the exact body and returns note and assignment", async () => {
  const { fetcher, sent } = fakeFetch([{ status: 201, body: { note: { id: "doc" }, assignment: { id: ID } } }]);
  const api = assignmentApi(fetcher);
  const result = await api.saveDocument(ID, { expectedRevision: 4, artifactId: "art", projectId: null, title: "Reply" });
  assert.deepEqual(result, { note: { id: "doc" }, assignment: { id: ID } });
  assert.deepEqual(sent[0], {
    path: `/api/assignments/${ID}/save-document`,
    method: "POST",
    body: { expectedRevision: 4, artifactId: "art", projectId: null, title: "Reply" },
    credentials: "same-origin",
    contentType: "application/json",
  });
});

test("save errors keep their code and already_saved points at the note", async () => {
  const { fetcher } = fakeFetch([
    { status: 409, body: { error: "Already saved", code: "already_saved", noteId: "doc-1" } },
    { status: 409, body: { error: "Stale", code: "revision_conflict", currentRevision: 9 } },
    { status: 500, body: "<html>" },
    new TypeError("offline"),
  ]);
  const api = assignmentApi(fetcher);
  const body = { expectedRevision: 1, artifactId: "a" };
  const saved = await api.saveDocument(ID, body).catch((e) => e);
  assert.equal(saved.code, "already_saved");
  assert.equal(savedNoteIdOf(saved), "doc-1");
  const stale = await api.saveDocument(ID, body).catch((e) => e);
  assert.equal(stale.code, "revision_conflict");
  assert.equal(stale.body.currentRevision, 9);
  assert.equal(savedNoteIdOf(stale), null);
  assert.equal((await api.saveDocument(ID, body).catch((e) => e)).code, "unexpected_response");
  assert.equal((await api.saveDocument(ID, body).catch((e) => e)).code, "network_error");
  assert.equal(savedNoteIdOf(new Error("x")), null);
});
