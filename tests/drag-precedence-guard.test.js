"use strict";

// Source-grep regression guard.
//
// The runtime bug fixed by commit 72e7424 was that Obsidian's MarkdownView
// drop handler preempted ours because CM6 iterates handlers in extension
// precedence order. The fix wraps our extension in Prec.highest at the two
// registration sites (initial registerEditorExtension and reconfigureDragDrop).
// Pure-function unit tests (see drag-extract.test.js) can't observe handler
// ordering, so we pin the wrap textually: if either site loses Prec.highest,
// this test fails before we ship a regression.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("src/main.js wraps the DnD CM6 extension in Prec.highest at both registration sites", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.js"),
    "utf8"
  );
  const needle = "Prec.highest(buildDragDropExtension(this))";
  const matches = src.split(needle).length - 1;
  assert.ok(
    matches >= 2,
    `Expected '${needle}' to appear at both the initial registerEditorExtension call and reconfigureDragDrop, found ${matches}. If you intentionally moved the wrap, update this guard.`
  );
});
