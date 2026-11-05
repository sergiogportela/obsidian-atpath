"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { mkdir, mkdtemp, rm, symlink } = require("node:fs/promises");
const { join } = require("node:path");
const {
  REPOSITORY_MAP_PATH, f_discoverRepositories, f_readRepositoryMap, f_writeRepositoryMap,
} = require("../src/repository-index");

test("desktop discovery preserves innermost Git worktrees and repositories without origins", async t => {
  const base = await mkdtemp(join(process.cwd(), ".repository-index-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, "workspace");
  const parent = join(cwd, "local-checkout");
  const child = join(parent, "nested");
  const storage = join(base, "child-git");
  const skipped = join(cwd, "node_modules");
  await Promise.all([mkdir(child, { recursive: true }), mkdir(skipped, { recursive: true })]);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["init", "-q"], { cwd: parent });
  execFileSync("git", ["config", "--local", "remote.origin.url", "git@github.com:Org/Actual-Name.git"], { cwd: parent });
  execFileSync("git", ["init", "-q", "--separate-git-dir", storage], { cwd: child });
  execFileSync("git", ["init", "-q"], { cwd: skipped });
  await symlink(child, join(cwd, "redirect"), "dir");
  assert.deepEqual(await f_discoverRepositories(cwd), [
    { root: "", identity: null, refs: [] },
    { root: "local-checkout", identity: "org/actual-name", refs: [] },
    { root: "local-checkout/nested", identity: null, refs: [] },
  ]);
});

test("repository map persists only when changed and rejects traversal roots", async () => {
  let content;
  let writes = 0;
  const adapter = {
    exists: async path => path === REPOSITORY_MAP_PATH && content !== undefined,
    read: async () => content,
    write: async (path, text) => {
      assert.equal(path, REPOSITORY_MAP_PATH);
      content = text;
      writes++;
    },
  };
  const repositories = [{ root: "nested/checkout", identity: "org/name", refs: ["main"], aliases: ["org/old"] }];
  assert.deepEqual(await f_readRepositoryMap(adapter), []);
  await f_writeRepositoryMap(adapter, repositories);
  await f_writeRepositoryMap(adapter, repositories);
  assert.equal(writes, 1);
  assert.deepEqual(await f_readRepositoryMap(adapter), repositories);
  content = '{"version":1,"repositories":[{"root":"../other","identity":"org/name"}]}';
  await assert.rejects(f_readRepositoryMap(adapter), /Invalid repository map entry/);
});

function f_loadPlugin() {
  const Module = require("node:module");
  const obsidian = require("obsidian");
  const originalLoad = Module._load;
  Module._load = function (id, ...rest) {
    if (id === "obsidian") return { ...obsidian, Platform: { isMobile: true } };
    if (id === "@codemirror/view") return {
      ViewPlugin: { define: (_plugin, options) => options },
      EditorView: { domEventHandlers: handlers => handlers },
      MatchDecorator: class {},
      WidgetType: class {},
    };
    if (id === "@codemirror/state") return {
      Compartment: class { of(value) { return value; } },
      Prec: { highest: value => value },
    };
    return originalLoad.call(this, id, ...rest);
  };
  try {
    return require("../src/main");
  } finally {
    Module._load = originalLoad;
  }
}

test("normal plugin registration prioritizes [[ and consumes its closing pair", async t => {
  const AtPath = f_loadPlugin();
  const plugin = new AtPath();
  const { TFile } = require("obsidian");
  const source = new TFile("checkout/note.md");
  const target = new TFile("checkout/space here.md");
  const nativeSuggest = {};
  const suggests = [nativeSuggest];
  plugin.app = {
    appId: "test",
    vault: { adapter: {}, on() {} },
    workspace: { editorSuggest: { suggests }, onLayoutReady() {}, on() {} },
  };
  plugin.loadSettings = async () => { plugin.settings = {}; };
  plugin.registerEditorSuggest = suggest => suggests.push(suggest);
  for (const name of ["register", "registerEditorExtension", "registerEvent", "registerDomEvent",
    "addCommand", "addSettingTab", "registerMarkdownPostProcessor"]) plugin[name] = () => {};
  const oldDocument = globalThis.document;
  globalThis.document = {};
  t.after(() => { globalThis.document = oldDocument; });
  await plugin.onload();
  plugin.repositories = [{ root: "checkout", identity: "org/repo" }];
  assert.equal(suggests[1], nativeSuggest);
  const suggest = suggests[0];
  let text = "Before [[space]] after";
  const editor = {
    getValue: () => text,
    getLine: () => text,
    posToOffset: cursor => cursor.ch,
    replaceRange: (value, from, to) => { text = text.slice(0, from.ch) + value + text.slice(to.ch); },
  };
  const context = suggest.onTrigger({ line: 0, ch: 14 }, editor, source);
  assert.equal(context.query, "space");
  suggest.context = { ...context, editor, file: source };
  suggest.selectSuggestion({ target });
  assert.equal(text, "Before [space here.md](/space%20here.md)  after");

  text = "Before @space";
  assert.equal(suggest.onTrigger({ line: 0, ch: text.length }, editor, source), null);
  for (const nativeQuery of ["![[space", "[[space#heading", "[[#^block", "[[space^block", "[[space|alias"]) {
    text = "Before " + nativeQuery;
    assert.equal(suggest.onTrigger({ line: 0, ch: text.length }, editor, source), null, nativeQuery);
  }
});

test("canonical linked copy and publishing collection trust destination and deduplicate descendants", async t => {
  const AtPath = f_loadPlugin();
  const plugin = new AtPath();
  const { TFile, TFolder } = require("obsidian");
  const source = new TFile("checkout/note.md");
  const target = new TFile("checkout/docs/actual.md");
  const docs = new TFolder("checkout/docs", [target]);
  let note = "[wrong](/docs/actual.md) [folder](/docs/) [ordinary](#heading)";
  const files = new Map([target, docs].map(file => [file.path, file]));
  plugin.app = {
    vault: {
      getAbstractFileByPath: path => files.get(path),
      cachedRead: async () => "ACTUAL FILE",
      adapter: { read: async () => "12345678" },
    },
    workspace: {
      getActiveViewOfType: () => ({ file: source, editor: { getValue: () => note } }),
      getActiveFile: () => source,
    },
  };
  plugin.settings = { maxFileSizeMB: 5, maxFolderFiles: 10 };
  plugin.repositories = [{ root: "checkout", identity: "org/repo" }];
  plugin._unindexedTargets = new Map();
  plugin.core = { isIgnored: () => false };
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let clipboard;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: { writeText: async text => { clipboard = text; } },
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  });
  await plugin.copyNoteWithAtPaths();
  assert.equal(clipboard.split("ACTUAL FILE").length, 2);
  assert.match(clipboard, /^\[wrong\]\(\/docs\/actual.md\)/);
  assert.match(clipboard, /## docs\/actual\.md/);
  assert.deepEqual(await plugin.collectAtPathFiles(note, source), [{
    relPath: "docs/actual.md", legacyLabel: null, vaultPath: target.path, content: "ACTUAL FILE",
  }]);

  // A folder whose candidate count exceeds the cap cannot become copyable
  // simply by placing one of its children earlier in the note.
  const second = new TFile("checkout/docs/second.md");
  docs.children.push(second);
  files.set(second.path, second);
  plugin.settings.maxFolderFiles = 1;
  for (const markdown of [
    "[explicit](/docs/actual.md) [folder](/docs/)",
    "[folder](/docs/) [explicit](/docs/actual.md)",
  ]) {
    note = markdown;
    await plugin.copyNoteWithAtPaths();
    assert.match(clipboard, /## docs\/actual\.md/);
    assert.doesNotMatch(clipboard, /## docs\/second\.md/);
  }

  const localOnly = { path: "checkout/docs/direct.md", localOnly: true, extension: "md", stat: { size: 8, mtime: 1 } };
  plugin._unindexedTargets.set(localOnly.path, localOnly);
  plugin._linkedCountWatches = new Map();
  const { f_createTokenIndex } = require("../src/token-index");
  const index = f_createTokenIndex({
    getFiles: () => [target, second, localOnly],
    read: file => plugin.f_readLinkedFile(file),
    isEligible: file => plugin.f_eligibleLinkedFile(file),
    looksBinary: () => false,
  });
  t.after(() => index.dispose());
  plugin._tokenIndex = index;
  plugin.settings.showTokenCounts = true;
  plugin.noteBarEl = {};
  plugin.linkedBarEl = {};
  plugin._statusBarGen = 0;
  plugin._renderStatusBarSegments = () => {};
  plugin._renderLinkedPopover = () => {};
  await index.start();
  await Promise.all([target, second, localOnly].map(file => index.request(file)));
  assert.deepEqual(plugin.f_folderTokenCount(docs.path), { overCap: true, fileCount: 2, limit: 1 });
  plugin.settings.maxFolderFiles = 2;
  note = "[folder](/docs/) [indexed](/docs/actual.md) [unindexed](/docs/direct.md)";
  await plugin.updateStatusBar();
  assert.equal(plugin._lastLinkedTotal, 8, "the folder covers the indexed file but not the explicitly linked unindexed file");
  await plugin.copyNoteWithAtPaths();
  assert.equal(clipboard.split("ACTUAL FILE").length, 3);
  assert.match(clipboard, /## docs\/direct\.md\n\n```\n12345678/);
});

test("repository rename rewrites local targets while preserving query, fragment and historical SHA", async () => {
  const AtPath = f_loadPlugin();
  const plugin = new AtPath();
  const { TFile } = require("obsidian");
  const source = new TFile("checkout/note.md");
  const target = new TFile("checkout/new.md");
  const shaLink = "[Historical](https://github.com/org/repo/blob/abcd123/old.md?raw=1#Heading)";
  let text = "[Old](/old.md?raw=1#Heading)\n" + shaLink;
  plugin.repositories = [{ root: "checkout", identity: "org/repo" }];
  plugin.app = { vault: {
    getMarkdownFiles: () => [source],
    getAbstractFileByPath: path => path === target.path ? target : undefined,
    cachedRead: async () => text,
    process: async (file, update) => {
      assert.equal(file, source);
      text = update(text);
    },
  } };
  await plugin.f_rewriteRepositoryReferences(target.path, "checkout/old.md");
  assert.equal(text, "[new.md](/new.md?raw=1#Heading)\n" + shaLink);
});
