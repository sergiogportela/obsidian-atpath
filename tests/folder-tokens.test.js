"use strict";

// Tier 2: getFolderTokens cap + batch + epoch + in-flight dedupe.
// Builds a fake vault tree and a synthetic getTokenCount per file.

const test = require("node:test");
const assert = require("node:assert/strict");

const { TFile, TFolder } = require("obsidian");
const { createAtPathCore } = require("../src/atpath-core.js");

function makeFolder(path, fileCount, sizePerFile = 100) {
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(new TFile(path + "/f" + i + ".md", { size: sizePerFile }));
  }
  return new TFolder(path, files);
}

function buildPlugin(folder, settings = {}) {
  const byPath = new Map();
  function index(node) {
    byPath.set(node.path, node);
    if (node instanceof TFolder) for (const c of node.children) index(c);
  }
  const root = new TFolder("", [folder]);
  index(folder);

  const tokenCalls = [];
  const plugin = {
    app: {
      vault: {
        getAbstractFileByPath: (p) => byPath.get(p) || null,
        getFiles: () => [...byPath.values()].filter((n) => n instanceof TFile),
        getRoot: () => root,
      },
    },
    settings: Object.assign({ maxFileSizeMB: 5, maxFolderFiles: 500, folderEncodeBatchSize: 1 }, settings),
    getTokenCount: async (p) => {
      tokenCalls.push(p);
      return 10;
    },
  };
  return { plugin, tokenCalls };
}

test("getFolderTokens: numeric sum when files <= cap", async () => {
  const folder = makeFolder("docs", 5);
  const { plugin, tokenCalls } = buildPlugin(folder, { maxFolderFiles: 100, folderEncodeBatchSize: 2 });
  const core = createAtPathCore(plugin);
  const result = await core.getFolderTokens("docs");
  assert.equal(result, 50); // 5 files * 10 tokens
  assert.equal(tokenCalls.length, 5);
  // Memoized
  assert.equal(core.getCachedFolderTokens("docs"), 50);
});

test("getFolderTokens: sentinel when files > cap; walk short-circuits", async () => {
  // Make a folder with 20 files but cap at 5
  const folder = makeFolder("big", 20);
  const { plugin, tokenCalls } = buildPlugin(folder, { maxFolderFiles: 5 });
  const core = createAtPathCore(plugin);
  const result = await core.getFolderTokens("big");
  assert.equal(typeof result, "object");
  assert.equal(result.overCap, true);
  // We expect fileCount = cap + 1 (the short-circuit boundary)
  assert.equal(result.fileCount, 6);
  // No file token calls — short-circuit happened before encode step
  assert.equal(tokenCalls.length, 0);
  // Memoized as sentinel
  const cached = core.getCachedFolderTokens("big");
  assert.equal(cached.overCap, true);
  assert.equal(cached.fileCount, 6);
});

test("getFolderTokens: in-flight dedupe — two concurrent calls share one promise", async () => {
  // Slow down the per-file token count so the second call hits while the
  // first is still resolving.
  const folder = makeFolder("docs2", 3);
  const { plugin, tokenCalls } = buildPlugin(folder, { maxFolderFiles: 100 });
  plugin.getTokenCount = async (p) => {
    await new Promise((r) => setTimeout(r, 5));
    tokenCalls.push(p);
    return 7;
  };
  const core = createAtPathCore(plugin);
  const [a, b] = await Promise.all([core.getFolderTokens("docs2"), core.getFolderTokens("docs2")]);
  assert.equal(a, 21);
  assert.equal(b, 21);
  // Per-file calls should fire once (3), not twice (6).
  assert.equal(tokenCalls.length, 3);
});

