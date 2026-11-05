"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { mkdir, mkdtemp, rm, symlink, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const {
  REPOSITORY_MAP_PATH, f_discoverRepositories, f_lookupRenamedRepository, f_readRepositoryMap, f_writeRepositoryMap,
} = require("../src/repository-index");

test("desktop discovery preserves innermost Git worktrees and repositories without origins", async t => {
  const base = await mkdtemp(join(process.cwd(), ".repository-index-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, "workspace");
  const parent = join(cwd, "local-checkout");
  const child = join(parent, "nested");
  const storage = join(base, "child-git");
  const invalid = join(parent, "not-a-repo");
  const skipped = join(cwd, "node_modules");
  await Promise.all([mkdir(child, { recursive: true }), mkdir(skipped, { recursive: true }), mkdir(join(invalid, ".git"), { recursive: true })]);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["init", "-q"], { cwd: parent });
  execFileSync("git", ["config", "--local", "remote.origin.url", "git@github.com:Org/Actual-Name.git"], { cwd: parent });
  execFileSync("git", ["init", "-q", "--separate-git-dir", storage], { cwd: child });
  execFileSync("git", ["init", "-q"], { cwd: skipped });
  await symlink(child, join(cwd, "redirect"), "dir");
  const warnings = [];
  t.mock.method(console, "warn", message => warnings.push(message));
  assert.deepEqual(await f_discoverRepositories(cwd), [
    { root: "", identity: null, refs: [] },
    { root: "local-checkout", identity: "org/actual-name", refs: [] },
    { root: "local-checkout/nested", identity: null, refs: [] },
  ]);
  assert.deepEqual(warnings, ["AtPath skipped invalid Git marker: " + join(invalid, ".git")]);
});

test("missing Git executable rejects discovery so the caller retains the cache", async t => {
  const base = await mkdtemp(join(process.cwd(), ".repository-no-git-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, ".git"));
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function (id, ...rest) {
    if (id === "child_process") return {
      execFile: (_name, _args, _options, callback) => callback(Object.assign(new Error("git was not found"), { code: "ENOENT" })),
    };
    return originalLoad.call(this, id, ...rest);
  };
  try {
    await assert.rejects(f_discoverRepositories(base), { code: "ENOENT" });
  } finally {
    Module._load = originalLoad;
  }
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

test("rename lookup invokes the GitHub CLI and adds macOS Homebrew locations", async () => {
  const Module = require("node:module");
  const originalLoad = Module._load;
  let command;
  Module._load = function (id, ...rest) {
    if (id === "child_process") return {
      execFile: (name, args, options, callback) => {
        command = { name, args, options };
        callback(null, { stdout: "Org/New-Name\n" });
      },
    };
    return originalLoad.call(this, id, ...rest);
  };
  try {
    assert.equal(await f_lookupRenamedRepository("org/old-name"), "org/new-name");
  } finally {
    Module._load = originalLoad;
  }
  assert.equal(command.name, "gh");
  assert.deepEqual(command.args, ["api", "repos/org/old-name", "--jq", ".full_name"]);
  if (process.platform === "darwin") {
    assert.ok(command.options.env.PATH.split(":").includes("/opt/homebrew/bin"));
    assert.ok(command.options.env.PATH.split(":").includes("/usr/local/bin"));
  }
});

function f_loadPlugin(isMobile = true) {
  const Module = require("node:module");
  const obsidian = require("obsidian");
  const originalLoad = Module._load;
  Module._load = function (id, ...rest) {
    if (id === "obsidian") return { ...obsidian, Platform: { isMobile } };
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
    delete require.cache[require.resolve("../src/main")];
    return require("../src/main");
  } finally {
    Module._load = originalLoad;
  }
}

test("opened task worktrees use their own checkout and invalid Git markers cannot fall back to the parent", async t => {
  const base = await mkdtemp(join(process.cwd(), ".repository-source-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vaultPath = join(base, "vault");
  const taskRoot = "data/0_llm/worktrees/task";
  const invalidRoot = "data/0_llm/worktrees/invalid";
  const taskDirectory = join(vaultPath, taskRoot);
  const invalidDirectory = join(vaultPath, invalidRoot);
  await Promise.all([
    mkdir(join(taskDirectory, "_work_units"), { recursive: true }),
    mkdir(invalidDirectory, { recursive: true }),
  ]);
  execFileSync("git", ["init", "-q"], { cwd: vaultPath });
  execFileSync("git", ["init", "-q", "--separate-git-dir", join(base, "task.git")], { cwd: taskDirectory });
  execFileSync("git", ["config", "--local", "remote.origin.url", "git@github.com:Org/Task.git"], { cwd: taskDirectory });
  await writeFile(join(invalidDirectory, ".git"), "gitdir: ../missing");
  await Promise.all([
    writeFile(join(vaultPath, "README.md"), "parent"),
    writeFile(join(taskDirectory, "README.md"), "task"),
  ]);

  const AtPath = f_loadPlugin(false);
  const plugin = new AtPath();
  const { TFile } = require("obsidian");
  const readme = new TFile(taskRoot + "/README.md");
  const parentReadme = new TFile("README.md");
  const files = new Map([parentReadme, readme].map(file => [file.path, file]));
  const sourcePath = taskRoot + "/_work_units/source.md";
  let activePath = sourcePath;
  let savedMap;
  plugin.app = {
    vault: {
      adapter: {
        getBasePath: () => vaultPath,
        exists: async () => savedMap !== undefined,
        read: async () => savedMap,
        write: async (_path, value) => { savedMap = value; },
      },
      getAbstractFileByPath: path => files.get(path),
    },
    workspace: { getActiveFile: () => ({ path: activePath }) },
  };
  plugin.repositories = await f_discoverRepositories(vaultPath);
  plugin._sourceCheckoutChecks = new Map();
  plugin._unindexedTargets = new Map();
  plugin.f_repositoryIndexChanged = () => {};
  plugin._nativeRepositoryLinks = {};
  assert.deepEqual(plugin.repositories.map(repo => repo.root), [""]);
  const link = { destination: "/README.md" };
  assert.match(plugin.f_resolveLinkTarget(link, sourcePath).reason, /not been verified/);

  await plugin.f_refreshRepositoryIndex();
  assert.equal(plugin.f_resolveLinkTarget(link, sourcePath).target, readme);
  assert.equal(JSON.parse(savedMap).repositories.find(repo => repo.root === taskRoot).identity, "org/task");

  const invalidSource = invalidRoot + "/source.md";
  await plugin.f_discoverOpenedSource(invalidSource);
  assert.match(plugin.f_resolveLinkTarget(link, invalidSource).reason, /Invalid Git marker.*invalid\/\.git/);
  assert.equal(plugin.f_resolveLinkTarget(link, invalidSource).normalizedPath, undefined);

  activePath = "source.md";
  await plugin.f_refreshRepositoryIndex();
  assert.equal(JSON.parse(savedMap).repositories.find(repo => repo.root === taskRoot).identity, "org/task");
  assert.equal(plugin.f_resolveLinkTarget(link, activePath).target, parentReadme);
  await plugin.f_discoverOpenedSource(sourcePath);
  assert.equal(plugin.f_resolveLinkTarget(link, sourcePath).target, readme);
  const looseSource = "data/source.md";
  assert.match(plugin.f_resolveLinkTarget(link, looseSource).reason, /not been verified/);
  await plugin.f_discoverOpenedSource(looseSource);
  assert.equal(plugin.f_resolveLinkTarget(link, looseSource).target, parentReadme);

  const MobileAtPath = f_loadPlugin();
  const mobile = new MobileAtPath();
  mobile.app = plugin.app;
  mobile._unindexedTargets = new Map();
  mobile.repositories = JSON.parse(savedMap).repositories;
  assert.equal(mobile.f_resolveLinkTarget(link, sourcePath).target, readme);
  assert.match(mobile.f_resolveLinkTarget(link, invalidSource).reason, /unavailable in this device's repository map/);
});

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
  const editorHandlers = new Map();
  plugin.registerDomEvent = (_element, name, handler) => editorHandlers.set(name, handler);
  for (const name of ["register", "registerEditorExtension", "registerEvent",
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

  const opened = [];
  plugin.f_resolveLinkTarget = ({ destination }) => ({ destination, kind: "missing", reason: "Local target is unavailable" });
  plugin.f_resolveLinkTargetAsync = async ref => plugin.f_resolveLinkTarget(ref);
  plugin.f_openRepositoryTarget = async result => { opened.push(result); };
  const f_editorEvent = (type, destination) => {
    const actions = [];
    const link = {
      dataset: { atpathDestination: destination, atpathSource: source.path },
      closest: () => link,
    };
    return {
      type, button: 0, actions, target: link,
      preventDefault: () => actions.push("prevent"),
      stopImmediatePropagation: () => actions.push("stop"),
    };
  };
  for (const type of ["click", "contextmenu"]) {
    const ordinary = f_editorEvent(type, "Note.md");
    editorHandlers.get(type)(ordinary);
    assert.deepEqual(ordinary.actions, [], "unresolved ordinary relative links keep native " + type);
  }
  const canonical = f_editorEvent("click", "/missing.md");
  editorHandlers.get("click")(canonical);
  assert.deepEqual(canonical.actions, ["prevent", "stop"]);
  await Promise.resolve();
  assert.deepEqual(opened, [{ destination: "/missing.md", kind: "missing", reason: "Local target is unavailable" }]);
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
  const absoluteDestination = { destination: "/Users/example/old.md" };
  assert.match(plugin.f_resolveLinkTarget(absoluteDestination, source.path).reason, /migrate|repository-relative/i);
  const validUsersFile = new TFile("checkout/Users/example/old.md");
  files.set(validUsersFile.path, validUsersFile);
  assert.equal(plugin.f_resolveLinkTarget(absoluteDestination, source.path).target, validUsersFile);
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
  assert.equal(text, "[Old](/new.md?raw=1#Heading)\n" + shaLink);
});
