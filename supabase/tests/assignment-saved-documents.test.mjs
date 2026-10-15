import { test, before } from "node:test";
import assert from "node:assert/strict";
import { as, createDb, migrate, skip } from "./harness.mjs";

// U-05: save_assignment_artifact_as_note() against PGlite. Saving an accepted
// result creates one document item in one transaction, with the project
// defaulting rules, idempotency, the state/artifact/revision guards, project
// link validation, ownership, RLS, the artifact_saved event and the
// on-delete-set-null link.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
let n = 0;
const uuid = () => `eeeeeeee-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const CONTENT = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Dear vendor" }] }] };

let db;
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const user = async (who, sql, params = []) => (await as(db, "authenticated", who, sql, params))[0]?.r;
const svc = async (sql, params = []) => (await as(db, "service_role", null, sql, params))[0]?.r;

const newWs = async (who = A) =>
  (await one(`insert into public.workspaces (user_id, name, agent_enabled) values ($1, 'W', true) returning id`, [who])).id;
async function note(who, ws, kind = "task", projectId = null) {
  const id = uuid();
  const [r] = (await as(db, "authenticated", who, "select public.save_notes($1::jsonb, false) r", [JSON.stringify([{
    id, workspace_id: ws, title: "Captured", content: { type: "doc" }, plain_text: "", bucket: kind === "project" ? "projects" : "next",
    tags: [], kind, project_id: projectId, created_at: "2026-10-13T00:00:00.000Z", completed_at: null, expected_revision: null,
  }])]))[0].r;
  assert.equal(r.status, "saved", JSON.stringify(r));
  return id;
}
const rev = async (id) => Number((await one("select revision from public.assignments where id = $1", [id])).revision);
const review = async (who, id, artifact, decision, comment = null) =>
  user(who, "select public.review_assignment_artifact($1, $2, $3, $4, $5) r", [id, await rev(id), artifact, decision, comment]);
async function submitted(id, title = "Reply draft") {
  const lease = await svc("select public.claim_assignment($1, null) r", [id]);
  assert.equal(lease.status, "claimed");
  const s = await svc("select public.submit_assignment_artifact($1, $2, $3::jsonb) r", [lease.attemptId, lease.leaseToken,
    JSON.stringify({ kind: "draft", title, content: CONTENT, plain_text: "Dear vendor", source_note_ids: [] })]);
  assert.equal(s.status, "submitted");
  return s.artifactId;
}
/** A completed assignment (accepted result) delegated from `source`, or a new task. */
async function completed({ who = A, ws, source, decision = "accept" } = {}) {
  ws ??= await newWs(who);
  source ??= await note(who, ws);
  const created = await user(who, "select public.create_assignment($1, $2, 'Draft a reply', '{}'::uuid[], 'builtin', null) r", [ws, source]);
  assert.equal(created.status, "created");
  const id = created.assignment.id;
  const artifactId = await submitted(id);
  if (decision) assert.equal((await review(who, id, artifactId, decision)).status, "saved");
  return { id, ws, source, artifactId };
}
const save = async (who, id, artifactId, options = {}, expected) =>
  user(who, "select public.save_assignment_artifact_as_note($1, $2, $3, $4::jsonb) r",
    [id, expected ?? await rev(id), artifactId, JSON.stringify(options)]);
const savedNoteId = async (artifactId) =>
  (await one("select saved_note_id from public.assignment_artifacts where id = $1", [artifactId])).saved_note_id;
const noteRow = (id) => one("select * from public.notes where id = $1", [id]);

before(async () => {
  if (skip) return;
  db = await createDb();
  await migrate(db);
  await db.exec(`insert into auth.users values ('${A}'), ('${B}');`);
  for (const who of [A, B])
    await db.query(`insert into public.agent_settings (user_id, provider, model, api_key_ciphertext, key_hint)
      values ($1, 'anthropic', 'm', 'x', 'abcd')`, [who]);
});

test("saving creates one document item with the artifact, provenance and revision 1", { skip }, async () => {
  const ws = await newWs();
  const project = await note(A, ws, "project");
  const source = await note(A, ws, "task", project);
  const { id, artifactId } = await completed({ ws, source });
  const before = await one("select * from public.assignments where id = $1", [id]);
  const r = await save(A, id, artifactId);
  assert.equal(r.status, "created");
  assert.equal(r.artifactId, artifactId);
  const row = await noteRow(r.note.id);
  assert.deepEqual(
    [row.user_id, row.workspace_id, row.kind, row.bucket, row.project_id, row.title, row.plain_text, Number(row.revision),
      row.source, row.triage_status, row.completed_at, row.tags],
    [A, ws, "document", "reference", project, "Reply draft", "Dear vendor", 1, "web", "none", null, []]);
  assert.deepEqual(row.content, CONTENT);
  assert.deepEqual(row.origin, { kind: "assignment", assignmentId: id, artifactId });
  // The note in the result is note_json(), the shape GET /api/notes maps.
  assert.deepEqual(Object.keys(r.note).sort(), ["bucket", "completed_at", "content", "created_at", "due_date", "id", "kind",
    "next_check_on", "origin", "plain_text", "project_id", "revision", "source", "tags", "title", "updated_at",
    "waiting_for", "waiting_on", "workspace_id"]);
  assert.equal(r.note.revision, 1);
  // The link and the event; the assignment row itself is unchanged.
  assert.equal(await savedNoteId(artifactId), r.note.id);
  const after = await one("select * from public.assignments where id = $1", [id]);
  assert.deepEqual(after, before);
  assert.equal(r.assignment.revision, Number(before.revision));
  assert.equal(r.assignment.state, "completed");
  const event = await one(`select type, actor, from_state, to_state, payload, attempt_id from public.assignment_events
    where assignment_id = $1 order by id desc limit 1`, [id]);
  const attempt = (await one("select attempt_id from public.assignment_artifacts where id = $1", [artifactId])).attempt_id;
  assert.deepEqual(event, { type: "artifact_saved", actor: "user", from_state: null, to_state: null,
    payload: { artifactId, noteId: r.note.id }, attempt_id: attempt });
  // A user write, not an agent action, and the source task is untouched.
  assert.equal((await q("select 1 from public.agent_actions where note_id = $1", [r.note.id])).length, 0);
  assert.equal((await noteRow(source)).completed_at, null);
});

test("project defaults: source's project, the source project itself, none; explicit null and other project", { skip }, async () => {
  const ws = await newWs();
  const project = await note(A, ws, "project");
  const other = await note(A, ws, "project");
  const sub = await note(A, ws, "project", project);
  const projectOf = async (r) => (assert.equal(r.status, "created", JSON.stringify(r)), (await noteRow(r.note.id)).project_id);

  const inProject = await completed({ ws, source: await note(A, ws, "task", project) });
  assert.equal(await projectOf(await save(A, inProject.id, inProject.artifactId)), project);
  const isProject = await completed({ ws, source: sub });
  assert.equal(await projectOf(await save(A, isProject.id, isProject.artifactId)), sub);
  const loose = await completed({ ws, source: await note(A, ws, "note") });
  assert.equal(await projectOf(await save(A, loose.id, loose.artifactId)), null);
  const explicitNull = await completed({ ws, source: await note(A, ws, "task", project) });
  assert.equal(await projectOf(await save(A, explicitNull.id, explicitNull.artifactId, { project_id: null })), null);
  const explicitOther = await completed({ ws, source: await note(A, ws, "task", project) });
  const r = await save(A, explicitOther.id, explicitOther.artifactId, { project_id: other, title: "  Vendor reply  " });
  assert.equal(await projectOf(r), other);
  assert.equal((await noteRow(r.note.id)).title, "Vendor reply");
  // A source item deleted after the assignment finished: no default project.
  const gone = await completed({ ws, source: await note(A, ws, "task", project) });
  await user(A, "select public.delete_note($1, null, false) r", [gone.source]);
  assert.equal((await one("select source_note_id from public.assignments where id = $1", [gone.id])).source_note_id, null);
  assert.equal(await projectOf(await save(A, gone.id, gone.artifactId)), null);
});

test("saving twice is idempotent: already_saved with the first note id, no duplicate", { skip }, async () => {
  const { id, artifactId } = await completed();
  const first = await save(A, id, artifactId);
  const count = async () => Number((await one("select count(*) c from public.notes where origin ->> 'assignmentId' = $1", [id])).c);
  for (const options of [{}, { title: "Other" }, { project_id: null }])
    assert.deepEqual(await save(A, id, artifactId, options), { status: "already_saved", noteId: first.note.id });
  assert.equal(await count(), 1);
  assert.equal((await q("select 1 from public.assignment_events where assignment_id = $1 and type = 'artifact_saved'", [id])).length, 1);
});

test("guards: not completed, superseded or unaccepted artifact, stale revision, wrong artifact", { skip }, async () => {
  const review1 = await completed({ decision: null });
  assert.deepEqual(await save(A, review1.id, review1.artifactId),
    { status: "invalid_transition", from: "needs_review", to: "completed", allowed: ["canceled", "completed", "queued"] });
  const rejected = await completed({ decision: "reject" });
  const r = await save(A, rejected.id, rejected.artifactId);
  assert.deepEqual([r.status, r.from], ["invalid_transition", "canceled"]);

  // Request changes, then accept the second result: the first is superseded.
  const ws = await newWs();
  const created = await user(A, "select public.create_assignment($1, $2, 'Draft', '{}'::uuid[], 'builtin', null) r", [ws, await note(A, ws)]);
  const id = created.assignment.id;
  const firstArtifact = await submitted(id, "First");
  assert.equal((await review(A, id, firstArtifact, "request_changes", "Shorter")).status, "saved");
  const secondArtifact = await submitted(id, "Second");
  assert.equal((await review(A, id, secondArtifact, "accept")).status, "saved");
  assert.deepEqual(await save(A, id, firstArtifact), { status: "artifact_superseded" });
  assert.deepEqual(await save(A, id, uuid()), { status: "not_found" });
  const otherAssignment = await completed();
  assert.deepEqual(await save(A, id, otherAssignment.artifactId), { status: "not_found" });

  const current = await rev(id);
  assert.deepEqual(await save(A, id, secondArtifact, {}, current - 1),
    { status: "conflict", currentRevision: current, state: "completed" });
  assert.equal(await savedNoteId(secondArtifact), null, "nothing was written");
  assert.equal((await save(A, id, secondArtifact)).status, "created");
});

test("invalid payloads write nothing", { skip }, async () => {
  const { id, artifactId } = await completed();
  const notes = async () => Number((await one("select count(*) c from public.notes")).c);
  const count = await notes();
  for (const options of [{ title: "" }, { title: "   " }, { title: "x".repeat(201) }, { title: 5 }, { project_id: "nope" },
    { project_id: 7 }, [], "x"])
    assert.deepEqual(await save(A, id, artifactId, options), { status: "invalid_payload" }, JSON.stringify(options));
  assert.deepEqual(await user(A, "select public.save_assignment_artifact_as_note($1, null, $2, '{}') r", [id, artifactId]),
    { status: "invalid_payload" });
  assert.deepEqual(await user(A, "select public.save_assignment_artifact_as_note($1, $2, null, '{}') r", [id, await rev(id)]),
    { status: "invalid_payload" });
  // A null options object means the defaults.
  assert.equal((await user(A, "select public.save_assignment_artifact_as_note($1, $2, $3, null) r", [id, await rev(id), artifactId])).status, "created");
  assert.equal(await notes(), count + 1);
  await assert.rejects(as(db, "authenticated", null, "select public.save_assignment_artifact_as_note($1, 1, $2, '{}')", [id, artifactId]),
    /Not signed in/);
});

test("project link errors surface as invalid codes and create nothing", { skip }, async () => {
  const ws = await newWs();
  const { id, artifactId } = await completed({ ws });
  const otherWs = await newWs();
  const cases = [
    await note(A, ws, "task"), // not a project
    await note(A, otherWs, "project"), // another workspace
    await note(B, await newWs(B), "project"), // another account
    uuid(), // missing
  ];
  for (const project of cases)
    assert.deepEqual(await save(A, id, artifactId, { project_id: project }), { status: "invalid", code: "invalid_project_link" });
  assert.equal(await savedNoteId(artifactId), null);
  assert.equal((await q("select 1 from public.notes where origin ->> 'assignmentId' = $1", [id])).length, 0);
  assert.equal((await q("select 1 from public.assignment_events where assignment_id = $1 and type = 'artifact_saved'", [id])).length, 0);
  // A document is not a project, so it can attach at any depth and can't
  // form a cycle: the deepest allowed project still accepts it.
  let parent = null;
  for (let depth = 0; depth < 5; depth++) parent = await note(A, ws, "project", parent);
  const r = await save(A, id, artifactId, { project_id: parent });
  assert.equal(r.status, "created");
  assert.equal((await noteRow(r.note.id)).project_id, parent);
});

test("other accounts get not_found; RLS and grants keep the link server-owned", { skip }, async () => {
  const { id, artifactId } = await completed();
  assert.deepEqual(await save(B, id, artifactId, {}, await rev(id)), { status: "not_found" });
  assert.equal(await savedNoteId(artifactId), null);
  const r = await save(A, id, artifactId);
  assert.equal((await as(db, "authenticated", B, "select id from public.notes where id = $1", [r.note.id])).length, 0);
  assert.equal((await as(db, "authenticated", B, "select id from public.assignment_artifacts where id = $1", [artifactId])).length, 0);
  assert.equal((await as(db, "authenticated", A, "select saved_note_id from public.assignment_artifacts where id = $1", [artifactId]))[0].saved_note_id, r.note.id);
  await assert.rejects(as(db, "authenticated", A, "update public.assignment_artifacts set saved_note_id = null where id = $1", [artifactId]),
    /permission denied/);
  for (const role of ["anon", "service_role"])
    await assert.rejects(as(db, role, A, "select public.save_assignment_artifact_as_note($1, 1, $2, '{}')", [id, artifactId]),
      /permission denied/, role);
  const grants = await q(`select grantee from information_schema.routine_privileges
    where routine_name = 'save_assignment_artifact_as_note' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`);
  assert.deepEqual(grants.map((g) => g.grantee), ["authenticated"]);
  const definer = await one(`select prosecdef, proconfig from pg_proc where proname = 'save_assignment_artifact_as_note'`);
  assert.deepEqual([definer.prosecdef, definer.proconfig], [true, ['search_path=""']]);
});

test("deleting the saved note clears the link and leaves the assignment intact", { skip }, async () => {
  const { id, artifactId } = await completed();
  const r = await save(A, id, artifactId);
  const before = await one("select * from public.assignments where id = $1", [id]);
  const eventsBefore = await q("select id, type from public.assignment_events where assignment_id = $1 order by id", [id]);
  const deleted = await user(A, "select public.delete_note($1, 1, true) r", [r.note.id]);
  assert.equal(deleted.status, "deleted");
  assert.equal(await savedNoteId(artifactId), null);
  assert.deepEqual(await one("select * from public.assignments where id = $1", [id]), before);
  assert.deepEqual(await q("select id, type from public.assignment_events where assignment_id = $1 order by id", [id]), eventsBefore);
  assert.equal((await q("select 1 from public.assignment_reviews where assignment_id = $1", [id])).length, 1);
  // The result can be saved again.
  const again = await save(A, id, artifactId);
  assert.equal(again.status, "created");
  assert.notEqual(again.note.id, r.note.id);
});

test("the saved document can move workspace; the link is kept", { skip }, async () => {
  const { id, artifactId, ws } = await completed();
  const r = await save(A, id, artifactId, { project_id: null });
  const other = await newWs();
  const [moved] = await user(A, "select public.save_notes($1::jsonb, true) r", [JSON.stringify([{ ...r.note,
    workspace_id: other, tags: [], expected_revision: 1 }])]);
  assert.equal(moved.status, "saved");
  assert.equal(await savedNoteId(artifactId), r.note.id);
  assert.notEqual(other, ws);
});
