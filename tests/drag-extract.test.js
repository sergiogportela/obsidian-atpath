"use strict";

// Regression: drag-and-drop @path insertion from the file-explorer.
//
// The runtime bug (fixed by wrapping the CM6 extension in Prec.highest)
// was that Obsidian's MarkdownView drop handler preempted ours, so a
// wikilink got inserted instead of an @path. We can't unit-test CM6
// handler ordering, but we CAN pin down the extraction layer that turns
// raw dragged paths into the {kind, vaultPath, target} shape the editor
// insertion expects — the Tier 0 path that reads from currentDragRefs
// is what the rest of the chain depends on.

const test = require("node:test");
const assert = require("node:assert/strict");

const { TFile, TFolder } = require("obsidian");
const { extractDraggedVaultPaths } = require("../src/atpath-core.js");

function buildApp() {
  const indexMd = new TFile("notes/index.md", { size: 100 });
  const v1 = new TFile("notes/api/v1.md", { size: 200 });
  const apiFolder = new TFolder("notes/api", [v1]);
  const notesFolder = new TFolder("notes", [indexMd, apiFolder]);
  const root = new TFolder("", [notesFolder]);

  const byPath = new Map();
  function index(node) {
    byPath.set(node.path, node);
    if (node instanceof TFolder) for (const c of node.children) index(c);
  }
  index(notesFolder);

  return {
    app: {
      vault: {
        getAbstractFileByPath: (p) => byPath.get(p) || null,
      },
    },
    indexMd, v1, apiFolder, notesFolder,
  };
}

test("extractDraggedVaultPaths: Tier 0 happy path — captured file ref returns file out", () => {
  const { app, indexMd } = buildApp();
  const captured = [{ kind: "file", vaultPath: "notes/index.md", target: indexMd }];
  const out = extractDraggedVaultPaths(null, app, "", captured);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "file");
  assert.equal(out[0].vaultPath, "notes/index.md");
  assert.equal(out[0].target, indexMd);
});

test("extractDraggedVaultPaths: Tier 0 folder ref returns folder out", () => {
  const { app, apiFolder } = buildApp();
  const captured = [{ kind: "folder", vaultPath: "notes/api", target: apiFolder }];
  const out = extractDraggedVaultPaths(null, app, "", captured);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "folder");
  assert.equal(out[0].target, apiFolder);
});

test("extractDraggedVaultPaths: self-drop into the source file is skipped", () => {
  const { app, indexMd } = buildApp();
  const captured = [{ kind: "file", vaultPath: "notes/index.md", target: indexMd }];
  const out = extractDraggedVaultPaths(null, app, "notes/index.md", captured);
  assert.equal(out.length, 0);
});

test("extractDraggedVaultPaths: stale captured path that no longer exists is dropped", () => {
  const { app } = buildApp();
  const captured = [{ kind: "file", vaultPath: "notes/gone.md", target: null }];
  const out = extractDraggedVaultPaths(null, app, "", captured);
  assert.equal(out.length, 0);
});

test("extractDraggedVaultPaths: multi-select preserves order, dedupes repeats", () => {
  const { app, indexMd, v1 } = buildApp();
  const captured = [
    { kind: "file", vaultPath: "notes/index.md", target: indexMd },
    { kind: "file", vaultPath: "notes/api/v1.md", target: v1 },
    { kind: "file", vaultPath: "notes/index.md", target: indexMd }, // duplicate
  ];
  const out = extractDraggedVaultPaths(null, app, "", captured);
  assert.equal(out.length, 2);
  assert.equal(out[0].vaultPath, "notes/index.md");
  assert.equal(out[1].vaultPath, "notes/api/v1.md");
});

test("extractDraggedVaultPaths: empty currentDragRefs with no DataTransfer returns []", () => {
  const { app } = buildApp();
  const out = extractDraggedVaultPaths(null, app, "", []);
  assert.equal(out.length, 0);
});

test("extractDraggedVaultPaths: text/plain fallback resolves bare vault paths", () => {
  const { app, indexMd } = buildApp();
  const dataTransfer = {
    getData: (mime) => (mime === "text/plain" ? "notes/index.md" : ""),
  };
  const out = extractDraggedVaultPaths(dataTransfer, app, "", null);
  assert.equal(out.length, 1);
  assert.equal(out[0].target, indexMd);
});
