import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeIn, isAgentResult, progressOf, projectCounts, projectDetail, projectScopeIds, projectTree, treeIds } from './projects-view.ts';
import { createNote } from './notes.ts';

const at = (day) => `2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`;
const note = (title, patch = {}) => ({ ...createNote(title, 'next', 'work'), updatedAt: at(10), ...patch });

function fixture() {
  const root = note('Root', { kind: 'project', bucket: 'projects' });
  const sub = note('Sub', { kind: 'project', projectId: root.id });
  const deep = note('Deep', { kind: 'project', projectId: sub.id });
  const other = note('Another', { kind: 'project' });
  const items = [
    root, sub, deep, other,
    note('Task open', { kind: 'task', projectId: root.id, dueDate: '2026-10-20' }),
    note('Task soon', { kind: 'task', projectId: root.id, dueDate: '2026-10-16' }),
    note('Task done', { kind: 'task', projectId: root.id, completedAt: at(5) }),
    note('Follow', { kind: 'followup', projectId: root.id }),
    note('Plain', { kind: 'note', projectId: root.id }),
    note('Doc', { kind: 'document', projectId: root.id, updatedAt: at(2) }),
    note('Result', { kind: 'note', projectId: root.id, origin: { kind: 'assignment', assignmentId: 'a1', artifactId: 'r1' }, updatedAt: at(11) }),
    note('Sub task', { kind: 'task', projectId: sub.id }),
    note('Sub done', { kind: 'task', projectId: sub.id, completedAt: at(6) }),
    note('Deep done', { kind: 'task', projectId: deep.id, completedAt: at(7) }),
    note('Elsewhere', { kind: 'project', workspaceId: 'home' }),
  ];
  return { root, sub, deep, other, items };
}

test('counts include nested non-project items; progress is the real ratio', () => {
  const { root, sub, deep, other, items } = fixture();
  assert.deepEqual(projectCounts(items, root.id), { open: 7, done: 3, total: 10 });
  assert.deepEqual(projectCounts(items, sub.id), { open: 1, done: 2, total: 3 });
  assert.deepEqual(projectCounts(items, deep.id), { open: 0, done: 1, total: 1 });
  assert.equal(progressOf(projectCounts(items, sub.id)), 2 / 3);
  assert.equal(progressOf(projectCounts(items, other.id)), null);
});

test('tree nests by project_id, open first then title, one workspace only', () => {
  const { sub, deep, items } = fixture();
  const done = note('Finished', { kind: 'project', completedAt: at(3) });
  const tree = projectTree([...items, done], 'work');
  assert.deepEqual(tree.map((n) => n.project.title), ['Another', 'Root', 'Finished']);
  const r = tree[1];
  assert.equal(r.depth, 1);
  assert.deepEqual(r.children.map((n) => n.project.id), [sub.id]);
  assert.equal(r.children[0].depth, 2);
  assert.deepEqual(r.children[0].children.map((n) => n.project.id), [deep.id]);
  assert.equal(treeIds(tree).length, 5);
});

test('orphans and cycles still show at the top level', () => {
  const orphan = note('Orphan', { kind: 'project', projectId: 'gone' });
  const a = note('A', { kind: 'project' });
  const b = note('B', { kind: 'project', projectId: a.id });
  a.projectId = b.id;
  const tree = projectTree([orphan, a, b], 'work');
  assert.ok(tree.some((n) => n.project.id === orphan.id));
  assert.equal(treeIds(tree).sort().join(), [orphan.id, a.id, b.id].sort().join());
});

test('detail splits direct contents into sections in order', () => {
  const { root, sub, items } = fixture();
  const d = projectDetail(items, root.id);
  assert.equal(d.project.id, root.id);
  assert.deepEqual(d.ancestors, []);
  assert.deepEqual(d.subprojects.map((s) => s.project.id), [sub.id]);
  assert.deepEqual(d.subprojects[0].counts, { open: 1, done: 2, total: 3 });
  assert.deepEqual(d.tasks.open.map((n) => n.title), ['Task soon', 'Task open', 'Follow']);
  assert.deepEqual(d.tasks.done.map((n) => n.title), ['Task done']);
  assert.deepEqual(d.notes.map((n) => n.title), ['Plain']);
  assert.deepEqual(d.documents.map((n) => n.title), ['Result', 'Doc']);
});

test('detail breadcrumb is root first; unknown or non-project ids are null', () => {
  const { root, sub, deep, items } = fixture();
  assert.deepEqual(projectDetail(items, deep.id).ancestors.map((n) => n.id), [root.id, sub.id]);
  assert.equal(projectDetail(items, 'missing'), null);
  assert.equal(projectDetail(items, items.find((n) => n.title === 'Plain').id), null);
});

test('assignment scope covers the project and its items', () => {
  const { root, sub, items } = fixture();
  const scope = projectScopeIds(items, root.id);
  assert.ok(scope.has(root.id) && scope.has(sub.id));
  const list = [
    { sourceNoteId: root.id, state: 'running' },
    { sourceNoteId: sub.id, state: 'needs_review' },
    { sourceNoteId: sub.id, state: 'completed' },
    { sourceNoteId: 'outside', state: 'running' },
    { sourceNoteId: null, state: 'running' },
  ];
  assert.equal(activeIn(list, scope), 2);
  assert.equal(isAgentResult({ origin: { kind: 'assignment' } }), true);
  assert.equal(isAgentResult({ origin: null }), false);
});
