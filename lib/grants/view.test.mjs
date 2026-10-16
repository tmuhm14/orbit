import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "../../tests/load-ts.mjs";

const view = loadTs(new URL("./view.ts", import.meta.url));

test("Settings labels: grant summary, checkbox keys, key display and times", () => {
  const spaces = [{ id: "w1", name: "Personal" }, { id: "w2", name: "Work" }];
  const grants = [{ workspaceId: "w2", capability: "item.write" }, { workspaceId: "w1", capability: "item.write" },
    { workspaceId: "w1", capability: "workspace.read" }];
  assert.equal(view.grantSummary(grants, spaces), "Personal: read, capture · Work: capture");
  assert.equal(view.grantSummary([], spaces), "No access");
  assert.deepEqual(view.fromKeys(view.grantKeys(grants)), [...grants].sort((a, b) =>
    `${a.workspaceId}:${a.capability}`.localeCompare(`${b.workspaceId}:${b.capability}`)));
  assert.deepEqual(view.GRANT_OPTIONS.map((o) => o.capability), ["workspace.read", "item.write"]);
  assert.equal(view.keyDisplay("0123456789ab"), "orbit_sk_0123456789ab_…");
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(view.when(null, now), "Never");
  assert.equal(view.when("2026-10-15T11:59:30Z", now), "Just now");
  assert.equal(view.when("2026-10-15T11:30:00Z", now), "30 min ago");
  assert.equal(view.when("2026-10-15T09:00:00Z", now), "3 h ago");
  assert.equal(view.when("nope", now), "—");
});
