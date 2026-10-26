import assert from "node:assert/strict";
import test from "node:test";
import { projectSessionLog, editTargetForCall } from "../internal/session-log-view.js";

// retainAll refolds the same slice with pruning disabled; a session with no
// retention summary must produce the same projection either way.
test("retainAll refolds a projection that carries no retention summary", () => {
  const agent = { session: { events: [] } };
  const projected = projectSessionLog(agent, undefined, undefined, { retainAll: true });
  assert.equal(projected.openTurn, false);
});

// A non-canonical sequence is rejected before the projection runs.
test("an edit target requires a canonical call sequence", () => {
  assert.equal(editTargetForCall({ session: { events: [] } }, "call-1", 0), undefined);
  assert.equal(editTargetForCall({ session: { events: [] } }, "", 1), undefined);
});
