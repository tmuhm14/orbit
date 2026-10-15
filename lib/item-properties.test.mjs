import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOWUP_COPY,
  REMINDER_COPY,
  addDays,
  calendarDateLabel,
  fireTimeLabel,
  followupSummary,
  projectOptions,
  projectPathLabel,
  reminderErrorMessage,
  snoozePresets,
  wallTimeLabel,
  weekday,
  workspaceMoveError,
} from './item-properties.ts';
import { createNote } from './notes.ts';
import { REMINDER_ERROR_CODES } from './reminders.ts';

const item = (title, patch = {}) => ({ ...createNote(title, 'projects', 'work'), ...patch });

test('project paths run from the root project down, and untitled projects get a name', () => {
  const area = item('Area', { kind: 'project' });
  const outcome = item('Outcome', { kind: 'project', projectId: area.id });
  const blank = item('  ', { kind: 'project', projectId: outcome.id });
  const notes = [area, outcome, blank];
  assert.equal(projectPathLabel(notes, blank.id), 'Area › Outcome › Untitled project');
  assert.equal(projectPathLabel(notes, area.id), 'Area');
  assert.equal(projectPathLabel(notes, 'missing'), '');
});

test('project options stay in the workspace, skip the item, explain refusals and filter by path', () => {
  const area = item('Area', { kind: 'project' });
  const sub = item('Launch', { kind: 'project', projectId: area.id });
  const other = item('Elsewhere', { kind: 'project', workspaceId: 'personal' });
  const task = item('Write brief', { kind: 'task' });
  const notes = [sub, area, other, task];
  const forTask = projectOptions(notes, task);
  assert.deepEqual(forTask.map((o) => [o.title, o.parents, o.error]), [
    ['Area', '', null],
    ['Launch', 'Area', null],
  ]);
  // Moving Area under its own sub-project would be a cycle; Area itself is not offered.
  const forArea = projectOptions(notes, area);
  assert.deepEqual(forArea.map((o) => [o.id, o.error]), [[sub.id, 'project_cycle']]);
  assert.deepEqual(projectOptions(notes, task, 'area').map((o) => o.title), ['Area', 'Launch']);
  assert.deepEqual(projectOptions(notes, task, '  LAUNCH ').map((o) => o.title), ['Launch']);
  assert.deepEqual(projectOptions(notes, task, 'nothing'), []);
});

test('linked items and projects with children cannot change workspace', () => {
  const project = item('P', { kind: 'project' });
  const child = item('C', { projectId: project.id });
  const loose = item('L');
  const notes = [project, child, loose];
  assert.equal(workspaceMoveError(notes, child), 'linked_item_move');
  assert.equal(workspaceMoveError(notes, project), 'linked_item_move');
  assert.equal(workspaceMoveError(notes, loose), null);
});

test('calendar arithmetic crosses months, leap days and years without time zones', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2027-02-28', 2), '2027-03-02');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekday('2026-10-14'), 3); // Wednesday
  assert.equal(calendarDateLabel('2026-10-20', '2026-10-14', 'en-US'), 'Oct 20');
  assert.equal(calendarDateLabel('2027-01-02', '2026-10-14', 'en-US'), 'Jan 2, 2027');
});

test('follow-up summaries read "Waiting on X · check date" and carry the check state', () => {
  const today = '2026-10-14';
  assert.deepEqual(followupSummary({ waitingOn: 'Sam', nextCheckOn: '2026-10-20', completedAt: null }, today, 'en-US'),
    { text: 'Waiting on Sam · check Oct 20', state: 'upcoming' });
  assert.deepEqual(followupSummary({ waitingOn: null, nextCheckOn: today, completedAt: null }, today, 'en-US'),
    { text: 'check today', state: 'due' });
  assert.deepEqual(followupSummary({ waitingOn: 'Ana', nextCheckOn: '2026-10-01', completedAt: null }, today, 'en-US'),
    { text: 'Waiting on Ana · check was due Oct 1', state: 'overdue' });
  assert.deepEqual(followupSummary({ waitingOn: null, nextCheckOn: null, completedAt: null }, today),
    { text: null, state: null });
  assert.equal(followupSummary({ waitingOn: null, nextCheckOn: '2026-10-01', completedAt: '2026-10-02T00:00:00Z' }, today).state, null);
});

