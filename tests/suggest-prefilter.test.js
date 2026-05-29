"use strict";

// Autocomplete hot-path prefilter: isSubsequenceCI is the cheap predicate
// that gates Obsidian's expensive fuzzy scorer in AtPathSuggest.getSuggestions.
// These tests lock in two properties the narrowing cache relies on:
//   1. It matches the case-insensitive subsequence semantics of the scorer.
//   2. Monotonicity: if a string survives a longer query, it survives every
//      prefix of that query — this is what makes "narrow the previous
//      survivors instead of rescanning the vault" correct.

const test = require("node:test");
const assert = require("node:assert/strict");

const { isSubsequenceCI } = require("../src/atpath-core.js");

test("isSubsequenceCI: empty query matches anything", () => {
  assert.equal(isSubsequenceCI("", "anything"), true);
  assert.equal(isSubsequenceCI("", ""), true);
});

test("isSubsequenceCI: non-empty query never matches empty text", () => {
  assert.equal(isSubsequenceCI("a", ""), false);
});

test("isSubsequenceCI: contiguous substring matches", () => {
  assert.equal(isSubsequenceCI("path", "notes/path/file.md"), true);
});

test("isSubsequenceCI: gapped subsequence matches", () => {
  // n..t..s..d  appears in order in "notes/index.md"
  assert.equal(isSubsequenceCI("ntsd", "notes/index.md"), true);
  assert.equal(isSubsequenceCI("nmd", "notes/index.md"), true);
});

test("isSubsequenceCI: out-of-order chars do not match", () => {
  assert.equal(isSubsequenceCI("dn", "notes/index.md"), false);
});

test("isSubsequenceCI: case-insensitive both directions", () => {
  assert.equal(isSubsequenceCI("PATH", "src/path.js"), true);
  assert.equal(isSubsequenceCI("path", "SRC/PATH.JS"), true);
  assert.equal(isSubsequenceCI("PaTh", "sRc/pAtH.js"), true);
});

test("isSubsequenceCI: missing char fails", () => {
  assert.equal(isSubsequenceCI("xyz", "notes/index.md"), false);
});

test("isSubsequenceCI: monotonic — prefix always matches if extension does", () => {
  // The narrowing cache reuses the survivor set of the previous (shorter)
  // query. That is only sound if every string matching a longer query also
  // matches its prefixes. Exhaustively check that invariant over a corpus.
  const corpus = [
    "notes/index.md",
    "src/main.js",
    "src/atpath-core.js",
    "archive/old/report-2024.md",
    "repos/app/README.md",
    "a/b/c/deeply/nested/file.txt",
    "Photos/2024/Trip.png",
  ];
  const queries = ["s", "sm", "sma", "smai", "smain", "no", "not", "note",
    "rd", "rdme", "abc", "abcd", "rep24"];
  for (const text of corpus) {
    for (const q of queries) {
      if (q.length < 2) continue;
      const full = isSubsequenceCI(q, text);
      if (full) {
        // every prefix must also match
        for (let i = 1; i < q.length; i++) {
          assert.equal(
            isSubsequenceCI(q.slice(0, i), text),
            true,
            `prefix "${q.slice(0, i)}" of "${q}" must match "${text}"`
          );
        }
      }
    }
  }
});
