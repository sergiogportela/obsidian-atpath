"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { f_createFileSymlinkReader, f_mergeShortcutItems } = require("../src/explorer-symlink-shortcuts");

test("file shortcut discovery follows in-vault file targets, including chains; ignores loops, folders and outside targets", async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "atpath-symlinks-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "vault");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), "instructions");
  await fs.writeFile(path.join(scratch, "private.md"), "outside");
  for (const [name, target] of [
    ["CLAUDE.md", "AGENTS.md"], ["CHAIN.md", "CLAUDE.md"],
    ["MISSING.md", "absent.md"], ["LOOP.md", "LOOP.md"],
    ["OUTSIDE.md", "../private.md"], ["directory", "nested"],
    ["nested/alias.md", "../AGENTS.md"],
  ]) await fs.symlink(target, path.join(root, name));
  const reader = f_createFileSymlinkReader(root);
  assert.deepEqual((await reader.list("/")).map(x => [x.path, x.targetPath]).sort(), [
    ["CHAIN.md", "AGENTS.md"], ["CLAUDE.md", "AGENTS.md"],
  ]);
  assert.deepEqual(await reader.list("nested"), [{ path: "nested/alias.md", name: "alias.md", targetPath: "AGENTS.md" }]);
  assert.deepEqual(await reader.list("directory"), []);
  assert.equal(await reader.resolve("directory/alias.md"), null);
  assert.equal(await reader.resolve("../private.md"), null);
  assert.equal(await reader.resolve("AGENTS.md"), null);
});

test("shortcut lookup observes retargeting, deletion and replacement without cached destinations", async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "atpath-retarget-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  await fs.writeFile(path.join(scratch, "one.md"), "one");
  await fs.writeFile(path.join(scratch, "two.md"), "two");
  const alias = path.join(scratch, "alias.md");
  const reader = f_createFileSymlinkReader(scratch);
  await fs.symlink("one.md", alias);
  assert.equal((await reader.resolve("alias.md")).targetPath, "one.md");
  await fs.unlink(alias); await fs.symlink("two.md", alias);
  assert.equal((await reader.resolve("alias.md")).targetPath, "two.md");
  await fs.unlink(path.join(scratch, "two.md"));
  assert.equal(await reader.resolve("alias.md"), null);
  assert.deepEqual(await reader.list("/"), []);
  await fs.unlink(alias); await fs.writeFile(alias, "regular file");
  assert.equal(await reader.resolve("alias.md"), null);
});

test("explorer shortcuts sort by alias name or target timestamps while keeping folders first", () => {
  const folder = { file: { name: "Z folder" }, collapsible: true };
  const first = { file: { name: "AGENTS.md", stat: { mtime: 10, ctime: 5 } } };
  const last = { file: { name: "README.md", stat: { mtime: 20, ctime: 30 } } };
  const alias = { shortcut: { name: "CLAUDE.md" }, file: first.file };
  assert.deepEqual(f_mergeShortcutItems([folder, first, last], [alias], "alphabetical"), [folder, first, alias, last]);
  assert.deepEqual(f_mergeShortcutItems([folder, last, first], [alias], "alphabeticalReverse"), [folder, last, alias, first]);
  assert.deepEqual(f_mergeShortcutItems([folder, first, last], [alias], "byModifiedTime"), [folder, last, first, alias]);
  assert.deepEqual(f_mergeShortcutItems([folder, first, last], [alias], "byCreatedTimeReverse"), [folder, first, alias, last]);
  assert.deepEqual(f_mergeShortcutItems([last, first], [alias], "custom"), [last, first, alias]);
});
