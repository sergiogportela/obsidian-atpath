"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { f_createTokenIndex } = require("../src/token-index");
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
    // Deterministic counter double: tokenizer correctness is tested separately.
    count: async text => Math.ceil(text.length / 4),
    getFiles: () => files,
    read: async file => file.text,
    isEligible: file => !file.path.endsWith(".png"),
    looksBinary: text => text.includes("\0"),
    ...overrides,
  });
}

test("folder totals distinguish pending, skipped and counted files", async () => {
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
    assert.equal(pendingBadge.text, "3 …");
    assert.match(pendingBadge.title, /still pending/);
    pending.resolve(unicode.text);
    assert.equal(await index.request(unicode), 2);
    assert.equal(await index.request(binary), null);
    assert.equal(await index.request(oversized), null);
    assert.deepEqual(index.get("top", true), { tokens: 5, pending: 0, skipped: 2, failed: 0, counted: 2, candidates: 3 });
    assert.deepEqual(index.get("top/deep", true), { tokens: 2, pending: 0, skipped: 1, failed: 0, counted: 1, candidates: 2 });
    assert.deepEqual(index.get("/", true), index.get("top", true));
    assert.match(f_describeTokenBadge(index.get("/", true), String).title, /2 files skipped/);
  } finally {
    await index.dispose();
  }
});

test("explicit unindexed targets have direct counts and no folder contribution", async () => {
  const indexed = f_file("folder/native.md", "abcd");
  const explicit = { ...f_file("folder/unindexed.md", "abcdefgh"), localOnly: true };
  const index = f_index([indexed, explicit]);
  try {
    await index.start();
    assert.equal(await index.request(indexed), 1);
    assert.equal(await index.request(explicit), 2);
    assert.deepEqual(index.get("folder", true), {
      tokens: 1, pending: 0, skipped: 0, failed: 0, counted: 1, candidates: 1,
    });
    assert.deepEqual(index.get(explicit.path), { tokens: 2, pending: 0, skipped: 0, failed: 0, counted: 1 });
  } finally {
    await index.dispose();
  }
});

