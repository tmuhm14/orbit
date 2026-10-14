import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionSummary, inboxItems, nextActionItems, waitingItems } from './home-items.ts';
import { createNote } from './notes.ts';

const at = (day) => `2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`;
const note = (title, bucket, patch = {}) => ({ ...createNote(title, bucket, 'work'), ...patch });
const titles = (list) => list.items.map(item => item.title);
const noise = () => [
  note('Done', 'inbox', { completedAt: at(10) }),
  note('Elsewhere', 'inbox', { workspaceId: 'personal' }),
  note('Other bucket', 'reference'),
];

test('inbox lists active workspace items, newest capture first, with a full count', () => {
  const items = [note('Old', 'inbox', { createdAt: at(1) }), note('New', 'inbox', { createdAt: at(9) }), note('Mid', 'inbox', { createdAt: at(5) }), ...noise()];
  const list = inboxItems(items, 'work');
  assert.deepEqual(titles(list), ['New', 'Mid', 'Old']);
  assert.equal(list.count, 3);
  const limited = inboxItems(items, 'work', 2);
  assert.deepEqual(titles(limited), ['New', 'Mid']);
  assert.equal(limited.count, 3);
});

test('next actions put dated items first by due date, then most recently updated', () => {
  const items = [
    note('Undated old', 'next', { updatedAt: at(1) }),
    note('Due later', 'next', { dueDate: '2026-11-01', updatedAt: at(2) }),
    note('Undated new', 'next', { updatedAt: at(8) }),
    note('Due soon', 'next', { dueDate: '2026-10-14', updatedAt: at(1) }),
    note('Invalid date', 'next', { dueDate: '2026-02-30', updatedAt: at(3) }),
    note('Completed', 'next', { completedAt: at(4), dueDate: '2026-10-01' }),
    note('Elsewhere', 'next', { workspaceId: 'personal', dueDate: '2026-10-01' }),
  ];
  assert.deepEqual(titles(nextActionItems(items, 'work')), ['Due soon', 'Due later', 'Undated new', 'Invalid date', 'Undated old']);
});

test('waiting for shows the least recently touched first', () => {
  const items = [note('Recent', 'waiting', { updatedAt: at(9) }), note('Stale', 'waiting', { updatedAt: at(2) }), ...noise()];
  const list = waitingItems(items, 'work');
  assert.deepEqual(titles(list), ['Stale', 'Recent']);
  assert.equal(list.count, 2);
});

test('empty input gives empty lists and a zero summary', () => {
  for (const fn of [inboxItems, nextActionItems, waitingItems]) assert.deepEqual(fn([], 'work'), { count: 0, items: [] });
  assert.deepEqual(attentionSummary([], 'work', '2026-10-13'), { toClarify: 0, overdue: 0, dueToday: 0 });
});

test('attention summary counts inbox, overdue and due today within the workspace', () => {
  const items = [
    note('Clarify', 'inbox'),
    note('Clarify and late', 'inbox', { dueDate: '2026-10-01' }),
    note('Late', 'next', { dueDate: '2026-10-12' }),
    note('Today', 'waiting', { dueDate: '2026-10-13' }),
    note('Tomorrow', 'next', { dueDate: '2026-10-14' }),
    note('Done late', 'next', { dueDate: '2026-10-01', completedAt: at(2) }),
    note('Elsewhere', 'inbox', { workspaceId: 'personal', dueDate: '2026-10-13' }),
  ];
  assert.deepEqual(attentionSummary(items, 'work', '2026-10-13'), { toClarify: 2, overdue: 2, dueToday: 1 });
});
