import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemHref, libraryHref, parseLibraryParams, parseNotesView, parseRoute, parseTasksParams, projectHref, tasksHref,
} from './workspace-routes.ts';

const params = (text) => new URLSearchParams(text);

test('parseRoute maps every workspace path, including id segments', () => {
  assert.deepEqual(parseRoute('/'), { page: 'notes' });
  assert.deepEqual(parseRoute('/tasks'), { page: 'tasks' });
  assert.deepEqual(parseRoute('/projects'), { page: 'projects' });
  assert.deepEqual(parseRoute('/library'), { page: 'library' });
  assert.deepEqual(parseRoute('/agents'), { page: 'agents' });
  assert.deepEqual(parseRoute('/settings'), { page: 'settings', section: 'account' });
  assert.deepEqual(parseRoute('/settings/spaces'), { page: 'settings', section: 'spaces' });
  assert.deepEqual(parseRoute('/settings/agents'), { page: 'settings', section: 'agents' });
  assert.deepEqual(parseRoute('/settings/agents/setup'), { page: 'settings', section: 'setup' });
  assert.deepEqual(parseRoute('/settings/unknown'), { page: 'settings', section: 'account' });
  assert.deepEqual(parseRoute('/scheduled'), { page: 'scheduled' });
  assert.deepEqual(parseRoute('/projects/abc-1'), { page: 'project', id: 'abc-1' });
  assert.deepEqual(parseRoute('/items/a%20b'), { page: 'item', id: 'a b' });
  assert.deepEqual(parseRoute('/tasks/'), { page: 'tasks' });
});

test('parseRoute never throws on bad input', () => {
  assert.deepEqual(parseRoute('/items/%E0%A4%A'), { page: 'item', id: '' });
  assert.deepEqual(parseRoute(null), { page: 'notes' });
  assert.deepEqual(parseRoute('/nope/deeper/still'), { page: 'notes' });
  assert.deepEqual(parseRoute('/unknown'), { page: 'notes' });
});

test('hrefs round-trip through parseRoute', () => {
  for (const id of ['plain', 'with space', 'a/b', '1?x=2']) {
    assert.deepEqual(parseRoute(new URL(projectHref(id), 'http://x').pathname), { page: 'project', id });
    assert.deepEqual(parseRoute(new URL(itemHref(id), 'http://x').pathname), { page: 'item', id });
  }
});

test('tasks params default to next and ignore unknown filters', () => {
  assert.deepEqual(parseTasksParams(params('')), { filter: 'next', project: null });
  assert.deepEqual(parseTasksParams(null), { filter: 'next', project: null });
  assert.deepEqual(parseTasksParams(params('filter=waiting&project=p1')), { filter: 'waiting', project: 'p1' });
  assert.deepEqual(parseTasksParams(params('filter=bogus&project=%20')), { filter: 'next', project: null });
});

test('tasksHref is canonical and round-trips', () => {
  assert.equal(tasksHref(), '/tasks');
  assert.equal(tasksHref({ filter: 'next' }), '/tasks');
  assert.equal(tasksHref({ filter: 'due' }), '/tasks?filter=due');
  assert.equal(tasksHref({ filter: 'completed', project: 'p 1' }), '/tasks?filter=completed&project=p+1');
  const back = parseTasksParams(new URL(tasksHref({ filter: 'waiting', project: 'p&1' }), 'http://x').searchParams);
  assert.deepEqual(back, { filter: 'waiting', project: 'p&1' });
});

test('notes view from ?view= falls back to Home', () => {
  assert.equal(parseNotesView('next'), 'next');
  assert.equal(parseNotesView('all'), 'all');
  assert.equal(parseNotesView('completed'), 'completed');
  assert.equal(parseNotesView('bogus'), 'overview');
  assert.equal(parseNotesView(null), 'overview');
});

test('library params and hrefs', () => {
  assert.deepEqual(parseLibraryParams(params('')), { tag: null, q: '' });
  assert.deepEqual(parseLibraryParams(params('tag=work&q=plan')), { tag: 'work', q: 'plan' });
  assert.equal(parseLibraryParams(params(`q=${'a'.repeat(500)}`)).q.length, 200);
  assert.equal(libraryHref(), '/library');
  assert.equal(libraryHref({ q: '   ' }), '/library');
  assert.equal(libraryHref({ tag: 'a b', q: 'x' }), '/library?tag=a+b&q=x');
});
