"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { mkdir, mkdtemp, rm, symlink, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const {
  REPOSITORY_MAP_PATH, f_discoverRepositories, f_discoverSourceCheckout, f_lookupRenamedRepository, f_readRepositoryMap, f_writeRepositoryMap,
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

function f_loadPlugin(isMobile = true, obsidianOverrides = {}) {
  const Module = require("node:module");
  const obsidian = require("obsidian");
  const originalLoad = Module._load;
  Module._load = function (id, ...rest) {
    if (id === "obsidian") return {
      ...obsidian, Platform: { isMobile },
      MarkdownRenderChild: class {
        register(callback) { this.cleanup = callback; }
        unload() { this.cleanup(); }
      },
      ...obsidianOverrides,
    };
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

test("open Reading badges and all editor panes react to count changes and settings", async () => {
  const AtPath = f_loadPlugin(false);
  const { f_createTokenIndex } = require("../src/token-index");
  const file = { path: "a/file.md", stat: { size: 4, mtime: 1 }, text: "1234" };
  let reads = 0;
  const index = f_createTokenIndex({
    count: async text => Math.ceil(text.length / 4),
    enabled: false,
    getFiles: () => [file],
    read: async file => { reads++; return file.text; },
    isEligible: () => true,
    looksBinary: () => false,
  });
  const plugin = new AtPath();
  const dispatches = [0, 0];
  const children = [];
  const context = { addChild: child => children.push(child) };
  const fileBadge = {};
  const folderBadge = {};
  plugin.settings = { showTokenCounts: false };
  plugin._tokenIndex = index;
  plugin._linkedCountWatches = new Map();
  plugin._readingTokenRefreshes = new Set();
  plugin.getTokenCount = () => index.request(file);
  plugin.updateStatusBar = () => {};
  plugin.app = { workspace: {
    getLeavesOfType(type) {
      assert.equal(type, "markdown");
      return dispatches.map((_, pane) => ({ view: { editor: { cm: { dispatch: () => dispatches[pane]++ } } } }));
    },
  } };
  try {
    plugin.f_bindReadingTokenBadge(context, fileBadge, { kind: "file", normalizedPath: file.path });
    plugin.f_bindReadingTokenBadge(context, folderBadge, { kind: "folder", normalizedPath: "a" });
    assert.deepEqual([fileBadge.hidden, folderBadge.hidden, reads], [true, true, 0]);

    async function f_waitForBadges(count) {
      const expected = " (" + count + ")";
      const deadline = Date.now() + 1000;
      while ((fileBadge.textContent !== expected || folderBadge.textContent !== expected) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.deepEqual([fileBadge.textContent, folderBadge.textContent], [expected, expected]);
    }
    plugin.settings.showTokenCounts = true;
    plugin.onTokenSettingsChanged();
    await f_waitForBadges(1);
    assert.deepEqual([fileBadge.hidden, folderBadge.hidden, reads], [false, false, 1]);

    file.text = "123456789012";
    file.stat = { size: 12, mtime: 2 };
    index.upsert(file);
    await f_waitForBadges(3);
    assert.equal(reads, 2);

    plugin.settings.showTokenCounts = false;
    plugin.onTokenSettingsChanged();
    assert.deepEqual([fileBadge.hidden, folderBadge.hidden], [true, true]);
    plugin.settings.showTokenCounts = true;
    plugin.onTokenSettingsChanged();
    await f_waitForBadges(3);
    assert.deepEqual([fileBadge.hidden, folderBadge.hidden, reads], [false, false, 2]);
    assert.deepEqual(dispatches, [3, 3]);

    for (const child of children) child.unload();
    assert.equal(plugin._readingTokenRefreshes.size, 0);
  } finally {
    await index.dispose();
  }
});

test("Reading badges recover when the repository map becomes ready and recheck missing targets", async () => {
  const AtPath = f_loadPlugin();
  const plugin = new AtPath();
  const { TFile } = require("obsidian");
  const file = new TFile("a/target.md");
  let exists = true;
  let probes = 0;
  let notify;
  let child;
  const badge = {};
  plugin.settings = { showTokenCounts: true };
  plugin.repositories = [];
  plugin._unindexedTargets = new Map();
  plugin._readingTokenRefreshes = new Set();
  plugin._debouncedUpdateStatusBar = () => {};
  plugin._tokenIndex = {
    subscribe: callback => { notify = callback; return () => { notify = null; }; },
    get: () => ({ counted: 1, tokens: 3 }),
  };
  plugin.app = {
    vault: { getAbstractFileByPath: path => exists && path === file.path ? file : null },
    workspace: { getLeavesOfType: () => [] },
  };
  const resolve = () => plugin.f_resolveLinkTarget({ destination: "/target.md" }, "a/note.md");
  plugin.f_bindReadingTokenBadge({ addChild: value => { child = value; } }, badge, resolve(), {
    resolve,
    probe: async () => { probes++; },
    onTarget: () => {},
  });
  assert.equal(badge.textContent, " (unavailable)");
  plugin.repositories = [{ root: "a", identity: "owner/repo" }];
  plugin.f_repositoryIndexChanged();
  assert.equal(badge.textContent, " (3)");

  exists = false;
  plugin._suggestVaultGen++;
  notify();
  assert.equal(badge.textContent, " (unavailable)");
  await Promise.resolve();
  notify();
  notify();
  assert.equal(probes, 1);

  exists = true;
  plugin._suggestVaultGen++;
  notify();
  assert.equal(badge.textContent, " (3)");
  child.unload();
  assert.equal(notify, null);
});

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
  suggest.close = () => { suggest.context = null; };
  let text = "Before [[space]] after";
  let cursor;
  const editor = {
    getValue: () => text,
    getLine: () => text,
    posToOffset: cursor => cursor.ch,
    replaceRange: (value, from, to) => { text = text.slice(0, from.ch) + value + text.slice(to.ch); },
    transaction: ({ changes, selection }, origin) => {
      assert.equal(suggest.context, null, "the chooser closes before editing");
      assert.equal(origin, "input.autocomplete");
      for (const change of changes) editor.replaceRange(change.text, change.from, change.to);
      cursor = selection.from;
    },
  };
  const context = suggest.onTrigger({ line: 0, ch: 14 }, editor, source);
  assert.equal(context.query, "space");
  suggest.context = { ...context, editor, file: source };
  suggest.selectSuggestion({ target });
  const insertion = "Before [space here.md](/space%20here.md) ";
  assert.equal(text, insertion + " after");
  assert.deepEqual(cursor, { line: 0, ch: insertion.length });
  suggest.selectSuggestion({ target });
  assert.equal(text, insertion + " after", "a second acceptance cannot replay the stale query");
  editor.replaceRange("\n[[repo_b/target", cursor, cursor);
  assert.equal(text, insertion + "\n[[repo_b/target after");

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

test("registered drag and drop uses the destination editor's checkout in an inactive split", async t => {
  const AtPath = f_loadPlugin();
  const plugin = new AtPath();
  const { TFile } = require("obsidian");
  const active = new TFile("checkout-a/active.md");
  const source = new TFile("checkout-b/note.md");
  const target = new TFile("checkout-b/docs/space here.md");
  const files = new Map([active, source, target].map(file => [file.path, file]));
  const changes = [];
  const view = { posAtCoords: () => 4, dispatch: transaction => changes.push(transaction) };
  plugin.app = {
    appId: "test",
    vault: { adapter: {}, on() {}, getAbstractFileByPath: path => files.get(path) },
    workspace: {
      editorSuggest: { suggests: [] },
      getActiveFile: () => active,
      getLeavesOfType: () => [{ view: { file: source, editor: { cm: view } } }],
      onLayoutReady() {},
      on() {},
    },
  };
  plugin.loadSettings = async () => { plugin.settings = {}; };
  plugin.registerEditorSuggest = suggest => plugin.app.workspace.editorSuggest.suggests.push(suggest);
  let handlers;
  plugin.registerEditorExtension = extension => { if (extension.drop) handlers = extension; };
  for (const name of ["register", "registerEvent", "registerDomEvent", "addCommand",
    "addSettingTab", "registerMarkdownPostProcessor"]) plugin[name] = () => {};
  const oldDocument = globalThis.document;
  globalThis.document = {};
  t.after(() => { globalThis.document = oldDocument; });
  await plugin.onload();
  plugin.repositories = [{ root: "checkout-a", identity: "org/a" }, { root: "checkout-b", identity: "org/b" }];

  const f_event = file => ({
    dataTransfer: {
      getData: mime => mime === "application/obsidian-file" ? JSON.stringify({ path: file.path }) : "",
    },
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  });
  const hover = f_event(target);
  assert.equal(handlers.dragover(hover, view), true);
  assert.equal(hover.dataTransfer.dropEffect, "link");
  assert.equal(hover.defaultPrevented, true);

  const drop = f_event(target);
  assert.equal(handlers.drop(drop, view), true);
  assert.equal(drop.propagationStopped, true);
  const expected = "[docs/space here.md](/docs/space%20here.md) ";
  assert.deepEqual(changes, [{
    changes: { from: 4, to: 4, insert: expected },
    selection: { anchor: 4 + expected.length },
    userEvent: "input.drop",
  }]);

  assert.equal(handlers.dragover(f_event(source), view), false);
  assert.equal(handlers.drop(f_event(source), view), false);
  assert.equal(changes.length, 1);
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
    count: async text => Math.ceil(text.length / 4),
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
  plugin._bufferTokenCounts = { update() {} };
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

  // Internal folders count independently and remain selectable alongside
  // an outside ancestor, without leaking into that ancestor's copy expansion.
  const archived = new TFile("checkout/docs/90_archive/old.md");
  const archive = new TFolder("checkout/docs/90_archive", [archived]);
  docs.children.push(archive);
  files.set(archive.path, archive);
  files.set(archived.path, archived);
  plugin._folderCountExclusions = ["90_archive"];
  index.setFolderExclusions(plugin._folderCountExclusions);
  index.upsert(archived);
  await index.request(archived);
  assert.equal(plugin.f_folderTokenCount(docs.path), 6);
  assert.equal(plugin.f_folderTokenCount(archive.path), 3);
  note = "[parent](/docs/)";
  await plugin.copyNoteWithAtPaths();
  assert.doesNotMatch(clipboard, /## docs\/90_archive\/old\.md/);
  for (const markdown of [
    "[parent](/docs/) [archive](/docs/90_archive/) [old](/docs/90_archive/old.md)",
    "[old](/docs/90_archive/old.md) [archive](/docs/90_archive/) [parent](/docs/)",
  ]) {
    note = markdown;
    await plugin.updateStatusBar();
    assert.equal(plugin._lastLinkedTotal, 9);
    await plugin.copyNoteWithAtPaths();
    assert.equal(clipboard.split("## docs/90_archive/old.md").length, 2);
  }
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
  await plugin.f_rewriteRepositoryReferences([{ newPath: target.path, oldPath: "checkout/old.md" }]);
  assert.equal(text, "[Old](/new.md?raw=1#Heading)\n" + shaLink);
});

test("queued renames preserve event order and ignore redundant folder descendants", async () => {
  const plugin = new (f_loadPlugin())();
  const { TFile, TFolder } = require("obsidian");
  plugin.repositories = [{ root: "a", identity: "org/a" }];
  const batches = [];
  plugin.f_rewriteRepositoryReferences = async moves => { batches.push(moves); };
  const first = new TFile("a/tmp.md");
  plugin.f_queueRepositoryMove(first, "a/first.md");
  plugin.f_queueRepositoryMove(new TFile("a/first.md"), "a/second.md");
  first.path = "a/second.md";
  plugin.f_queueRepositoryMove(first, "a/tmp.md");
  plugin.f_queueRepositoryMove(new TFolder("a/new"), "a/old");
  plugin.f_queueRepositoryMove(new TFile("a/new/child.md"), "a/old/child.md");
  await new Promise(resolve => setTimeout(resolve, 150));
  await plugin._repositoryRename;
  assert.deepEqual(batches, [[
    { oldPath: "a/first.md", newPath: "a/tmp.md", isFolder: false },
    { oldPath: "a/second.md", newPath: "a/first.md", isFolder: false },
    { oldPath: "a/tmp.md", newPath: "a/second.md", isFolder: false },
    { oldPath: "a/old", newPath: "a/new", isFolder: true },
  ]]);
});

test("one rename batch reads each note once and retains an edit made before atomic processing", async () => {
  const plugin = new (f_loadPlugin())();
  const { TFile } = require("obsidian");
  const sources = [new TFile("a/note.md"), new TFile("a/concurrent.md")];
  const targets = [new TFile("a/new.md"), new TFile("a/second.md")];
  const files = new Map(targets.map(file => [file.path, file]));
  const contents = new Map(sources.map(file => [file.path, '[First](/old.md) [Second](/other.md)']));
  let reads = 0, resolutions = 0, writes = 0;
  plugin.repositories = [{ root: "a", identity: "org/a" }];
  plugin.app = { vault: {
    getMarkdownFiles: () => sources,
    getAbstractFileByPath: path => { resolutions++; return files.get(path); },
    cachedRead: async file => { reads++; return contents.get(file.path); },
    process: async (file, update) => {
      writes++;
      const suffix = file === sources[1] ? '\nUser edit [Added](/old.md)' : '';
      contents.set(file.path, update(contents.get(file.path) + suffix));
    },
  } };
  await plugin.f_rewriteRepositoryReferences([
    { oldPath: "a/old.md", newPath: "a/new.md" },
    { oldPath: "a/other.md", newPath: "a/second.md" },
  ]);
  assert.equal(reads, 2);
  assert.equal(writes, 2);
  assert.equal(resolutions, 7, "two initial parses plus one reparse only for the concurrently edited note");
  assert.equal(contents.get(sources[0].path), '[First](/new.md) [Second](/second.md)');
  assert.equal(contents.get(sources[1].path), '[First](/new.md) [Second](/second.md)\nUser edit [Added](/new.md)');
});

test("failed notes and unaddressable destinations produce one notice and do not stop other notes", async t => {
  const notices = [];
  const plugin = new (f_loadPlugin(true, { Notice: class { constructor(text) { notices.push(text); } } }))();
  const { TFile } = require("obsidian");
  const sources = [new TFile("a/unreadable.md"), new TFile("a/ambiguous.md"), new TFile("a/success.md")];
  const target = new TFile("b/new.md");
  const local = new TFile("a/new.md");
  const text = '[Moved](/old.md) [Local](/local.md)';
  const results = [];
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  plugin.repositories = [{ root: "a", identity: "org/a" }, { root: "b", identity: "org/b" }, { root: "duplicate", identity: "org/b" }];
  plugin.app = { vault: {
    getMarkdownFiles: () => sources,
    getAbstractFileByPath: path => [target, local].find(file => file.path === path),
    cachedRead: async file => {
      if (file === sources[0]) throw new Error("Cannot read this note");
      return file === sources[1] ? text : '[Local](/local.md)';
    },
    process: async (file, update) => results.push([file.path, update(file === sources[1] ? text : '[Local](/local.md)')]),
  } };
  await plugin.f_rewriteRepositoryReferences([
    { oldPath: "a/old.md", newPath: "b/new.md" },
    { oldPath: "a/local.md", newPath: "a/new.md" },
  ]);
  assert.deepEqual(results, [
    ["a/ambiguous.md", '[Moved](/old.md) [Local](/new.md)'],
    ["a/success.md", '[Local](/new.md)'],
  ]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /2 note\(s\):\na\/unreadable.md\na\/ambiguous.md/);
  assert.equal(warnings.length, 2);
});

test("legacy path and wikilink alias repair share the batch's final paths", () => {
  const plugin = new (f_loadPlugin())();
  plugin.app = { metadataCache: { getFirstLinkpathDest: () => ({ path: "a/second.md" }) } };
  const moves = [
    { oldPath: "a/first.md", newPath: "a/tmp.md" },
    { oldPath: "a/second.md", newPath: "a/first.md" },
    { oldPath: "a/tmp.md", newPath: "a/second.md" },
    { oldPath: "a/old", newPath: "a/new", isFolder: true },
  ];
  // These paths have no legacy repo-root marker, so references are vault-relative.
  assert.equal(plugin.f_rewriteLegacyReferences('@a/first.md @a/second.md @a/old/child.md [[a/second.md|@a/first.md]]', 'note.md', moves),
    '@a/second.md @a/first.md @a/new/child.md [[a/second.md|@a/second.md]]');
});

test("shared discovery contract excludes hidden duplicates and includes only the explicit source checkout", async t => {
  const fixture = require("./fixtures/repository-discovery.json");
  const { f_resolveRepositoryLink } = require("../src/repository-links");
  const base = await mkdtemp(join(process.cwd(), ".repository-discovery-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const checkout of fixture.checkouts) {
    const cwd = join(base, checkout.root);
    await mkdir(cwd, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
    execFileSync("git", ["config", "--local", "remote.origin.url", "https://github.com/" + checkout.identity + ".git"], { cwd });
    await writeFile(join(cwd, "note.md"), "Fixture target");
    if (checkout.gitRefs) {
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Discovery fixture"], { cwd });
      for (const ref of checkout.gitRefs) execFileSync("git", ["update-ref", ref, "HEAD"], { cwd });
      for (const [ref, target] of Object.entries(checkout.symbolicRefs || {})) {
        execFileSync("git", ["symbolic-ref", ref, target], { cwd });
      }
    }
  }
  for (const entry of fixture.symlinks) await symlink(join(base, entry.target), join(base, entry.path), "dir");
  const discovered = await f_discoverRepositories(base);
  for (const entry of fixture.cases) {
    const repositories = [...discovered];
    if (entry.sourceRoot !== undefined && !repositories.some(repo => repo.root === entry.sourceRoot)) {
      repositories.push(await f_discoverSourceCheckout(base, entry.sourcePath));
    }
    assert.deepEqual(repositories.map(repo => repo.root).sort(), entry.expectedRoots, entry.name);
    for (const repo of repositories) {
      const expected = fixture.checkouts.find(checkout => checkout.root === repo.root);
      assert.equal(repo.identity, expected.identity);
      assert.deepEqual(repo.refs, expected.expectedRefs || []);
    }
    const result = f_resolveRepositoryLink({ destination: entry.destination }, {
      sourcePath: entry.sourcePath, repositories,
      getTargetType: path => fixture.checkouts.some(checkout =>
        [checkout.root, "note.md"].filter(Boolean).join("/") === path) ? "file" : null,
    });
    for (const [key, value] of Object.entries(entry.expected)) assert.equal(result[key], value, entry.name + ": " + key);
  }
});

test("later explicit child moves are not mistaken for an earlier folder's descendant events", async () => {
  const plugin = new (f_loadPlugin())();
  const { TFile, TFolder } = require("obsidian");
  plugin.repositories = [{ root: "", identity: "org/workspace" }];
  let batch;
  plugin.f_rewriteRepositoryReferences = async moves => { batch = moves; };
  plugin.f_queueRepositoryMove(new TFolder("b"), "a");
  plugin.f_queueRepositoryMove(new TFile("b/child.md"), "a/child.md");
  plugin.f_queueRepositoryMove(new TFile("a/child.md"), "b/child.md");
  plugin.f_queueRepositoryMove(new TFile("b/child.md"), "a/child.md");
  await new Promise(resolve => setTimeout(resolve, 150));
  await plugin._repositoryRename;
  assert.equal(batch.length, 3);
  assert.deepEqual(batch[2], { oldPath: "a/child.md", newPath: "b/child.md", isFolder: false });
});

test("checkout renames wait for fresh discovery and preserve the map from the first event", async () => {
  const plugin = new (f_loadPlugin())();
  const { TFolder } = require("obsidian");
  const before = [{ root: "", identity: "org/workspace" }, { root: "a", identity: "org/a" }];
  const after = [{ root: "", identity: "org/workspace" }, { root: "renamed", identity: "org/a" }];
  plugin.repositories = before;
  let finishRefresh;
  plugin._repositoryRefresh = new Promise(resolve => { finishRefresh = resolve; });
  const calls = [];
  plugin.f_refreshRepositoryIndex = async () => {
    assert.equal(plugin._repositoryRefresh, null);
    calls.push("fresh scan");
    plugin.repositories = after;
  };
  plugin.f_rewriteRepositoryReferences = async (moves, prior) => {
    assert.deepEqual(prior, before);
    assert.equal(plugin.repositories, after);
    calls.push("rewrite");
  };
  plugin.f_queueRepositoryMove(new TFolder("renamed"), "a");
  // Another discovery can replace the map before the debounce runs.
  plugin.repositories = after;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(calls, []);
  plugin._repositoryRefresh = null;
  finishRefresh();
  await plugin._repositoryRename;
  assert.deepEqual(calls, ["fresh scan", "rewrite"]);
});

test("failed checkout discovery leaves note text untouched and reports the unverified move", async t => {
  const notices = [];
  const plugin = new (f_loadPlugin(true, { Notice: class { constructor(text) { notices.push(text); } } }))();
  const { TFolder } = require("obsidian");
  plugin.repositories = [{ root: "", identity: "org/workspace" }, { root: "a", identity: "org/a" }];
  plugin.f_refreshRepositoryIndex = async () => {}; // Production retains its prior map on failure.
  let rewrites = 0;
  plugin.f_rewriteRepositoryReferences = async () => { rewrites++; };
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  plugin.f_queueRepositoryMove(new TFolder("renamed"), "a");
  await new Promise(resolve => setTimeout(resolve, 150));
  await plugin._repositoryRename;
  assert.equal(rewrites, 0);
  assert.equal(notices.length, 1);
  assert.match(warnings[0][1].message, /Renamed checkout could not be verified: renamed/);
});