test('snooze presets are wall-clock times in the reminder zone', () => {
  // Wednesday 2026-10-14 10:10 in Chicago (UTC-5).
  const morning = Date.parse('2026-10-14T15:10:00Z');
  assert.deepEqual(snoozePresets(morning, 'America/Chicago'), [
    { id: 'later', label: 'Later today', localDate: '2026-10-14', localTime: '13:30' },
    { id: 'tomorrow', label: 'Tomorrow morning', localDate: '2026-10-15', localTime: '09:00' },
    { id: 'next-week', label: 'Next week', localDate: '2026-10-19', localTime: '09:00' },
  ]);
  // 22:00 in Chicago: "later today" would be tomorrow, so it is not offered.
  const late = Date.parse('2026-10-15T03:00:00Z');
  assert.deepEqual(snoozePresets(late, 'America/Chicago').map((p) => p.id), ['tomorrow', 'next-week']);
  // Same instant is already Thursday in Tokyo; on a Monday, next week is seven days on.
  assert.equal(snoozePresets(late, 'Asia/Tokyo')[0].localDate, '2026-10-15');
  const monday = Date.parse('2026-10-19T14:00:00Z');
  assert.equal(snoozePresets(monday, 'UTC').at(-1).localDate, '2026-10-26');
  // The night before the fall-back change: tomorrow morning is still 09:00 local.
  const beforeFallBack = Date.parse('2026-11-01T02:00:00Z'); // Oct 31, 21:00 CDT
  assert.deepEqual(snoozePresets(beforeFallBack, 'America/Chicago').map((p) => [p.localDate, p.localTime]),
    [['2026-11-01', '09:00'], ['2026-11-02', '09:00']]);
});

test('fire times read in local words', () => {
  const now = Date.parse('2026-10-14T15:00:00Z'); // 10:00 in Chicago
  const opts = { now, timeZone: 'America/Chicago', locale: 'en-US' };
  assert.equal(fireTimeLabel('2026-10-14T20:00:00Z', opts), 'Today at 3:00 PM');
  assert.equal(fireTimeLabel('2026-10-15T14:00:00Z', opts), 'Tomorrow at 9:00 AM');
  assert.equal(fireTimeLabel('2026-10-19T14:00:00Z', opts), 'Monday at 9:00 AM');
  assert.equal(fireTimeLabel('2026-10-27T14:00:00Z', opts), 'Tue, Oct 27 at 9:00 AM');
  // Across the fall-back change, 9:00 local is 15:00 UTC.
  assert.equal(fireTimeLabel('2026-11-02T15:00:00Z', opts), 'Mon, Nov 2 at 9:00 AM');
  assert.equal(fireTimeLabel('2027-01-04T15:00:00Z', opts), 'Mon, Jan 4, 2027 at 9:00 AM');
  assert.equal(wallTimeLabel('09:00', 'en-US'), '9:00 AM');
  assert.equal(wallTimeLabel('23:30', 'en-US'), '11:30 PM');
});

test('every reminder and follow-up error has friendly copy', () => {
  for (const code of [...REMINDER_ERROR_CODES, 'unavailable']) {
    assert.equal(typeof REMINDER_COPY[code], 'string', code);
    assert.ok(REMINDER_COPY[code].length > 10, code);
  }
  assert.equal(reminderErrorMessage('surprise'), REMINDER_COPY.unavailable);
  assert.deepEqual(Object.keys(FOLLOWUP_COPY).sort(), ['nextCheckOn', 'waitingFor', 'waitingOn']);
});