test("disabled counts do not read content and queued counts resume when enabled", async () => {
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

test("restart reuses warm counts only for matching tokenizer identity and verified content", async () => {
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
  assert.deepEqual(reads, ["note.md", "sniffed.md"]);
  reads.length = 0;
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
    assert.deepEqual(index.get("new", true), { tokens: 3, pending: 0, skipped: 0, failed: 0, counted: 1, candidates: 1 });
    assert.deepEqual(index.get("old", true), { tokens: 0, pending: 0, skipped: 0, failed: 0, counted: 0, candidates: 0 });
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
    assert.deepEqual(index.get("new", true), { tokens: 2, pending: 0, skipped: 0, failed: 0, counted: 1, candidates: 1 });
  } finally {
    await index.dispose();
  }
});

test("explorer degrades when the native workspace shape is absent", () => {
  assert.equal(f_describeTokenBadge(null, String).text, "…");
  assert.equal(f_describeTokenBadge({ tokens: 0, counted: 0, pending: 0, skipped: 1 }, String).text, "—");
  assert.equal(f_installExplorerTokenBadges({ workspace: {}, index: {}, formatTokens: String }), null);
  const failed = f_describeTokenBadge({ tokens: 0, counted: 0, pending: 0, skipped: 1, failed: 1 }, String);
  assert.equal(failed.text, "— !");
  assert.match(failed.title, /Reload AtPath to retry/);
});

test("warm cache verifies content and detects offline and live edits with identical metadata", async () => {
  const file = f_file("note.md", "aaaa");
  let saved;
  let encodes = 0;
  const count = async text => { encodes++; return text === "aaaa" ? 1 : 2; };
  const cold = f_index([file], { count, save: async value => { saved = value; } });
  await cold.start();
  assert.equal(await cold.request(file), 1);
  await cold.dispose();
  const warm = f_index([file], { count, load: async () => saved });
  await warm.start();
  assert.equal(warm.get(file.path).pending, 1, "persisted values are not displayed before validation");
  assert.equal(await warm.request(file), 1);
  assert.equal(encodes, 1, "verified text bypasses tokenization");
  file.text = "bbbb";
  warm.upsert(file);
  assert.equal(warm.get(file.path).pending, 1);
  assert.equal(await warm.request(file), 2);
  await warm.dispose();
  const offline = f_index([file], { count, load: async () => saved });
  await offline.start();
  assert.equal(await offline.request(file), 2);
  assert.equal(encodes, 3);
  await offline.dispose();
  for (const corrupt of [{ ...saved, tokenizer: "other" }, { ...saved, version: 1 },
    { ...saved, files: { "note.md": { ...saved.files["note.md"], digest: null } } }]) {
    const index = f_index([file], { count, load: async () => corrupt });
    await index.start();
    await index.request(file);
    await index.dispose();
  }
  assert.equal(encodes, 6, "old, mismatched and malformed cache entries cannot be reused");
});

test("late worker results cannot overwrite edits, renames, deletes or disposal", async () => {
  for (const operation of ["modify", "rename", "delete", "dispose", "stat"]) {
    const file = f_file("old.md", "aaaa");
    const started = f_deferred();
    const release = f_deferred();
    let first = true;
    const index = f_index([file], { count: async () => {
      if (!first) return 2;
      first = false;
      started.resolve();
      return release.promise;
    } });
    await index.start();
    const old = index.request(file);
    await started.promise;
    if (operation === "modify") { file.text = "bbbb"; index.upsert(file); }
    else if (operation === "stat") file.stat.mtime++;
    else if (operation === "rename") { file.path = "new.md"; index.rename(file, "old.md"); }
    else if (operation === "delete") index.remove("old.md");
    else await index.dispose();
    release.resolve(999);
    assert.equal(await old, null);
    if (["modify", "rename", "stat"].includes(operation)) assert.equal(await index.request(file), 2);
    assert.notEqual(index.get(file.path)?.tokens, 999);
    await index.dispose();
  }
});

test("failed checkpoint retries without another modification and persists deletion", async t => {
  try { t.mock.timers.enable({ apis: ["setTimeout"] }); }
  catch (error) { if (error.code !== "ERR_INVALID_ARG_TYPE") throw error; t.mock.timers.enable(["setTimeout"]); }
  const file = f_file("note.md", "aaaa");
  let attempts = 0;
  let saved;
  const failures = [];
  const index = f_index([file], {
    save: async value => { attempts++; if (attempts === 1) throw new Error("quota"); saved = value; },
    onError: error => failures.push(error.message),
  });
  await index.start();
  const request = index.request(file);
  t.mock.timers.tick(0);
  await request;
  t.mock.timers.tick(5000);
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  assert.deepEqual(failures, ["quota"]);
  assert.equal(attempts, 1);
  t.mock.timers.tick(5000);
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(saved.files["note.md"].tokens, 1);
  index.remove("note.md");
  t.mock.timers.reset();
  await index.dispose();
  assert.deepEqual(saved.files, {});
});

test("folder boundaries stop ancestor totals while retaining direct and nested counts", async () => {
  const files = [f_file("work/active.md", "aaaa"), f_file("work/90_archive/old.md", "aaaaaaaa"),
    f_file("work/90_archive/deep/nested.md", "aaaa"), f_file("work/90_archive/deep/90_archive/older.md", "aaaaaaaaaaaa"),
    f_file("work/scratch/draft.md", "aaaa")];
  let encodes = 0;
  const index = f_index(files, { folderExclusions: ["90_archive", "work/scratch"], count: async text => { encodes++; return text.length / 4; } });
  try {
    await index.start();
    await Promise.all(files.map(file => index.request(file)));
    assert.equal(index.get("work", true).tokens, 1);
    assert.equal(index.get("/", true).tokens, 1);
    assert.equal(index.get("work/90_archive", true).tokens, 3);
    assert.equal(index.get("work/90_archive/deep", true).tokens, 1);
    assert.equal(index.get(files[3].path).tokens, 3);
    assert.equal(index.get("work", true).candidates, 1);
    index.setFolderExclusions([]);
    assert.equal(index.get("work", true).tokens, 8);
    assert.equal(encodes, 5, "settings rebuild aggregates without encoding files again");
    index.setFolderExclusions(["90_archive"]);
    const moved = files[1];
    const oldPath = moved.path;
    moved.path = "work/restored.md";
    index.rename(moved, oldPath);
    await index.request(moved);
    assert.equal(index.get("work", true).tokens, 4);
    assert.equal(index.get("work/90_archive", true).tokens, 1);
  } finally { await index.dispose(); }
});

test("warm checkpoints and early unload preserve saved candidates awaiting verification", async t => {
  const files = [f_file("first.md", "aaaa"), f_file("slow.md", "bbbb")];
  let saved;
  const save = async value => { saved = value; };
  const cold = f_index(files, { save });
  await cold.start();
  await Promise.all(files.map(file => cold.request(file)));
  await cold.dispose();
  try { t.mock.timers.enable({ apis: ["setTimeout"] }); }
  catch (error) { if (error.code !== "ERR_INVALID_ARG_TYPE") throw error; t.mock.timers.enable(["setTimeout"]); }
  const release = f_deferred();
  const warm = f_index(files, { load: async () => saved, save,
    read: file => file === files[1] ? release.promise : Promise.resolve(file.text),
    count: async () => { throw new Error("unchanged text must reuse the saved count"); },
  });
  await warm.start();
  const first = warm.request(files[0]);
  t.mock.timers.tick(0);
  await first;
  const slow = warm.request(files[1]);
  t.mock.timers.tick(5000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(Object.keys(saved.files).sort(), ["first.md", "slow.md"]);
  assert.equal(warm.get("slow.md").pending, 1);
  t.mock.timers.reset();
  await warm.dispose();
  assert.equal(await slow, null);
  release.resolve(files[1].text);
  const restart = f_index(files, { load: async () => saved,
    count: async () => { throw new Error("early unload must preserve the candidate"); },
  });
  await restart.start();
  assert.deepEqual(await Promise.all(files.map(file => restart.request(file))), [1, 1]);
  await restart.dispose();

  try { t.mock.timers.enable({ apis: ["setTimeout"] }); }
  catch (error) { if (error.code !== "ERR_INVALID_ARG_TYPE") throw error; t.mock.timers.enable(["setTimeout"]); }
  const blocked = f_deferred();
  const deleting = f_index(files, { load: async () => saved, save, read: () => blocked.promise });
  await deleting.start();
  t.mock.timers.tick(5000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.ok(saved.files["slow.md"]);
  deleting.remove("slow.md");
  t.mock.timers.reset();
  await deleting.dispose();
  assert.equal(saved.files["slow.md"], undefined, "deletion removes a checkpointed candidate still awaiting verification");
  blocked.resolve("");
});

test("read and tokenizer errors are distinct failed entries and leave other files countable", async () => {
  const files = [f_file("unreadable.md", "aaaa"), f_file("poison.md", "bbbb"), f_file("healthy.md", "cccc")];
  const errors = [];
  const index = f_index(files, {
    read: async file => { if (file === files[0]) throw new Error("ENOENT"); return file.text; },
    count: async text => { if (text === "bbbb") throw new Error("worker timeout"); return 1; },
    onError: (error, path, stage) => errors.push({ message: error.message, path, stage }),
  });
  await index.start();
  assert.deepEqual(await Promise.all(files.map(file => index.request(file))), [null, null, 1]);
  assert.deepEqual(errors.map(error => error.stage), ["read", "count"]);
  const total = index.get("/", true);
  assert.equal(total.failed, 2);
  assert.equal(total.skipped, 0);
  assert.equal(total.tokens, 1);
  const badge = f_describeTokenBadge(total, String);
  assert.equal(badge.text, "1 !");
  assert.match(badge.title, /2 files failed.*incomplete/);
  assert.match(f_describeTokenBadge(index.get("poison.md"), String).text, /!/);
  await index.dispose();
});

test("touches, renames and stat changes retain saved candidates while verification is in flight", async () => {
  for (const operation of ["modify", "rename", "stat"]) {
    const file = f_file("note.md", "aaaa");
    let saved;
    let encodes = 0;
    const count = async () => { encodes++; return 1; };
    const cold = f_index([file], { count, save: async value => { saved = value; } });
    await cold.start();await cold.request(file);await cold.dispose();
    const started = f_deferred();const release = f_deferred();let first = true;
    const warm = f_index([file], { count, load: async () => saved,
      read: async () => { if (first) { first = false; started.resolve(); return release.promise; } return file.text; } });
    await warm.start();const old = warm.request(file);await started.promise;
    if (operation === "modify") warm.upsert(file);
    else if (operation === "stat") file.stat.mtime++;
    else { file.path = "renamed.md"; warm.rename(file, "note.md"); }
    release.resolve(file.text);assert.equal(await old, null);
    assert.equal(await warm.request(file), 1);assert.equal(encodes, 1);
    await warm.dispose();
  }
});

test("persistent save failures back off and log once per failure streak", async t => {
  try { t.mock.timers.enable({ apis: ["setTimeout"] }); }
  catch (error) { if (error.code !== "ERR_INVALID_ARG_TYPE") throw error; t.mock.timers.enable(["setTimeout"]); }
  const file = f_file("note.md", "aaaa");let attempts = 0;let warnings = 0;
  const index = f_index([file], { save: async () => { if (++attempts < 4) throw new Error("quota"); }, onError: () => warnings++ });
  await index.start();const request = index.request(file);t.mock.timers.tick(0);await request;
  for (const delay of [5000, 5000, 10000, 20000]) {
    t.mock.timers.tick(delay);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  assert.equal(attempts, 4);assert.equal(warnings, 1);
  t.mock.timers.reset();await index.dispose();
});
