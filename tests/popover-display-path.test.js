"use strict";

// Plan 006: cover-our-back test for core.computeDisplayPath.
//
// The linked-@paths popover renders each row's label by calling
// `core.computeDisplayPath(target.path, sourcePath)`. These tests pin
// the three shapes the popover depends on so a future refactor of the
// helper surfaces in CI rather than only in the UI.

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeDisplayPath } = require("../src/atpath-core.js");

test("computeDisplayPath: target in same repo as source → bare relpath", () => {
  const source = "arbi_shared/_repos/myrepo/notes/index.md";
  const target = "arbi_shared/_repos/myrepo/findings/foo.md";
  assert.equal(computeDisplayPath(target, source), "findings/foo.md");
});

test("computeDisplayPath: target in different repo from source → <repo>/<rest>", () => {
  const source = "arbi_shared/_repos/repo-a/notes/index.md";
  const target = "arbi_shared/_repos/repo-b/findings/foo.md";
  assert.equal(computeDisplayPath(target, source), "repo-b/findings/foo.md");
});

test("computeDisplayPath: target outside _repos/ → passthrough", () => {
  const source = "arbi_shared/_repos/myrepo/notes/index.md";
  const target = "Inbox/notes/note.md";
  assert.equal(computeDisplayPath(target, source), "Inbox/notes/note.md");
});

test("computeDisplayPath: empty source + target in repo → <repo>/<rest>", () => {
  // Active note outside any repo context — popover falls back to
  // labeling the target by its own repo name.
  const target = "arbi_shared/_repos/repo-x/findings/foo.md";
  assert.equal(computeDisplayPath(target, ""), "repo-x/findings/foo.md");
});
