"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { f_parseFolderCountExclusions, f_isFolderCountBoundary, f_folderCountIncludes } = require("../src/folder-count-policy");

test("folder settings accept one name or vault path per line and reject ambiguous patterns", () => {
  const rules = f_parseFolderCountExclusions(" 90_archive/\n\n /repo/scratch/\n90_archive\n");
  assert.deepEqual(rules, ["90_archive", "repo/scratch"]);
  assert.equal(f_isFolderCountBoundary("a/90_archive", rules), true);
  assert.equal(f_isFolderCountBoundary("other/repo/scratch", rules), false);
  assert.equal(f_isFolderCountBoundary("repo/scratch", rules), true);
  assert.equal(f_isFolderCountBoundary("a/90_archive_more", rules), false);
  assert.deepEqual(f_parseFolderCountExclusions(""), []);
  for (const text of ["../secret", "a//b", "**/archive", "a\\b", "."]) assert.throws(() => f_parseFolderCountExclusions(text));
});

test("coverage deduplicates overlapping references without hiding explicitly linked excluded targets", () => {
  const rules = ["90_archive"];
  assert.equal(f_folderCountIncludes("work", "work/a.md", rules), true);
  assert.equal(f_folderCountIncludes("work", "work/90_archive/a.md", rules), false);
  assert.equal(f_folderCountIncludes("work", "work/90_archive", rules, true), false);
  assert.equal(f_folderCountIncludes("work/90_archive", "work/90_archive/a.md", rules), true);
  assert.equal(f_folderCountIncludes("/", "90_archive/a.md", rules), false);
  assert.equal(f_folderCountIncludes("work", "workspace/a.md", rules), false);
});
