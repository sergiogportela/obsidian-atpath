// obsidian-atpath — Author repository Markdown links and navigate local files.
// Uses Obsidian API + CodeMirror 6.

const { Plugin, EditorSuggest, MarkdownRenderChild, MarkdownView, TFile, TFolder, Menu, PluginSettingTab, Setting, Notice, Modal, Platform, setIcon, prepareFuzzySearch, renderResults, requestUrl } = require("obsidian");
const { ViewPlugin, Decoration, MatchDecorator, EditorView, WidgetType } = require("@codemirror/view");
const { Compartment, Prec } = require("@codemirror/state");
const { f_createTokenIndex } = require("./token-index");
const { TOKEN_COUNT_DISCLOSURE } = require("./token-contract");
const { f_createTokenCounter } = require("./token-counter");
const { f_createBufferTokenCounts } = require("./buffer-token-counts");
const { DEFAULT_FOLDER_COUNT_EXCLUSIONS, f_parseFolderCountExclusions, f_isFolderCountBoundary, f_folderCountIncludes } = require("./folder-count-policy");
const { f_installExplorerTokenBadges } = require("./explorer-token-badges");
const { f_loadTokenCache, f_saveTokenCache } = require("./token-cache-storage");
const { f_isEligibleLinkedPath } = require("./linked-file-policy");

const { f_scanMarkdownLinks, f_repositoryForPath, f_resolveRepositoryLink, f_formatRepositoryLink, f_rewriteRepositoryDestinations } = require("./repository-links");
const { f_installNativeRepositoryLinks } = require("./native-repository-links");
const {
  REPOSITORY_MAP_PATH, f_discoverRepositories, f_discoverSourceCheckout, f_isPrunedSourcePath,
  f_lookupRenamedRepository,
  f_readRepositoryMap, f_writeRepositoryMap,
} = require("./repository-index");

// ─── ATPATH_PERF — opt-in perf instrumentation, no-op unless enabled ──
// Enable in devtools console: localStorage.setItem("atpath-perf", "1")
// Then reload Obsidian, reproduce, and run: window.__atpath_perf_dump()
const ATPATH_PERF = (() => {
  let enabled = false;
  try {
    enabled = (typeof window !== "undefined") && !!window.localStorage &&
              window.localStorage.getItem("atpath-perf") === "1";
  } catch (_) { /* localStorage may throw in some sandboxes */ }
  const counts = new Map();
  const times = new Map();
  const bump = (label, dt) => {
    counts.set(label, (counts.get(label) || 0) + 1);
    if (dt != null) times.set(label, (times.get(label) || 0) + dt);
  };
  const api = {
    enabled,
    inc(label) { if (enabled) bump(label, null); },
    record(label, dt) { if (enabled) bump(label, dt); },
    time(label, fn) {
      if (!enabled) return fn();
      const t0 = performance.now();
      try { return fn(); }
      finally { bump(label, performance.now() - t0); }
    },
    async timeAsync(label, fn) {
      if (!enabled) return fn();
      const t0 = performance.now();
      try { return await fn(); }
      finally { bump(label, performance.now() - t0); }
    },
    dump() {
      const rows = [];
      for (const [k, n] of counts) {
        const ms = times.get(k);
        rows.push({
          label: k,
          count: n,
          totalMs: ms != null ? Number(ms.toFixed(1)) : null,
          avgMs: ms != null && n > 0 ? Number((ms / n).toFixed(2)) : null,
        });
      }
      rows.sort((a, b) => (b.totalMs || 0) - (a.totalMs || 0));
      // eslint-disable-next-line no-console
      console.warn("[atpath-perf] dump (sorted by totalMs)", rows);
      counts.clear();
      times.clear();
      return rows;
    },
  };
  if (enabled && typeof window !== "undefined") {
    try {
      window.__atpath_perf = api;
      window.__atpath_perf_dump = () => api.dump();
      // eslint-disable-next-line no-console
      console.warn("[atpath-perf] enabled. Call window.__atpath_perf_dump() to print + reset.");
    } catch (_) { /* ignore */ }
  }
  return api;
})();

// ─── AtPathWidget — renders @path as a single span immune to emphasis splitting

class AtPathWidget extends WidgetType {
  constructor(fullMatch, path, tokenCount) {
    super();
    this.fullMatch = fullMatch;
    this.path = path;
    this.tokenCount = tokenCount;
  }
  eq(other) {
    return this.fullMatch === other.fullMatch && this.tokenCount === other.tokenCount;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "atpath-link";
    span.textContent = this.fullMatch;
    span.dataset.atpath = this.path;
    if (this.tokenCount) span.dataset.tokens = this.tokenCount;
    return span;
  }
  ignoreEvent(event) { return event.type !== "mousedown"; }
}

class WikilinkAtPathWidget extends WidgetType {
  constructor(displayPath, vaultPath, tokenCount) {
    super();
    this.displayPath = displayPath;
    this.vaultPath = vaultPath;
    this.tokenCount = tokenCount;
  }
  eq(other) {
    return this.displayPath === other.displayPath
      && this.vaultPath === other.vaultPath
      && this.tokenCount === other.tokenCount;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "atpath-link";
    span.textContent = "@" + this.displayPath;
    span.dataset.atpath = this.vaultPath;
    if (this.tokenCount) span.dataset.tokens = this.tokenCount;
    return span;
  }
  ignoreEvent(event) { return event.type !== "mousedown"; }
}

class AtFolderWidget extends WidgetType {
  constructor(fullMatch, relPath, tokenCount) {
    super();
    this.fullMatch = fullMatch;
    this.relPath = relPath;
    this.tokenCount = tokenCount;
  }
  eq(other) {
    return this.fullMatch === other.fullMatch && this.tokenCount === other.tokenCount;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "atpath-link atpath-folder-link";
    span.textContent = this.fullMatch;
    span.dataset.atpath = this.relPath;
    span.dataset.atpathKind = "folder";
    if (this.tokenCount) span.dataset.tokens = this.tokenCount;
    return span;
  }
  ignoreEvent(event) { return event.type !== "mousedown"; }
}

// ─── Token counting helpers ──────────────────────────────────────────

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "ico", "webp", "avif",
  "heic", "heif", "tiff", "tif",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "zip", "gz", "tar", "rar", "7z", "bz2",
  "mp3", "wav", "ogg", "flac", "aac", "m4a",
  "mp4", "avi", "mkv", "mov", "webm", "wmv",
  "woff", "woff2", "ttf", "otf", "eot",
  "exe", "dll", "so", "dylib", "bin",
  "sqlite", "db",
]);

function makeFence(content) {
  let max = 2;
  const runs = content.match(/`{3,}/g);
  if (runs) for (const r of runs) { if (r.length > max) max = r.length; }
  return "`".repeat(max + 1);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (_) { /* fall through to fallback */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.className = "atpath-clipboard-fallback";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

function formatTokens(n) {
  if (n == null) return "…";
  if (Number.isNaN(n)) return "!";
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

// Unified renderer for a linked-target row's count cell. Handles the
// pending placeholder, the over-cap sentinel, and the normal numeric
// case in one place so every consumer agrees.
function formatLinkedTargetCount(t) {
  if (!t) return "0";
  if (t.kind === "missing") return "Unavailable";
  if (t.failed && !t.tokens && !t.pending) return "!";
  if (t.pending) return (t.tokens ? formatTokens(t.tokens) + "+" : "…") + (t.skipped ? " *" : "") + (t.failed ? " !" : "");
  if (t.overCap) return "> " + t.overCap.limit + " files";
  return formatTokens(t.tokens || 0) + (t.skipped ? " *" : "") + (t.failed ? " !" : "");
}

function f_formatFolderTokenCount(value) {
  return value?.overCap ? formatLinkedTargetCount({ overCap: value }) :
    formatLinkedTargetCount({ tokens: value?.tokens ?? value, pending: value?.partial, skipped: value?.skipped, failed: value?.failed });
}

function f_uniqueLinkedTokenTotal(targets, rules = []) {
  const folders = targets.filter(target => target.kind === "folder" && !target.overCap);
  return targets.reduce((total, target) => {
    if (!target.localOnly && folders.some(folder => folder !== target && f_folderCountIncludes(folder.path, target.path, rules, target.kind === "folder"))) return total;
    return total + (target.tokens || 0);
  }, 0);
}

const { buildMainPage, buildAtPathPage, buildUnpublishedPage, slugifyPath } = require("./html-builder");
const { deployToVercel, ensureProject, checkProjectAvailability, slugify } = require("./vercel-api");
const { buildAuthShell } = require("./auth-shell-builder");
const { buildAuthFunction, buildApproveFunction } = require("./auth-function-template");
const { applySiteIconToDeployFiles, injectSiteIconIntoHtml } = require("./site-icon");
const {
  createAtPathCore,
  getRepoRoot: coreGetRepoRoot,
  toRepoRelative: coreToRepoRelative,
  discoverRepoRoots: coreDiscoverRepoRoots,
  resolveAtPathFromSource: coreResolveAtPathFromSource,
  resolveAtPathFolderFromSource: coreResolveAtPathFolderFromSource,
  computeDisplayPath: coreComputeDisplayPath,
  isSubsequenceCI,
  extractDraggedVaultPaths: coreExtractDraggedVaultPaths,
  looksBinary,
} = require("./atpath-core");
const {
  HTML_APP_SCOPE_SINGLE_FILE,
  HTML_APP_SCOPE_FOLDER,
  isHtmlExtension,
  buildHtmlAppDefaults,
  buildHtmlAppDeployFiles,
  partitionHtmlAppDeployFiles,
  getPublishedHtmlAppState,
  setPublishedHtmlAppState,
  renamePublishedHtmlAppState,
  collectDirectoryFiles,
} = require("./html-app-publish");

const DEFAULT_SETTINGS = {
  showTokenCounts: true,
  maxFileSizeMB: 5,
  maxFolderFiles: 500,
  folderCountExclusions: DEFAULT_FOLDER_COUNT_EXCLUSIONS,
  statusBarShowSelection: true,
  suggestFolders: true,
  enableDragDropAtPath: true,
  vercelToken: "",
  contactUrl: "",
  contactLabel: "Entre em contato",
  clerkPublishableKey: "",
  clerkSecretKey: "",
  publisherEmail: "",
  siteIconDataUrl: "",
  siteIconFileName: "",
  publishedPages: {},
  publishedHtmlApps: {},
};

function getPublishState(plugin, publishData) {
  if (publishData.publishKind === "html-app") {
    return getPublishedHtmlAppState(plugin.settings, publishData.sourcePath);
  }
  return plugin.settings.publishedPages[publishData.notePath];
}

function setPublishState(plugin, publishData, nextState) {
  if (publishData.publishKind === "html-app") {
    return setPublishedHtmlAppState(plugin.settings, publishData.sourcePath, nextState);
  }
  plugin.settings.publishedPages[publishData.notePath] = nextState;
  return nextState;
}

const SITE_ICON_MAX_BYTES = 1024 * 1024;
const SITE_ICON_ACCEPT = ".png,.jpg,.jpeg,.svg,.ico,.webp,.gif,image/*";

function describeSiteIcon(settings) {
  if (settings.siteIconFileName) {
    return "Saved globally as " + settings.siteIconFileName + ".";
  }
  if (settings.siteIconDataUrl) {
    return "Saved globally for future publishes.";
  }
  return "No image saved yet.";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

async function saveSiteIconFile(plugin, file) {
  if (!file) throw new Error("Choose an image file first.");
  if (file.size > SITE_ICON_MAX_BYTES) {
    throw new Error("Site icon must be 1 MB or smaller.");
  }

  const type = String(file.type || "");
  const fileName = String(file.name || "").toLowerCase();
  const looksLikeImage = type.startsWith("image/")
    || /\.(png|jpe?g|svg|ico|webp|gif)$/i.test(fileName);
  if (!looksLikeImage) {
    throw new Error("Choose a PNG, JPG, SVG, ICO, WebP, or GIF image.");
  }

  const dataUrl = await readFileAsDataUrl(file);
  if (!/^data:image\//i.test(dataUrl)) {
    throw new Error("The selected file could not be stored as an image.");
  }

  plugin.settings.siteIconDataUrl = dataUrl;
  plugin.settings.siteIconFileName = file.name || "";
  await plugin.saveSettings();
}

function clearSiteIcon(plugin) {
  plugin.settings.siteIconDataUrl = "";
  plugin.settings.siteIconFileName = "";
  return plugin.saveSettings();
}

function addSiteIconPicker(setting, plugin, baseDescription, opts = {}) {
  const allowClear = opts.allowClear !== false;
  const chooseSavedLabel = opts.chooseSavedLabel || "Replace image";
  const chooseEmptyLabel = opts.chooseEmptyLabel || "Choose image";
  const notices = opts.notices !== false;
  let pending = Promise.resolve();
  let chooseBtn = null;
  let clearBtn = null;

  const inputEl = setting.controlEl.createEl("input", {
    attr: {
      type: "file",
      accept: SITE_ICON_ACCEPT,
    },
  });
  inputEl.addClass("atpath-hidden");

  const refresh = () => {
    setting.setDesc(baseDescription + " " + describeSiteIcon(plugin.settings));
    if (chooseBtn) {
      chooseBtn.setButtonText(plugin.settings.siteIconDataUrl ? chooseSavedLabel : chooseEmptyLabel);
    }
    if (clearBtn) {
      clearBtn.setDisabled(!plugin.settings.siteIconDataUrl);
    }
  };

  inputEl.addEventListener("change", () => {
    const file = inputEl.files && inputEl.files[0];
    if (!file) return;

    pending = (async () => {
      try {
        await saveSiteIconFile(plugin, file);
        refresh();
        if (notices) new Notice("Site icon saved for future publishes.");
      } catch (error) {
        new Notice(error.message || String(error));
      } finally {
        inputEl.value = "";
      }
    })();
    void pending;
  });

  setting.addButton((btn) => {
    chooseBtn = btn;
    btn.onClick(() => inputEl.click());
  });

  if (allowClear) {
    setting.addButton((btn) => {
      clearBtn = btn;
      btn.setButtonText("Clear").onClick(() => {
        void (async () => {
          try {
            await clearSiteIcon(plugin);
            refresh();
            if (notices) new Notice("Site icon cleared.");
          } catch (error) {
            new Notice(error.message || String(error));
          }
        })();
      });
    });
  }

  refresh();

  return {
    waitForPending: async () => {
      await pending;
    },
  };
}

// ─── Helpers: open externally & context menu ─────────────────────────

function openInDefaultApp(plugin, vaultPath) {
  const adapter = plugin.app.vault.adapter;
  if (!adapter || typeof adapter.getBasePath !== "function") {
    new Notice("Opening in the default app is only available on desktop.");
    return;
  }
  const basePath = adapter.getBasePath();
  const absolutePath = require("path").join(basePath, vaultPath);
  require("electron").shell.openPath(absolutePath);
}

function showAtPathMenu(plugin, event, vaultPath, result) {
  result ??= { kind: "file", normalizedPath: vaultPath, target: plugin.app.vault.getAbstractFileByPath(vaultPath) };
  if (!result.target) return;
  const menu = new Menu();
  if (!result.target.localOnly) {
    for (const [title, icon, pane] of [
      ["Open link", "file", false],
      ["Open in new tab", "file-plus", "tab"],
      ["Open to the right", "separator-vertical", "split"],
      ...(!Platform.isMobile ? [["Open in new window", "picture-in-picture-2", "window"]] : []),
    ]) {
      menu.addItem(item => item.setTitle(title).setIcon(icon).onClick(() =>
        plugin.f_openRepositoryTarget(result, pane)
          .catch(error => new Notice("Could not open link: " + error.message))));
    }
    menu.addSeparator();
    menu.addItem(item => item.setTitle("Reveal in file explorer").setIcon("folder-search")
      .onClick(() => f_revealInFileExplorer(plugin.app, result.target)));
  }
  menu.addItem(item => item.setTitle("Copy path").setIcon("copy")
    .onClick(() => copyToClipboard(vaultPath).catch(error => new Notice("Could not copy path: " + error.message))));
  if (!Platform.isMobile) {
    menu.addItem(item => item.setTitle("Open in default app").setIcon("arrow-up-right")
      .onClick(() => openInDefaultApp(plugin, vaultPath)));
  }
  menu.showAtMouseEvent(event);
}

function f_revealInFileExplorer(app, folder) {
  const leaves = app.workspace.getLeavesOfType("file-explorer");
  let revealed = false;
  for (const leaf of leaves) {
    const view = leaf.view;
    try {
      if (typeof view?.revealInFolder === "function") {
        view.revealInFolder(folder);
        revealed = true;
      }
    } catch (err) {
      console.warn("[atpath] revealInFolder failed", err);
    }
  }
  if (!revealed) new Notice("Could not reveal target in file explorer: " + folder.path);
}

function showAtPathFolderMenu(plugin, event, folder) {
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle("Reveal in file explorer")
      .setIcon("folder")
      .onClick(() => f_revealInFileExplorer(plugin.app, folder))
  );
  if (!Platform.isMobile) {
    menu.addItem((item) =>
      item
        .setTitle("Open folder in default app")
        .setIcon("arrow-up-right")
        .onClick(() => openInDefaultApp(plugin, folder.path))
    );
  }
  menu.showAtMouseEvent(event);
}

async function openFileByViewState(plugin, resolved) {
  const ext = resolved.extension;
  const viewType = typeof plugin.app.viewRegistry.getTypeByExtension === 'function'
    ? plugin.app.viewRegistry.getTypeByExtension(ext)
    : plugin.app.viewRegistry.typeByExtension[ext];
  const leaf = plugin.app.workspace.getLeaf(false);
  await leaf.setViewState({
    type: viewType || "markdown",
    active: true,
    state: { file: resolved.path },
  });
}

// ─── A) Repo root detection ──────────────────────────────────────────
// Pure helpers live in src/atpath-core.js so Plan A (editor) and Plan B
// (file explorer) share one implementation. Local aliases below preserve
// the unqualified names used throughout this file.

const getRepoRoot = coreGetRepoRoot;
const toRepoRelative = coreToRepoRelative;
const discoverRepoRoots = coreDiscoverRepoRoots;
const resolveAtPathFromSource = coreResolveAtPathFromSource;
const resolveAtPathFolderFromSource = coreResolveAtPathFolderFromSource;

function resolveAtPath(relPath, plugin) {
  const activeFile = plugin.app.workspace.getActiveFile();
  if (!activeFile) return relPath;
  return resolveAtPathFromSource(relPath, activeFile.path, plugin);
}

// ─── B) EditorSuggest — Autocomplete ─────────────────────────────────

class AtPathSuggest extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor, file) {
    if (!file || !f_repositoryForPath(file.path, this.plugin.repositories)) return null;
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const start = before.lastIndexOf("[[");
    if (start < 0) return null;
    const query = before.slice(start + 2);
    if (/[\[\]#^|]/.test(query)
      || before[start - 1] === "!" || /(^|[^\\])(?:\\\\)*\\$/.test(before.slice(0, start))) return null;
    if (isInExcludedRange(editor.posToOffset(cursor), buildExcludedRanges(editor.getValue()))) return null;
    return { start: { line: cursor.line, ch: start }, end: cursor, query };
  }

  getSuggestions(context) {
    // Debounce. At large vault sizes a single scan can cost 100–250ms; running
    // it on every intermediate keystroke of a fast burst is the autocomplete
    // lag the user feels. EditorSuggest accepts a Promise, so we coalesce a
    // typing burst into one compute that fires ~100ms after the user pauses.
    // Superseded calls are left unresolved (Obsidian uses only the latest),
    // which avoids the empty-list flicker that resolving them early causes.
    if (this._suggestDebounceTimer) clearTimeout(this._suggestDebounceTimer);
    return new Promise((resolve) => {
      this._suggestDebounceTimer = setTimeout(() => {
        this._suggestDebounceTimer = null;
        resolve(this._computeSuggestions(context));
      }, 100);
    });
  }

  _computeSuggestions(context) {
    const file = context.file;
    if (!file) return [];
    const sourcePath = file.path;
    const query = context.query || "";
    const showFolders = this.plugin.settings.suggestFolders !== false;
    const core = this.plugin.core;

    const sourceRepo = f_repositoryForPath(sourcePath, this.plugin.repositories);
    const tierOf = path => f_repositoryForPath(path, this.plugin.repositories) === sourceRepo ? 0 : 1;

    // ── Incremental candidate narrowing (autocomplete hot path) ────────
    // Building a display string + running Obsidian's fuzzy scorer for every
    // vault file on every keystroke costs ~300ms at ~59k files. Two
    // optimizations keep this cheap:
    //   1. A cheap `isSubsequenceCI` prefilter so the expensive fuzzy
    //      scorer only ever runs on strings that can actually match.
    //   2. Reuse the previous keystroke's surviving candidates when the
    //      query only grew. Fuzzy matching is monotonic — a longer query's
    //      matches are always a subset of the shorter query's matches — so
    //      we narrow the prior survivor set instead of rescanning the vault.
    // `_suggestVaultGen` (bumped on create/delete/rename) invalidates the
    // cache when the file set or any path changes.
    const vaultGen = this.plugin._suggestVaultGen || 0;
    const cache = this._suggestCache;
    let base;
    if (
      cache &&
      cache.sourcePath === sourcePath &&
      cache.showFolders === showFolders &&
      cache.vaultGen === vaultGen &&
      query.startsWith(cache.query)
    ) {
      base = cache.items;
    } else {
      base = this._buildSuggestCandidates(sourcePath, showFolders, tierOf);
    }

    const survivors = query
      ? base.filter((c) => isSubsequenceCI(query, c.display))
      : base;
    this._suggestCache = { sourcePath, showFolders, vaultGen, query, items: survivors };

    const fuzzy = query ? prepareFuzzySearch(query) : null;
    const tiers = [[], [], []];
    for (const c of survivors) {
      let fuzzyResult = null;
      let score = c.kind === "folder" ? 1.3 : 1;
      if (fuzzy) {
        fuzzyResult = fuzzy(c.display);
        if (!fuzzyResult) continue;
        // Folder bias so they're not buried below same-score files.
        score = c.kind === "folder" ? fuzzyResult.score * 1.3 : fuzzyResult.score;
      }
      tiers[c.tier].push({
        kind: c.kind, target: c.target, display: c.display, fuzzyResult, score,
      });
    }

    if (fuzzy) {
      for (const t of tiers) t.sort((a, b) => b.score - a.score);
    } else {
      // Empty query: folders first within each tier, then alphabetical.
      for (const t of tiers) {
        t.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
          return a.display.localeCompare(b.display);
        });
      }
    }

    return [...tiers[0], ...tiers[1], ...tiers[2]].slice(0, 50);
  }

  // Build the full {kind, target, display, tier} candidate list for a source
  // file: every vault file plus (optionally) every folder, display strings
  // precomputed once. Feeds the narrowing cache in getSuggestions so the
  // per-keystroke work is just subsequence filtering + scoring the survivors.
  _buildSuggestCandidates(sourcePath, showFolders, tierOf) {
    const core = this.plugin.core;
    const out = [];
    for (const f of this.app.vault.getFiles()) {
      out.push({
        kind: "file",
        target: f,
        display: this.plugin.f_displayLinkedPath(f.path, sourcePath),
        tier: tierOf(f.path),
      });
    }
    if (showFolders) {
      for (const folder of core.listAllFolders()) {
        out.push({
          kind: "folder",
          target: folder,
          display: this.plugin.f_displayLinkedPath(folder.path, sourcePath) + "/",
          tier: tierOf(folder.path),
        });
      }
    }
    return out;
  }

  renderSuggestion(value, el) {
    const row = el.createDiv({ cls: "atpath-suggest-row" });
    if (value.kind === "folder") {
      const iconEl = row.createSpan({ cls: "atpath-suggest-icon" });
      setIcon(iconEl, "folder");
    }
    const titleEl = row.createDiv({ cls: "atpath-suggest-title" });
    if (value.fuzzyResult) {
      renderResults(titleEl, value.display, value.fuzzyResult);
    } else {
      titleEl.setText(value.display);
    }
  }

  selectSuggestion(value) {
    const context = this.context;
    this.close();
    if (!context) return;
    const { editor, start, end, file } = context;
    try {
      const insertion = this.plugin.f_formatLinkedTarget(value.target, file.path);
      const tail = editor.getLine(end.line).slice(end.ch);
      const replaceEnd = tail.startsWith("]]") ? { ...end, ch: end.ch + 2 } : end;
      const text = insertion + " ";
      editor.transaction({
        changes: [{ from: start, to: replaceEnd, text }],
        selection: { from: { line: start.line, ch: start.ch + text.length } },
      }, "input.autocomplete");
    } catch (error) {
      new Notice(error.message);
    }
  }
}

