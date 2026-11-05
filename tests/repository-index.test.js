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
  text = "Before ![[space";
  assert.equal(suggest.onTrigger({ line: 0, ch: text.length }, editor, source), null);
});

test("canonical linked copy and publishing collection trust destination and deduplicate descendants", async t => {
  const AtPath = f_loadPlugin();
  const plugin = new AtPath();
  const { TFile, TFolder } = require("obsidian");
  const source = new TFile("checkout/note.md");
  const target = new TFile("checkout/docs/actual.md");
  const docs = new TFolder("checkout/docs", [target]);
  const note = "[wrong](/docs/actual.md) [folder](/docs/) [ordinary](#heading)";
  const files = new Map([target, docs].map(file => [file.path, file]));
  plugin.app = {
    vault: {
      getAbstractFileByPath: path => files.get(path),
      cachedRead: async () => "ACTUAL FILE",
    },
    workspace: {
      getActiveViewOfType: () => ({ file: source, editor: { getValue: () => note } }),
    },
  };
  plugin.settings = { maxFileSizeMB: 5, maxFolderFiles: 10 };
  plugin.repositories = [{ root: "checkout", identity: "org/repo" }];
  plugin._unindexedTargets = new Map();
  plugin.core = { isIgnored: () => false };
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let clipboard;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { clipboard = text; } } });
  t.after(() => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete navigator.clipboard;
  });
  await plugin.copyNoteWithAtPaths();
  assert.equal(clipboard.split("ACTUAL FILE").length, 2);
  assert.match(clipboard, /^\[wrong\]\(\/docs\/actual.md\)/);
  assert.match(clipboard, /## docs\/actual\.md/);
  assert.deepEqual(await plugin.collectAtPathFiles(note, source), [{
    relPath: "docs/actual.md", legacyLabel: null, vaultPath: target.path, content: "ACTUAL FILE",
  }]);
});
