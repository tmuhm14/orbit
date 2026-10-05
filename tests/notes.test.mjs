import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { noteRepository, createNote, STORAGE_KEY } from "../lib/notes.ts";
const store = new Map();
const persisted = (value) => JSON.parse(JSON.stringify(value));
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, value),
};
beforeEach(() => store.clear());
test("notes and empty workspaces remain isolated between accounts", () => {
  const note = createNote("Private note");
  noteRepository.save("alice", [note]);
  noteRepository.save("bob", []);
  assert.deepEqual(noteRepository.load("alice"), persisted([note]));
  assert.deepEqual(noteRepository.load("bob"), []);
});
test("legacy notes are never assigned automatically; explicit import is preserved and claimed once", () => {
  const note = createNote("Original note");
  localStorage.setItem(STORAGE_KEY, JSON.stringify([note]));
  assert.equal(
    noteRepository.load("alice").some((n) => n.id === note.id),
    false,
  );
  assert.equal(noteRepository.hasLegacyNotes("alice"), true);
  assert.deepEqual(noteRepository.importLegacy("alice", []), persisted([note]));
  assert.equal(noteRepository.hasLegacyNotes("bob"), false);
  assert.deepEqual(noteRepository.importLegacy("bob", []), []);
  assert.equal(localStorage.getItem(STORAGE_KEY), JSON.stringify([note]));
});
test("invalid legacy notes are preserved without claiming or replacing account notes", () => {
  localStorage.setItem(STORAGE_KEY, "broken");
  const note = createNote("Current note");
  noteRepository.save("alice", [note]);
  assert.throws(() => noteRepository.importLegacy("alice", [note]));
  assert.deepEqual(noteRepository.load("alice"), persisted([note]));
  assert.equal(localStorage.getItem(STORAGE_KEY), "broken");
  assert.equal(localStorage.getItem(`${STORAGE_KEY}:legacy-owner`), null);
});
test("import keeps the current version of a note instead of duplicating its ID", () => {
  const old = createNote("Old title");
  localStorage.setItem(STORAGE_KEY, JSON.stringify([old]));
  const edited = { ...old, title: "New title" };
  assert.deepEqual(noteRepository.importLegacy("alice", [edited]), [edited]);
});
test("browser notes are listed for moving without claiming them, then marked once moved", async () => {
  const { browserNotes } = await import("../lib/notes.ts");
  const own = createNote("Mine");
  const legacy = { ...createNote("Legacy"), id: "welcome-0" };
  noteRepository.save("alice", [own]);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([legacy]));
  const pending = browserNotes.pending("alice");
  assert.equal(pending.length, 2);
  assert.equal(pending[0].id, own.id);
  assert.notEqual(pending[1].id, "welcome-0", "non-UUID ids are replaced");
  assert.equal(localStorage.getItem(`${STORAGE_KEY}:legacy-owner`), null, "listing claims nothing");
  browserNotes.markUploaded("alice");
  assert.deepEqual(browserNotes.pending("alice"), []);
  assert.equal(noteRepository.hasLegacyNotes("bob"), false, "legacy now belongs to alice");
  assert.equal(noteRepository.load("alice").length, 1, "originals kept as a backup");
});
