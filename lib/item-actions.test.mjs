import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canCompleteNote,
  canMoveNote,
  completeNoteInList,
  menuIndex,
  menuPlacement,
  moveNoteInList,
  moveTargets,
} from './item-actions.ts';
import { BUCKETS, createNote } from './notes.ts';

const NOW = '2026-10-14T12:00:00.000Z';
const note = (bucket, patch = {}) => ({ ...createNote('Synthetic item', bucket, 'work'), ...patch });

test('move targets list every bucket except the current one, in bucket order', () => {
  const targets = moveTargets('next').map((b) => b.id);
  assert.deepEqual(targets, BUCKETS.map((b) => b.id).filter((id) => id !== 'next'));
  assert.equal(targets.length, BUCKETS.length - 1);
});

test('moving changes only bucket and updatedAt', () => {
  const a = note('inbox');
  const b = note('inbox');
  const notes = [a, b];
  assert.equal(canMoveNote(notes, a.id, 'work', 'waiting'), true);
  const moved = moveNoteInList(notes, a.id, 'work', 'waiting', NOW);
  assert.deepEqual(moved[0], { ...a, bucket: 'waiting', updatedAt: NOW });
  assert.equal(moved[1], b);
});

test('moving to the same bucket, another workspace or a completed note is a no-op', () => {
  const same = note('next');
  const other = note('inbox', { workspaceId: 'personal' });
  const done = note('inbox', { completedAt: NOW });
  const notes = [same, other, done];
  assert.equal(canMoveNote(notes, same.id, 'work', 'next'), false);
  assert.equal(canMoveNote(notes, other.id, 'work', 'next'), false);
  assert.equal(canMoveNote(notes, done.id, 'work', 'next'), false);
  assert.equal(canMoveNote(notes, 'missing', 'work', 'next'), false);
  const result = moveNoteInList(notes, same.id, 'work', 'next', NOW);
  result.forEach((n, i) => assert.equal(n, notes[i]));
  moveNoteInList(notes, other.id, 'work', 'next', NOW).forEach((n, i) => assert.equal(n, notes[i]));
  moveNoteInList(notes, done.id, 'work', 'next', NOW).forEach((n, i) => assert.equal(n, notes[i]));
});

test('completing sets completedAt and updatedAt once, scoped to the workspace', () => {
  const open = note('next');
  const other = note('next', { workspaceId: 'personal' });
  const done = note('next', { completedAt: '2026-01-01T00:00:00.000Z' });
  const notes = [open, other, done];
  assert.equal(canCompleteNote(notes, open.id, 'work'), true);
  assert.equal(canCompleteNote(notes, other.id, 'work'), false);
  assert.equal(canCompleteNote(notes, done.id, 'work'), false);
  const result = completeNoteInList(notes, open.id, 'work', NOW);
  assert.deepEqual(result[0], { ...open, completedAt: NOW, updatedAt: NOW });
  assert.equal(result[1], other);
  assert.equal(completeNoteInList(notes, done.id, 'work', NOW)[2], done);
});

test('menu index wraps with arrows and jumps with Home/End', () => {
  assert.equal(menuIndex(0, 4, 'ArrowDown'), 1);
  assert.equal(menuIndex(3, 4, 'ArrowDown'), 0);
  assert.equal(menuIndex(0, 4, 'ArrowUp'), 3);
  assert.equal(menuIndex(2, 4, 'ArrowUp'), 1);
  assert.equal(menuIndex(-1, 4, 'ArrowDown'), 0);
  assert.equal(menuIndex(-1, 4, 'ArrowUp'), 3);
  assert.equal(menuIndex(2, 4, 'Home'), 0);
  assert.equal(menuIndex(1, 4, 'End'), 3);
  assert.equal(menuIndex(1, 4, 'Enter'), null);
  assert.equal(menuIndex(0, 0, 'ArrowDown'), null);
});

test('menu placement stays inside the viewport and flips above when needed', () => {
  const viewport = { width: 375, height: 812 };
  const menu = { width: 220, height: 300 };
  // Anchor near the left edge: clamps to the margin instead of going off-screen.
  const left = menuPlacement({ top: 100, bottom: 144, left: 10, right: 54 }, menu, viewport);
  assert.equal(left.left, 8);
  assert.equal(left.placement, 'below');
  assert.equal(left.top, 148);
  // Anchor near the right edge: right-aligned to the anchor.
  const right = menuPlacement({ top: 100, bottom: 144, left: 323, right: 367 }, menu, viewport);
  assert.equal(right.left, 367 - 220);
  // Near the bottom: flips above.
  const bottom = menuPlacement({ top: 700, bottom: 744, left: 300, right: 344 }, menu, viewport);
  assert.equal(bottom.placement, 'above');
  assert.equal(bottom.top, 700 - 4 - 300);
  // Narrow viewport: width shrinks to fit.
  const narrow = menuPlacement({ top: 0, bottom: 44, left: 0, right: 44 }, menu, { width: 200, height: 400 });
  assert.equal(narrow.width, 184);
  assert.equal(narrow.left, 8);
  // Tall menu in a short viewport: capped and scrollable.
  const tall = menuPlacement({ top: 10, bottom: 54, left: 0, right: 300 }, { width: 220, height: 900 }, { width: 375, height: 400 });
  assert.equal(tall.maxHeight, 400 - 54 - 4 - 8);
  assert.ok(tall.top + Math.min(900, tall.maxHeight) <= 400 - 8);
});
