import { test } from "node:test";
import assert from "node:assert/strict";
import { actionFeedback } from "./action-feedback.ts";
import { BUCKETS } from "./notes.ts";

test("all destination labels support capture and move feedback", () => {
  for (const bucket of BUCKETS) {
    assert.equal(actionFeedback(`Captured in ${bucket.name}`).kind, "capture");
    assert.equal(actionFeedback(`Moved to ${bucket.name}`).kind, "move");
  }
});

test("errors, conflicts and arbitrary user text never trigger celebrations", () => {
  for (const message of ["Could not save", "Note completed but not saved", "This note was changed elsewhere and was not deleted.", "Created Note completed", "Moved to Inbox failed", "Project deleted", ""]) {
    assert.deepEqual(actionFeedback(message), { kind: "info", caption: "" });
  }
  assert.equal(actionFeedback("Note completed").kind, "complete");
});
