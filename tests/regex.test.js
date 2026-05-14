"use strict";

// Tier 1: AT_PATH_FOLDER_RE regex behavior.
//
// The regex source is duplicated here as a literal. The authoritative
// definition lives in `src/main.js` near line 563:
//
//   const AT_PATH_FOLDER_RE = /(^|[\s(])@([\w\p{L}\p{M}._-][\w\p{L}\p{M}./ _()&-]*?)\/(?=$|[\s)>,;:!?])/gu;
//
// Group 1 = boundary char (start-of-string or whitespace/open-paren).
// Group 2 = folder path (no trailing slash).
// We rebuild a fresh RegExp per test to avoid stateful `lastIndex`.

const test = require("node:test");
const assert = require("node:assert/strict");

const SRC = "(^|[\\s(])@([\\w\\p{L}\\p{M}._-][\\w\\p{L}\\p{M}./ _()&-]*?)\\/(?=$|[\\s)>,;:!?])";
const FLAGS = "gu";

function re() { return new RegExp(SRC, FLAGS); }

function matchAll(input) {
  const r = re();
  const out = [];
  let m;
  while ((m = r.exec(input)) !== null) {
    out.push({ full: m[0], boundary: m[1], path: m[2], index: m.index });
  }
  return out;
}

test("matches plain @foo/ at start of string", () => {
  const hits = matchAll("@foo/");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "foo");
});

test("matches nested @foo/bar/", () => {
  const hits = matchAll("@foo/bar/");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "foo/bar");
});

test("matches @90_archive/ (leading digit + underscore)", () => {
  const hits = matchAll("@90_archive/");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "90_archive");
});

test("matches @folder/ inside a sentence", () => {
  const hits = matchAll("see @notes/api/ for details");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "notes/api");
});

test("matches @folder/ after open-paren", () => {
  const hits = matchAll("(@notes/)");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "notes");
});

test("rejects @foo (no trailing slash, no extension)", () => {
  const hits = matchAll("@foo");
  assert.equal(hits.length, 0);
});

test("rejects @foo.md (file ref, no trailing slash)", () => {
  const hits = matchAll("@foo.md");
  assert.equal(hits.length, 0);
});

test("rejects @foo/bar (no trailing slash)", () => {
  const hits = matchAll("@foo/bar");
  assert.equal(hits.length, 0);
});

test("rejects bare @ alone", () => {
  const hits = matchAll("@");
  assert.equal(hits.length, 0);
});

test("rejects mid-word @ (no boundary)", () => {
  // "x@foo/" — the @ is preceded by `x`, which is not in `(^|[\s(])`.
  const hits = matchAll("x@foo/");
  assert.equal(hits.length, 0);
});

test("trailing-slash bounded by space accepts @foo/ word", () => {
  const hits = matchAll("@foo/ bar");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "foo");
});

test("trailing-slash bounded by comma accepts @foo/,", () => {
  // The lookahead allowlist is [\s)>,;:!?] — `,` is in it, `.` is NOT.
  const hits = matchAll("see @foo/, ok");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "foo");
});

test("rejects @foo/. (period not in trailing lookahead set)", () => {
  const hits = matchAll("see @foo/.");
  assert.equal(hits.length, 0);
});

test("matches multiple folder refs in one line", () => {
  const hits = matchAll("@a/ and @b/c/");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].path, "a");
  assert.equal(hits[1].path, "b/c");
});
