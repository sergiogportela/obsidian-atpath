"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { f_createTokenIndex, f_estimateTokens } = require("../src/token-index");
const { f_describeTokenBadge, f_installExplorerTokenBadges } = require("../src/explorer-token-badges");

function f_file(path, text, mtime = 1) {
  return { path, text, stat: { size: Buffer.byteLength(text), mtime } };
}

function f_deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function f_index(files, overrides = {}) {
  return f_createTokenIndex({
    getFiles: () => files,
    read: async file => file.text,
    isEligible: file => !file.path.endsWith(".png"),
    looksBinary: text => text.includes("\0"),
    ...overrides,
  });
}

test("folder totals distinguish pending, skipped and estimated files", async () => {
  const plain = f_file("top/plain.md", "abcdefghijkl");
  const unicode = f_file("top/deep/unicode.md", "Olá, 🦉");
  const binary = f_file("top/deep/false-text.md", "\0abc");
  const oversized = f_file("top/image.png", "abc");
  const pending = f_deferred();
  const index = f_index([plain, unicode, binary, oversized], {
    read: file => file === unicode ? pending.promise : Promise.resolve(file.text),
  });
  try {
    await index.start();
    assert.equal(await index.request(plain), 3);
    const inProgress = index.get("top", true);
    assert.equal(inProgress.tokens, 3);
    assert.ok(inProgress.pending > 0);
    assert.equal(inProgress.candidates, 3);
    const pendingBadge = f_describeTokenBadge(inProgress, String);
    assert.equal(pendingBadge.text, "~3 …");
    assert.match(pendingBadge.title, /still pending/);
    pending.resolve(unicode.text);
    assert.equal(await index.request(unicode), 2);
    assert.equal(await index.request(binary), null);
    assert.equal(await index.request(oversized), null);
    assert.deepEqual(index.get("top", true), { tokens: 5, pending: 0, skipped: 2, counted: 2, candidates: 3 });
    assert.deepEqual(index.get("top/deep", true), { tokens: 2, pending: 0, skipped: 1, counted: 1, candidates: 2 });
    assert.deepEqual(index.get("/", true), index.get("top", true));
    assert.match(f_describeTokenBadge(index.get("/", true), String).title, /2 files skipped/);
  } finally {
    await index.dispose();
  }
});

test("explicit unindexed targets have direct estimates and no folder contribution", async () => {
  const indexed = f_file("folder/native.md", "abcd");
  const explicit = { ...f_file("folder/unindexed.md", "abcdefgh"), localOnly: true };
  const index = f_index([indexed, explicit]);
  try {
    await index.start();
    assert.equal(await index.request(indexed), 1);
    assert.equal(await index.request(explicit), 2);
    assert.deepEqual(index.get("folder", true), {
      tokens: 1, pending: 0, skipped: 0, counted: 1, candidates: 1,
    });
    assert.deepEqual(index.get(explicit.path), { tokens: 2, pending: 0, skipped: 0, counted: 1 });
  } finally {
    await index.dispose();
  }
});

test("disabled counts do not read content and queued estimates resume when enabled", async () => {
  const first = f_file("first.md", "abcd");
  const next = f_file("next.md", "abcdefgh");
  const started = f_deferred();
  const release = f_deferred();
  const readPaths = [];
  const index = f_index([first, next], {
    enabled: false,
    read: async file => {
      readPaths.push(file.path);
      if (file === first) {
        started.resolve();
        await release.promise;
      }
      return file.text;
    },
  });
  try {
    await index.start();
    assert.equal(await index.request(first), null);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(readPaths, []);
    index.setEnabled(true);
    await started.promise;
    const nextRequest = index.request(next);
    index.setEnabled(false);
    assert.equal(await nextRequest, null);
    release.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(readPaths, [first.path]);
    index.setEnabled(true);
    assert.equal(await index.request(next), 2);
    assert.deepEqual(readPaths, [first.path, next.path]);
  } finally {
    release.resolve();
    await index.dispose();
  }
});

test("cache checkpoints preserve completed work despite continuous queue progress", async t => {
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
  } catch (error) {
    if (error.code !== "ERR_INVALID_ARG_TYPE") throw error;
    t.mock.timers.enable(["setTimeout"]);
  }
  const files = Array.from({ length: 12 }, (_, index) => f_file("note-" + index + ".md", "abcd"));
  const delays = files.map(f_deferred);
  const checkpoints = [];
  const index = f_index(files, {
    read: file => delays[files.indexOf(file)].promise,
    save: async value => { checkpoints.push(value); },
  });
  try {
    await index.start();
    for (let indexInQueue = 0; indexInQueue <= 10; indexInQueue++) {
      const request = index.request(files[indexInQueue]);
      t.mock.timers.tick(indexInQueue === 0 ? 0 : 500);
      delays[indexInQueue].resolve(files[indexInQueue].text);
      assert.equal(await request, 1);
    }
    assert.equal(checkpoints.length, 1, "continuous reads must not postpone the checkpoint");
    assert.equal(Object.keys(checkpoints[0].files).length, 10);
    assert.equal(checkpoints[0].files["note-0.md"].tokens, 1);
  } finally {
    for (let i = 0; i < files.length; i++) delays[i].resolve(files[i].text);
    await index.dispose();
  }
});

