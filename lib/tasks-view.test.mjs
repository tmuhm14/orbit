import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueState, isActionable, isWaiting, tasksEmptyCopy, tasksView } from './tasks-view.ts';
import { createNote } from './notes.ts';

const at = (day) => `2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`;
const TODAY = '2026-10-15';
const note = (title, patch = {}) => ({ ...createNote(title, 'inbox', 'work'), updatedAt: at(10), ...patch });
const titles = (list) => list.map((n) => n.title);

test('actionable: tasks, follow-ups and the Next / Waiting buckets, never projects', () => {
  assert.equal(isActionable(note('t', { kind: 'task' })), true);
  assert.equal(isActionable(note('f', { kind: 'followup' })), true);
  assert.equal(isActionable(note('n', { bucket: 'next' })), true);
  assert.equal(isActionable(note('w', { bucket: 'waiting' })), true);
  assert.equal(isActionable(note('plain')), false);
  assert.equal(isActionable(note('p', { kind: 'project', bucket: 'next' })), false);
  assert.equal(isWaiting(note('x', { kind: 'task', waitingOn: 'Sam' })), true);
  assert.equal(isWaiting(note('x', { kind: 'task', waitingOn: '  ' })), false);
});

test('next: open, not waiting, dated first then most recent', () => {
  const items = [
    note('Undated old', { kind: 'task', updatedAt: at(1) }),
    note('Due later', { kind: 'task', dueDate: '2026-11-01' }),
    note('Undated new', { bucket: 'next', updatedAt: at(12) }),
    note('Due soon', { kind: 'task', dueDate: '2026-10-16' }),
    note('Waiting', { kind: 'followup' }),
    note('Done', { kind: 'task', completedAt: at(9) }),
    note('Elsewhere', { kind: 'task', workspaceId: 'home' }),
    note('Just a note'),
  ];
  const view = tasksView(items, 'work', { filter: 'next', project: null }, TODAY);
  assert.deepEqual(titles(view.items), ['Due soon', 'Due later', 'Undated new', 'Undated old']);
  assert.equal(view.groups, null);
  assert.deepEqual(view.counts, { next: 4, due: 2, waiting: 1, completed: 1 });
});

test('due: overdue, today, upcoming groups from due-items', () => {
  const items = [
    note('Up', { kind: 'task', dueDate: '2026-10-20' }),
    note('Late', { dueDate: '2026-10-01' }),
    note('Now', { kind: 'task', dueDate: TODAY }),
    note('Done late', { kind: 'task', dueDate: '2026-10-01', completedAt: at(2) }),
  ];
  const view = tasksView(items, 'work', { filter: 'due', project: null }, TODAY);
  assert.deepEqual(titles(view.items), ['Late', 'Now', 'Up']);
  assert.deepEqual(titles(view.groups.overdue), ['Late']);
  assert.deepEqual(titles(view.groups.today), ['Now']);
  assert.deepEqual(titles(view.groups.upcoming), ['Up']);
  assert.equal(dueState(items[0], TODAY), 'upcoming');
  assert.equal(dueState(items[1], TODAY), 'overdue');
  assert.equal(dueState(items[2], TODAY), 'today');
  assert.equal(dueState(items[3], TODAY), null);
});

test('waiting: late checks first, then today, upcoming by date, undated stalest first', () => {
  const items = [
    note('Undated fresh', { bucket: 'waiting', updatedAt: at(14) }),
    note('Upcoming far', { kind: 'followup', nextCheckOn: '2026-10-30' }),
    note('Today', { kind: 'followup', nextCheckOn: TODAY }),
    note('Overdue', { kind: 'followup', nextCheckOn: '2026-10-02' }),
    note('Upcoming near', { kind: 'task', waitingOn: 'Sam', nextCheckOn: '2026-10-17' }),
    note('Undated stale', { bucket: 'waiting', updatedAt: at(1) }),
    note('Project waiting', { kind: 'project', bucket: 'waiting' }),
  ];
  const view = tasksView(items, 'work', { filter: 'waiting', project: null }, TODAY);
  assert.deepEqual(titles(view.items), ['Overdue', 'Today', 'Upcoming near', 'Upcoming far', 'Undated stale', 'Undated fresh']);
});

test('completed: actionable done items, latest first', () => {
  const items = [
    note('A', { kind: 'task', completedAt: at(3) }),
    note('B', { bucket: 'next', completedAt: at(8) }),
    note('Done note', { completedAt: at(9) }),
  ];
  assert.deepEqual(titles(tasksView(items, 'work', { filter: 'completed', project: null }, TODAY).items), ['B', 'A']);
});

test('project filter includes nested items and excludes the rest', () => {
  const root = note('Root', { kind: 'project' });
  const sub = note('Sub', { kind: 'project', projectId: root.id });
  const items = [
    root, sub,
    note('In root', { kind: 'task', projectId: root.id }),
    note('In sub', { kind: 'task', projectId: sub.id }),
    note('Outside', { kind: 'task' }),
  ];
  const view = tasksView(items, 'work', { filter: 'next', project: root.id }, TODAY);
  assert.deepEqual(titles(view.items).sort(), ['In root', 'In sub']);
  assert.deepEqual(titles(tasksView(items, 'work', { filter: 'next', project: sub.id }, TODAY).items), ['In sub']);
  assert.equal(tasksView(items, 'work', { filter: 'next', project: 'missing' }, TODAY).items.length, 0);
});

test('empty copy names the filter and the project scope', () => {
  for (const filter of ['next', 'due', 'waiting', 'completed']) {
    const copy = tasksEmptyCopy(filter, false);
    assert.ok(copy.title && copy.body);
    assert.ok(!copy.title.includes('project'));
    assert.ok(tasksEmptyCopy(filter, true).title.endsWith('in this project'));
  }
});
