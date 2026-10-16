import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesText } from './note-search.ts';

const note = { title: 'Quarterly Plan', plainText: 'Budget review with finance', tags: ['work', 'q4'] };

test('matches title, body and tags case-insensitively', () => {
  assert.equal(matchesText(note, 'plan'), true);
  assert.equal(matchesText(note, 'FINANCE'), true);
  assert.equal(matchesText(note, 'q4'), true);
  assert.equal(matchesText(note, 'holiday'), false);
});

test('an empty or blank query matches everything', () => {
  assert.equal(matchesText(note, ''), true);
  assert.equal(matchesText(note, '   '), true);
});
