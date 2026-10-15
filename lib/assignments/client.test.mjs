import { test } from "node:test";
import assert from "node:assert/strict";
import { AssignmentApiError, assignmentIntent, assignmentsClient } from "./client.ts";
import {
  ASSIGNMENT_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  allowedTargets,
  isTransitionAllowed,
  userActions,
} from "./transitions.ts";

// The browser client against a fetch double, and the TS transition mirror's
// helpers. The mirror itself is compared with the database seed in
// supabase/tests/assignments.test.mjs.
const ID = "33333333-3333-4333-8333-333333333333";

function fakeFetch(responses) {
  const sent = [];
  const fetcher = async (path, init = {}) => {
    sent.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined,
      credentials: init.credentials, contentType: init.headers?.["Content-Type"] });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { fetcher, sent };
}

test("client: paths, methods and bodies", async () => {
  const assignment = { id: ID, revision: 2 };
  const { fetcher, sent } = fakeFetch([
    { status: 201, body: { assignment } }, { body: { assignments: [assignment] } }, { body: { assignment, events: [] } },
    { body: { assignment } }, { body: { assignment } }, { body: { assignment } }, { body: { assignment, reviewId: "r" } },
  ]);
  const client = assignmentsClient(fetcher);
  assert.deepEqual(await client.create({ workspaceId: "w", sourceNoteId: "n", requestedOutcome: "o" }), assignment);
  assert.deepEqual(await client.list("w", { states: ["queued", "running"], limit: 10 }), [assignment]);
  assert.equal((await client.get(ID)).assignment.id, ID);
  await client.cancel(ID, 2);
  await client.retry(ID, 3);
  await client.answer(ID, 4, "q", "Formal");
  assert.equal((await client.review(ID, 5, "a", "request_changes", "Shorter")).reviewId, "r");
  assert.deepEqual(sent.map((s) => [s.method, s.path, s.body]), [
    ["POST", "/api/assignments", { workspaceId: "w", sourceNoteId: "n", requestedOutcome: "o" }],
    ["GET", "/api/assignments?workspaceId=w&state=queued%2Crunning&limit=10", undefined],
    ["GET", `/api/assignments/${ID}`, undefined],
    ["POST", `/api/assignments/${ID}/cancel`, { expectedRevision: 2 }],
    ["POST", `/api/assignments/${ID}/retry`, { expectedRevision: 3 }],
    ["POST", `/api/assignments/${ID}/answer`, { expectedRevision: 4, questionId: "q", answer: "Formal" }],
    ["POST", `/api/assignments/${ID}/review`, { expectedRevision: 5, artifactId: "a", decision: "request_changes", comment: "Shorter" }],
  ]);
  assert.ok(sent.every((s) => s.credentials === "same-origin"));
  assert.deepEqual(sent.map((s) => s.contentType ?? null),
    ["application/json", null, null, "application/json", "application/json", "application/json", "application/json"]);
});

test("client: errors carry the route's status, code and body", async () => {
  const conflict = { error: "That assignment was changed elsewhere", code: "revision_conflict", currentRevision: 4, state: "running" };
  const { fetcher } = fakeFetch([{ status: 409, body: conflict }, { status: 502, body: "<html>" }, new TypeError("offline"), { body: "" }]);
  const client = assignmentsClient(fetcher);
  await assert.rejects(client.cancel(ID, 1), (e) =>
    e instanceof AssignmentApiError && e.status === 409 && e.code === "revision_conflict" && e.body.currentRevision === 4
    && e.message === conflict.error);
  await assert.rejects(client.cancel(ID, 1), (e) => e.code === "unexpected_response" && e.status === 502);
  await assert.rejects(client.cancel(ID, 1), (e) => e.code === "network_error" && e.status === 0);
  await assert.rejects(client.cancel(ID, 1), (e) => e.code === "unexpected_response");
});

test("client: U-05 saveDocument, availability and the sourceNoteId list option", async () => {
  const note = { id: "n", kind: "document" };
  const already = { error: "This result is already saved as a document", code: "already_saved", noteId: "n" };
  const { fetcher, sent } = fakeFetch([
    { status: 201, body: { note, assignment: { id: ID } } }, { status: 409, body: already },
    { body: { available: false, reason: "no_key" } }, { body: { assignments: [{ id: ID, savedNoteId: "n" }] } },
  ]);
  const client = assignmentsClient(fetcher);
  assert.deepEqual(await client.saveDocument(ID, { expectedRevision: 6, artifactId: "a", projectId: null, title: "T" }),
    { note, assignment: { id: ID } });
  await assert.rejects(client.saveDocument(ID, { expectedRevision: 6, artifactId: "a" }), (e) =>
    e instanceof AssignmentApiError && e.status === 409 && e.code === "already_saved" && e.body.noteId === "n");
  assert.deepEqual(await client.availability("w w"), { available: false, reason: "no_key" });
  assert.deepEqual(await client.list("w", { sourceNoteId: "s", states: ["completed"] }), [{ id: ID, savedNoteId: "n" }]);
  assert.deepEqual(sent.map((s) => [s.method, s.path, s.body]), [
    ["POST", `/api/assignments/${ID}/save-document`, { expectedRevision: 6, artifactId: "a", projectId: null, title: "T" }],
    ["POST", `/api/assignments/${ID}/save-document`, { expectedRevision: 6, artifactId: "a" }],
    ["GET", "/api/assignments/availability?workspaceId=w+w", undefined],
    ["GET", "/api/assignments?workspaceId=w&sourceNoteId=s&state=completed", undefined],
  ]);
});

test("intent is the outcome, answers and change requests only, oldest first", () => {
  const intent = assignmentIntent({
    assignment: { requestedOutcome: "Draft a reply", createdAt: "2026-10-14T00:00:00.000Z" },
    questions: [
      { answer: "Formal", answeredAt: "2026-10-14T00:02:00.000Z" },
      { answer: null, answeredAt: null },
    ],
    reviews: [
      { decision: "request_changes", comment: "Shorter", decidedAt: "2026-10-14T00:01:00.000Z" },
      { decision: "reject", comment: "No", decidedAt: "2026-10-14T00:03:00.000Z" },
    ],
  });
  assert.deepEqual(intent.map((i) => [i.kind, i.text]), [["outcome", "Draft a reply"], ["change_request", "Shorter"], ["answer", "Formal"]]);
});

test("transition helpers agree with the table", () => {
  assert.equal(TRANSITIONS.length, 17);
  for (const state of TERMINAL_STATES) {
    for (const actor of ["user", "executor", "system"]) assert.deepEqual(allowedTargets(state, actor), []);
    assert.deepEqual(userActions(state), []);
  }
  for (const state of ASSIGNMENT_STATES) assert.equal(isTransitionAllowed(state, state, "user"), false, "no self-transitions");
  assert.equal(isTransitionAllowed("needs_review", "completed", "user"), true);
  assert.equal(isTransitionAllowed("needs_review", "completed", "executor"), false, "only the user accepts");
  assert.equal(isTransitionAllowed("running", "needs_review", "user"), false);
  const target = { cancel: "canceled", retry: "queued", answer: "queued", accept: "completed", request_changes: "queued", reject: "canceled" };
  for (const state of ASSIGNMENT_STATES)
    for (const action of userActions(state))
      assert.ok(isTransitionAllowed(state, target[action], "user"), `${state} ${action}`);
});