test("restart reuses warm counts only for matching estimator version, mtime and size", async () => {
  const note = f_file("note.md", "12345678");
  const binary = f_file("sniffed.md", "\0");
  const skipped = f_file("file.png", "x");
  const files = [note, binary, skipped];
  let persisted;
  const cold = f_index(files, { save: async value => { persisted = value; } });
  await cold.start();
  await Promise.all(files.map(file => cold.request(file)));
  await cold.dispose();
  assert.deepEqual(Object.keys(persisted.files).sort(), ["note.md", "sniffed.md"]);

  const reads = [];
  const read = async file => { reads.push(file.path); return file.text; };
  const warm = f_index(files, { load: async () => persisted, read });
  await warm.start();
  assert.equal(await warm.request(note), 2);
  assert.equal(await warm.request(binary), null);
  assert.deepEqual(reads, []);
  note.text = "123456789012";
  note.stat = { ...note.stat, size: 12 };
  warm.upsert(note);
  assert.equal(await warm.request(note), 3);
  assert.deepEqual(reads, ["note.md"]);
  await warm.dispose();

  const stale = f_index(files, { load: async () => ({ ...persisted, version: -1 }), read });
  await stale.start();
  await stale.request(note);
  assert.deepEqual(reads, ["note.md", "note.md"]);
  await stale.dispose();
});

test("a priority link overtakes background work and stale reads cannot revive deleted or moved paths", async () => {
  const slow = f_file("old/slow.md", "1234");
  const first = f_file("first.md", "1234");
  const linked = f_file("linked.md", "12345678");
  const started = f_deferred();
  const release = f_deferred();
  const files = [slow, first, linked];
  const reads = [];
  const index = f_index(files, {
    read: async file => {
      reads.push(file.path);
      if (file === slow && file.path === "old/slow.md") {
        started.resolve();
        return release.promise;
      }
      return file.text;
    },
  });
  try {
    await index.start();
    const oldRequest = index.request(slow);
    await started.promise;
    const linkedRequest = index.request(linked);
    index.remove("old");
    slow.path = "new/slow.md";
    slow.text = "123456789012";
    slow.stat = { mtime: 2, size: 12 };
    index.rename({ path: "new", children: [slow] }, "old");
    release.resolve("1234");
    assert.equal(await oldRequest, null);
    assert.equal(await linkedRequest, 2);
    assert.equal(reads[1], "linked.md");
    assert.equal(await index.request(slow), 3);
    assert.equal(index.get("old/slow.md"), null);
    assert.deepEqual(index.get("new", true), { tokens: 3, pending: 0, skipped: 0, counted: 1, candidates: 1 });
    assert.deepEqual(index.get("old", true), { tokens: 0, pending: 0, skipped: 0, counted: 0, candidates: 0 });
  } finally {
    release.resolve("");
    await index.dispose();
  }
});

test("folder-first native rename events wait for descendant paths to update", async () => {
  const file = f_file("old/leaf.md", "abcdefgh");
  const index = f_index([file]);
  try {
    await index.start();
    assert.equal(await index.request(file), 2);
    index.rename({ path: "new", children: [file] }, "old");
    assert.equal(index.get("old/leaf.md"), null);
    file.path = "new/leaf.md";
    index.rename(file, "old/leaf.md");
    assert.equal(await index.request(file), 2);
    assert.deepEqual(index.get("new", true), { tokens: 2, pending: 0, skipped: 0, counted: 1, candidates: 1 });
  } finally {
    await index.dispose();
  }
});

test("estimator counts decoded characters and explorer degrades when the native workspace shape is absent", () => {
  assert.equal(f_estimateTokens(""), 0);
  assert.equal(f_estimateTokens("🦉🐈a"), 2);
  assert.equal(f_describeTokenBadge(null, String).text, "…");
  assert.equal(f_describeTokenBadge({ tokens: 0, counted: 0, pending: 0, skipped: 1 }, String).text, "—");
  assert.equal(f_installExplorerTokenBadges({ workspace: {}, index: {}, formatTokens: String }), null);
});
