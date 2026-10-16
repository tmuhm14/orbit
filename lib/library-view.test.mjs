import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLibraryItem, libraryItems, libraryTags, provenance } from './library-view.ts';
import { createNote } from './notes.ts';

const at = (day) => `2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`;
const note = (title, patch = {}) => ({ ...createNote(title, 'reference', 'work'), updatedAt: at(10), ...patch });

test('library: documents, notes out of the Inbox and anything in Reference', () => {
  assert.equal(isLibraryItem(note('doc', { kind: 'document', bucket: 'inbox' })), true);
  assert.equal(isLibraryItem(note('note', { bucket: 'someday' })), true);
  assert.equal(isLibraryItem(note('capture', { bucket: 'inbox' })), false);
  assert.equal(isLibraryItem(note('task in ref', { kind: 'task' })), true);
  assert.equal(isLibraryItem(note('task', { kind: 'task', bucket: 'next' })), false);
  assert.equal(isLibraryItem(note('done', { completedAt: at(1) })), false);
});

test('filters by tag and text, newest update first, one workspace', () => {
  const items = [
    note('Old plan', { tags: ['work'], updatedAt: at(1) }),
    note('New plan', { tags: ['work', 'q4'], updatedAt: at(12) }),
    note('Recipe', { tags: ['home'], plainText: 'pasta plan', updatedAt: at(5) }),
    note('Other space', { workspaceId: 'home', tags: ['work'] }),
  ];
  const t = (list) => list.map((n) => n.title);
  assert.deepEqual(t(libraryItems(items, 'work', { tag: null, q: '' })), ['New plan', 'Recipe', 'Old plan']);
  assert.deepEqual(t(libraryItems(items, 'work', { tag: 'work', q: '' })), ['New plan', 'Old plan']);
  assert.deepEqual(t(libraryItems(items, 'work', { tag: null, q: 'PLAN' })), ['New plan', 'Recipe', 'Old plan']);
  assert.deepEqual(t(libraryItems(items, 'work', { tag: 'home', q: 'pasta' })), ['Recipe']);
  assert.deepEqual(libraryTags(items, 'work'), [
    { tag: 'work', count: 2 }, { tag: 'home', count: 1 }, { tag: 'q4', count: 1 },
  ]);
});

test('provenance: agent results, Slack (https links only) and email', () => {
  assert.deepEqual(provenance({ source: 'web', origin: { kind: 'assignment', assignmentId: 'a1', artifactId: 'x' } }),
    { kind: 'assignment', label: 'Agent result', assignmentId: 'a1' });
  assert.deepEqual(provenance({ source: 'slack', origin: { kind: 'slack', channelName: 'ops', permalink: 'https://x.slack.com/p1' } }),
    { kind: 'slack', label: 'Slack · #ops', href: 'https://x.slack.com/p1' });
  assert.equal(provenance({ source: 'slack', origin: { kind: 'slack', permalink: 'javascript:alert(1)' } }).href, null);
  assert.deepEqual(provenance({ source: 'email', origin: { kind: 'email', from: 'a@b.co' } }),
    { kind: 'email', label: 'Email · a@b.co', href: null });
  assert.equal(provenance({ source: 'web', origin: null }), null);
});
