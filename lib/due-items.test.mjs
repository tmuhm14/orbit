import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupDueItems, localDateKey } from './due-items.ts';
import { createNote, isDueDate, isNote } from './notes.ts';

const note = (title, dueDate, patch = {}) => ({ ...createNote(title, 'next', 'work'), dueDate, ...patch });
test('due items use calendar dates, scope the workspace, and exclude completed or undated notes', () => {
  const overdue = note('Overdue', '2026-10-12');
  const today = note('Today', '2026-10-13');
  const sooner = note('Sooner', '2026-10-14');
  const later = note('Later', '2027-01-01');
  const groups = groupDueItems([later, today, overdue, sooner,
    note('Done', '2026-10-12', { completedAt: new Date().toISOString() }),
    note('Other workspace', '2026-10-12', { workspaceId: 'personal' }),
    note('No date', null), note('Invalid', '2026-02-30')], 'work', '2026-10-13');
  assert.deepEqual(groups, { overdue: [overdue], today: [today], upcoming: [sooner, later] });
  assert.equal(groupDueItems([today], 'work', '2026-10-14').overdue.length, 1);
});
test('due dates validate leap days and keep legacy notes compatible', () => {
  assert.equal(isDueDate('2028-02-29'), true);
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-1-01', '2026-10-13T00:00:00Z', 42]) assert.equal(isDueDate(value), false);
  const legacy = createNote('Old note');
  delete legacy.dueDate;
  assert.equal(isNote(legacy), true);
  assert.equal(isNote({ ...legacy, dueDate: '2026-02-30' }), false);
  assert.equal(localDateKey(new Date(2026, 9, 13, 23, 59)), '2026-10-13');
});

test('due dates round-trip through storage and invalid dates cannot be saved', async () => {
  const { readFileSync } = await import('node:fs');
  const { stripTypeScriptTypes } = await import('node:module');
  const notesModule = await import('./notes.ts');
  const code = stripTypeScriptTypes(readFileSync(new URL('./notes-db.ts', import.meta.url), 'utf8'))
    .replace('import "server-only";', '')
    .replace(/import \{[^}]+\} from "\.\/notes";/, 'const { BUCKETS, isNote } = notesModule;')
    .replace(/export /g, '');
  const { fromRow, toRow, isSavableNote } = new Function('notesModule', `${code}; return { fromRow, toRow, isSavableNote };`)(notesModule);
  const original = note('Deadline', '2028-02-29', { workspaceId: '12345678-1234-1234-1234-123456789abc' });
  assert.equal(isSavableNote(original), true);
  assert.equal(isSavableNote({ ...original, dueDate: '2026-02-29' }), false);
  const row = { ...toRow(original, 'user'), source: 'web', origin: null };
  assert.equal(row.due_date, '2028-02-29');
  assert.equal(fromRow(row).dueDate, '2028-02-29');
  assert.equal(toRow({ ...original, dueDate: null }, 'user').due_date, null);
  const legacy = { ...original };
  delete legacy.dueDate;
  assert.equal(Object.hasOwn(toRow(legacy, 'user'), 'due_date'), false);
});