function f_prioritizeRepositorySuggest(plugin, suggest) {
  const suggests = plugin.app.workspace.editorSuggest?.suggests;
  if (!Array.isArray(suggests)) return false;
  const index = suggests.indexOf(suggest);
  if (index < 0) return false;
  suggests.splice(index, 1);
  suggests.unshift(suggest);
  return true; // Obsidian's registered cleanup removes this same instance.
}

// ─── C) CM6 ViewPlugin — Clickable links in Live Preview ─────────────

const AT_PATH_RE = /(?<=^|[\s(])@([\w\p{L}\p{M}./_-]+\.[\w]+|[\w\p{L}\p{M}./_-][\w\p{L}\p{M}./ _()&-]+?\.[\w]+)/gu;

// Folder ref regex — uses a capture-group boundary instead of a second
// lookbehind to keep iOS Safari happy. Group 1 = leading boundary char,
// group 2 = folder path (no trailing slash). The trailing slash is
// matched literally and bounded by a positive lookahead.
const AT_PATH_FOLDER_RE = /(^|[\s(])@([\w\p{L}\p{M}._-][\w\p{L}\p{M}./ _()&-]*?)\/(?=$|[\s)>,;:!?])/gu;

// ─── Wikilink @path regex ─────────────────────────────────────────────
const WIKILINK_ATPATH_RE = /\[\[([^\]|]+)\|@([^\]]+)\]\]/g;