test("getFolderTokens: epoch invalidation — clearFolderTokenMemo mid-walk prevents memoization", async () => {
  const folder = makeFolder("docs3", 4);
  const { plugin } = buildPlugin(folder, { maxFolderFiles: 100, folderEncodeBatchSize: 1 });
  // Make encode slow so we can clear mid-walk
  plugin.getTokenCount = async () => {
    await new Promise((r) => setTimeout(r, 5));
    return 3;
  };
  const core = createAtPathCore(plugin);
  const promise = core.getFolderTokens("docs3");
  // Wait a tick for the walk to start, then clear (bumps epoch).
  await new Promise((r) => setTimeout(r, 1));
  core.clearFolderTokenMemo();
  const result = await promise;
  // The promise still resolves with a value, but the memo must not store it.
  assert.equal(typeof result, "number");
  assert.equal(core.getCachedFolderTokens("docs3"), null);
});

test("clearFolderTokenMemo: wipes both numeric and sentinel entries", async () => {
  const small = makeFolder("small", 2);
  const big = makeFolder("big", 10);
  const root = new TFolder("", [small, big]);
  const byPath = new Map();
  byPath.set("small", small);
  byPath.set("big", big);
  for (const c of small.children) byPath.set(c.path, c);
  for (const c of big.children) byPath.set(c.path, c);
  const plugin = {
    app: { vault: {
      getAbstractFileByPath: (p) => byPath.get(p) || null,
      getFiles: () => [...byPath.values()].filter((n) => n instanceof TFile),
      getRoot: () => root,
    }},
    settings: { maxFileSizeMB: 5, maxFolderFiles: 5, folderEncodeBatchSize: 1 },
    getTokenCount: async () => 4,
  };
  const core = createAtPathCore(plugin);
  const small_sum = await core.getFolderTokens("small");
  const big_sentinel = await core.getFolderTokens("big");
  assert.equal(small_sum, 8);
  assert.equal(big_sentinel.overCap, true);
  core.clearFolderTokenMemo();
  assert.equal(core.getCachedFolderTokens("small"), null);
  assert.equal(core.getCachedFolderTokens("big"), null);
});

test("getFolderTokens: yields between batches (macrotask boundary)", async () => {
  // Use 6 files, batch size 2 → 3 batches → at least 2 macrotask yields.
  const folder = makeFolder("yield", 6);
  const { plugin } = buildPlugin(folder, { maxFolderFiles: 100, folderEncodeBatchSize: 2 });
  const core = createAtPathCore(plugin);

  // Schedule a macrotask "ticker" while the walk runs.
  let ticks = 0;
  let stopped = false;
  function tick() {
    if (stopped) return;
    ticks++;
    setTimeout(tick, 0);
  }
  setTimeout(tick, 0);
  const result = await core.getFolderTokens("yield");
  stopped = true;
  assert.equal(result, 60); // 6 * 10
  // Expect at least 2 ticks (one per inter-batch yield).
  assert.ok(ticks >= 2, "expected at least 2 macrotask ticks during walk, got " + ticks);
});

test("getFolderTokens: respects maxFileSizeMB — large files skipped, not counted toward cap", async () => {
  // Two normal-size files + one giant file. maxFolderFiles=10, maxFileSizeMB tiny.
  const small1 = new TFile("mix/a.md", { size: 100 });
  const small2 = new TFile("mix/b.md", { size: 100 });
  const giant = new TFile("mix/big.md", { size: 50 * 1024 * 1024 });
  const folder = new TFolder("mix", [small1, small2, giant]);
  const root = new TFolder("", [folder]);
  const byPath = new Map();
  byPath.set("mix", folder);
  byPath.set("mix/a.md", small1);
  byPath.set("mix/b.md", small2);
  byPath.set("mix/big.md", giant);
  const plugin = {
    app: { vault: {
      getAbstractFileByPath: (p) => byPath.get(p) || null,
      getFiles: () => [small1, small2, giant],
      getRoot: () => root,
    }},
    settings: { maxFileSizeMB: 1, maxFolderFiles: 10, folderEncodeBatchSize: 1 },
    getTokenCount: async () => 7,
  };
  const core = createAtPathCore(plugin);
  const result = await core.getFolderTokens("mix");
  // Only the two small files counted (7 each), giant skipped.
  assert.equal(result, 14);
});