// ─── Excluded ranges — code blocks, inline code, YAML frontmatter ────
function buildExcludedRanges(content) {
  const ranges = [];
  // YAML frontmatter
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx !== -1) ranges.push([0, endIdx + 4]);
  }
  // Fenced code blocks (``` or ~~~)
  const fenceRe = /^(`{3,}|~{3,}).*$/gm;
  let fence;
  let openFence = null;
  while ((fence = fenceRe.exec(content)) !== null) {
    if (!openFence) {
      openFence = { start: fence.index, marker: fence[1][0], len: fence[1].length };
    } else if (fence[1][0] === openFence.marker && fence[1].length >= openFence.len) {
      ranges.push([openFence.start, fence.index + fence[0].length]);
      openFence = null;
    }
  }
  if (openFence) ranges.push([openFence.start, content.length]);
  // Inline code (backtick runs)
  const inlineRe = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
  let inl;
  while ((inl = inlineRe.exec(content)) !== null) {
    ranges.push([inl.index, inl.index + inl[0].length]);
  }
  return ranges;
}

function isInExcludedRange(pos, ranges) {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) return true;
    if (start > pos) break;
  }
  return false;
}

// ─── Unified scanner — finds both wikilink and legacy @path refs ──────
function scanAtPathRefs(content, app, sourcePath) {
  const results = [];
  const excluded = buildExcludedRanges(content);

  // Pass 1: wikilink format (file refs only — wikilinks always resolve to files)
  const wlRe = new RegExp(WIKILINK_ATPATH_RE.source, WIKILINK_ATPATH_RE.flags);
  let m;
  while ((m = wlRe.exec(content)) !== null) {
    if (isInExcludedRange(m.index, excluded)) continue;
    let vaultPath = m[1];
    if (app) {
      const resolved = app.metadataCache.getFirstLinkpathDest(vaultPath, sourcePath || "");
      if (resolved) vaultPath = resolved.path;
    }
    results.push({
      kind: "file",
      vaultPath,
      displayPath: m[2],
      format: "wikilink",
      fullMatch: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // Pass 2: folder refs (legacy @path/ form). Runs before the legacy file
  // pass so the greedy file regex can't claim a token that's part of an
  // @path/ folder ref (e.g. `@foo.md/` would otherwise match as @foo.md).
  const folderRe = new RegExp(AT_PATH_FOLDER_RE.source, AT_PATH_FOLDER_RE.flags);
  while ((m = folderRe.exec(content)) !== null) {
    const lead = m[1] || "";
    const relPath = m[2];
    const start = m.index + lead.length;
    const end = m.index + m[0].length;
    if (isInExcludedRange(start, excluded)) continue;
    const overlaps = results.some(r => start < r.end && end > r.start);
    if (overlaps) continue;
    results.push({
      kind: "folder",
      vaultPath: relPath,
      displayPath: relPath + "/",
      format: "legacy",
      fullMatch: "@" + relPath + "/",
      start,
      end,
    });
  }

  // Pass 3: legacy file format — skip matches that overlap wikilink or
  // folder hits, and (defense-in-depth) reject matches whose end is
  // immediately followed by `/` (would belong to a folder ref).
  const legacyRe = new RegExp(AT_PATH_RE.source, AT_PATH_RE.flags);
  while ((m = legacyRe.exec(content)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (isInExcludedRange(start, excluded)) continue;
    if (content.charAt(end) === "/") continue;
    const overlaps = results.some(r => start < r.end && end > r.start);
    if (overlaps) continue;
    results.push({
      kind: "file",
      vaultPath: null, // caller resolves via resolveAtPathFromSource
      displayPath: m[1],
      format: "legacy",
      fullMatch: m[0],
      start,
      end,
    });
  }

  // Sort by position
  results.sort((a, b) => a.start - b.start);
  return results;
}

function buildAtPathViewPlugin(plugin) {
  function buildDecorations(view) {
    const builder = [];
    const selRanges = view.state.selection.ranges;
    const selectionOverlaps = (from, to) =>
      selRanges.some((r) => r.from >= from && r.to <= to);

    for (const { from, to } of view.visibleRanges) {
      const text = view.state.sliceDoc(from, to);
      const folderRanges = []; // [absoluteStart, absoluteEnd] pairs in this slice

      // Pass 1: folder refs
      const fre = new RegExp(AT_PATH_FOLDER_RE.source, AT_PATH_FOLDER_RE.flags);
      let m;
      while ((m = fre.exec(text)) !== null) {
        const lead = m[1] || "";
        const relPath = m[2];
        const absStart = from + m.index + lead.length;
        const absEnd = from + m.index + m[0].length;
        folderRanges.push([absStart, absEnd]);
        const fullMatch = "@" + relPath + "/";

        let tokenStr = null;
        if (plugin.settings.showTokenCounts) {
          const sourcePath = plugin.app.workspace.getActiveFile()?.path || "";
          const resolved = plugin.core.resolveAtPathTarget(
            { kind: "folder", vaultPath: relPath },
            sourcePath
          );
          if (resolved.kind === "folder") {
            tokenStr = f_formatFolderTokenCount(plugin.f_folderTokenCount(resolved.normalizedPath));
          }
        }

        if (selectionOverlaps(absStart, absEnd)) {
          const attrs = { "data-atpath": relPath, "data-atpath-kind": "folder" };
          if (tokenStr) attrs["data-tokens"] = tokenStr;
          builder.push({
            from: absStart,
            to: absEnd,
            deco: Decoration.mark({ class: "atpath-link atpath-folder-link", attributes: attrs }),
          });
        } else {
          builder.push({
            from: absStart,
            to: absEnd,
            deco: Decoration.replace({
              widget: new AtFolderWidget(fullMatch, relPath, tokenStr),
            }),
          });
        }
      }

      function overlapsFolder(absStart, absEnd) {
        for (const [fs, fe] of folderRanges) {
          if (absStart < fe && absEnd > fs) return true;
        }
        return false;
      }

      // Pass 2: file refs (skip overlaps + matches immediately followed by "/")
      const fileRe = new RegExp(AT_PATH_RE.source, AT_PATH_RE.flags);
      while ((m = fileRe.exec(text)) !== null) {
        const absStart = from + m.index;
        const absEnd = from + m.index + m[0].length;
        if (overlapsFolder(absStart, absEnd)) continue;
        if (absEnd < to && text[m.index + m[0].length] === "/") continue;
        const relPath = m[1];

        const attrs = { "data-atpath": relPath };
        let tokenStr = null;
        if (plugin.settings.showTokenCounts) {
          const vaultPath = resolveAtPath(relPath, plugin);
          const cached = plugin.tokenCache.get(vaultPath);
          if (cached) tokenStr = formatTokens(cached.tokens);
          else if (plugin._tokenIndex.get(vaultPath)?.failed) tokenStr = "!";
          else plugin.scheduleTokenFetch(vaultPath, view);
        }

        if (selectionOverlaps(absStart, absEnd)) {
          if (tokenStr) attrs["data-tokens"] = tokenStr;
          builder.push({
            from: absStart,
            to: absEnd,
            deco: Decoration.mark({ class: "atpath-link", attributes: attrs }),
          });
        } else {
          builder.push({
            from: absStart,
            to: absEnd,
            deco: Decoration.replace({
              widget: new AtPathWidget(m[0], relPath, tokenStr),
            }),
          });
        }
      }
    }

    builder.sort((a, b) => a.from - b.from || a.to - b.to);
    return Decoration.set(builder.map((b) => b.deco.range(b.from, b.to)));
  }

  return ViewPlugin.define(
    (view) => ({
      decorations: ATPATH_PERF.time("vp.atpath.buildDecorations.init", () => buildDecorations(view)),
      update(update) {
        ATPATH_PERF.inc("vp.atpath.update.calls");
        const triggers = [];
        if (update.docChanged) triggers.push("doc");
        if (update.viewportChanged) triggers.push("vp");
        if (update.selectionSet) triggers.push("sel");
        if (plugin.tokenCacheDirty) triggers.push("dirty");
        if (triggers.length > 0) {
          for (const t of triggers) ATPATH_PERF.inc("vp.atpath.update.trigger." + t);
          ATPATH_PERF.inc("vp.atpath.rebuild");
          this.decorations = ATPATH_PERF.time("vp.atpath.buildDecorations", () => buildDecorations(update.view));
          plugin.tokenCacheDirty = false;
        }
      },
    }),
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const target = event.target;
          if (!target.classList.contains("atpath-link")) return false;
          const relPath = target.dataset.atpath;
          if (!relPath) return false;

          event.preventDefault();
          const activeFile = plugin.app.workspace.getActiveFile();
          if (!activeFile) return false;
          const sourcePath = activeFile.path;

          if (target.dataset.atpathKind === "folder") {
            const resolved = plugin.core.resolveAtPathTarget(
              { kind: "folder", vaultPath: relPath },
              sourcePath
            );
            if (resolved.kind === "folder") {
              f_revealInFileExplorer(plugin.app, resolved.target);
            }
            return true;
          }

          const vaultPath = resolveAtPathFromSource(relPath, sourcePath, plugin);
          const resolved = plugin.app.vault.getAbstractFileByPath(vaultPath);
          if (resolved instanceof TFile) {
            openFileByViewState(plugin, resolved);
          }
          return true;
        },
        contextmenu(event, view) {
          const target = event.target;
          if (!target.classList.contains("atpath-link")) return false;
          const relPath = target.dataset.atpath;
          if (!relPath) return false;

          event.preventDefault();
          const activeFile = plugin.app.workspace.getActiveFile();
          if (!activeFile) return false;

          if (target.dataset.atpathKind === "folder") {
            const resolved = plugin.core.resolveAtPathTarget(
              { kind: "folder", vaultPath: relPath },
              activeFile.path
            );
            if (resolved.kind === "folder") {
              showAtPathFolderMenu(plugin, event, resolved.target);
            }
            return true;
          }

          const vaultPath = resolveAtPathFromSource(relPath, activeFile.path, plugin);
          showAtPathMenu(plugin, event, vaultPath);
          return true;
        },
      },
    }
  );
}

// ─── C2) CM6 ViewPlugin — Wikilink @path decoration in Live Preview ──

function resolveWikilinkHref(plugin, href, sourcePath) {
  // data-href from Obsidian may be the raw link target; resolve it to a vault path
  const direct = plugin.app.vault.getAbstractFileByPath(href);
  if (direct instanceof TFile) return direct.path;
  // Try Obsidian's link resolver (handles shortest-path links, etc.)
  const resolved = plugin.app.metadataCache.getFirstLinkpathDest(href, sourcePath || "");
  if (resolved instanceof TFile) return resolved.path;
  return href;
}

function buildWikilinkViewPlugin(plugin) {
  const decorator = new MatchDecorator({
    regexp: WIKILINK_ATPATH_RE,
    decoration: (match, view, pos) => {
      const end = pos + match[0].length;
      const cursorInside = view.state.selection.ranges.some(
        r => r.from >= pos && r.to <= end
      );
      const linkTarget = match[1];  // group 1 = link target (may be short)
      const displayPath = match[2]; // group 2 = @display path

      // Resolve short link target to full vault path
      const activeFile = plugin.app.workspace.getActiveFile();
      const sourcePath = activeFile?.path || "";
      const resolved = plugin.app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
      const vaultPath = resolved?.path || linkTarget;

      let tokenStr = null;
      if (plugin.settings.showTokenCounts) {
        const cached = plugin.tokenCache.get(vaultPath);
        if (cached) tokenStr = formatTokens(cached.tokens);
        else if (plugin._tokenIndex.get(vaultPath)?.failed) tokenStr = "!";
        else plugin.scheduleTokenFetch(vaultPath, view);
      }

      if (!cursorInside) {
        return Decoration.replace({
          widget: new WikilinkAtPathWidget(displayPath, vaultPath, tokenStr),
        });
      }
      return null;
    },
  });

  return ViewPlugin.define(
    (view) => ({
      decorations: ATPATH_PERF.time("vp.wikilink.createDeco.init", () => decorator.createDeco(view)),
      update(update) {
        ATPATH_PERF.inc("vp.wikilink.update.calls");
        if (update.docChanged) ATPATH_PERF.inc("vp.wikilink.update.trigger.doc");
        if (update.selectionSet) ATPATH_PERF.inc("vp.wikilink.update.trigger.sel");
        if (plugin.tokenCacheDirty) ATPATH_PERF.inc("vp.wikilink.update.trigger.dirty");
        if (plugin.tokenCacheDirty || update.selectionSet) {
          ATPATH_PERF.inc("vp.wikilink.createDeco");
          this.decorations = ATPATH_PERF.time("vp.wikilink.createDeco.full", () => decorator.createDeco(update.view));
          plugin.tokenCacheDirty = false;
        } else {
          ATPATH_PERF.inc("vp.wikilink.updateDeco");
          this.decorations = ATPATH_PERF.time("vp.wikilink.updateDeco.incremental", () => decorator.updateDeco(update, this.decorations));
        }
      },
    }),
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const target = event.target;
          if (!target.classList.contains("atpath-link")) return false;
          const vaultPath = target.dataset.atpath;
          if (!vaultPath) return false;
          event.preventDefault();
          const resolved = plugin.app.vault.getAbstractFileByPath(vaultPath);
          if (resolved instanceof TFile) openFileByViewState(plugin, resolved);
          return true;
        },
        contextmenu(event, view) {
          const target = event.target;
          if (!target.classList.contains("atpath-link")) return false;
          const vaultPath = target.dataset.atpath;
          if (!vaultPath) return false;
          event.preventDefault();
          showAtPathMenu(plugin, event, vaultPath);
          return true;
        },
      },
    }
  );
}

// ─── C3) CM6 update listener — live note + selection token counts ────

function buildBufferCountListener(plugin) {
  return EditorView.updateListener.of(update => {
    if (!update.docChanged && !update.selectionSet) return;
    if (plugin.app.workspace.getActiveViewOfType(MarkdownView)?.editor.cm !== update.view) return;
    clearTimeout(plugin._bufferReadTimer);
    plugin._bufferReadTimer = setTimeout(() => plugin.f_updateBufferTokenCounts(), 80);
    plugin._bufferTokenCounts.invalidate(update.docChanged, update.state.selection.ranges.some(range => !range.empty));
  });
}

// ─── C3) CM6 drag-and-drop — insert @path refs on file-explorer drop ─

function extractDraggedVaultPaths(dataTransfer, plugin, sourcePath) {
  return coreExtractDraggedVaultPaths(dataTransfer, plugin.app, sourcePath, plugin._currentDragRefs);
}

function captureDragRefsFromExplorerDom(plugin, evt) {
  const app = plugin.app;
  const out = [];
  const seen = new Set();
  const target = evt.target instanceof Element ? evt.target : null;
  if (!target) return out;
  const item = target.closest("[data-path]");
  if (!item) return out;

  // Multi-select drag: pick all `.is-selected` items in the same file-explorer
  // leaf when the dragged item is one of them. `.is-active` is the currently
  // open note marker and is NOT part of a selection set, so it must not pull
  // siblings in — treat it as single-item only.
  const explorer = item.closest(".workspace-leaf-content[data-type='file-explorer']") ||
                   item.closest(".nav-files-container") ||
                   null;
  let candidates;
  if (explorer && item.classList.contains("is-selected")) {
    const selected = explorer.querySelectorAll(".is-selected[data-path]");
    candidates = selected.length > 0 ? Array.from(selected) : [item];
  } else {
    candidates = [item];
  }

  for (const el of candidates) {
    const path = el.getAttribute("data-path");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const af = app.vault.getAbstractFileByPath(path);
    if (!af) continue;
    if (af instanceof TFile) {
      out.push({ kind: "file", vaultPath: af.path, target: af });
    } else if (af instanceof TFolder) {
      out.push({ kind: "folder", vaultPath: af.path, target: af });
    }
  }
  return out;
}

function insertAtPathRefs(view, pos, refs, plugin, sourcePath, belowDocument = false) {
  const parts = [];
  for (const ref of refs) {
    if (!ref?.target) continue;
    try {
      parts.push(plugin.f_formatLinkedTarget(ref.target, sourcePath));
    } catch (error) {
      new Notice(error.message);
    }
  }
  if (parts.length === 0) return;
  const line = view.state.doc.lineAt(pos);
  // Include the insertion point at EOF in an unfinished fenced block.
  const inCode = isInExcludedRange(pos, buildExcludedRanges(view.state.doc.toString() + "\n"));
  const blankLine = /^[\t ]*$/.test(line.text) && !inCode;
  const from = blankLine ? line.from : pos;
  const to = blankLine ? line.to : pos;
  let text;
  if (blankLine) text = parts.map(part => line.text + "- " + part).join("\n") + " ";
  else if (belowDocument && !inCode) text = "\n\n" + parts.map(part => "- " + part).join("\n") + " ";
  else text = parts.join(" ") + " ";
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: "input.drop",
  });
}

function buildDragDropExtension(plugin) {
  return EditorView.domEventHandlers({
    dragover(evt, view) {
      const sourcePath = f_editorSourcePath(view, plugin);
      if (!sourcePath) return false;
      const refs = extractDraggedVaultPaths(evt.dataTransfer, plugin, sourcePath);
      if (!refs.length) return false;
      evt.preventDefault();
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = "link";
      return true;
    },
    drop(evt, view) {
      const sourcePath = f_editorSourcePath(view, plugin);
      if (!sourcePath) return false;
      let refs = extractDraggedVaultPaths(evt.dataTransfer, plugin, sourcePath);
      if (!refs.length) return false;
      if (refs.length > 50) {
        new Notice("Drop limited to 50 paths");
        refs = refs.slice(0, 50);
      }
      evt.preventDefault();
      evt.stopPropagation();
      // Clamp the space below the document to its end, not the old cursor.
      const dropPos = view.posAtCoords({ x: evt.clientX, y: evt.clientY }, false) ?? view.state.selection.main.head;
      const endRect = dropPos === view.state.doc.length ? view.coordsAtPos(dropPos) : null;
      insertAtPathRefs(view, dropPos, refs, plugin, sourcePath, endRect && evt.clientY > endRect.bottom);
      plugin._currentDragRefs = null;
      return true;
    },
  });
}

// ─── D) markdownPostProcessor — Clickable links in Reading mode ──────

function f_editorSourcePath(view, plugin) {
  const source = plugin.app.workspace.getLeavesOfType("markdown")
    .find(leaf => leaf.view.editor?.cm === view);
  return source?.view.file?.path || plugin.app.workspace.getActiveFile()?.path;
}

class RepositoryTokenWidget extends WidgetType {
  constructor(count, skipped, failed) {
    super();
    this.count = count;
    this.skipped = skipped;
    this.failed = failed;
  }
  eq(other) { return this.count === other.count && this.skipped === other.skipped && this.failed === other.failed; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "atpath-token-count";
    span.textContent = " (" + this.count + ")";
    span.title = TOKEN_COUNT_DISCLOSURE + (this.skipped ? " " + this.skipped + " files skipped." : "");
    if (this.failed) span.title += " " + this.failed + " files failed to count; total is incomplete.";
    return span;
  }
}

function f_buildRepositoryLinkView(plugin) {
  function f_decorate(view, refs, sourcePath) {
    if (!sourcePath) return { decorations: Decoration.none, linkDecorations: Decoration.none };
    const ranges = [];
    const links = [];
    for (const ref of refs) {
      if (!view.visibleRanges.some(range => ref.start >= range.from && ref.end <= range.to)) continue;
      const result = plugin.f_resolveLinkTarget(ref, sourcePath);
      if (!f_managesRepositoryNavigation(ref.destination, result)) continue;
      links.push(Decoration.mark({
        class: "atpath-repository-link",
        attributes: { "data-atpath-destination": ref.destination, "data-atpath-source": sourcePath,
          title: result.reason || result.normalizedPath },
      }).range(ref.start, ref.end));
      if (!plugin.settings.showTokenCounts) continue;
      let text;
      let skipped;
      let failed;
      if (result.kind === "missing") text = "unavailable";
      else if (result.kind === "folder") {
        const count = plugin.f_folderTokenCount(result.normalizedPath);
        skipped = count?.skipped;
        failed = count?.failed;
        text = f_formatFolderTokenCount(count);
      } else {
        plugin.f_watchLinkedCount(result.normalizedPath, false);
        const cached = plugin.tokenCache.get(result.normalizedPath);
        if (!cached) plugin.scheduleTokenFetch(result.normalizedPath, view);
        if (cached) text = formatTokens(cached.tokens);
        else if (plugin._tokenIndex.get(result.normalizedPath)?.failed) { text = "!"; failed = 1; }
      }
      if (text) ranges.push(Decoration.widget({ widget: new RepositoryTokenWidget(text, skipped, failed), side: 1 }).range(ref.end));
    }
    return { decorations: Decoration.set(ranges, true), linkDecorations: Decoration.set(links, true) };
  }

  return ViewPlugin.define(view => {
    const refs = plugin.f_scanMarkdownRefs(view.state.doc.toString());
    const sourcePath = f_editorSourcePath(view, plugin);
    return {
      refs,
      sourcePath,
      generation: plugin._repositoryDecorationGeneration,
      ...f_decorate(view, refs, sourcePath),
      update(update) {
        const path = f_editorSourcePath(update.view, plugin);
        if (update.docChanged) this.refs = plugin.f_scanMarkdownRefs(update.state.doc.toString());
        if (update.docChanged || update.viewportChanged || path !== this.sourcePath
          || this.generation !== plugin._repositoryDecorationGeneration) {
          this.sourcePath = path;
          this.generation = plugin._repositoryDecorationGeneration;
          Object.assign(this, f_decorate(update.view, this.refs, path));
        }
      },
    };
  }, {
    decorations: value => value.decorations,
    // Keep one wrapper around Obsidian's escaped/emphasized label fragments.
    provide: extension => EditorView.outerDecorations.of(view => view.plugin(extension)?.linkDecorations ?? Decoration.none),
  });
}

function f_captureEditorRepositoryLinks(plugin) {
  const handle = event => {
    const link = event.target.closest?.("[data-atpath-destination][data-atpath-source]");
    if (!link || !link.closest(".cm-content")) return;
    if (event.type !== "contextmenu") {
      if (event.type === "mousedown" && !(event.button === 1 || Platform.isAndroidApp)) return;
      if (event.type === "click" && (event.button !== 0 || Platform.isAndroidApp)) return;
      if (!event.ctrlKey && !event.metaKey && event.button !== 1 && !Platform.isMobile) {
        if (event.altKey || event.shiftKey || !link.closest(".is-live-preview")
          || !event.target.closest(".cm-underline, .external-link")) return;
        if (!link.ownerDocument.getSelection()?.isCollapsed) return;
      }
    }
    f_interceptRepositoryLink(plugin, event, link.dataset.atpathDestination, link.dataset.atpathSource);
  };
  const documents = new WeakSet();
  const f_registerDocument = doc => {
    if (documents.has(doc)) return;
    documents.add(doc);
    for (const type of ["click", "mousedown", "contextmenu"]) plugin.registerDomEvent(doc, type, handle, { capture: true });
  };
  f_registerDocument(document);
  plugin.app.workspace.iterateAllLeaves?.(leaf => f_registerDocument(leaf.view.containerEl.ownerDocument));
  plugin.registerEvent(plugin.app.workspace.on("window-open", (_workspaceWindow, win) => f_registerDocument(win.document)));
}

function f_isCanonicalRepositoryDestination(destination) {
  return (destination.startsWith("/") && !destination.startsWith("//"))
    || /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\//i.test(destination);
}

function f_managesRepositoryNavigation(destination, result) {
  return result.kind !== "ignored" && (result.kind !== "missing" || f_isCanonicalRepositoryDestination(destination));
}

function f_interceptRepositoryLink(plugin, event, destination, sourcePath) {
  const resolved = plugin.f_resolveLinkTarget({ destination }, sourcePath);
  if (!f_managesRepositoryNavigation(destination, resolved)) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === "contextmenu") {
    if (resolved.kind === "folder") showAtPathFolderMenu(plugin, event, resolved.target);
    if (resolved.kind === "file") showAtPathMenu(plugin, event, resolved.normalizedPath, resolved);
  } else {
    void plugin.f_resolveLinkTargetAsync({ destination }, sourcePath)
      .then(result => plugin.f_openRepositoryTarget(result, event.ctrlKey || event.metaKey || event.button === 1))
      .catch(error => new Notice("Could not open repository link: " + error.message));
  }
  return true;
}

function registerPostProcessor(plugin) {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    for (const link of el.querySelectorAll("a[href]")) {
      const destination = link.dataset.href || link.getAttribute("href");
      if (!destination || (!f_isCanonicalRepositoryDestination(destination) && !/^\.\.?\//.test(destination))) continue;
      const result = plugin.f_resolveLinkTarget({ destination }, ctx.sourcePath);
      if (!f_managesRepositoryNavigation(destination, result) && !(result.kind === "ignored" && result.repository)) continue;
      link.addEventListener("click", event => f_interceptRepositoryLink(plugin, event, destination, ctx.sourcePath), true);
      link.addEventListener("contextmenu", event => f_interceptRepositoryLink(plugin, event, destination, ctx.sourcePath), true);
      const nativeTitle = link.title;
      const badge = link.createSpan({ cls: "atpath-token-count" });
      plugin.f_bindReadingTokenBadge(ctx, badge, result, {
        resolve: () => plugin.f_resolveLinkTarget({ destination }, ctx.sourcePath),
        probe: target => plugin.f_probeUnindexedTarget(target.vaultPath, target.repository),
        onTarget: target => {
          const managed = f_managesRepositoryNavigation(destination, target);
          link.classList.toggle("atpath-link", managed);
          link.title = managed ? target.reason || target.normalizedPath || nativeTitle : nativeTitle;
        },
      });
    }

    // ── Wikilink @path references (rendered as a.internal-link by Obsidian) ──
    const internalLinks = el.querySelectorAll("a.internal-link");
    for (const link of internalLinks) {
      if (link.classList.contains("atpath-link") || !link.textContent.startsWith("@")) continue;
      link.classList.add("atpath-link");
      const rawHref = link.dataset.href || link.getAttribute("href") || "";
      const vaultPath = resolveWikilinkHref(plugin, rawHref, ctx.sourcePath);
      link.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showAtPathMenu(plugin, e, vaultPath);
      });
      const tokenSpan = link.ownerDocument.createElement("span");
      tokenSpan.className = "atpath-token-count";
      link.after(tokenSpan);
      plugin.f_bindReadingTokenBadge(ctx, tokenSpan, { kind: "file", normalizedPath: vaultPath });
    }

    // ── Legacy @path references (plain text matched by regex) ──
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const fileRe = /(?:^|(?<=[\s(]))@([\w\p{L}\p{M}./_-]+\.[\w]+|[\w\p{L}\p{M}./_-][\w\p{L}\p{M}./ _()&-]+?\.[\w]+)/gu;
    const replacements = [];

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      // Folder pass first (so overlapping file matches can be excluded).
      const folderRanges = [];
      const folderRe = new RegExp(AT_PATH_FOLDER_RE.source, AT_PATH_FOLDER_RE.flags);
      let fMatch;
      while ((fMatch = folderRe.exec(text)) !== null) {
        const lead = fMatch[1] || "";
        const capture = fMatch[2];
        const startIdx = fMatch.index + lead.length;
        const endIdx = fMatch.index + fMatch[0].length;
        folderRanges.push([startIdx, endIdx]);
        replacements.push({
          node,
          kind: "folder",
          match: "@" + capture + "/",
          capture,
          index: startIdx,
          length: endIdx - startIdx,
        });
      }

      // File pass — skip matches that overlap a folder range or are followed by "/".
      fileRe.lastIndex = 0;
      let match;
      while ((match = fileRe.exec(text)) !== null) {
        const startIdx = match.index;
        const endIdx = match.index + match[0].length;
        let overlaps = false;
        for (const [fs, fe] of folderRanges) {
          if (startIdx < fe && endIdx > fs) { overlaps = true; break; }
        }
        if (overlaps) continue;
        if (text[endIdx] === "/") continue;
        replacements.push({
          node,
          kind: "file",
          match: match[0],
          capture: match[1],
          index: startIdx,
          length: match[0].length,
        });
      }
    }

    // Group by node, then process each node in reverse-index order so indices stay valid.
    const byNode = new Map();
    for (const r of replacements) {
      if (!byNode.has(r.node)) byNode.set(r.node, []);
      byNode.get(r.node).push(r);
    }

    for (const [textNode, items] of byNode) {
      items.sort((a, b) => b.index - a.index);
      for (const item of items) {
        const { kind, match, capture, index, length } = item;
        const before = textNode.textContent.substring(0, index);
        const after = textNode.textContent.substring(index + length);
        const parent = textNode.parentNode;
        if (!parent) continue;

        const link = document.createElement("a");
        link.className = kind === "folder"
          ? "atpath-link atpath-folder-link"
          : "atpath-link";
        link.textContent = match;

        if (kind === "folder") {
          link.addEventListener("click", (e) => {
            e.preventDefault();
            const resolved = plugin.core.resolveAtPathTarget(
              { kind: "folder", vaultPath: capture },
              ctx.sourcePath
            );
            if (resolved.kind === "folder") {
              f_revealInFileExplorer(plugin.app, resolved.target);
            }
          });
          link.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const resolved = plugin.core.resolveAtPathTarget(
              { kind: "folder", vaultPath: capture },
              ctx.sourcePath
            );
            if (resolved.kind === "folder") {
              showAtPathFolderMenu(plugin, e, resolved.target);
            }
          });
        } else {
          link.addEventListener("click", (e) => {
            e.preventDefault();
            const vaultPath = resolveAtPathFromSource(capture, ctx.sourcePath, plugin);
            const resolved = plugin.app.vault.getAbstractFileByPath(vaultPath);
            if (resolved instanceof TFile) {
              openFileByViewState(plugin, resolved);
            }
          });
          link.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const vaultPath = resolveAtPathFromSource(capture, ctx.sourcePath, plugin);
            showAtPathMenu(plugin, e, vaultPath);
          });
        }

        if (after) parent.insertBefore(document.createTextNode(after), textNode.nextSibling);

        const target = kind === "folder"
          ? plugin.core.resolveAtPathTarget({ kind: "folder", vaultPath: capture }, ctx.sourcePath)
          : { kind: "file", normalizedPath: resolveAtPathFromSource(capture, ctx.sourcePath, plugin) };
        const tokenSpan = link.ownerDocument.createElement("span");
        tokenSpan.className = "atpath-token-count";
        parent.insertBefore(tokenSpan, textNode.nextSibling);
        plugin.f_bindReadingTokenBadge(ctx, tokenSpan, target);

        parent.insertBefore(link, textNode.nextSibling);
        textNode.textContent = before;
      }
    }
  });
}

// ─── E) Settings tab ─────────────────────────────────────────────────

class AtPathSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show token counts")
      .setDesc("Show local counts beside links and explorer rows and in the status bar. " + TOKEN_COUNT_DISCLOSURE)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showTokenCounts).onChange(async (value) => {
          this.plugin.settings.showTokenCounts = value;
          await this.plugin.saveSettings();
          this.plugin.onTokenSettingsChanged();
        })
      );

    new Setting(containerEl)
      .setName("Max file size (MB)")
      .setDesc("Skip larger linked files when counting, copying or publishing.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxFileSizeMB)).onChange(async (value) => {
          const num = parseFloat(value);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.maxFileSizeMB = num;
            await this.plugin.saveSettings();
            this.plugin.onTokenSettingsChanged();
          }
        })
      );

    new Setting(containerEl)
      .setName("Max files per folder reference")
      .setDesc("Folder references above this limit show a file count and are skipped when copying linked content.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxFolderFiles)).onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.maxFolderFiles = num;
            await this.plugin.saveSettings();
            this.plugin.onTokenSettingsChanged();
          }
        })
      );

    let folderExclusionsInput;
    new Setting(containerEl)
      .setName("Exclude folders from parent totals")
      .setDesc("One folder name or vault-relative path per line; no wildcards. These folders are left out of totals and copied content for folders above them. Direct links to the folder or its files still work. Leave empty to include all folders, then select Apply.")
      .addTextArea(text => {
        folderExclusionsInput = text;
        text.setPlaceholder("90_archive\nproject/scratch").setValue(this.plugin.settings.folderCountExclusions);
      })
      .addButton(button => button.setButtonText("Apply").onClick(async () => {
          const value = folderExclusionsInput.getValue();
          try { f_parseFolderCountExclusions(value); }
          catch (error) { new Notice(error.message); return; }
          this.plugin.settings.folderCountExclusions = value;
          await this.plugin.saveSettings();
          this.plugin.onTokenSettingsChanged();
          new Notice("Folder exclusions applied.");
        }));

    new Setting(containerEl)
      .setName("Show selection tokens in status bar")
      .setDesc("When you select text, the note segment shows `Sel: <selected> / <total>`. Disable to always show the note total only.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.statusBarShowSelection !== false)
          .onChange(async (value) => {
            this.plugin.settings.statusBarShowSelection = value;
            await this.plugin.saveSettings();
            this.plugin.updateStatusBar();
          })
      );

    new Setting(containerEl)
      .setName("Suggest folders in autocomplete")
      .setDesc("Include folder candidates when you type [[. A folder inserts an ordinary Markdown link.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.suggestFolders !== false)
          .onChange(async (value) => {
            this.plugin.settings.suggestFolders = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Drag-and-drop repository links")
      .setDesc("Dragging a file or folder into the editor inserts a Markdown repository link. Disable to restore Obsidian’s default drag behavior.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDragDropAtPath !== false)
          .onChange(async (value) => {
            this.plugin.settings.enableDragDropAtPath = value;
            await this.plugin.saveSettings();
            this.plugin.reconfigureDragDrop();
          })
      );

    new Setting(containerEl).setHeading().setName("Publishing");

    new Setting(containerEl)
      .setName("Vercel API token")
      .setDesc("Personal access token for deploying notes to Vercel.")
      .addText((text) =>
        text
          .setPlaceholder("Enter token...")
          .setValue(this.plugin.settings.vercelToken)
          .then((t) => { t.inputEl.type = "password"; })
          .onChange(async (value) => {
            this.plugin.settings.vercelToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Contact URL")
      .setDesc("Link for the contact button on published pages (e.g. WhatsApp link).")
      .addText((text) =>
        text
          .setPlaceholder("https://wa.me/...")
          .setValue(this.plugin.settings.contactUrl)
          .onChange(async (value) => {
            this.plugin.settings.contactUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Contact button label")
      .setDesc("Text shown on the contact button.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.contactLabel)
          .onChange(async (value) => {
            this.plugin.settings.contactLabel = value;
            await this.plugin.saveSettings();
          })
      );

    const siteIconSetting = new Setting(containerEl)
      .setName("Site icon");
    addSiteIconPicker(
      siteIconSetting,
      this.plugin,
      "Shown in browser tabs for published sites. Choose it once and reuse it everywhere."
    );

    new Setting(containerEl).setHeading().setName("Private publishing");

    new Setting(containerEl)
      .setName("Clerk publishable key")
      .setDesc("From your Clerk dashboard (clerk.com). Free tier: 50k users/month.")
      .addText((text) =>
        text
          .setPlaceholder("pk_live_...")
          .setValue(this.plugin.settings.clerkPublishableKey)
          .onChange(async (value) => {
            this.plugin.settings.clerkPublishableKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Clerk secret key")
      .setDesc("Keep this secret. Used server-side to verify session tokens.")
      .addText((text) =>
        text
          .setPlaceholder("sk_live_...")
          .setValue(this.plugin.settings.clerkSecretKey)
          .then((t) => { t.inputEl.type = "password"; })
          .onChange(async (value) => {
            this.plugin.settings.clerkSecretKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Publisher email")
      .setDesc("Viewers can request access via email to this address.")
      .addText((text) =>
        text
          .setPlaceholder("you@example.com")
          .setValue(this.plugin.settings.publisherEmail)
          .onChange(async (value) => {
            this.plugin.settings.publisherEmail = value.trim();
            await this.plugin.saveSettings();
          })
      );

  }
}

// ─── F) Publish modals ───────────────────────────────────────────────

class PublishConfirmModal extends Modal {
  constructor(app, publishData, onConfirm, onUnpublish) {
    super(app);
    this.publishData = publishData;
    this.onConfirm = onConfirm;
    this.onUnpublish = onUnpublish;
  }

  onOpen() {
    const { contentEl } = this;
    const { domain, plugin } = this.publishData;
    const atPathFiles = this.publishData.atPathFiles || [];
    const pageState = getPublishState(plugin, this.publishData);
    const isHtmlAppPublish = this.publishData.publishKind === "html-app";

    contentEl.createEl("h2", { text: "Publish to Vercel" });

    // ── Status block ──
    const statusEl = contentEl.createDiv({ cls: "atpath-publish-status" });
    if (pageState && pageState.url && !pageState.isUnpublished) {
      statusEl.createSpan({ cls: "atpath-status-dot atpath-status-dot--live" });
      statusEl.appendText("Live at " + pageState.url);
      if (pageState.isPrivate && pageState.approvedEmails) {
        statusEl.appendText(" — Private (" + pageState.approvedEmails.length + " users)");
      }
    } else if (pageState && pageState.isUnpublished) {
      statusEl.createSpan({ cls: "atpath-status-dot atpath-status-dot--unpublished" });
      statusEl.appendText("Unpublished — " + pageState.url);
    } else {
      statusEl.appendText("Not published");
      statusEl.createEl("br");
      statusEl.createEl("small", { text: "Will publish to " + domain });
    }

    if (isHtmlAppPublish) {
      const modeLabel = this.publishData.publishScope === HTML_APP_SCOPE_FOLDER ? "Folder mode" : "Single-file mode";
      contentEl.createEl("p", { text: modeLabel + " — " + this.publishData.sourcePath });
      if (this.publishData.publishScope === HTML_APP_SCOPE_FOLDER) {
        const sourceFolder = this.publishData.sourcePath.split("/").slice(0, -1).join("/") || "/";
        contentEl.createEl("small", { text: "Will deploy the parent folder recursively from " + sourceFolder });
      } else {
        contentEl.createEl("small", { text: "Will deploy only this HTML file as /index.html" });
      }
    } else if (atPathFiles.length > 0) {
      // ── Linked @path notes ──
      const heading = "Linked files (" + atPathFiles.length + ")";
      if (atPathFiles.length > 5) {
        const details = contentEl.createEl("details");
        details.createEl("summary", { text: heading });
        const list = details.createEl("ul");
        for (const f of atPathFiles) list.createEl("li", { text: "@" + f.relPath });
      } else {
        contentEl.createEl("p", { text: heading });
        const list = contentEl.createEl("ul");
        for (const f of atPathFiles) list.createEl("li", { text: "@" + f.relPath });
      }
    }

    // ── Vercel token (only if not saved) ──
    let tokenValue = plugin.settings.vercelToken;
    if (!tokenValue) {
      new Setting(contentEl)
        .setName("Vercel API token")
        .addText((text) =>
          text
            .setPlaceholder("Enter token...")
            .then((t) => { t.inputEl.type = "password"; })
            .onChange((value) => { tokenValue = value.trim(); })
        );
    }

    let siteTitleValue = pageState && pageState.siteTitle
      ? pageState.siteTitle
      : this.publishData.noteTitle;
    if (isHtmlAppPublish) {
      new Setting(contentEl)
        .setName("Website title")
        .setDesc("Used as the publish label and unpublished placeholder title.")
        .addText((text) =>
          text
            .setValue(siteTitleValue)
            .onChange((value) => { siteTitleValue = value.trim(); })
        );
    }

    let siteIconPicker = null;
    if (!plugin.settings.siteIconDataUrl) {
      const siteIconSetting = new Setting(contentEl)
        .setName("Site icon");
      siteIconPicker = addSiteIconPicker(
        siteIconSetting,
        plugin,
        "Optional. Shown in browser tabs and saved globally for future publishes.",
        { notices: false }
      );
    }

    // ── Project name (editable for new, read-only for existing) ──
    const isExistingProject = pageState && pageState.projectName;
    let projectNameValue = isExistingProject
      ? pageState.projectName
      : (this.publishData.defaultProjectName || slugify(this.publishData.noteTitle));
    const projectNameSetting = new Setting(contentEl)
      .setName("Project name")
      .setDesc(isExistingProject ? projectNameValue + ".vercel.app" : "");
    if (isExistingProject) {
      projectNameSetting.setDesc(projectNameValue + ".vercel.app (already deployed)");
    } else {
      projectNameSetting.addText((text) => {
        const validateProjectName = (val) => {
          const invalid = val.length > 100 || /[^a-z0-9._-]/.test(val) || val.includes("---") || !val;
          const tooLong = val.length > 40;
          text.inputEl.toggleClass("atpath-input-error", invalid);
          return { valid: !invalid, tooLong };
        };
        text
          .setValue(projectNameValue)
          .onChange((value) => {
            projectNameValue = value.trim();
            const result = validateProjectName(projectNameValue);
            if (!result.valid) {
              projectNameSetting.setDesc("Invalid: use a-z, 0-9, ., _, - (max 100 chars, no ---)");
            } else if (result.tooLong) {
              projectNameSetting.setDesc(projectNameValue + ".vercel.app — Warning: long names may be shortened by Vercel");
            } else {
              projectNameSetting.setDesc(projectNameValue + ".vercel.app");
            }
          });
        const initResult = validateProjectName(projectNameValue);
        projectNameSetting.setDesc(
          initResult.tooLong
            ? projectNameValue + ".vercel.app — Warning: long names may be shortened by Vercel"
            : projectNameValue + ".vercel.app"
        );
      });
    }

    let compactLinks = true;
    if (!isHtmlAppPublish) {
      // ── Compact toggle ──
      new Setting(contentEl)
        .setName("Use file names for published links?")
        .setDesc("Show just the filename (e.g. helpers.py) instead of the full path")
        .addToggle((toggle) =>
          toggle.setValue(true).onChange((value) => { compactLinks = value; })
        );
    }

    let isPrivate = (pageState && pageState.isPrivate) || false;
    let clerkPubKey = plugin.settings.clerkPublishableKey;
    let clerkSecKey = plugin.settings.clerkSecretKey;
    let approvedEmailsText = ((pageState && pageState.approvedEmails) || []).join("\n");

    // ── Private toggle ──
    const privateToggleContainer = contentEl.createDiv();
    const authSectionEl = contentEl.createDiv({ cls: "atpath-auth-section" + (isPrivate ? "" : " atpath-hidden") });
    new Setting(privateToggleContainer)
      .setName("Require login to view")
      .addToggle((toggle) =>
        toggle.setValue(isPrivate).onChange((value) => {
          isPrivate = value;
          if (value) {
            authSectionEl.removeClass("atpath-hidden");
          } else {
            authSectionEl.addClass("atpath-hidden");
          }
        })
      );

    // ── Auth fields (inside authSectionEl) ──
    if (!clerkPubKey) {
      new Setting(authSectionEl)
        .setName("Clerk publishable key")
        .addText((text) =>
          text
            .setPlaceholder("pk_live_...")
            .onChange((value) => { clerkPubKey = value.trim(); })
        );
    }

    if (!clerkSecKey) {
      new Setting(authSectionEl)
        .setName("Clerk secret key")
        .addText((text) =>
          text
            .setPlaceholder("sk_live_...")
            .then((t) => { t.inputEl.type = "password"; })
            .onChange((value) => { clerkSecKey = value.trim(); })
        );
    }

    const emailsSetting = new Setting(authSectionEl)
      .setName("Approved emails")
      .setDesc("One email per line");
    emailsSetting.controlEl.addClass("atpath-approved-emails");
    const textarea = emailsSetting.controlEl.createEl("textarea", {
      attr: { placeholder: "alice@example.com\nbob@example.com", rows: "4" },
    });
    textarea.value = approvedEmailsText;
    textarea.addEventListener("input", () => { approvedEmailsText = textarea.value; });

    // ── Buttons ──
    const buttonSetting = new Setting(contentEl);

    // Unpublish button (only if currently published)
    if (pageState && pageState.url && !pageState.isUnpublished) {
      buttonSetting.addButton((btn) =>
        btn.setButtonText("Unpublish").setWarning().onClick(() => {
          this.close();
          new UnpublishConfirmModal(this.app, this.publishData, this.onUnpublish).open();
        })
      );
    }

    buttonSetting.addButton((btn) =>
      btn.setButtonText("Cancel").onClick(() => this.close())
    );

    const publishLabel = (pageState && pageState.url) ? "Republish" : "Publish";
    buttonSetting.addButton((btn) =>
      btn.setButtonText(publishLabel).setCta().onClick(() => {
        void (async () => {
          try {
            if (siteIconPicker) {
              await siteIconPicker.waitForPending();
            }
            if (!tokenValue) {
              new Notice("Please enter a Vercel API token.");
              return;
            }
            if (isHtmlAppPublish && !siteTitleValue) {
              new Notice("Please enter a website title.");
              return;
            }
            if (!projectNameValue || projectNameValue.length > 100 || /[^a-z0-9._-]/.test(projectNameValue) || projectNameValue.includes("---")) {
              new Notice("Invalid project name. Use a-z, 0-9, ., _, - (max 100 chars, no ---).");
              return;
            }
            if (isPrivate) {
              const emails = approvedEmailsText.split("\n").map(e => e.trim().toLowerCase()).filter(Boolean);
              if (emails.length === 0) {
                new Notice("Add at least one approved email.");
                return;
              }
              if (!clerkPubKey) {
                new Notice("Please enter a Clerk publishable key.");
                return;
              }
              if (!clerkSecKey) {
                new Notice("Please enter a Clerk secret key.");
                return;
              }

              if (clerkPubKey.startsWith("pk_test_") || clerkSecKey.startsWith("sk_test_")) {
                new Notice("Warning: test keys may not work on production. Consider live keys.", 8000);
              }

              this.close();
              this.onConfirm({
                token: tokenValue,
                compactLinks,
                siteTitle: siteTitleValue || this.publishData.noteTitle,
                isPrivate: true,
                approvedEmails: emails,
                clerkPublishableKey: clerkPubKey,
                clerkSecretKey: clerkSecKey,
                projectName: projectNameValue,
              });
            } else {
              // Warn if switching from private to public
              if (pageState && pageState.isPrivate) {
                const confirmed = confirm("This will make the page publicly accessible. Continue?");
                if (!confirmed) return;
              }
              this.close();
              this.onConfirm({
                token: tokenValue,
                compactLinks,
                siteTitle: siteTitleValue || this.publishData.noteTitle,
                isPrivate: false,
                projectName: projectNameValue,
              });
            }
          } catch (error) {
            new Notice(error.message || String(error));
          }
        })();
      })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class UnpublishConfirmModal extends Modal {
  constructor(app, publishData, onUnpublish) {
    super(app);
    this.publishData = publishData;
    this.onUnpublish = onUnpublish;
  }

  onOpen() {
    const { contentEl } = this;
    const { plugin } = this.publishData;
    const pageState = getPublishState(plugin, this.publishData);
    const url = pageState ? pageState.url : "";

    contentEl.createEl("h2", { text: "Unpublish" });
    contentEl.createEl("p", { text: url });
    contentEl.createEl("p", {
      text: "This will replace the content with a placeholder page. The URL will remain active. You can republish at any time.",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Go back").onClick(() => {
          this.close();
          new PublishConfirmModal(
            this.app,
            this.publishData,
            this.publishData._onConfirm,
            this.publishData._onUnpublish
          ).open();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Unpublish").setWarning().onClick(() => {
          this.close();
          this.onUnpublish();
        })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PublishResultModal extends Modal {
  constructor(app, result) {
    super(app);
    this.result = result;
  }

  onOpen() {
    const { contentEl } = this;
    const { success, url, summary, error, warning } = this.result;

    if (success) {
      contentEl.createEl("h2", { text: warning ? "Published with warnings" : "Published successfully" });
      contentEl.createEl("p", { text: summary });

      if (warning) {
        const warnDiv = contentEl.createDiv({ cls: "atpath-deploy-warning" });
        warnDiv.createEl("p", { text: warning });
      }

      contentEl.createEl("p", { text: url, cls: "atpath-publish-url" });

      new Setting(contentEl)
        .addButton((btn) =>
          btn.setButtonText("Copy URL").setCta().onClick(async () => {
            await copyToClipboard(url);
            btn.setButtonText("Copied!");
            setTimeout(() => btn.setButtonText("Copy URL"), 2000);
          })
        )
        .addButton((btn) =>
          btn.setButtonText("Open in browser").onClick(() => {
            window.open(url, "_blank");
          })
        );
    } else {
      contentEl.createEl("h2", { text: "Publish failed" });
      const pre = contentEl.createEl("pre", { cls: "atpath-error-pre" });
      pre.textContent = error;
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close())
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class MigrationPreviewModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Review legacy links for migration" });

    const statusEl = contentEl.createEl("p", { text: "Scanning files...", cls: "atpath-migration-status" });

    const plan = await this.plugin.f_planRepositoryMigration();
    const resolved = plan.reduce((total, file) => total + file.edits.length, 0);
    const unresolved = plan.reduce((total, file) => total + file.skipped.length, 0);
    statusEl.setText(resolved + " proposed replacements and " + unresolved + " unresolved references in " + plan.length + " files.");
    for (const file of plan) {
      const details = contentEl.createEl("details");
      details.createEl("summary", { text: file.file.path });
      const lines = [];
      for (const edit of file.edits) lines.push("- " + edit.original, "+ " + edit.replacement);
      for (const skipped of file.skipped) lines.push("Unresolved: " + skipped);
      details.createEl("pre", { text: lines.join("\n") });
    }
    new Setting(contentEl).addButton(button => button.setButtonText("Close").onClick(() => this.close()))
      .addButton(button => button.setButtonText("Apply reviewed replacements").setDisabled(!resolved).setCta().onClick(async () => {
        this.close();
        await this.plugin.f_applyRepositoryMigration(plan);
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class HtmlAppScopeModal extends Modal {
  constructor(app, plugin, htmlFile) {
    super(app);
    this.plugin = plugin;
    this.htmlFile = htmlFile;
  }

  onOpen() {
    const { contentEl } = this;
    const pageState = getPublishedHtmlAppState(this.plugin.settings, this.htmlFile.path);
    const previousScope = pageState && pageState.scope;

    contentEl.createEl("h2", { text: "@Path: publish HTML app" });
    contentEl.createEl("p", { text: this.htmlFile.path });

    if (pageState && pageState.url && !pageState.isUnpublished) {
      contentEl.createEl("p", { text: "Current publish: " + pageState.url });
    } else if (pageState && pageState.isUnpublished) {
      contentEl.createEl("p", { text: "Current publish: unpublished at " + pageState.url });
    }

    contentEl.createEl("p", {
      text: "Choose whether to deploy just this HTML file or its whole folder.",
    });

    contentEl.createEl("small", {
      text: "Single file deploys only this file as /index.html. Folder deploys the parent folder recursively and uses this file as the site entry point.",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Publish single file")
          .setCta(previousScope !== HTML_APP_SCOPE_FOLDER)
          .onClick(async () => {
            this.close();
            await this.plugin.publishHtmlApp(this.htmlFile, HTML_APP_SCOPE_SINGLE_FILE);
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Publish folder")
          .setCta(previousScope === HTML_APP_SCOPE_FOLDER)
          .onClick(async () => {
            this.close();
            await this.plugin.publishHtmlApp(this.htmlFile, HTML_APP_SCOPE_FOLDER);
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close())
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── G) Plugin lifecycle ─────────────────────────────────────────────

class AtPathPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.tokenCache = new Map();
    this.tokenCacheDirty = false;
    this._refreshTimer = null;
    this._lastEditorView = null;
    this._statusBarGen = 0;
    this.core = createAtPathCore(this);
    this._unindexedTargets = new Map();
    this._unindexedProbes = new Map();
    this._linkedCountWatches = new Map();
    this._readingTokenRefreshes = new Set();
    this._folderCountExclusions = f_parseFolderCountExclusions(this.settings.folderCountExclusions);
    this._tokenCounter = f_createTokenCounter();
    const f_reportCountError = (error, path = "editor buffer") => {
      if (error.tokenCounterUnavailable && this._countFailureShown) return;
      if (error.tokenCounterUnavailable) this._countFailureShown = true;
      console.warn("AtPath could not count " + path, error);
      new Notice(error.tokenCounterUnavailable
        ? "The token worker could not recover. Unavailable counts show !. Reload AtPath to retry."
        : "Could not count " + path + ". Its count shows !; other files will continue.", 0);
    };
    this._bufferTokenCounts = f_createBufferTokenCounts({
      count: (text, options) => this._tokenCounter.count(text, options),
      onChange: (note, selection) => {
        this._noteBufferTokens = note;
        this._selectionTokens = selection;
        this._repaintStatusBarFromBuffer();
      },
      onError: f_reportCountError,
    });
    const vault = this.app.vault;
    const vaultKey = this.app.appId || vault.adapter.getBasePath?.() || vault.getName();
    this._tokenIndex = f_createTokenIndex({
      enabled: this.settings.showTokenCounts,
      getFiles: () => [...vault.getFiles(), ...this._unindexedTargets.values()],
      read: file => file.localOnly ? this.f_readLinkedFile(file) : vault.read(file),
      count: text => this._tokenCounter.count(text),
      folderExclusions: this._folderCountExclusions,
      isEligible: file => this.f_eligibleLinkedFile(file),
      looksBinary,
      load: () => f_loadTokenCache(vaultKey),
      save: cache => f_saveTokenCache(vaultKey, cache),
      tokenCache: this.tokenCache,
      onError: (error, path, stage) => {
        if (stage === "count") f_reportCountError(error, path);
        else if (path) console.warn("AtPath could not " + stage + " " + path, error);
        else console.warn("AtPath device-local token cache unavailable; writes retry with backoff", error);
      },
    });
    this.register(this._tokenIndex.subscribe(() => {
      let changed = false;
      for (const [key, watch] of this._linkedCountWatches) {
        const next = this.f_linkedCountSignature(watch.path, watch.folder);
        if (watch.signature === next) continue;
        this._linkedCountWatches.set(key, { ...watch, signature: next });
        changed = true;
      }
      if (!changed) return;
      this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
      this.tokenCacheDirty = true;
      this._scheduleRefresh();
    }));
    this.app.workspace.onLayoutReady(() => {
      if (this._repositoryIndexClosed) return;
      this._explorerTokenBadges = f_installExplorerTokenBadges({
        workspace: this.app.workspace, index: this._tokenIndex,
        formatTokens,
        isEnabled: () => this.settings.showTokenCounts,
      });
      if (this.settings.showTokenCounts) {
        void this._tokenIndex.start().catch(error => console.warn("AtPath could not start token counting", error));
      }
    });
    this.register(() => {
      this._explorerTokenBadges?.dispose();
      void this._tokenIndex.dispose();
      this._bufferTokenCounts.dispose();
      this._tokenCounter.dispose();
      this._readingTokenRefreshes.clear();
      clearTimeout(this._refreshTimer);
      clearTimeout(this._statusBarTimeout);
      clearTimeout(this._bufferReadTimer);
    });

    this.repositories = [];
    this._sourceCheckoutChecks = new Map();
    this._repositoryAliasAttempts = new Map();
    const suggest = new AtPathSuggest(this);
    this.registerEditorSuggest(suggest);
    if (!f_prioritizeRepositorySuggest(this, suggest)) console.warn("AtPath could not prioritize repository link suggestions");
    this.register(() => clearTimeout(suggest._suggestDebounceTimer));
    this.registerEditorExtension(f_buildRepositoryLinkView(this));
    f_captureEditorRepositoryLinks(this);
    this.register(() => {
      this._repositoryIndexClosed = true;
      clearTimeout(this._repositoryRefreshTimer);
      clearTimeout(this._repositoryMoveTimer);
      this._nativeRepositoryLinks?.unload();
    });
    this.app.workspace.onLayoutReady(() => this.f_refreshRepositoryIndex());
    this.registerEvent(this.app.vault.on("raw", path => {
      if (this._unindexedProbes.delete(path) && this._unindexedTargets.delete(path)) {
        this._tokenIndex.remove(path);
        this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
        this._scheduleRefresh();
      }
      if (path === REPOSITORY_MAP_PATH && Platform.isMobile) this.f_queueRepositoryRefresh();
      else if (!Platform.isMobile && /(?:^|\/)\.git(?:$|\/(?:config|HEAD|packed-refs|refs\/))/.test(path)) this.f_queueRepositoryRefresh();
    }));
    this.addCommand({ id: "refresh-repositories", name: "Refresh repository map",
      callback: () => {
        this._repositoryAliasAttempts.clear();
        this._repositoryAliasWarning = false;
        return this.f_refreshRepositoryIndex();
      } });
    this.registerEditorExtension(buildAtPathViewPlugin(this));
    this.registerEditorExtension(buildWikilinkViewPlugin(this));
    if (!Platform.isMobile) {
      this.registerEditorExtension(buildBufferCountListener(this));
    }

    // Drag-and-drop — registered behind a CM6 Compartment so the
    // `enableDragDropAtPath` toggle can reconfigure live without reload.
    this.dragDropCompartment = new Compartment();
    this.registerEditorExtension(
      this.dragDropCompartment.of(
        this.settings.enableDragDropAtPath !== false ? Prec.highest(buildDragDropExtension(this)) : []
      )
    );

    // Capture file-explorer drag sources from the DOM, since Obsidian does not
    // expose a stable DataTransfer MIME for internal vault drags. Listeners run
    // in the capture phase so we see the event before any handler can stop it.
    this._currentDragRefs = null;
    this.registerDomEvent(document, "dragstart", (evt) => {
      // Always clear first so a missed dragend can't leave stale refs in place.
      this._currentDragRefs = null;
      if (this.settings.enableDragDropAtPath === false) return;
      const refs = captureDragRefsFromExplorerDom(this, evt);
      if (refs.length > 0) this._currentDragRefs = refs;
    }, { capture: true });
    this.registerDomEvent(document, "dragend", () => {
      this._currentDragRefs = null;
    }, { capture: true });

    registerPostProcessor(this);

    // Status bar (desktop only — Obsidian's status bar is desktop-scoped)
    if (!Platform.isMobile) {
      this.noteBarEl = this.addStatusBarItem();
      this.noteBarEl.addClass("mod-clickable", "atpath-status-note");
      this.registerDomEvent(this.noteBarEl, "click", () => this.copyNoteWithAtPaths());

      this.linkedBarEl = this.addStatusBarItem();
      this.linkedBarEl.addClass("mod-clickable", "atpath-status-linked");
      this.linkedBarEl.setAttribute("aria-haspopup", "true");

      // Linked segment spans — built once, text updated in place so the
      // popover child survives between repaints.
      this._linkedLabelEl = this.linkedBarEl.createSpan({ cls: "atpath-label", text: "Links" });
      this._linkedValueEl = this.linkedBarEl.createSpan({ cls: "atpath-value", text: "" });
      this._linkedCountEl = this.linkedBarEl.createSpan({ cls: "atpath-count", text: "" });

      // Popover (anchored as child; all positioning lives in styles.css).
      this._popoverEl = this.linkedBarEl.createDiv({ cls: "atpath-linked-popover" });
      this._popoverEl.setAttribute("role", "dialog");
      this._popoverEl.setAttribute("hidden", "");
      this._popoverPinned = false;
      this._popoverHideTimer = null;
      this._popoverCheckedPaths = new Set();
      this._popoverCheckedSig = null;

      this.registerHoverLinkSource("atpath-status", {
        display: "AtPath status bar",
        defaultMod: true,
      });

      this._wireLinkedPopoverEvents();

      // Buffer-aware live counts (selection + active doc) — step 5.
      this._noteBufferTokens = null;
      this._selectionTokens = 0;

      this.updateStatusBar();
    }

    // Cache invalidation via vault events
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this._tokenIndex.upsert(file);
        }
        this._debouncedUpdateStatusBar();
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this._tokenIndex.upsert(file);
        if (file instanceof TFolder) this.f_queueRepositoryRefresh();
        this._suggestVaultGen = (this._suggestVaultGen || 0) + 1;
        if (this.core) {
          if (file instanceof TFolder) this.core.clearFoldersCache();
          this.core.clearFolderTokenMemo();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this._suggestVaultGen = (this._suggestVaultGen || 0) + 1;
        this._tokenIndex.remove(file.path);
        if (file instanceof TFolder && this.repositories.some(repo => repo.root === file.path || repo.root?.startsWith(file.path + "/"))) {
          this.f_queueRepositoryRefresh();
        }
        if (this.core) {
          if (file instanceof TFolder) this.core.clearFoldersCache();
          this.core.clearFolderTokenMemo();
        }
        this._debouncedUpdateStatusBar();
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this._suggestVaultGen = (this._suggestVaultGen || 0) + 1;
        this._tokenIndex.rename(file, oldPath);
        if (this.core) {
          if (file instanceof TFolder) this.core.clearFoldersCache();
          this.core.clearFolderTokenMemo();
        }
        this.f_queueRepositoryMove(file, oldPath);
        let movedPublishedState = false;
        // Update publishedPages key if renamed
        if (this.settings.publishedPages[oldPath]) {
          this.settings.publishedPages[file.path] = this.settings.publishedPages[oldPath];
          delete this.settings.publishedPages[oldPath];
          movedPublishedState = true;
        }
        if (renamePublishedHtmlAppState(this.settings, oldPath, file.path)) {
          movedPublishedState = true;
        }
        if (movedPublishedState) {
          void this.saveSettings();
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !isHtmlExtension(file.extension)) return;

        menu.addItem((item) =>
          item
            .setTitle("@Path: publish this HTML app...")
            .setIcon("upload")
            .onClick(() => new HtmlAppScopeModal(this.app, this, file).open())
        );
      })
    );

    // Status bar triggers
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this._linkedCountWatches.clear();
        this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
        this._noteBufferTokens = null;
        this._selectionTokens = 0;
        this.updateStatusBar();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", file => {
        if (file?.extension === "md") void this.f_discoverOpenedSource(file.path);
        this._noteBufferTokens = null;
        this._selectionTokens = 0;
        if (this.core) this.core.clearFolderTokenMemo();
        this.updateStatusBar();
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this._debouncedUpdateStatusBar();
      })
    );

    this.addSettingTab(new AtPathSettingTab(this.app, this));

    this.addCommand({
      id: "copy-note-with-atpaths",
      name: "Copy note with linked files to clipboard",
      editorCallback: () => this.copyNoteWithAtPaths(),
    });

    this.addCommand({
      id: "publish-to-vercel",
      name: "Publish current note to Vercel",
      callback: () => this.publishToVercel(),
    });

    this.addCommand({
      id: "dry-run-migration",
      name: "Preview legacy links for migration",
      callback: () => this.dryRunMigration(),
    });

    // Tray menu button in status bar
    if (!Platform.isMobile) {
      this.trayBarEl = this.addStatusBarItem();
      this.trayBarEl.addClass("mod-clickable", "atpath-tray-btn");
      this.trayBarEl.setText("@Path");
      this.registerDomEvent(this.trayBarEl, "click", (event) => this.showTrayMenu(event));
    }
  }

  showTrayMenu(event) {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Review legacy links for migration").setIcon("replace-all")
        .onClick(() => new MigrationPreviewModal(this.app, this).open())
    );
    menu.addItem((item) =>
      item.setTitle("Publish to Vercel").setIcon("upload")
        .onClick(() => this.publishToVercel())
    );
    menu.addItem((item) =>
      item.setTitle("Copy with linked files").setIcon("clipboard-copy")
        .onClick(() => this.copyNoteWithAtPaths())
    );
    menu.addItem((item) =>
      item.setTitle("Settings").setIcon("settings")
        .onClick(() => {
          this.app.setting.open();
          this.app.setting.openTabById(this.manifest.id);
        })
    );
    menu.showAtMouseEvent(event);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    try { f_parseFolderCountExclusions(this.settings.folderCountExclusions); }
    catch (error) {
      console.warn("AtPath invalid folder exclusions; using the default", error);
      this.settings.folderCountExclusions = DEFAULT_FOLDER_COUNT_EXCLUSIONS;
      new Notice("Invalid folder exclusions. Using 90_archive; edit the list in AtPath settings.");
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  reconfigureDragDrop() {
    if (!this.dragDropCompartment) return;
    const ext = this.settings.enableDragDropAtPath !== false
      ? Prec.highest(buildDragDropExtension(this))
      : [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      // `leaf.view.editor.cm` is the internal CM6 handle. Wrap in try/catch
      // so an Obsidian API rename doesn't crash the settings toggle —
      // a missed live-reconfigure is recoverable by reload, a crash isn't.
      const cm = leaf.view && leaf.view.editor && leaf.view.editor.cm;
      if (!cm) continue;
      try {
        cm.dispatch({ effects: this.dragDropCompartment.reconfigure(ext) });
      } catch (err) {
        console.warn("[atpath] drag-drop reconfigure failed for one leaf", err);
      }
    }
  }

  f_linkedCountSignature(path, folder) {
    const count = this._tokenIndex.get(path, folder);
    return count ? [count.tokens, count.pending, count.skipped, count.failed, count.counted, count.candidates].join(":") : "";
  }

  f_watchLinkedCount(path, folder) {
    const key = (folder ? "folder:" : "file:") + path;
    if (this._linkedCountWatches.has(key)) return;
    if (this._linkedCountWatches.size >= 500) this._linkedCountWatches.delete(this._linkedCountWatches.keys().next().value);
    this._linkedCountWatches.set(key, { path, folder, signature: this.f_linkedCountSignature(path, folder) });
  }

  async getTokenCount(vaultPath) {
    if (!this.settings.showTokenCounts) return null;
    this.f_watchLinkedCount(vaultPath, false);
    const file = this.app.vault.getAbstractFileByPath(vaultPath) || this._unindexedTargets.get(vaultPath);
    return file && (file instanceof TFile || file.localOnly) ? this._tokenIndex.request(file) : null;
  }

  f_updateBufferTokenCounts(view = this.app.workspace.getActiveViewOfType(MarkdownView), content) {
    if (!this.settings.showTokenCounts || !view) return;
    const state = view.editor.cm?.state;
    const selections = state ? state.selection.ranges.filter(range => !range.empty)
      .map(range => state.sliceDoc(range.from, range.to)) : [view.editor.getSelection?.() || ""].filter(Boolean);
    this._bufferTokenCounts.update(content ?? view.editor.getValue(), selections);
  }

  f_folderTokenCount(path) {
    this.f_watchLinkedCount(path, true);
    const total = this._tokenIndex.get(path, true);
    const limit = this.settings.maxFolderFiles || 500;
    if (total.candidates > limit) return { overCap: true, fileCount: total.candidates, limit };
    if (total.pending || total.skipped || total.failed) return { partial: Boolean(total.pending), skipped: total.skipped, failed: total.failed, tokens: total.tokens };
    return total.tokens;
  }

  f_bindReadingTokenBadge(context, badge, target, navigation) {
    let active = true;
    let generation = this._suggestVaultGen;
    let requestedPath;
    let probedPath;
    navigation?.onTarget(target);
    const paint = () => {
      if (!active) return;
      if (navigation && generation !== this._suggestVaultGen) {
        generation = this._suggestVaultGen;
        target = navigation.resolve();
        navigation.onTarget(target);
        requestedPath = undefined;
        probedPath = undefined;
      }
      const hidden = !this.settings.showTokenCounts || target.kind === "ignored";
      if (badge.hidden !== hidden) badge.hidden = hidden;
      if (hidden) return;
      const { kind, normalizedPath: path } = target;
      let text = "";
      let title = TOKEN_COUNT_DISCLOSURE;
      if (kind === "missing") {
        text = " (unavailable)";
        if (navigation && target.status === "missing" && target.vaultPath && probedPath !== target.vaultPath) {
          const path = target.vaultPath;
          probedPath = path;
          void navigation.probe(target).then(() => {
            if (!active || target.vaultPath !== path) return;
            target = navigation.resolve();
            navigation.onTarget(target);
            paint();
          }).catch(error => console.warn("AtPath could not resolve Reading view count", error));
        }
      } else if (kind === "folder") {
        const count = this.f_folderTokenCount(path);
        text = " (" + f_formatFolderTokenCount(count) + ")";
        if (count?.skipped) title = count.skipped + " files skipped. " + title;
        if (count?.failed) title = count.failed + " files failed to count; total is incomplete. " + title;
      } else if (kind === "file" && path != null) {
        const snapshot = this._tokenIndex.get(path);
        if (snapshot?.counted) text = " (" + formatTokens(snapshot.tokens) + ")";
        else if (snapshot?.failed) { text = " (!)"; title = "File failed to count. " + title; }
        else if (snapshot?.pending) {
          text = " (…)";
          this._tokenIndex.prioritize(path);
        } else if (!snapshot && requestedPath !== path) {
          requestedPath = path;
          void this.getTokenCount(path).then(paint)
            .catch(error => console.warn("AtPath could not count Reading view link", path, error));
        }
      }
      if (badge.textContent !== text) badge.textContent = text;
      if (badge.title !== title) badge.title = title;
    };
    const child = new MarkdownRenderChild(badge);
    const unsubscribe = this._tokenIndex.subscribe(paint);
    this._readingTokenRefreshes.add(paint);
    child.register(() => {
      active = false;
      unsubscribe();
      this._readingTokenRefreshes.delete(paint);
    });
    context.addChild(child);
    paint();
  }

  scheduleTokenFetch(vaultPath, view) {
    if (!this.settings.showTokenCounts) return;
    if (view) this._lastEditorView = view;
    void this.getTokenCount(vaultPath).catch(error => console.warn("AtPath could not count", vaultPath, error));
  }

  scheduleFolderTokenFetch(_folderPath, view) {
    if (view) this._lastEditorView = view;
  }

  _scheduleRefresh() {
    ATPATH_PERF.inc("scheduleRefresh.calls");
    if (this._refreshTimer) {
      ATPATH_PERF.inc("scheduleRefresh.coalesced");
      return;
    }
    ATPATH_PERF.inc("scheduleRefresh.scheduled");
    this._refreshTimer = window.setTimeout(() => {
      this._refreshTimer = null;
      ATPATH_PERF.inc("scheduleRefresh.fired");
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) leaf.view.editor?.cm?.dispatch();
      this.updateStatusBar();
    }, 150);
  }

  _debouncedUpdateStatusBar() {
    if (this._statusBarTimeout) clearTimeout(this._statusBarTimeout);
    this._statusBarTimeout = setTimeout(() => this.updateStatusBar(), 300);
  }

  async updateStatusBar() {
    ATPATH_PERF.inc("updateStatusBar.calls");
    const _usbT0 = ATPATH_PERF.enabled ? performance.now() : 0;
    if (!this.noteBarEl || !this.linkedBarEl) return; // mobile or pre-init

    const gen = ++this._statusBarGen;
    const clearBars = () => {
      this.noteBarEl.empty();
      this.noteBarEl.removeAttribute("aria-label");
      this._hideLinkedSegment();
      this._linkedTargets = [];
      this._lastLinkedTotal = 0;
      this._linkedPartial = false;
      this._linkedSig = "";
      this._renderLinkedPopover();
    };

    if (!this.settings.showTokenCounts) {
      clearBars();
      return;
    }

    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) { clearBars(); return; }

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) { clearBars(); return; }

    const content = mdView.editor.getValue();

    this.f_updateBufferTokenCounts(mdView, content);

    // Linked tokens — file + folder refs, deduped by normalized path.
    const refs = ATPATH_PERF.time("updateStatusBar.scanAtPathRefs", () => this.f_scanLinkedRefs(content, activeFile.path));
    ATPATH_PERF.inc("updateStatusBar.refs." + (refs.length < 5 ? "lt5" : refs.length < 15 ? "5-15" : refs.length < 30 ? "15-30" : "30+"));
    const seen = new Set();
    const linkedTargets = [];
    let linkedTotal = 0;

    let pendingOrOverCap = false;
    for (const ref of refs) {
      const resolved = this.f_resolveLinkTarget(ref, activeFile.path);
      if (resolved.kind === "missing") {
        if (resolved.vaultPath && ref.destination) void this.f_probeUnindexedTarget(resolved.vaultPath, resolved.repository);
        const key = "missing:" + (ref.destination || ref.displayPath);
        if (!seen.has(key)) {
          seen.add(key);
          linkedTargets.push({ kind: "missing", path: key, label: ref.displayPath, reason: resolved.reason, tokens: 0 });
          pendingOrOverCap = true;
        }
        continue;
      }
      const normalizedPath = resolved.normalizedPath;
      if (seen.has(normalizedPath)) continue;
      seen.add(normalizedPath);

      if (resolved.kind === "folder") {
        const cached = this.f_folderTokenCount(normalizedPath);
        if (cached == null) {
          const cm = mdView.editor && mdView.editor.cm ? mdView.editor.cm : this._lastEditorView;
          this.scheduleFolderTokenFetch(normalizedPath, cm);
          linkedTargets.push({ kind: "folder", path: normalizedPath, tokens: 0, pending: true });
          pendingOrOverCap = true;
          continue;
        }
        if (cached && typeof cached === "object" && cached.overCap) {
          linkedTargets.push({ kind: "folder", path: normalizedPath, tokens: 0, overCap: cached });
          pendingOrOverCap = true;
          continue;
        }
        const pending = Boolean(cached?.partial);
        const skipped = cached?.skipped;
        const failed = cached?.failed;
        pendingOrOverCap ||= pending || Boolean(skipped) || Boolean(failed);
        linkedTargets.push({ kind: "folder", path: normalizedPath, tokens: cached?.tokens ?? cached, pending, skipped, failed });
        continue;
      }

      const tokens = await this.getTokenCount(normalizedPath);
      if (gen !== this._statusBarGen) return;
      if (tokens != null) {
        linkedTargets.push({ kind: resolved.kind, path: normalizedPath, tokens, localOnly: resolved.target?.localOnly });
      } else if (this._tokenIndex.get(normalizedPath)?.failed) {
        linkedTargets.push({ kind: resolved.kind, path: normalizedPath, tokens: 0, failed: 1 });
        pendingOrOverCap = true;
      }
    }

    linkedTotal = f_uniqueLinkedTokenTotal(linkedTargets, this._folderCountExclusions);
    this._linkedTargets = linkedTargets;
    this._lastLinkedTotal = linkedTotal;
    this._linkedPartial = pendingOrOverCap;
    this._linkedSig = linkedTargets.map((t) => t.kind + ":" + t.path).sort().join("|");

    this._renderStatusBarSegments(this._noteBufferTokens, linkedTotal, linkedTargets.length, pendingOrOverCap);
    this._renderLinkedPopover();
    if (ATPATH_PERF.enabled) {
      ATPATH_PERF.record("updateStatusBar.totalMs", performance.now() - _usbT0);
    }
  }

  _repaintStatusBarFromBuffer() {
    if (!this.noteBarEl || !this.linkedBarEl) return;
    if (!this.settings.showTokenCounts) return;
    if (!this.app.workspace.getActiveViewOfType(MarkdownView)) return;
    const linkedCount = (this._linkedTargets || []).length;
    this._renderStatusBarSegments(
      this._noteBufferTokens,
      this._lastLinkedTotal || 0,
      linkedCount,
      !!this._linkedPartial
    );
  }

  _renderStatusBarSegments(noteTokens, linkedTotal, linkedCount, partial) {
    if (!this.noteBarEl || !this.linkedBarEl) return;

    this.noteBarEl.empty();
    const noteLabel = this.noteBarEl.createSpan({ cls: "atpath-label" });
    const noteValue = this.noteBarEl.createSpan({ cls: "atpath-value" });
    const sel = this._selectionTokens;
    if ((sel == null || sel > 0 || Number.isNaN(sel)) && this.settings.statusBarShowSelection !== false) {
      this.noteBarEl.addClass("atpath-status-has-selection");
      noteLabel.setText("Sel");
      noteValue.setText(formatTokens(sel) + " / " + formatTokens(noteTokens));
      this.noteBarEl.setAttribute(
        "aria-label",
        "Selection: " + (Number.isNaN(sel) ? "failed" : sel ?? "pending") + "\nNote: " + (Number.isNaN(noteTokens) ? "failed" : noteTokens ?? "pending") + "\n" + TOKEN_COUNT_DISCLOSURE
      );
    } else {
      this.noteBarEl.removeClass("atpath-status-has-selection");
      noteLabel.setText("Note");
      noteValue.setText(formatTokens(noteTokens));
      this.noteBarEl.setAttribute("aria-label", "Note: " + (Number.isNaN(noteTokens) ? "failed" : noteTokens ?? "pending") + "\n" + TOKEN_COUNT_DISCLOSURE);
    }

    if (linkedCount === 0) {
      this._hideLinkedSegment();
      return;
    }
    this._linkedLabelEl.removeClass("atpath-hidden");
    this._linkedValueEl.removeClass("atpath-hidden");
    this._linkedCountEl.removeClass("atpath-hidden");
    const suffix = partial ? "+" : "";
    this._linkedValueEl.setText(formatTokens(linkedTotal) + suffix);
    this._linkedCountEl.setText("(" + linkedCount + ")");
    this.linkedBarEl.setAttribute(
      "aria-label",
      "Links (" + linkedCount + "): " + linkedTotal.toLocaleString() + suffix + "\n" + TOKEN_COUNT_DISCLOSURE +
        (partial ? " — some targets still counting, skipped, failed or over the folder limit" : "")
    );
  }

  _hideLinkedSegment() {
    if (!this.linkedBarEl) return;
    this.linkedBarEl.removeAttribute("aria-label");
    if (this._linkedLabelEl) this._linkedLabelEl.addClass("atpath-hidden");
    if (this._linkedValueEl) this._linkedValueEl.addClass("atpath-hidden");
    if (this._linkedCountEl) this._linkedCountEl.addClass("atpath-hidden");
    this._hidePopoverImmediate();
  }

  _wireLinkedPopoverEvents() {
    if (!this.linkedBarEl || !this._popoverEl) return;

    this.registerDomEvent(this.linkedBarEl, "mouseenter", () => this._showPopover());
    this.registerDomEvent(this.linkedBarEl, "mouseleave", () => this._scheduleHidePopover());
    this.registerDomEvent(this._popoverEl, "mouseenter", () => this._showPopover());
    this.registerDomEvent(this._popoverEl, "mouseleave", () => this._scheduleHidePopover());

    this.registerDomEvent(this.linkedBarEl, "click", (evt) => {
      // Clicks inside the popover (checkboxes, buttons) should not toggle pin state.
      if (this._popoverEl && this._popoverEl.contains(evt.target)) return;
      this._popoverPinned = !this._popoverPinned;
      if (this._popoverPinned) {
        this.linkedBarEl.addClass("is-pinned");
        this._showPopover();
      } else {
        this.linkedBarEl.removeClass("is-pinned");
        this._scheduleHidePopover();
      }
    });

    this.registerDomEvent(document, "click", (evt) => {
      if (!this._popoverPinned) return;
      if (!this._popoverEl || this._popoverEl.hasAttribute("hidden")) return;
      const t = evt.target;
      if (this.linkedBarEl.contains(t)) return;
      if (this._popoverEl.contains(t)) return;
      this._hidePopoverImmediate();
    });
  }

  _showPopover() {
    if (!this._popoverEl) return;
    if ((this._linkedTargets || []).length === 0) return;
    if (this._popoverHideTimer) {
      window.clearTimeout(this._popoverHideTimer);
      this._popoverHideTimer = null;
    }
    this._popoverEl.removeAttribute("hidden");
  }

  _scheduleHidePopover() {
    if (!this._popoverEl) return;
    if (this._popoverPinned) return;
    if (this._popoverHideTimer) window.clearTimeout(this._popoverHideTimer);
    this._popoverHideTimer = window.setTimeout(() => {
      if (this._popoverEl) this._popoverEl.setAttribute("hidden", "");
      this._popoverHideTimer = null;
    }, 150);
  }

  _hidePopoverImmediate() {
    if (!this._popoverEl) return;
    if (this._popoverHideTimer) {
      window.clearTimeout(this._popoverHideTimer);
      this._popoverHideTimer = null;
    }
    this._popoverEl.setAttribute("hidden", "");
    this._popoverPinned = false;
    if (this.linkedBarEl) this.linkedBarEl.removeClass("is-pinned");
  }

  _renderLinkedPopover() {
    ATPATH_PERF.inc("popover.render.calls");
    if (!this._popoverEl) return;
    const targets = this._linkedTargets || [];

    if (targets.length === 0) {
      this._popoverEl.empty();
      this._popoverBuiltSig = "";
      this._popoverRowMap = null;
      this._popoverHeaderEl = null;
      this._popoverSelectedEl = null;
      this._hidePopoverImmediate();
      return;
    }

    const isSelectable = (t) => t.kind !== "missing" && !t.pending && !t.overCap;

    // Reset checked set when target list identity changes; preserve otherwise.
    if (this._popoverCheckedSig !== this._linkedSig) {
      this._popoverCheckedPaths = new Set(targets.filter(isSelectable).map((t) => t.path));
      this._popoverCheckedSig = this._linkedSig;
    } else {
      const liveSet = new Set(targets.map((t) => t.path));
      const selectableSet = new Set(targets.filter(isSelectable).map((t) => t.path));
      for (const p of [...this._popoverCheckedPaths]) {
        if (!liveSet.has(p) || !selectableSet.has(p)) this._popoverCheckedPaths.delete(p);
      }
    }

    // DOM build signature: order-sensitive AND includes the active file path,
    // because hover-link `sourcePath` is captured in each row's listener closure.
    // (`_linkedSig` is sorted — fine for checkbox-selection identity, but it
    // would let the fast path serve stale row order or a wrong sourcePath when
    // switching between notes that share the same target set.)
    const activeFile = this.app.workspace.getActiveFile();
    const sourcePath = activeFile ? activeFile.path : "";
    // Include pending/overCap truthiness so a row transitioning through
    // pending → over-cap → counted forces a full re-render rather than a
    // fast-path patch that would leave handlers + tooltips stale.
    const renderSig = sourcePath + "\n" +
      targets.map((t) =>
        t.kind + ":" + t.path +
        (t.pending ? ":p" : "") +
        (t.overCap ? ":o" : "")
      ).join("|");

    const partial = !!this._linkedPartial;
    const totalSuffix = partial ? "+" : "";

    // Fast path: same DOM identity — update mutable bits only.
    if (this._popoverBuiltSig === renderSig && this._popoverRowMap) {
      ATPATH_PERF.inc("popover.render.fastPath");
      if (this._popoverHeaderEl) {
        const w = targets.length === 1 ? "target" : "targets";
        this._popoverHeaderEl.setText(
          "Linked references · " + formatTokens(this._lastLinkedTotal || 0) + totalSuffix +
          " tokens · " + targets.length + " " + w
        );
      }
      for (const t of targets) {
        const refs = this._popoverRowMap.get(t.path);
        if (!refs) continue;
        if (refs.countEl) refs.countEl.setText(formatLinkedTargetCount(t));
        if (refs.cb) {
          const selectable = isSelectable(t);
          refs.cb.disabled = !selectable;
          if (!selectable) refs.cb.checked = false;
          else refs.cb.checked = this._popoverCheckedPaths.has(t.path);
        }
        if (refs.row) {
          const title = t.pending
            ? "Still counting…"
            : t.overCap
              ? "Skipped: over the configured max-files limit"
              : (t.kind === "folder" ? t.path + "/" : t.path);
          refs.row.setAttribute("title", title);
          if (t.pending) refs.row.addClass("atpath-linked-popover-row--pending");
          else refs.row.removeClass("atpath-linked-popover-row--pending");
          if (t.overCap) refs.row.addClass("atpath-linked-popover-row--overcap");
          else refs.row.removeClass("atpath-linked-popover-row--overcap");
        }
      }
      this._refreshPopoverSelectedTotal();
      return;
    }

    // Slow path: rebuild full DOM.
    ATPATH_PERF.inc("popover.render.slowPath");
    ATPATH_PERF.inc("popover.render.slowPath.targets." + (targets.length < 5 ? "lt5" : targets.length < 15 ? "5-15" : targets.length < 30 ? "15-30" : "30+"));
    this._popoverEl.empty();
    this._popoverRowMap = new Map();

    const header = this._popoverEl.createDiv({ cls: "atpath-linked-popover-header" });
    this._popoverHeaderEl = header;
    const targetWord = targets.length === 1 ? "target" : "targets";
    header.setText(
      "Linked references · " + formatTokens(this._lastLinkedTotal || 0) + totalSuffix +
      " tokens · " + targets.length + " " + targetWord
    );

    const rowsEl = this._popoverEl.createDiv({ cls: "atpath-linked-popover-rows" });

    for (const t of targets) {
      const row = rowsEl.createEl("label", { cls: "atpath-linked-popover-row" });
      if (t.kind === "folder") row.addClass("atpath-linked-popover-row--folder");
      if (t.pending) row.addClass("atpath-linked-popover-row--pending");
      if (t.overCap) row.addClass("atpath-linked-popover-row--overcap");

      const selectable = isSelectable(t);
      const cb = row.createEl("input", { type: "checkbox", cls: "atpath-linked-popover-check" });
      cb.checked = selectable && this._popoverCheckedPaths.has(t.path);
      cb.disabled = !selectable;
      cb.addEventListener("change", () => {
        if (!selectable) { cb.checked = false; return; }
        if (cb.checked) this._popoverCheckedPaths.add(t.path);
        else this._popoverCheckedPaths.delete(t.path);
        this._refreshPopoverSelectedTotal();
      });

      const iconEl = row.createSpan({ cls: "atpath-linked-popover-icon" });
      setIcon(iconEl, t.kind === "folder" ? "folder" : "file-text");

      const displayLabel = (t.label || this.f_displayLinkedPath(t.path, sourcePath)) +
        (t.kind === "folder" ? "/" : "");
      const pathSpan = row.createSpan({ cls: "atpath-linked-popover-path" });
      // <bdi> keeps the path reading LTR even though the container is
      // direction:rtl (used solely to anchor the ellipsis on the LEFT so
      // the filename tail stays visible — see styles.css).
      pathSpan.createEl("bdi", { text: displayLabel });
      const fullPath = t.kind === "folder" ? t.path + "/" : t.path;
      const rowTitle = t.reason || (t.pending
        ? "Still counting…"
        : t.overCap
          ? "Skipped: over the configured max-files limit"
          : t.skipped ? fullPath + " · " + t.skipped + " files skipped" : fullPath);
      pathSpan.setAttribute("title", rowTitle);
      row.setAttribute("title", rowTitle);

      const countEl = row.createSpan({
        cls: "atpath-linked-popover-count",
        text: formatLinkedTargetCount(t),
      });

      if (t.kind === "file") {
        // mouseenter (not mouseover) — does not bubble, so it fires once
        // per row entry rather than on every child traversal.
        row.addEventListener("mouseenter", (evt) => {
          this.app.workspace.trigger("hover-link", {
            event: evt,
            source: "atpath-status",
            hoverParent: this,
            targetEl: row,
            linktext: t.path,
            sourcePath,
          });
        });
      }

      this._popoverRowMap.set(t.path, { row, cb, countEl });
    }

    const footer = this._popoverEl.createDiv({ cls: "atpath-linked-popover-footer" });
    this._popoverSelectedEl = footer.createDiv({ cls: "atpath-linked-popover-selected" });

    const actions = footer.createDiv({ cls: "atpath-linked-popover-actions" });
    const allBtn = actions.createEl("button", {
      text: "All",
      cls: "atpath-linked-popover-btn",
    });
    allBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      this._popoverCheckedPaths = new Set(targets.filter(isSelectable).map((t) => t.path));
      this._renderLinkedPopover();
      this._showPopover();
    });

    const noneBtn = actions.createEl("button", {
      text: "None",
      cls: "atpath-linked-popover-btn",
    });
    noneBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      this._popoverCheckedPaths.clear();
      this._renderLinkedPopover();
      this._showPopover();
    });

    const copySelectedBtn = actions.createEl("button", {
      text: "Copy selected",
      cls: "atpath-linked-popover-btn",
    });
    copySelectedBtn.setAttribute("title", "Copy the contents of selected links");
    copySelectedBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      const selected = new Set(this._popoverCheckedPaths);
      void this.copySelectedAtPathsOnly({ paths: selected });
    });

    const copyWithNoteBtn = actions.createEl("button", {
      text: "Copy selected + note",
      cls: "atpath-linked-popover-btn atpath-linked-popover-btn--primary",
    });
    copyWithNoteBtn.setAttribute("title", "Copy the note and the contents of selected links");
    copyWithNoteBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      const selected = new Set(this._popoverCheckedPaths);
      void this.copyNoteWithAtPaths({ paths: selected });
    });

    this._popoverBuiltSig = renderSig;
    this._refreshPopoverSelectedTotal();
  }

  _refreshPopoverSelectedTotal() {
    if (!this._popoverSelectedEl) return;
    const targets = this._linkedTargets || [];
    const selected = targets.filter(target => !target.pending && !target.overCap && this._popoverCheckedPaths.has(target.path));
    const total = f_uniqueLinkedTokenTotal(selected, this._folderCountExclusions);
    const count = selected.length;
    const selectableCount = targets.filter(t => t.kind !== "missing" && !t.pending && !t.overCap).length;
    this._popoverSelectedEl.setText(
      "Selected: " + formatTokens(total) + " tokens" +
      " (" + count + "/" + selectableCount + ")"
    );
  }

  async copySelectedAtPathsOnly(opts) {
    const paths = opts?.paths;
    if (!(paths instanceof Set) || !paths.size) {
      new Notice("No linked targets selected.");
      return;
    }
    await this.f_copyLinkedContent(false, paths);
  }

  async copyNoteWithAtPaths(opts) {
    await this.f_copyLinkedContent(true, opts?.paths);
  }

  async f_copyLinkedContent(includeNote, selectedPaths) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const sourcePath = view?.file?.path ?? this.app.workspace.getActiveFile()?.path;
    if (!view || !sourcePath) {
      new Notice("No active note.");
      return;
    }
    const content = view.editor.getValue();
    const refs = this.f_scanLinkedRefs(content, sourcePath);
    const seenTargets = new Set();
    const includedFiles = new Set();
    const blocks = [];
    const skipped = [];
    const maxFiles = this.settings.maxFolderFiles || 500;

    const f_add = async file => {
      if (includedFiles.has(file.path)) return null;
      if (!this.f_eligibleLinkedFile(file)) {
        skipped.push(this.f_displayLinkedPath(file.path, sourcePath) + " (excluded or too large)");
        return null;
      }
      try {
        const text = await this.f_readLinkedFile(file);
        if (looksBinary(text)) {
          skipped.push(this.f_displayLinkedPath(file.path, sourcePath) + " (binary)");
          return null;
        }
        includedFiles.add(file.path);
        return { path: this.f_displayLinkedPath(file.path, sourcePath), text };
      } catch {
        skipped.push(this.f_displayLinkedPath(file.path, sourcePath) + " (unreadable)");
        return null;
      }
    };

    for (const ref of refs) {
      const result = await this.f_resolveLinkTargetAsync(ref, sourcePath);
      const path = result.normalizedPath;
      if (selectedPaths && !selectedPaths.has(path)) continue;
      const key = path ?? ref.destination ?? ref.displayPath;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      if (result.kind === "missing") {
        skipped.push((ref.destination || ref.displayPath) + " (" + (result.reason || "unavailable") + ")");
      } else if (result.kind === "file") {
        const block = await f_add(result.target);
        if (block) blocks.push(block);
      } else if (result.kind === "folder") {
        const files = [];
        let excluded = 0;
        const pending = [result.target];
        while (pending.length && files.length <= maxFiles) {
          const item = pending.pop();
          if (item instanceof TFolder) {
            if (item !== result.target && f_isFolderCountBoundary(item.path, this._folderCountExclusions ?? [])) continue;
            for (let index = item.children.length - 1; index >= 0; index--) pending.push(item.children[index]);
          } else if (item instanceof TFile) {
            if (this.f_eligibleLinkedFile(item)) files.push(item);
            else excluded++;
          }
        }
        const label = this.f_displayLinkedPath(path, sourcePath);
        if (files.length > maxFiles) {
          skipped.push(label + " (over the " + maxFiles + "-file limit)");
          continue;
        }
        if (excluded) skipped.push(label + " (" + excluded + " excluded or oversized files)");
        const folderBlocks = [];
        for (const file of files) {
          const block = await f_add(file);
          if (block) folderBlocks.push(block);
        }
        if (folderBlocks.length) {
          blocks.push({ heading: "--- " + label + " (" + folderBlocks.length + " files) ---" });
          blocks.push(...folderBlocks);
        }
      }
    }
    const added = includedFiles.size;
    if (!includeNote && !added) {
      new Notice("Nothing to copy." + (skipped.length ? "\n" + skipped.join("\n") : ""), 0);
      return;
    }
    let output = includeNote ? content : "";
    for (const block of blocks) {
      if (output) output += "\n\n";
      if (block.heading) output += block.heading;
      else {
        const fence = makeFence(block.text);
        output += "## " + block.path + "\n\n" + fence + "\n" + block.text + "\n" + fence + "\n\n---";
      }
    }
    try {
      await copyToClipboard(output);
    } catch (error) {
      new Notice("Failed to copy to clipboard: " + error.message, 0);
      return;
    }
    new Notice("Copied " + (includeNote ? "note" + (added ? " and " : "") : "") +
      (added ? added + " linked file(s)" : "") + "." +
      (skipped.length ? "\nSkipped " + skipped.length + " target(s):\n" + skipped.join("\n") : ""), skipped.length ? 0 : 5000);
  }

  f_eligibleLinkedFile(file) {
    return !BINARY_EXTENSIONS.has(file.extension.toLowerCase())
      && file.stat.size <= this.settings.maxFileSizeMB * 1024 * 1024
      && !this.core.isIgnored(file.path)
      && f_isEligibleLinkedPath(file.path, this.app.vault.configDir);
  }

  f_readLinkedFile(file) {
    return file.localOnly ? this.app.vault.adapter.read(file.path) : this.app.vault.cachedRead(file);
  }

  async resolveLocalImages(md, activeFile) {
    const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let result = md;
    const replacements = [];
    let match;

    while ((match = imgRegex.exec(md)) !== null) {
      const src = match[2];
      if (/^https?:\/\//.test(src) || src.startsWith("data:")) continue;

      // Resolve vault path relative to active file
      const resolved = this.app.metadataCache.getFirstLinkpathDest(src, activeFile.path);
      if (!resolved || !(resolved instanceof TFile)) continue;

      try {
        const binary = await this.app.vault.readBinary(resolved);
        const bytes = new Uint8Array(binary);
        let b64 = "";
        for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
        b64 = btoa(b64);
        const ext = resolved.extension.toLowerCase();
        const mime = ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
        replacements.push({ original: match[2], dataUri: `data:${mime};base64,${b64}` });
      } catch (_) { /* skip unreadable images */ }
    }

    for (const r of replacements) {
      result = result.split(r.original).join(r.dataUri);
    }
    return result;
  }

  f_queueRepositoryRefresh() {
    clearTimeout(this._repositoryRefreshTimer);
    this._repositoryRefreshTimer = setTimeout(() => this.f_refreshRepositoryIndex(), 300);
  }

  f_repositoryIndexChanged() {
    this._suggestVaultGen = (this._suggestVaultGen || 0) + 1;
    this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
    this.tokenCacheDirty = true;
    for (const paint of this._readingTokenRefreshes) paint();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) leaf.view.editor?.cm?.dispatch();
    this._debouncedUpdateStatusBar();
    if (this._nativeRepositoryLinks) void this._nativeRepositoryLinks.refresh().catch(error =>
      console.warn("AtPath could not refresh repository backlinks", error));
  }

  f_sourceCheckoutIssue(sourcePath) {
    if (!f_isPrunedSourcePath(sourcePath)) return null;
    const repo = f_repositoryForPath(sourcePath, this.repositories);
    if (Platform.isMobile) {
      return repo?.root && f_isPrunedSourcePath(repo.root + "/.atpath-source") ? null :
        "Source checkout is unavailable in this device's repository map: " + sourcePath;
    }
    const check = this._sourceCheckoutChecks?.get(sourcePath.slice(0, sourcePath.lastIndexOf("/")));
    if (check?.reason) return check.reason;
    if (check && check.root === repo?.root) return null;
    return "Source checkout has not been verified: " + sourcePath;
  }

  async f_readOpenedSource(sourcePath, basePath) {
    const directory = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
    try {
      const repo = await f_discoverSourceCheckout(basePath, sourcePath);
      if (!this._repositoryIndexClosed) this._sourceCheckoutChecks.set(directory, { root: repo.root });
      return repo;
    } catch (error) {
      if (!this._repositoryIndexClosed) this._sourceCheckoutChecks.set(directory, { reason: error.message });
      return null;
    }
  }

  async f_discoverOpenedSource(sourcePath) {
    const adapter = this.app.vault.adapter;
    if (Platform.isMobile || this._repositoryIndexClosed || !f_isPrunedSourcePath(sourcePath)
      || typeof adapter.getBasePath !== "function") return;
    await this._repositoryRefresh;
    if (this._repositoryIndexClosed) return;
    const directory = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
    const check = this._sourceCheckoutChecks.get(directory);
    if (check && !check.reason && check.root === f_repositoryForPath(sourcePath, this.repositories)?.root) return;
    const repo = await this.f_readOpenedSource(sourcePath, adapter.getBasePath());
    if (this._repositoryIndexClosed) return;
    if (repo && !this.repositories.some(entry => entry.root === repo.root)) {
      const matches = this.repositories.filter(entry => entry.identity && entry.identity === repo.identity);
      const aliases = [...new Set(matches.flatMap(entry => entry.aliases || []))].sort();
      if (aliases.length) repo.aliases = aliases;
      this.repositories.push(repo);
      await this.f_persistRepositoryMap().catch(error => console.warn("AtPath could not save the opened source checkout", error));
    }
    this.f_repositoryIndexChanged();
  }

  async f_refreshRepositoryIndex() {
    if (this._repositoryIndexClosed) return;
    if (this._repositoryRefresh) {
      this._repositoryRefreshAgain = true;
      return;
    }
    const adapter = this.app.vault.adapter;
    this._repositoryRefresh = (async () => {
      this._sourceCheckoutChecks.clear();
      const cached = await f_readRepositoryMap(adapter).catch(error => {
        console.warn("AtPath could not read the repository map", error);
        return [];
      });
      if (this._repositoryIndexClosed) return;
      if (Platform.isMobile || !this.repositories.length) {
        this.repositories = cached;
        this._unindexedProbes.clear();
        this.f_repositoryIndexChanged();
      }
      if (!Platform.isMobile && typeof adapter.getBasePath === "function") {
        const basePath = adapter.getBasePath();
        const discovered = await f_discoverRepositories(basePath);
        if (this._repositoryIndexClosed) return;
        const prior = [...cached, ...this.repositories];
        const retainedRoots = new Set(prior.filter(repo =>
          repo.root && f_isPrunedSourcePath(repo.root + "/.atpath-source")
        ).map(repo => repo.root));
        for (const root of retainedRoots) {
          if (this._repositoryIndexClosed) return;
          const retained = await f_discoverSourceCheckout(basePath, root + "/.atpath-source").catch(() => null);
          if (retained?.root === root) discovered.push(retained);
        }
        const activePath = this.app.workspace.getActiveFile()?.path;
        if (activePath && f_isPrunedSourcePath(activePath)) {
          const activeRepo = await this.f_readOpenedSource(activePath, basePath);
          if (activeRepo && !discovered.some(repo => repo.root === activeRepo.root)) discovered.push(activeRepo);
        }
        if (this._repositoryIndexClosed) return;
        for (const repo of discovered) {
          const aliases = prior.filter(item => item.identity && item.identity === repo.identity)
            .flatMap(item => item.aliases || []);
          if (aliases.length) repo.aliases = [...new Set(aliases)].sort();
        }
        for (const repo of prior) {
          if (repo.identity && !discovered.some(item => item.identity === repo.identity)) {
            discovered.push({ identity: repo.identity, aliases: repo.aliases });
          }
        }
        this.repositories = discovered;
        this.f_repositoryIndexChanged();
        await this.f_persistRepositoryMap();
      }
      if (this._repositoryIndexClosed || !this.repositories.length || this._nativeRepositoryLinks) return;
      this._nativeRepositoryLinks = f_installNativeRepositoryLinks({
        metadataCache: this.app.metadataCache,
        vault: this.app.vault,
        scan: f_scanMarkdownLinks,
        resolve: (destination, sourcePath) => {
          if (!f_repositoryForPath(sourcePath, this.repositories)) return null;
          const result = this.f_resolveLinkTarget({ destination }, sourcePath, false);
          if (result.kind === "ignored") return null;
          return { file: result.target instanceof TFile ? result.target : null };
        },
      });
      if (!this._nativeRepositoryLinks) console.warn("AtPath repository backlinks are unavailable in this Obsidian version");
      else await this._nativeRepositoryLinks.refresh();
    })().catch(error => console.warn("AtPath could not refresh the repository map", error));
    try {
      await this._repositoryRefresh;
    } finally {
      this._repositoryRefresh = null;
      if (this._repositoryRefreshAgain) {
        this._repositoryRefreshAgain = false;
        this.f_queueRepositoryRefresh();
      }
    }
  }

  f_persistRepositoryMap() {
    this._repositoryMapWrite = (this._repositoryMapWrite ?? Promise.resolve()).catch(() => {}).then(() => {
      if (!this._repositoryIndexClosed) return f_writeRepositoryMap(this.app.vault.adapter, this.repositories);
    });
    return this._repositoryMapWrite;
  }

  f_requestRepositoryAlias(identity) {
    if (Platform.isMobile || this._repositoryIndexClosed) return;
    const owner = identity.split("/")[0] + "/";
    if (!this.repositories.some(repo => repo.identity?.startsWith(owner) || repo.aliases?.some(alias => alias.startsWith(owner)))) return;
    const lastAttempt = this._repositoryAliasAttempts.get(identity);
    if (lastAttempt && Date.now() - lastAttempt < 5 * 60 * 1000) return;
    this._repositoryAliasAttempts.set(identity, Date.now());
    this._repositoryAliasQueue = (this._repositoryAliasQueue ?? Promise.resolve()).then(async () => {
      if (this._repositoryIndexClosed) return;
      const canonical = await f_lookupRenamedRepository(identity);
      if (this._repositoryIndexClosed || !canonical || canonical === identity) return;
      const repositories = this.repositories;
      const matches = repositories.filter(repo => repo.identity === canonical);
      if (!matches.length) return;
      const oldAliases = repositories.filter(repo => repo.root === undefined && repo.identity === identity)
        .flatMap(repo => repo.aliases || []);
      for (const repo of matches) repo.aliases = [...new Set([...(repo.aliases || []), ...oldAliases, identity])].sort();
      this.repositories = repositories.filter(repo => repo.root !== undefined || repo.identity !== identity);
      this.f_repositoryIndexChanged();
      await this.f_persistRepositoryMap();
    }).catch(error => {
      if (this._repositoryAliasWarning) return;
      if (error.code === "ENOENT") {
        this._repositoryAliasWarning = true;
        console.warn("AtPath cannot look up GitHub repository renames because the GitHub CLI (gh) was not found.");
      } else if (/gh auth login|authentication required/i.test(error.stderr || "")) {
        this._repositoryAliasWarning = true;
        console.warn("AtPath cannot look up GitHub repository renames until the GitHub CLI is authenticated.");
      }
    });
  }

  f_displayLinkedPath(path, sourcePath) {
    const repo = f_repositoryForPath(path, this.repositories);
    if (!repo) return path;
    const relative = repo.root ? path.slice(repo.root.length + 1) : path;
    const sourceRepo = f_repositoryForPath(sourcePath, this.repositories);
    return sourceRepo === repo ? relative || "/" : (repo.identity?.split("/")[1] ?? repo.root.split("/").pop()) + "/" + relative;
  }

  f_formatLinkedTarget(target, sourcePath) {
    const sourceIssue = this.f_sourceCheckoutIssue?.(sourcePath);
    if (sourceIssue) throw new Error(sourceIssue);
    return f_formatRepositoryLink(target.path === "/" ? "" : target.path, sourcePath, this.repositories,
      target instanceof TFolder ? "folder" : "file");
  }

  f_scanMarkdownRefs(content) {
    return f_scanMarkdownLinks(content).filter(link => link.destination && !link.destination.startsWith("#"))
      .map(link => ({
        ...link, format: "markdown", displayPath: link.label || link.destination,
        start: link.position.start.offset, end: link.position.end.offset,
      }));
  }

  f_scanLinkedRefs(content, sourcePath) {
    const markdown = this.f_scanMarkdownRefs(content);
    const managed = markdown.filter(ref => this.f_resolveLinkTarget(ref, sourcePath).kind !== "ignored");
    const legacy = scanAtPathRefs(content, this.app, sourcePath).filter(ref =>
      !markdown.some(link => ref.start < link.end && ref.end > link.start));
    return [...managed, ...legacy].sort((left, right) => left.start - right.start);
  }

  f_resolveLinkTarget(ref, sourcePath, lookupAlias = true) {
    if (!ref.destination) {
      const result = this.core.resolveAtPathTarget(ref, sourcePath);
      if (result.kind !== "missing" || ref.format !== "legacy") return result;
      const legacy = ref.displayPath?.replace(/\/+$/, "") || "";
      const sourceRepo = f_repositoryForPath(sourcePath, this.repositories);
      const [first, ...rest] = legacy.split("/");
      const matches = this.repositories.filter(repo => typeof repo.root === "string" &&
        (repo.identity?.split("/")[1] === first || repo.root.split("/").pop() === first));
      const candidates = [sourceRepo && [sourceRepo.root, legacy].filter(Boolean).join("/"),
        matches.length === 1 && rest.length && [matches[0].root, ...rest].filter(Boolean).join("/")];
      for (const path of candidates) {
        if (!path) continue;
        const target = this.app.vault.getAbstractFileByPath(path);
        if (ref.kind === "folder" ? target instanceof TFolder : target instanceof TFile) {
          return { kind: ref.kind, target, normalizedPath: path };
        }
      }
      return result;
    }
    if (ref.destination.startsWith("#")) return { kind: "ignored" };
    const vault = this.app.vault;
    let target;
    const result = f_resolveRepositoryLink(ref, {
      sourcePath,
      repositories: this.repositories,
      getTargetType: path => {
        target = path ? (vault.getAbstractFileByPath(path) || this._unindexedTargets.get(path)) : vault.getRoot();
        return target instanceof TFolder ? "folder" : target instanceof TFile || target?.localOnly ? "file" : null;
      },
    });
    if (lookupAlias && result.repository && (result.status === "out-of-scope" ||
      (result.status === "missing" && result.vaultPath === undefined))) this.f_requestRepositoryAlias(result.repository);
    if (result.status === "out-of-scope") {
      return { ...result, kind: "ignored" };
    }
    const sourceIssue = this.f_sourceCheckoutIssue?.(sourcePath);
    if (sourceIssue) return { status: "missing", kind: "missing", reason: sourceIssue, sourcePath };
    if (result.status === "missing" && /^\/(?:Users|home|Volumes|private|tmp)\//.test(ref.destination)) {
      result.reason = "This absolute-looking destination is repository-relative. Migrate it to a repository path or a workspace GitHub link.";
    }
    if (result.status !== "resolved" && !f_isCanonicalRepositoryDestination(ref.destination)) {
      const pathname = ref.destination.split(/[?#]/)[0];
      if (!pathname.includes("/") && !pathname.includes(".")) return { ...result, status: "out-of-scope", kind: "ignored" };
      if (!f_repositoryForPath(sourcePath, this.repositories)) return { ...result, kind: "ignored" };
    }
    return { ...result, kind: result.status === "resolved" ? result.kind : "missing",
      target, normalizedPath: target?.path ?? result.vaultPath };
  }

  async f_resolveLinkTargetAsync(ref, sourcePath) {
    const result = this.f_resolveLinkTarget(ref, sourcePath);
    if (ref.destination && result.status === "missing" && result.vaultPath) {
      await this.f_probeUnindexedTarget(result.vaultPath, result.repository);
      return this.f_resolveLinkTarget(ref, sourcePath);
    }
    return result;
  }

  f_probeUnindexedTarget(path, identity) {
    if (this._unindexedProbes.has(path)) return this._unindexedProbes.get(path);
    if (this._unindexedProbes.size >= 500) this._unindexedProbes.delete(this._unindexedProbes.keys().next().value);
    const adapter = this.app.vault.adapter;
    const probe = (async () => {
      const stat = await adapter.stat(path);
      if (stat?.type !== "file" || this._repositoryIndexClosed || this.app.vault.getAbstractFileByPath(path)) return;
      if (!Platform.isMobile && typeof adapter.getBasePath === "function") {
        const { resolve, relative, sep, isAbsolute } = require("path");
        const { realpath } = require("fs").promises;
        const repo = f_repositoryForPath(path, this.repositories);
        if (!repo || repo.identity !== identity) return;
        const base = adapter.getBasePath();
        const [root, target] = await Promise.all([realpath(resolve(base, repo.root)), realpath(resolve(base, path))]);
        const relativePath = relative(root, target);
        if (relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath)) return;
      }
      if (this._repositoryIndexClosed) return;
      const file = { path, extension: path.includes(".") ? path.split(".").pop() : "", stat, localOnly: true };
      this._unindexedTargets.set(path, file);
      this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
      this._scheduleRefresh();
    })().catch(error => {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") console.warn("AtPath could not inspect linked file", path, error);
    });
    this._unindexedProbes.set(path, probe);
    return probe;
  }

  async f_openRepositoryTarget(result, newLeaf) {
    if (result.kind === "folder") {
      f_revealInFileExplorer(this.app, result.target);
    } else if (result.kind === "file") {
      if (result.target.localOnly) {
        if (Platform.isMobile) new Notice("File is available for copy but is outside the Obsidian index: " + result.normalizedPath);
        else openInDefaultApp(this, result.normalizedPath);
        return;
      }
      const leaf = this.app.workspace.getLeaf(newLeaf);
      const fragment = result.fragment;
      await leaf.openFile(result.target, fragment ? { eState: { subpath: fragment } } : {});
    } else {
      new Notice(result.reason || "Repository link target is unavailable");
    }
  }

  f_queueRepositoryMove(file, oldPath) {
    this._pendingRepositoryMoves ??= [];
    const moves = this._pendingRepositoryMoves;
    if (!moves.length) this._pendingRepositoryMap = this.repositories.slice();
    const newPath = file.path;
    // Obsidian emits a folder rename followed by each descendant rename.
    const parentMove = moves[moves.length - 1];
    if (parentMove?.isFolder && oldPath.startsWith(parentMove.oldPath + "/") &&
      newPath === parentMove.newPath + oldPath.slice(parentMove.oldPath.length)) return;
    // Keep event order: collapsing chains loses temporary-path swaps.
    moves.push({ oldPath, newPath, isFolder: file instanceof TFolder });
    clearTimeout(this._repositoryMoveTimer);
    this._repositoryMoveTimer = setTimeout(() => {
      const repositoriesBefore = this._pendingRepositoryMap;
      this._pendingRepositoryMoves = [];
      this._repositoryRename = (this._repositoryRename ?? Promise.resolve()).then(async () => {
        if (this._repositoryIndexClosed) return;
        const movedRoots = [];
        for (const repo of repositoriesBefore) {
          if (typeof repo.root !== "string") continue;
          let root = repo.root;
          for (const { oldPath, newPath } of moves) {
            if (root === oldPath || root.startsWith(oldPath + "/")) root = newPath + root.slice(oldPath.length);
          }
          if (root !== repo.root) movedRoots.push({ root, identity: repo.identity });
        }
        if (movedRoots.length) {
          // An in-flight refresh does not await a requested rerun. Finish it
          // before starting a fresh scan, then reject stale or failed maps.
          await this._repositoryRefresh;
          await this.f_refreshRepositoryIndex();
          if (this._repositoryIndexClosed) return;
          for (const repo of movedRoots) {
            if (!this.repositories.some(current => current.root === repo.root && current.identity === repo.identity)) {
              throw new Error("Renamed checkout could not be verified: " + repo.root);
            }
          }
        }
        await this.f_rewriteRepositoryReferences(moves, repositoriesBefore);
      }).catch(error => {
        console.warn("AtPath could not update links after a rename", error);
        new Notice("AtPath could not update links after a rename. Check the developer console for details.", 0);
      });
    }, 100);
  }

  async f_rewriteRepositoryReferences(moves, repositoriesBefore = this.repositories) {
    if (this._repositoryIndexClosed || !this.repositories.length) return;
    const repositories = this.repositories.slice();
    const failed = new Set();
    for (const mdFile of this.app.vault.getMarkdownFiles()) {
      if (this._repositoryIndexClosed) break;
      const rewrite = content => {
        const updated = f_rewriteRepositoryDestinations(content, {
          sourcePath: mdFile.path, moves, repositories, repositoriesBefore,
          getTargetType: path => {
            const target = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
            return target instanceof TFolder ? "folder" : target instanceof TFile ? "file" : null;
          },
          onError: (error, destination) => {
            failed.add(mdFile.path);
            console.warn("AtPath could not update repository link", mdFile.path, destination, error);
          },
        });
        return this.f_rewriteLegacyReferences(updated, mdFile.path, moves);
      };
      try {
        const content = await this.app.vault.cachedRead(mdFile);
        const updated = rewrite(content);
        if (updated !== content) {
          await this.app.vault.process(mdFile, current => current === content ? updated : rewrite(current));
        }
      } catch (error) {
        failed.add(mdFile.path);
        console.warn("AtPath could not update links in", mdFile.path, error);
      }
    }
    if (failed.size) {
      new Notice("AtPath could not update some links after a rename in " + failed.size + " note(s):\n" +
        [...failed].join("\n") + "\nCheck the developer console for details.", 0);
    }
  }

  getRepoRoots() {
    return discoverRepoRoots(this);
  }

  async collectAtPathFiles(content, activeFile) {
    const seen = new Set();
    const atPathFiles = [];
    for (const ref of this.f_scanLinkedRefs(content, activeFile.path)) {
      const result = await this.f_resolveLinkTargetAsync(ref, activeFile.path);
      if (result.kind !== "file" || seen.has(result.normalizedPath) || !this.f_eligibleLinkedFile(result.target)) continue;
      seen.add(result.normalizedPath);
      try {
        const text = await this.f_readLinkedFile(result.target);
        if (!looksBinary(text)) atPathFiles.push({
          relPath: this.f_displayLinkedPath(result.normalizedPath, activeFile.path),
          legacyLabel: ref.format === "markdown" ? null : ref.displayPath,
          vaultPath: result.normalizedPath,
          content: text,
        });
      } catch (error) {
        console.warn("AtPath could not read linked file for publishing", result.normalizedPath, error);
      }
    }
    return atPathFiles;
  }

  async collectFileProtocolHtmlFiles(content) {
    const FILE_PROTO_RE = /\[([^\]]*)\]\((file:\/\/\/[^)]+\.html?)\)/gi;
    const bundles = [];
    const seen = new Set();
    let m;

    let pathMod;
    let fileURLToPath;
    try {
      pathMod = require("path");
      fileURLToPath = require("url").fileURLToPath;
    } catch (_) {
      // Not available on mobile — skip
      return bundles;
    }

    while ((m = FILE_PROTO_RE.exec(content)) !== null) {
      const url = m[2];
      if (seen.has(url)) continue;
      seen.add(url);

      try {
        const absPath = fileURLToPath(url);
        const dirPath = pathMod.dirname(absPath);
        const entryFilename = pathMod.basename(absPath);
        const dirName = pathMod.basename(dirPath);
        const files = await collectDirectoryFiles(dirPath);
        bundles.push({ url, entryFilename, dirName, files });
      } catch (_) { /* skip unreadable directories */ }
    }

    return bundles;
  }

  async collectHtmlAppFolderFiles(htmlFile) {
    let pathMod;
    try {
      require("fs");
      pathMod = require("path");
    } catch (_) {
      throw new Error("Folder publishing is not available in this environment.");
    }

    const adapter = this.app.vault.adapter;
    if (!adapter || typeof adapter.getBasePath !== "function") {
      throw new Error("Folder publishing is only available on desktop.");
    }

    const basePath = adapter.getBasePath();
    const absoluteFilePath = pathMod.join(basePath, htmlFile.path);
    const absoluteFolderPath = pathMod.dirname(absoluteFilePath);
    return collectDirectoryFiles(absoluteFolderPath);
  }

  async publishToVercel() {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) { new Notice("No active note to publish."); return; }

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) { new Notice("No active file."); return; }

    const noteTitle = activeFile.basename;
    const notePath = activeFile.path;
    const content = mdView.editor.getValue();
    const atPathFiles = await this.collectAtPathFiles(content, activeFile);
    const fileProtoFiles = await this.collectFileProtocolHtmlFiles(content);
    const existingPageState = this.settings.publishedPages[notePath];
    const domain = ((existingPageState && existingPageState.projectName) || slugify(noteTitle)) + ".vercel.app";

    const publishData = {
      publishKind: "note",
      noteTitle,
      notePath,
      content,
      activeFile,
      atPathFiles,
      fileProtoFiles,
      domain,
      defaultProjectName: slugify(noteTitle),
      plugin: this,
    };

    const onConfirm = (modalOpts) => {
      this._executePublish(publishData, modalOpts);
    };
    const onUnpublish = () => {
      this._executeUnpublish(publishData);
    };
    // Store callbacks for UnpublishConfirmModal's "Go back"
    publishData._onConfirm = onConfirm;
    publishData._onUnpublish = onUnpublish;

    new PublishConfirmModal(this.app, publishData, onConfirm, onUnpublish).open();
  }

  async publishHtmlApp(htmlFile, scope) {
    if (!(htmlFile instanceof TFile) || !isHtmlExtension(htmlFile.extension)) {
      new Notice("Choose an HTML file to publish.");
      return;
    }

    let entryHtml;
    try {
      entryHtml = await this.app.vault.cachedRead(htmlFile);
    } catch (_) {
      new Notice("Could not read the selected HTML file.");
      return;
    }

    const existingAppState = getPublishedHtmlAppState(this.settings, htmlFile.path);
    const defaults = buildHtmlAppDefaults({
      filePath: htmlFile.path,
      scope,
      entryHtml,
      existingState: existingAppState,
    });

    const publishData = {
      publishKind: "html-app",
      noteTitle: defaults.siteTitle,
      sourcePath: htmlFile.path,
      htmlFile,
      publishScope: scope,
      domain: defaults.domain,
      defaultProjectName: defaults.defaultProjectName,
      plugin: this,
    };

    const onConfirm = (modalOpts) => {
      this._executeHtmlAppPublish(publishData, modalOpts);
    };
    const onUnpublish = () => {
      this._executeUnpublish(publishData);
    };
    publishData._onConfirm = onConfirm;
    publishData._onUnpublish = onUnpublish;

    new PublishConfirmModal(this.app, publishData, onConfirm, onUnpublish).open();
  }

  async _executePublish(publishData, opts) {
    const { noteTitle, notePath, content, activeFile, atPathFiles, fileProtoFiles } = publishData;
    const { token, compactLinks, isPrivate, approvedEmails, clerkPublishableKey, clerkSecretKey, projectName: chosenProjectName } = opts;
    const { contactUrl, contactLabel, siteIconDataUrl } = this.settings;

    if (token !== this.settings.vercelToken) {
      this.settings.vercelToken = token;
      await this.saveSettings();
    }

    this.trayBarEl?.setText("...");

    try {
      const atPathSlugs = new Map();
      const slugsByPath = new Map();
      const usedSlugs = new Set();
      for (const file of atPathFiles) {
        const base = slugifyPath(file.relPath) || "linked-file";
        let slug = base;
        for (let index = 2; usedSlugs.has(slug); index++) slug = base + "-" + index;
        usedSlugs.add(slug);
        slugsByPath.set(file.vaultPath, slug);
        if (file.legacyLabel) atPathSlugs.set(file.legacyLabel, slug);
      }
      const repositoryLinks = {
        sourcePath: notePath,
        resolveLink: (destination, sourcePath) => this.f_resolveLinkTarget({ destination }, sourcePath, false),
        slugsByPath,
      };

      let resolvedContent = await this.resolveLocalImages(content, activeFile);

      // Build slug map for file:/// HTML bundles and rewrite links
      const fileProtoSlugs = new Map();
      for (const bundle of fileProtoFiles) {
        let slug = slugifyPath(bundle.dirName);
        if (usedSlugs.has(slug)) slug += "-project";
        usedSlugs.add(slug);
        fileProtoSlugs.set(bundle.url, { slug, entryFilename: bundle.entryFilename });
      }
      resolvedContent = resolvedContent.replace(
        /\[([^\]]*)\]\((file:\/\/\/[^)]+\.html?)\)/gi,
        (match, text, url) => {
          const info = fileProtoSlugs.get(url);
          return info ? `[${text}](atpath/${info.slug}/${info.entryFilename})` : match;
        }
      );

      const mainHtml = buildMainPage(noteTitle, resolvedContent, atPathSlugs, contactUrl, contactLabel, compactLinks, siteIconDataUrl, repositoryLinks);

      const subPages = {};
      const deployFiles = [];

      for (const f of atPathFiles) {
        const slug = slugsByPath.get(f.vaultPath);
        const ext = f.vaultPath.split(".").pop().toLowerCase();
        const isHtmlFile = ext === "html" || ext === "htm";

        if (isHtmlFile) {
          // Serve raw HTML files as rendered pages instead of wrapping in code block
          const pageHtml = injectSiteIconIntoHtml(f.content, siteIconDataUrl);
          if (isPrivate) {
            subPages["atpath/" + slug] = pageHtml;
          } else {
            deployFiles.push({ path: "atpath/" + slug + ".html", content: pageHtml });
          }
        } else {
          const childFile = this.app.vault.getFileByPath(f.vaultPath);
          const atContent = childFile ? await this.resolveLocalImages(f.content, childFile) : f.content;
          const pageTitle = f.relPath.split("/").pop();
          const pageHtml = buildAtPathPage(pageTitle, atContent, noteTitle, contactUrl, contactLabel, siteIconDataUrl, { ...repositoryLinks, sourcePath: f.vaultPath });
          if (isPrivate) {
            subPages["atpath/" + slug] = pageHtml;
          } else {
            deployFiles.push({ path: "atpath/" + slug + ".html", content: pageHtml });
          }
        }
      }

      // Deploy file:/// HTML bundles (all files in directory)
      const bundleStaticFiles = [];
      for (const bundle of fileProtoFiles) {
        const info = fileProtoSlugs.get(bundle.url);
        for (const f of bundle.files) {
          const deployPath = "atpath/" + info.slug + "/" + f.relPath;
          const ext = (f.relPath.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || "";
          const isHtmlFile = ext === "html" || ext === "htm";

          if (isPrivate && isHtmlFile) {
            // HTML files served through auth
            subPages[deployPath.replace(/\.html?$/, "")] = injectSiteIconIntoHtml(f.content, siteIconDataUrl);
          } else if (isPrivate) {
            // Non-HTML assets bypass auth (publicly accessible)
            bundleStaticFiles.push({ path: deployPath, content: f.content, encoding: f.encoding });
          } else {
            deployFiles.push({
              path: deployPath,
              content: isHtmlFile ? injectSiteIconIntoHtml(f.content, siteIconDataUrl) : f.content,
              encoding: f.encoding,
            });
          }
        }
      }

      let result;
      const pageState = this.settings.publishedPages[notePath] || {};
      const projectSlug = pageState.projectName || chosenProjectName || slugify(noteTitle);
      const projectName = await ensureProject(token, projectSlug);

      if (isPrivate) {
        // Save Clerk settings
        if (clerkPublishableKey) {
          this.settings.clerkPublishableKey = clerkPublishableKey;
        }
        if (clerkSecretKey) {
          this.settings.clerkSecretKey = clerkSecretKey;
        }
        await this.saveSettings();

        const pages = { main: mainHtml, ...subPages };

        // Publisher email is always approved
        const allApproved = [...approvedEmails];
        const pubEmail = (this.settings.publisherEmail || "").toLowerCase().trim();
        if (pubEmail && !allApproved.includes(pubEmail)) {
          allApproved.push(pubEmail);
        }

        const waMatch = contactUrl.match(/wa\.me\/(\d+)/);
        const publisherWhatsapp = waMatch ? waMatch[1] : "";
        const authShellHtml = buildAuthShell(noteTitle, this.settings.clerkPublishableKey, this.settings.publisherEmail, publisherWhatsapp, siteIconDataUrl);
        const authFunctionSrc = buildAuthFunction({
          approvedEmails: allApproved,
          pages,
          projectName,
        });
        const approveFunctionSrc = buildApproveFunction({
          projectName,
          clerkPublishableKey: this.settings.clerkPublishableKey,
          publisherEmail: pubEmail,
        });

        const packageJson = JSON.stringify({
          type: "module",
          dependencies: { "@clerk/backend": "^2" },
        });

        const vercelJson = JSON.stringify({
          rewrites: [
            { source: "/((?!api/).*)", destination: "/index.html" },
          ],
        });

        const privateFiles = [
          { path: "index.html", content: authShellHtml },
          { path: "api/auth.js", content: authFunctionSrc },
          { path: "api/approve.js", content: approveFunctionSrc },
          { path: "package.json", content: packageJson },
          { path: "vercel.json", content: vercelJson },
          ...bundleStaticFiles,
        ];

        const envVars = {
          CLERK_SECRET_KEY: this.settings.clerkSecretKey,
        };

        result = await deployToVercel(token, noteTitle, privateFiles, {
          isPrivate: true,
          envVars,
          projectName,
          onProgress: (msg) => this.trayBarEl?.setText(msg),
        });

        // Save page state
        this.settings.publishedPages[notePath] = {
          ...pageState,
          url: result.url,
          projectName: result.projectName,
          publishedAt: new Date().toISOString(),
          isPrivate: true,
          isUnpublished: false,
          approvedEmails,
        };
        await this.saveSettings();
      } else {
        // Public publish
        deployFiles.unshift({ path: "index.html", content: mainHtml });
        result = await deployToVercel(token, noteTitle, deployFiles, {
          projectName,
          onProgress: (msg) => this.trayBarEl?.setText(msg),
        });

        this.settings.publishedPages[notePath] = {
          ...pageState,
          url: result.url,
          projectName: result.projectName,
          publishedAt: new Date().toISOString(),
          isPrivate: false,
          isUnpublished: false,
          approvedEmails: [],
        };
        await this.saveSettings();
      }

      this.trayBarEl?.setText("@Path");

      const linkedCount = atPathFiles.length + fileProtoFiles.length;
      const summary = "Deployed \"" + noteTitle + "\"" + (linkedCount > 0 ? " with " + linkedCount + " linked page" + (linkedCount > 1 ? "s" : "") : "")
        + (isPrivate ? " (private)" : "");

      let warning = "";
      if (result.deploymentState && result.deploymentState !== "READY") {
        warning += "Deployment did not succeed (state: " + result.deploymentState + ").";
        if (result.deploymentError) warning += " " + result.deploymentError;
      } else if (result.healthCheck && !result.healthCheck.ok) {
        warning += "Deployment is live but the health check failed.";
        if (result.healthCheck.detail) warning += " " + result.healthCheck.detail;
      }

      new PublishResultModal(this.app, { success: true, url: result.url, summary, warning }).open();
    } catch (e) {
      this.trayBarEl?.setText("@Path");
      new PublishResultModal(this.app, { success: false, error: e.message || String(e) }).open();
    }
  }

  async _executeHtmlAppPublish(publishData, opts) {
    const { htmlFile, sourcePath, publishScope } = publishData;
    const {
      token,
      projectName: chosenProjectName,
      siteTitle,
      isPrivate,
      approvedEmails = [],
      clerkPublishableKey,
      clerkSecretKey,
    } = opts;

    if (token !== this.settings.vercelToken) {
      this.settings.vercelToken = token;
      await this.saveSettings();
    }

    this.trayBarEl?.setText("...");

    try {
      const entryHtml = await this.app.vault.cachedRead(htmlFile);
      const folderFiles = publishScope === HTML_APP_SCOPE_FOLDER
        ? await this.collectHtmlAppFolderFiles(htmlFile)
        : [];
      let deployFiles = buildHtmlAppDeployFiles({
        scope: publishScope,
        entryFilePath: htmlFile.path,
        entryHtml,
        folderFiles,
      });
      deployFiles = applySiteIconToDeployFiles(deployFiles, this.settings.siteIconDataUrl);

      const pageState = getPublishedHtmlAppState(this.settings, sourcePath) || {};
      const projectSlug = pageState.projectName || chosenProjectName || publishData.defaultProjectName;
      const projectName = await ensureProject(token, projectSlug);
      let result;

      if (isPrivate) {
        if (clerkPublishableKey) {
          this.settings.clerkPublishableKey = clerkPublishableKey;
        }
        if (clerkSecretKey) {
          this.settings.clerkSecretKey = clerkSecretKey;
        }
        await this.saveSettings();

        const { htmlPages, staticFiles } = partitionHtmlAppDeployFiles(deployFiles);
        const allApproved = [...approvedEmails];
        const pubEmail = (this.settings.publisherEmail || "").toLowerCase().trim();
        if (pubEmail && !allApproved.includes(pubEmail)) {
          allApproved.push(pubEmail);
        }

        const waMatch = this.settings.contactUrl.match(/wa\.me\/(\d+)/);
        const publisherWhatsapp = waMatch ? waMatch[1] : "";
        const authShellHtml = buildAuthShell(siteTitle, this.settings.clerkPublishableKey, this.settings.publisherEmail, publisherWhatsapp, this.settings.siteIconDataUrl);
        const authFunctionSrc = buildAuthFunction({
          approvedEmails: allApproved,
          pages: htmlPages,
          projectName,
        });
        const approveFunctionSrc = buildApproveFunction({
          projectName,
          clerkPublishableKey: this.settings.clerkPublishableKey,
          publisherEmail: pubEmail,
        });

        const packageJson = JSON.stringify({
          type: "module",
          dependencies: { "@clerk/backend": "^2" },
        });

        const vercelJson = JSON.stringify({
          rewrites: [
            { source: "/((?!api/).*)", destination: "/index.html" },
          ],
        });

        const privateFiles = [
          { path: "index.html", content: authShellHtml },
          { path: "api/auth.js", content: authFunctionSrc },
          { path: "api/approve.js", content: approveFunctionSrc },
          { path: "package.json", content: packageJson },
          { path: "vercel.json", content: vercelJson },
          ...staticFiles,
        ];

        result = await deployToVercel(token, siteTitle, privateFiles, {
          isPrivate: true,
          envVars: { CLERK_SECRET_KEY: this.settings.clerkSecretKey },
          projectName,
          onProgress: (msg) => this.trayBarEl?.setText(msg),
        });
      } else {
        result = await deployToVercel(token, siteTitle, deployFiles, {
          projectName,
          onProgress: (msg) => this.trayBarEl?.setText(msg),
        });
      }

      setPublishedHtmlAppState(this.settings, sourcePath, {
        ...pageState,
        url: result.url,
        projectName: result.projectName,
        publishedAt: new Date().toISOString(),
        isPrivate: !!isPrivate,
        isUnpublished: false,
        approvedEmails: isPrivate ? approvedEmails : [],
        scope: publishScope,
        siteTitle,
      });
      await this.saveSettings();

      this.trayBarEl?.setText("@Path");

      const modeLabel = publishScope === HTML_APP_SCOPE_FOLDER ? "folder app" : "single HTML file";
      const summary = "Deployed \"" + siteTitle + "\" as a " + modeLabel
        + " (" + deployFiles.length + " file" + (deployFiles.length === 1 ? "" : "s") + ")"
        + (isPrivate ? " (private)." : ".");

      let warning = "";
      if (result.deploymentState && result.deploymentState !== "READY") {
        warning += "Deployment did not succeed (state: " + result.deploymentState + ").";
        if (result.deploymentError) warning += " " + result.deploymentError;
      } else if (result.healthCheck && !result.healthCheck.ok) {
        warning += "Deployment is live but the health check failed.";
        if (result.healthCheck.detail) warning += " " + result.healthCheck.detail;
      }

      new PublishResultModal(this.app, { success: true, url: result.url, summary, warning }).open();
    } catch (e) {
      this.trayBarEl?.setText("@Path");
      new PublishResultModal(this.app, { success: false, error: e.message || String(e) }).open();
    }
  }

  async _executeUnpublish(publishData) {
    const plugin = this;
    const token = plugin.settings.vercelToken;
    const pageState = getPublishState(plugin, publishData) || {};
    const title = pageState.siteTitle || publishData.noteTitle;

    if (!token) {
      new Notice("No Vercel token configured.");
      return;
    }

    plugin.trayBarEl?.setText("...");

    try {
      const placeholderHtml = buildUnpublishedPage(title, plugin.settings.siteIconDataUrl);
      const files = [{ path: "index.html", content: placeholderHtml }];
      // Use stored projectName to handle collision-suffixed names
      const deployName = pageState.projectName || title;
      await deployToVercel(token, title, files, { projectName: deployName });

      setPublishState(plugin, publishData, {
        ...pageState,
        isUnpublished: true,
      });
      await plugin.saveSettings();

      plugin.trayBarEl?.setText("@Path");
      new Notice("Unpublished \"" + title + "\". You can republish at any time.");
    } catch (e) {
      plugin.trayBarEl?.setText("@Path");
      new PublishResultModal(plugin.app, { success: false, error: e.message || String(e) }).open();
    }
  }

  dryRunMigration() {
    new MigrationPreviewModal(this.app, this).open();
  }

  async f_planRepositoryMigration() {
    const plan = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path.split("/").some(part => part === "90_archive" || part === "prompts")) continue;
      const content = await this.app.vault.cachedRead(file);
      const refs = this.f_scanLinkedRefs(content, file.path).filter(ref => ref.format !== "markdown");
      const edits = [];
      const skipped = [];
      for (const ref of refs) {
        const result = this.f_resolveLinkTarget(ref, file.path);
        if (result.kind === "missing") {
          skipped.push(ref.fullMatch);
          continue;
        }
        try {
          edits.push({ start: ref.start, end: ref.end, original: ref.fullMatch,
            replacement: this.f_formatLinkedTarget(result.target, file.path) });
        } catch {
          skipped.push(ref.fullMatch);
        }
      }
      if (edits.length || skipped.length) plan.push({ file, path: file.path, content, edits, skipped });
    }
    return plan;
  }

  async f_applyRepositoryMigration(plan) {
    let replaced = 0;
    const stale = [];
    for (const { file, path, content, edits } of plan) {
      if (!edits.length) continue;
      if (file.path !== path) {
        stale.push(path);
        continue;
      }
      await this.app.vault.process(file, current => {
        if (current !== content) {
          stale.push(path);
          return current;
        }
        let updated = current;
        for (const edit of edits.slice().reverse()) {
          updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
        }
        replaced += edits.length;
        return updated;
      });
    }
    new Notice("Migrated " + replaced + " legacy links." + (stale.length ?
      "\nSkipped files changed since preview:\n" + stale.join("\n") : ""), stale.length ? 0 : 5000);
  }

  onTokenSettingsChanged() {
    const enabled = this.settings.showTokenCounts;
    this._folderCountExclusions = f_parseFolderCountExclusions(this.settings.folderCountExclusions);
    this._tokenIndex.setFolderExclusions(this._folderCountExclusions);
    this.core?.clearFolderTokenMemo();
    this._tokenIndex.setEnabled(enabled);
    if (enabled) {
      void this._tokenIndex.start().then(() => {
        if (this.settings.showTokenCounts) return this._tokenIndex.sync();
      }).catch(error => console.warn("AtPath could not refresh token counts", error));
    }
    this._explorerTokenBadges?.refresh();
    this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
    for (const paint of this._readingTokenRefreshes) paint();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const editor = leaf.view.editor?.cm;
      if (!editor) continue;
      // The legacy view extension clears this flag during its own update.
      this.tokenCacheDirty = true;
      editor.dispatch();
    }
    this.updateStatusBar();
  }

  f_rewriteLegacyReferences(content, sourcePath, moves) {
    if (!content.includes("@")) return content;
    const sourceRepoRoot = getRepoRoot(sourcePath);
    let updated = content;
    for (const { oldPath, newPath, isFolder } of moves) {
      const oldRepoRoot = getRepoRoot(oldPath);
      const newRepoRoot = getRepoRoot(newPath);
      const oldRel = oldRepoRoot ? toRepoRelative(oldPath, oldRepoRoot) : oldPath;
      const newRel = newRepoRoot ? toRepoRelative(newPath, newRepoRoot) : newPath;
      const replacements = [];
      if (sourceRepoRoot === oldRepoRoot && oldRel !== newRel) replacements.push([oldRel, newRel]);
      if (oldRepoRoot && sourceRepoRoot !== oldRepoRoot) {
        if (oldPath !== newPath) replacements.push([oldPath, newPath]);
        if (oldRel !== newRel) {
          const oldName = oldRepoRoot.split("/").pop();
          const newName = newRepoRoot?.split("/").pop();
          replacements.push([oldName + "/" + oldRel, newName ? newName + "/" + newRel : newPath]);
        }
      }
      for (const [before, after] of replacements) {
        const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = isFolder
          ? `(?<=(?:^|[\\s(]))@${escaped}/`
          : `(?<=(?:^|[\\s(]))@${escaped}(?=$|[\\s)\\]},;:!?])`;
        updated = updated.replace(new RegExp(pattern, "gm"), "@" + after + (isFolder ? "/" : ""));
      }
    }

    // Native Obsidian updates wikilink targets; repair legacy display aliases
    // once against the final paths, including later folder moves in this batch.
    const renamedFiles = new Set();
    for (let index = 0; index < moves.length; index++) {
      if (moves[index].isFolder) continue;
      let path = moves[index].newPath;
      for (const { oldPath, newPath } of moves.slice(index + 1)) {
        if (path === oldPath || path.startsWith(oldPath + "/")) path = newPath + path.slice(oldPath.length);
      }
      renamedFiles.add(path);
    }
    return updated.replace(new RegExp(WIKILINK_ATPATH_RE.source, WIKILINK_ATPATH_RE.flags), (match, linkTarget) => {
      const resolved = this.app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
      if (!resolved || !renamedFiles.has(resolved.path)) return match;
      const targetRepoRoot = getRepoRoot(resolved.path);
      const display = !targetRepoRoot ? resolved.path : sourceRepoRoot === targetRepoRoot
        ? toRepoRelative(resolved.path, targetRepoRoot)
        : targetRepoRoot.split("/").pop() + "/" + toRepoRelative(resolved.path, targetRepoRoot);
      return "[[" + linkTarget + "|@" + display + "]]";
    });
  }
}

module.exports = AtPathPlugin;
