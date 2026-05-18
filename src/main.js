// obsidian-atpath — Autocomplete and navigate @path/to/file references
// Uses Obsidian API + CodeMirror 6.

const { Plugin, EditorSuggest, MarkdownView, TFile, TFolder, Menu, PluginSettingTab, Setting, Notice, Modal, Platform, setIcon, prepareFuzzySearch, renderResults, requestUrl } = require("obsidian");
const { ViewPlugin, Decoration, MatchDecorator, EditorView, WidgetType } = require("@codemirror/view");
const { Compartment, Prec } = require("@codemirror/state");
const { encode } = require("gpt-tokenizer/model/gpt-4o");

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
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

// Unified renderer for a linked-target row's count cell. Handles the
// pending placeholder, the over-cap sentinel, and the normal numeric
// case in one place so every consumer agrees.
function formatLinkedTargetCount(t) {
  if (!t) return "0";
  if (t.pending) return "…";
  if (t.overCap) return "> " + t.overCap.fileCount + " files";
  return formatTokens(t.tokens || 0);
}

const { buildMainPage, buildAtPathPage, buildUnpublishedPage, slugifyPath, AT_PATH_RE: HTML_AT_PATH_RE } = require("./html-builder");
const { deployToVercel, ensureProject, checkProjectAvailability, slugify } = require("./vercel-api");
const { buildAuthShell } = require("./auth-shell-builder");
const { buildAuthFunction, buildApproveFunction } = require("./auth-function-template");
const { applySiteIconToDeployFiles, injectSiteIconIntoHtml } = require("./site-icon");
const {
  createAtPathCore,
  REPOS_SEGMENT: CORE_REPOS_SEGMENT,
  getRepoRoot: coreGetRepoRoot,
  toRepoRelative: coreToRepoRelative,
  discoverRepoRoots: coreDiscoverRepoRoots,
  resolveAtPathFromSource: coreResolveAtPathFromSource,
  resolveAtPathFolderFromSource: coreResolveAtPathFolderFromSource,
  computeDisplayPath: coreComputeDisplayPath,
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
  linkFormat: "legacy",
  showTokenCounts: true,
  maxFileSizeMB: 5,
  maxFolderFiles: 500,
  folderEncodeBatchSize: 1,
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
  const basePath = plugin.app.vault.adapter.getBasePath();
  const absolutePath = require("path").join(basePath, vaultPath);
  require("electron").shell.openPath(absolutePath);
}

function showAtPathMenu(plugin, event, vaultPath) {
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle("Open in default app")
      .setIcon("arrow-up-right")
      .onClick(() => openInDefaultApp(plugin, vaultPath))
  );
  menu.showAtMouseEvent(event);
}

function revealFolderInExplorer(app, folder) {
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
  if (!revealed) {
    const fallback = app.workspace.openLinkText(folder.path, "", false);
    if (fallback && typeof fallback.catch === "function") {
      fallback.catch(() => {});
    }
  }
}

function showAtPathFolderMenu(plugin, event, folder) {
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle("Reveal in file explorer")
      .setIcon("folder")
      .onClick(() => revealFolderInExplorer(plugin.app, folder))
  );
  menu.addItem((item) =>
    item
      .setTitle("Open folder in default app")
      .setIcon("arrow-up-right")
      .onClick(() => openInDefaultApp(plugin, folder.path))
  );
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

const REPOS_SEGMENT = CORE_REPOS_SEGMENT;
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

/** Broad resolution for migration only — tries multiple strategies to find the file. */
function resolveAtPathBroad(relPath, sourceFilePath, plugin) {
  // 1. Try existing exact resolution
  const exact = resolveAtPathFromSource(relPath, sourceFilePath, plugin);
  if (plugin.app.vault.getAbstractFileByPath(exact) instanceof TFile) return exact;

  // 2. Obsidian's link resolver (indexed, handles basename + shortest-unique-path)
  const linked = plugin.app.metadataCache.getFirstLinkpathDest(relPath, sourceFilePath);
  if (linked) return linked.path;

  // 3. All-repo scan: try every discovered repo root
  const sourceRepoRoot = getRepoRoot(sourceFilePath);
  const allRoots = discoverRepoRoots(plugin);
  for (const [, root] of allRoots) {
    if (root === sourceRepoRoot) continue;
    const candidate = root + "/" + relPath;
    const file = plugin.app.vault.getAbstractFileByPath(candidate);
    if (file instanceof TFile) return candidate;
  }

  // 4. Suffix match (last resort — linear scan, fine for one-time migration)
  const suffix = "/" + relPath;
  const matches = plugin.app.vault.getFiles().filter(f => f.path.endsWith(suffix));
  if (matches.length === 1) return matches[0].path;
  if (matches.length > 1 && sourceRepoRoot) {
    const sameRepo = matches.find(f => f.path.startsWith(sourceRepoRoot + "/"));
    if (sameRepo) return sameRepo.path;
  }
  // Ambiguous or not found: return null
  return null;
}

// ─── B) EditorSuggest — Autocomplete ─────────────────────────────────

class AtPathSuggest extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor, file) {
    const line = editor.getLine(cursor.line);
    // Walk backwards from cursor to find @ trigger
    let start = cursor.ch - 1;
    while (start >= 0 && !/\s/.test(line[start]) && line[start] !== "@") {
      start--;
    }
    if (start < 0 || line[start] !== "@") return null;
    // @ must be at start of line or preceded by whitespace
    if (start > 0 && !/\s/.test(line[start - 1])) return null;

    const query = line.substring(start + 1, cursor.ch);
    return {
      start: { line: cursor.line, ch: start },
      end: cursor,
      query,
    };
  }

  getSuggestions(context) {
    const file = context.file;
    if (!file) return [];
    const sourcePath = file.path;
    const query = context.query || "";
    const showFolders = this.plugin.settings.suggestFolders !== false;
    const core = this.plugin.core;

    // Source-aware slash-trigger: @prefix/ → enumerate immediate children
    // of that folder (same-repo → vault-abs → prefix-match), per §3.4.6.
    if (showFolders && query.endsWith("/")) {
      const items = core.enumerateFolderCandidates(query, sourcePath);
      return items.map((item) => ({
        kind: item.kind,
        target: item.target,
        display: item.display,
        fuzzyResult: null,
      }));
    }

    const fuzzy = query ? prepareFuzzySearch(query) : null;
    const sourceRepoRoot = getRepoRoot(sourcePath);
    const tierOf = (path) => {
      if (sourceRepoRoot && path.startsWith(sourceRepoRoot + "/")) return 0;
      if (getRepoRoot(path)) return 1;
      return 2;
    };
    const tiers = [[], [], []];

    for (const f of this.app.vault.getFiles()) {
      const display = core.computeDisplayPath(f.path, sourcePath);
      let fuzzyResult = null;
      let score = 1;
      if (fuzzy) {
        fuzzyResult = fuzzy(display);
        if (!fuzzyResult) continue;
        score = fuzzyResult.score;
      }
      tiers[tierOf(f.path)].push({
        kind: "file", target: f, display, fuzzyResult, score,
      });
    }

    if (showFolders) {
      for (const folder of core.listAllFolders()) {
        const display = core.computeDisplayPath(folder.path, sourcePath) + "/";
        let fuzzyResult = null;
        let score = 1.3;
        if (fuzzy) {
          fuzzyResult = fuzzy(display);
          if (!fuzzyResult) continue;
          score = fuzzyResult.score * 1.3; // folder bias so they're not buried
        }
        tiers[tierOf(folder.path)].push({
          kind: "folder", target: folder, display, fuzzyResult, score,
        });
      }
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

  selectSuggestion(value, evt) {
    const { editor } = this.context;
    const { start, end } = this.context;
    const sourcePath = this.context.file?.path || "";
    const mode = this.plugin.settings.linkFormat === "wikilink" ? "wikilink" : "legacy";
    // Wikilink mode + folder = legacy `@folder/` form (formatAtPathInsertion
    // ignores `mode` for folders, per §3.4.7).
    const insertion = this.plugin.core.formatAtPathInsertion(value.target, sourcePath, mode);
    editor.replaceRange(insertion + " ", start, end);
  }
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
            const cached = plugin.core.getCachedFolderTokens(resolved.normalizedPath);
            if (cached == null) {
              plugin.scheduleFolderTokenFetch(resolved.normalizedPath, view);
              tokenStr = "…";
            } else if (cached && typeof cached === "object" && cached.overCap) {
              tokenStr = formatLinkedTargetCount({ overCap: cached });
            } else {
              tokenStr = formatTokens(cached);
            }
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
              revealFolderInExplorer(plugin.app, resolved.target);
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
  let pendingTimer = null;
  let lastDoc = null;

  function scheduleDocRetoken(view) {
    if (pendingTimer) return;
    ATPATH_PERF.inc("buffer.scheduleDocRetoken.scheduled");
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      try {
        const text = view.state.doc.toString();
        // Bucket doc size: <1KB, 1-5KB, 5-20KB, 20-100KB, 100KB+
        const kb = text.length / 1024;
        const bucket = kb < 1 ? "lt1k" : kb < 5 ? "1-5k" : kb < 20 ? "5-20k" : kb < 100 ? "20-100k" : "100k+";
        ATPATH_PERF.inc("buffer.encode.docSize." + bucket);
        plugin._noteBufferTokens = ATPATH_PERF.time("buffer.encode.doc", () => encode(text).length);
      } catch (err) {
        console.warn("[atpath] buffer token count failed", err);
      }
      plugin._repaintStatusBarFromBuffer();
    }, 80);
  }

  function recomputeSelection(state) {
    ATPATH_PERF.inc("buffer.recomputeSelection.calls");
    let total = 0;
    let nonEmpty = 0;
    for (const r of state.selection.ranges) {
      if (r.empty) continue;
      nonEmpty++;
      try {
        total += ATPATH_PERF.time("buffer.encode.selection", () => encode(state.sliceDoc(r.from, r.to)).length);
      } catch (err) {
        console.warn("[atpath] selection token count failed", err);
        return;
      }
    }
    if (nonEmpty > 0) ATPATH_PERF.inc("buffer.recomputeSelection.nonEmpty");
    plugin._selectionTokens = total;
    plugin._repaintStatusBarFromBuffer();
  }

  return EditorView.updateListener.of((update) => {
    ATPATH_PERF.inc("buffer.updateListener.calls");
    if (update.docChanged) {
      ATPATH_PERF.inc("buffer.updateListener.docChanged");
      if (lastDoc !== update.state.doc) {
        lastDoc = update.state.doc;
        scheduleDocRetoken(update.view);
      }
    }
    if (update.selectionSet) {
      ATPATH_PERF.inc("buffer.updateListener.selectionSet");
      recomputeSelection(update.state);
    }
  });
}

// ─── C3) CM6 drag-and-drop — insert @path refs on file-explorer drop ─

function extractDraggedVaultPaths(dataTransfer, plugin, sourcePath) {
  const app = plugin.app;
  const out = [];
  const seen = new Set();
  const addPath = (rawPath) => {
    if (!rawPath || typeof rawPath !== "string") return;
    const path = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!path || seen.has(path)) return;
    const target = app.vault.getAbstractFileByPath(path);
    if (!target) return;
    if (sourcePath && target.path === sourcePath) return; // skip self-ref
    seen.add(path);
    if (target instanceof TFile) {
      out.push({ kind: "file", vaultPath: target.path, target });
    } else if (target instanceof TFolder) {
      out.push({ kind: "folder", vaultPath: target.path, target });
    }
  };

  // Tier 0: drag source captured at dragstart from the file-explorer DOM.
  // Obsidian doesn't expose a public DataTransfer MIME for internal vault
  // drags, so we sniff `data-path` attributes ourselves and stash the result
  // on the plugin until dragend.
  const captured = plugin._currentDragRefs;
  if (Array.isArray(captured) && captured.length > 0) {
    for (const r of captured) addPath(r && r.vaultPath);
    if (out.length > 0) return out;
  }

  if (!dataTransfer) return out;

  const tryJsonMime = (mime) => {
    let raw;
    try { raw = dataTransfer.getData(mime); } catch (_) { return false; }
    if (!raw) return false;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return false; }
    if (parsed && Array.isArray(parsed.files)) {
      for (const f of parsed.files) addPath(f && f.path);
      return out.length > 0;
    }
    if (Array.isArray(parsed)) {
      for (const f of parsed) addPath(f && (f.path || f));
      return out.length > 0;
    }
    if (parsed && typeof parsed.path === "string") {
      addPath(parsed.path);
      return out.length > 0;
    }
    return false;
  };

  // Tier 1: Obsidian's internal MIMEs (probe defensively — exact name has shifted).
  if (tryJsonMime("application/obsidian-files")) return out;
  if (tryJsonMime("application/obsidian-file")) return out;
  if (tryJsonMime("application/x-obsidian-files")) return out;

  // Tier 2: text/uri-list (obsidian:// or file:// URLs).
  let uriList;
  try { uriList = dataTransfer.getData("text/uri-list"); } catch (_) { uriList = ""; }
  if (uriList) {
    const basePath = (app.vault.adapter && typeof app.vault.adapter.getBasePath === "function")
      ? app.vault.adapter.getBasePath()
      : "";
    for (const line of uriList.split(/\r?\n/)) {
      const url = line.trim();
      if (!url || url.startsWith("#")) continue;
      if (url.startsWith("obsidian://")) {
        try {
          const u = new URL(url);
          const fileParam = u.searchParams.get("file");
          if (fileParam) addPath(decodeURIComponent(fileParam));
        } catch (_) { /* skip malformed */ }
      } else if (url.startsWith("file://")) {
        let abs;
        try { abs = decodeURIComponent(url.replace(/^file:\/\//, "")); } catch (_) { continue; }
        if (basePath && abs.startsWith(basePath + "/")) {
          addPath(abs.substring(basePath.length + 1));
        }
      }
    }
    if (out.length > 0) return out;
  }

  // Tier 3: text/plain — bare vault path(s), one per line.
  let plain;
  try { plain = dataTransfer.getData("text/plain"); } catch (_) { plain = ""; }
  if (plain) {
    for (const line of plain.split(/\r?\n/)) {
      const path = line.trim();
      if (path) addPath(path);
    }
  }
  return out;
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

function insertAtPathRefs(view, pos, refs, plugin) {
  const sourcePath = plugin.app.workspace.getActiveFile()?.path || "";
  const mode = plugin.settings.linkFormat === "wikilink" ? "wikilink" : "legacy";
  const parts = [];
  for (const r of refs) {
    if (!r || !r.target) continue;
    parts.push(plugin.core.formatAtPathInsertion(r.target, sourcePath, mode));
  }
  if (parts.length === 0) return;
  const text = parts.join(" ") + " ";
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: "input.drop",
  });
}

function buildDragDropExtension(plugin) {
  return EditorView.domEventHandlers({
    dragover(evt, _view) {
      const refs = extractDraggedVaultPaths(
        evt.dataTransfer,
        plugin,
        plugin.app.workspace.getActiveFile()?.path || ""
      );
      if (!refs.length) return false;
      evt.preventDefault();
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = "link";
      return true;
    },
    drop(evt, view) {
      const sourcePath = plugin.app.workspace.getActiveFile()?.path || "";
      let refs = extractDraggedVaultPaths(evt.dataTransfer, plugin, sourcePath);
      if (!refs.length) return false;
      if (refs.length > 50) {
        new Notice("Drop limited to 50 paths");
        refs = refs.slice(0, 50);
      }
      evt.preventDefault();
      evt.stopPropagation();
      const dropPos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
      insertAtPathRefs(view, dropPos != null ? dropPos : view.state.selection.main.head, refs, plugin);
      plugin._currentDragRefs = null;
      return true;
    },
  });
}

// ─── D) markdownPostProcessor — Clickable links in Reading mode ──────

function registerPostProcessor(plugin) {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    // ── Wikilink @path references (rendered as a.internal-link by Obsidian) ──
    const internalLinks = el.querySelectorAll("a.internal-link");
    for (const link of internalLinks) {
      if (!link.textContent.startsWith("@")) continue;
      link.classList.add("atpath-link");
      const rawHref = link.dataset.href || link.getAttribute("href") || "";
      const vaultPath = resolveWikilinkHref(plugin, rawHref, ctx.sourcePath);
      link.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showAtPathMenu(plugin, e, vaultPath);
      });
      // Token count
      if (plugin.settings.showTokenCounts) {
        const tokenSpan = document.createElement("span");
        tokenSpan.className = "atpath-token-count";
        const cached = plugin.tokenCache.get(vaultPath);
        if (cached) {
          tokenSpan.textContent = " (" + formatTokens(cached.tokens) + ")";
        } else {
          plugin.getTokenCount(vaultPath).then(
            (tokens) => {
              if (tokens != null) {
                tokenSpan.textContent = " (" + formatTokens(tokens) + ")";
              }
            },
            (err) => console.warn("[atpath] token count failed", err)
          );
        }
        link.after(tokenSpan);
      }
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
              revealFolderInExplorer(plugin.app, resolved.target);
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

        if (plugin.settings.showTokenCounts) {
          const tokenSpan = document.createElement("span");
          tokenSpan.className = "atpath-token-count";
          if (kind === "folder") {
            const resolved = plugin.core.resolveAtPathTarget(
              { kind: "folder", vaultPath: capture },
              ctx.sourcePath
            );
            if (resolved.kind === "folder") {
              const cached = plugin.core.getCachedFolderTokens(resolved.normalizedPath);
              if (cached == null) {
                tokenSpan.textContent = " (…)";
                plugin.core.getFolderTokens(resolved.normalizedPath).then(
                  (result) => {
                    if (result && typeof result === "object" && result.overCap) {
                      tokenSpan.textContent = " (" + formatLinkedTargetCount({ overCap: result }) + ")";
                    } else {
                      tokenSpan.textContent = " (" + formatTokens(result || 0) + ")";
                    }
                  },
                  (err) => console.warn("[atpath] folder token count failed", err)
                );
              } else if (cached && typeof cached === "object" && cached.overCap) {
                tokenSpan.textContent = " (" + formatLinkedTargetCount({ overCap: cached }) + ")";
              } else {
                tokenSpan.textContent = " (" + formatTokens(cached) + ")";
              }
            }
          } else {
            const vaultPath = resolveAtPathFromSource(capture, ctx.sourcePath, plugin);
            const cached = plugin.tokenCache.get(vaultPath);
            if (cached) {
              tokenSpan.textContent = " (" + formatTokens(cached.tokens) + ")";
            } else {
              plugin.getTokenCount(vaultPath).then(
                (tokens) => {
                  if (tokens != null) {
                    tokenSpan.textContent = " (" + formatTokens(tokens) + ")";
                  }
                },
                (err) => console.warn("[atpath] token count failed", err)
              );
            }
          }
          parent.insertBefore(tokenSpan, textNode.nextSibling);
        }

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
      .setName("Preferred insert format")
      .setDesc("Wikilink format integrates with graph view, backlinks, and rename tracking. Legacy format uses plain @path text.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("legacy", "Legacy (@path)")
          .addOption("wikilink", "Wikilink ([[path|@path]])")
          .setValue(this.plugin.settings.linkFormat)
          .onChange(async (value) => {
            this.plugin.settings.linkFormat = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show token counts")
      .setDesc("Display token count badges next to @path references and a total in the status bar.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showTokenCounts).onChange(async (value) => {
          this.plugin.settings.showTokenCounts = value;
          await this.plugin.saveSettings();
          this.plugin.onTokenSettingsChanged();
        })
      );

    new Setting(containerEl)
      .setName("Max file size (MB)")
      .setDesc("Skip token counting for files larger than this.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxFileSizeMB)).onChange(async (value) => {
          const num = parseFloat(value);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.maxFileSizeMB = num;
            await this.plugin.saveSettings();
            this.plugin.core.clearFolderTokenMemo();
            this.plugin.tokenCacheDirty = true;
            this.plugin._scheduleRefresh();
          }
        })
      );

    new Setting(containerEl)
      .setName("Max files per folder reference")
      .setDesc("Folder @path references that resolve to more files than this show `> N files` instead of a token count, to avoid freezing Obsidian on huge folders.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxFolderFiles)).onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.maxFolderFiles = num;
            await this.plugin.saveSettings();
            this.plugin.core.clearFolderTokenMemo();
            this.plugin.tokenCacheDirty = true;
            this.plugin._scheduleRefresh();
          }
        })
      );

    new Setting(containerEl)
      .setName("Folder encode batch size")
      .setDesc("Lower = smoother UI but slower folder counts. Raise only if your vault is small.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.folderEncodeBatchSize)).onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.folderEncodeBatchSize = num;
            await this.plugin.saveSettings();
          }
        })
      );

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
      .setDesc("Include folder candidates in @-autocomplete. Folders always insert as `@folder/` regardless of the wikilink setting (wikilink mode is file-only).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.suggestFolders !== false)
          .onChange(async (value) => {
            this.plugin.settings.suggestFolders = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Drag-and-drop @path inserts")
      .setDesc("Dragging a file or folder from the file explorer into the editor inserts an `@path` ref at the drop point. Disable to restore Obsidian's default drag behavior (image embed, link-on-drop, etc.).")
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
      const heading = "Linked @path notes (" + atPathFiles.length + ")";
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
        .setName("Compact @path to file title?")
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
    contentEl.createEl("h2", { text: "Migrate @paths to wikilinks" });

    const statusEl = contentEl.createEl("p", { text: "Scanning files...", cls: "atpath-migration-status" });

    const mdFiles = this.app.vault.getMarkdownFiles();
    let totalResolvable = 0;
    let totalUnresolvable = 0;
    const fileResults = [];

    for (const mdFile of mdFiles) {
      const content = await this.app.vault.cachedRead(mdFile);
      const refs = scanAtPathRefs(content).filter(r => r.format === "legacy" && r.kind !== "folder");
      if (refs.length === 0) continue;
      let resolvable = 0;
      let unresolvable = 0;
      for (const ref of refs) {
        const vaultPath = resolveAtPathBroad(ref.displayPath, mdFile.path, this.plugin);
        if (!vaultPath) { unresolvable++; continue; }
        const file = this.app.vault.getAbstractFileByPath(vaultPath);
        if (file instanceof TFile) resolvable++;
        else unresolvable++;
      }
      totalResolvable += resolvable;
      totalUnresolvable += unresolvable;
      fileResults.push({ path: mdFile.path, resolvable, unresolvable });
    }

    const totalRefs = totalResolvable + totalUnresolvable;

    if (totalRefs === 0) {
      statusEl.setText("No legacy @path references found.");
      new Setting(contentEl)
        .addButton((btn) => btn.setButtonText("Close").onClick(() => this.close()));
      return;
    }

    statusEl.setText(
      totalRefs + " legacy @path ref(s) in " + fileResults.length + " file(s) \u2014 " +
      totalResolvable + " resolvable, " + totalUnresolvable + " unresolvable"
    );

    // File list
    const listContainer = contentEl.createDiv({ cls: "atpath-migration-list" });
    if (fileResults.length > 10) {
      const details = listContainer.createEl("details");
      details.createEl("summary", { text: "Show " + fileResults.length + " files" });
      const ul = details.createEl("ul");
      for (const f of fileResults) {
        ul.createEl("li", { text: f.path + " (" + f.resolvable + " resolvable, " + f.unresolvable + " unresolvable)" });
      }
    } else {
      const ul = listContainer.createEl("ul");
      for (const f of fileResults) {
        ul.createEl("li", { text: f.path + " (" + f.resolvable + " resolvable, " + f.unresolvable + " unresolvable)" });
      }
    }

    if (totalUnresolvable > 0) {
      contentEl.createEl("p", {
        text: "Unresolvable references will be skipped.",
        cls: "atpath-migration-note",
      });
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close())
      )
      .addButton((btn) =>
        btn.setButtonText("Convert all").setCta().onClick(async () => {
          this.close();
          await this.plugin.migrateToWikilinks();
        })
      );
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
    this._inFlightTokenFetches = new Set();
    this._inFlightFolderTokenFetches = new Set();
    this._refreshTimer = null;
    this._lastEditorView = null;
    this._statusBarGen = 0;
    this.core = createAtPathCore(this);

    this.registerEditorSuggest(new AtPathSuggest(this));
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
      this._linkedLabelEl = this.linkedBarEl.createSpan({ cls: "atpath-label", text: "@paths" });
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
      this._noteBufferTokens = 0;
      this._selectionTokens = 0;

      this.updateStatusBar();
    }

    // Cache invalidation via vault events
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this.tokenCache.delete(file.path);
          if (this.core) this.core.clearFolderTokenMemo();
        }
        this._debouncedUpdateStatusBar();
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.core) {
          if (file instanceof TFolder) this.core.clearFoldersCache();
          this.core.clearFolderTokenMemo();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.tokenCache.delete(file.path);
        if (this.core) {
          if (file instanceof TFolder) this.core.clearFoldersCache();
          this.core.clearFolderTokenMemo();
        }
        this._debouncedUpdateStatusBar();
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.tokenCache.delete(oldPath);
        if (this.core) {
          if (file instanceof TFolder) this.core.clearFoldersCache();
          this.core.clearFolderTokenMemo();
        }
        void this.updateAtPathReferences(file, oldPath);
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
        this._noteBufferTokens = 0;
        this._selectionTokens = 0;
        this.updateStatusBar();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this._noteBufferTokens = 0;
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
      name: "Copy note with @path contents to clipboard",
      editorCallback: () => this.copyNoteWithAtPaths(),
    });

    this.addCommand({
      id: "publish-to-vercel",
      name: "Publish current note to Vercel",
      callback: () => this.publishToVercel(),
    });

    this.addCommand({
      id: "dry-run-migration",
      name: "Dry-run: preview @path migration to wikilinks",
      callback: () => this.dryRunMigration(),
    });

    this.addCommand({
      id: "migrate-to-wikilinks",
      name: "Migrate @path references to wikilinks",
      callback: () => this.migrateToWikilinks(),
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
      item.setTitle("Migrate @paths to wikilinks").setIcon("replace-all")
        .onClick(() => new MigrationPreviewModal(this.app, this).open())
    );
    menu.addItem((item) =>
      item.setTitle("Publish to Vercel").setIcon("upload")
        .onClick(() => this.publishToVercel())
    );
    menu.addItem((item) =>
      item.setTitle("Copy with @path contents").setIcon("clipboard-copy")
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

  async getTokenCount(vaultPath) {
    ATPATH_PERF.inc("getTokenCount.calls");
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) return null;
    const ext = file.extension.toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return null;
    if (file.stat.size > this.settings.maxFileSizeMB * 1024 * 1024) return null;
    const cached = this.tokenCache.get(vaultPath);
    if (cached && cached.mtime === file.stat.mtime) {
      ATPATH_PERF.inc("getTokenCount.cacheHit");
      return cached.tokens;
    }
    ATPATH_PERF.inc("getTokenCount.cacheMiss");
    const content = await ATPATH_PERF.timeAsync("getTokenCount.cachedRead", () => this.app.vault.cachedRead(file));
    const kb = content.length / 1024;
    const bucket = kb < 1 ? "lt1k" : kb < 5 ? "1-5k" : kb < 20 ? "5-20k" : kb < 100 ? "20-100k" : "100k+";
    ATPATH_PERF.inc("getTokenCount.encodeSize." + bucket);
    const tokens = ATPATH_PERF.time("getTokenCount.encode", () => encode(content).length);
    this.tokenCache.set(vaultPath, { mtime: file.stat.mtime, tokens });
    return tokens;
  }

  scheduleTokenFetch(vaultPath, view) {
    ATPATH_PERF.inc("scheduleTokenFetch.calls");
    if (!this.settings.showTokenCounts) return;
    if (this._inFlightTokenFetches.has(vaultPath)) {
      ATPATH_PERF.inc("scheduleTokenFetch.deduped");
      return;
    }
    ATPATH_PERF.inc("scheduleTokenFetch.dispatched");
    this._inFlightTokenFetches.add(vaultPath);
    this._lastEditorView = view;
    this.getTokenCount(vaultPath).then(
      (tokens) => {
        this._inFlightTokenFetches.delete(vaultPath);
        if (tokens != null) {
          this.tokenCacheDirty = true;
          this._scheduleRefresh();
        }
      },
      (err) => {
        this._inFlightTokenFetches.delete(vaultPath);
        console.warn("[atpath] token count failed", err);
      }
    );
  }

  scheduleFolderTokenFetch(folderPath, view) {
    ATPATH_PERF.inc("scheduleFolderTokenFetch.calls");
    if (!this.settings.showTokenCounts) return;
    // Always refresh _lastEditorView when a live view is provided, even on
    // a deduped call — otherwise the refresh after the walk completes
    // dispatches to a stale view and the inline `…` placeholder stays put.
    if (view) this._lastEditorView = view;
    if (this._inFlightFolderTokenFetches.has(folderPath)) {
      ATPATH_PERF.inc("scheduleFolderTokenFetch.deduped");
      return;
    }
    ATPATH_PERF.inc("scheduleFolderTokenFetch.dispatched");
    this._inFlightFolderTokenFetches.add(folderPath);
    this.core.getFolderTokens(folderPath).then(
      () => {
        this._inFlightFolderTokenFetches.delete(folderPath);
        this.tokenCacheDirty = true;
        this._scheduleRefresh();
      },
      (err) => {
        this._inFlightFolderTokenFetches.delete(folderPath);
        console.warn("[atpath] folder token count failed", err);
      }
    );
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
      if (this._lastEditorView) {
        try {
          ATPATH_PERF.time("scheduleRefresh.dispatch", () => this._lastEditorView.dispatch());
        } catch (e) {}
      }
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

    const gen = ++this._statusBarGen;

    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) { clearBars(); return; }

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) { clearBars(); return; }

    const content = mdView.editor.getValue();

    // Note tokens — prefer the live buffer count (step 5 maintains it).
    // Fallback to encoding here if the listener hasn't ticked yet.
    let noteTokens = this._noteBufferTokens;
    if (!noteTokens) {
      ATPATH_PERF.inc("updateStatusBar.encodeFallback");
      noteTokens = ATPATH_PERF.time("updateStatusBar.encodeFallback.encode", () => encode(content).length);
      this._noteBufferTokens = noteTokens;
    }

    // Linked tokens — file + folder refs, deduped by normalized path.
    const refs = ATPATH_PERF.time("updateStatusBar.scanAtPathRefs", () => scanAtPathRefs(content, this.app, activeFile.path));
    ATPATH_PERF.inc("updateStatusBar.refs." + (refs.length < 5 ? "lt5" : refs.length < 15 ? "5-15" : refs.length < 30 ? "15-30" : "30+"));
    const seen = new Set();
    const linkedTargets = [];
    let linkedTotal = 0;

    let pendingOrOverCap = false;
    for (const ref of refs) {
      const resolved = this.core.resolveAtPathTarget(ref, activeFile.path);
      if (resolved.kind === "missing") continue;
      const normalizedPath = resolved.normalizedPath;
      if (seen.has(normalizedPath)) continue;
      seen.add(normalizedPath);

      if (resolved.kind === "folder") {
        const cached = this.core.getCachedFolderTokens(normalizedPath);
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
        linkedTotal += cached;
        linkedTargets.push({ kind: "folder", path: normalizedPath, tokens: cached });
        continue;
      }

      const tokens = await this.getTokenCount(normalizedPath);
      if (gen !== this._statusBarGen) return;
      if (tokens != null) {
        linkedTotal += tokens;
        linkedTargets.push({ kind: resolved.kind, path: normalizedPath, tokens });
      }
    }

    this._linkedTargets = linkedTargets;
    this._lastLinkedTotal = linkedTotal;
    this._linkedPartial = pendingOrOverCap;
    this._linkedSig = linkedTargets.map((t) => t.kind + ":" + t.path).sort().join("|");

    this._renderStatusBarSegments(noteTokens, linkedTotal, linkedTargets.length, pendingOrOverCap);
    this._renderLinkedPopover();
    if (ATPATH_PERF.enabled) {
      ATPATH_PERF.record("updateStatusBar.totalMs", performance.now() - _usbT0);
    }
  }

  _repaintStatusBarFromBuffer() {
    if (!this.noteBarEl || !this.linkedBarEl) return;
    if (!this.settings.showTokenCounts) return;
    const linkedCount = (this._linkedTargets || []).length;
    this._renderStatusBarSegments(
      this._noteBufferTokens || 0,
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
    const sel = this._selectionTokens || 0;
    if (sel > 0 && this.settings.statusBarShowSelection !== false) {
      this.noteBarEl.addClass("atpath-status-has-selection");
      noteLabel.setText("Sel");
      noteValue.setText(formatTokens(sel) + " / " + formatTokens(noteTokens));
      this.noteBarEl.setAttribute(
        "aria-label",
        "Selection: " + formatTokens(sel) + "\nNote: " + formatTokens(noteTokens)
      );
    } else {
      this.noteBarEl.removeClass("atpath-status-has-selection");
      noteLabel.setText("Note");
      noteValue.setText(formatTokens(noteTokens));
      this.noteBarEl.setAttribute("aria-label", "Note: " + formatTokens(noteTokens));
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
      "@paths (" + linkedCount + "): " + formatTokens(linkedTotal) + suffix +
        (partial ? " — some targets still counting or skipped" : "")
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

    const isSelectable = (t) => !t.pending && !t.overCap;

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
          "Linked @paths · " + formatTokens(this._lastLinkedTotal || 0) + totalSuffix +
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
      "Linked @paths · " + formatTokens(this._lastLinkedTotal || 0) + totalSuffix +
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

      const displayLabel = this.core.computeDisplayPath(t.path, sourcePath) +
        (t.kind === "folder" ? "/" : "");
      const pathSpan = row.createSpan({ cls: "atpath-linked-popover-path" });
      // <bdi> keeps the path reading LTR even though the container is
      // direction:rtl (used solely to anchor the ellipsis on the LEFT so
      // the filename tail stays visible — see styles.css).
      pathSpan.createEl("bdi", { text: displayLabel });
      const fullPath = t.kind === "folder" ? t.path + "/" : t.path;
      const rowTitle = t.pending
        ? "Still counting…"
        : t.overCap
          ? "Skipped: over the configured max-files limit"
          : fullPath;
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
    copySelectedBtn.setAttribute("title", "Copy only the contents of selected @paths (no note body)");
    copySelectedBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      const selected = new Set(this._popoverCheckedPaths);
      void this.copySelectedAtPathsOnly({ paths: selected });
    });

    const copyWithNoteBtn = actions.createEl("button", {
      text: "Copy selected + note",
      cls: "atpath-linked-popover-btn atpath-linked-popover-btn--primary",
    });
    copyWithNoteBtn.setAttribute("title", "Copy the note body plus the contents of selected @paths");
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
    let total = 0;
    let count = 0;
    for (const t of targets) {
      if (t.pending || t.overCap) continue;
      if (this._popoverCheckedPaths.has(t.path)) {
        total += (t.tokens || 0);
        count += 1;
      }
    }
    const selectableCount = targets.filter((t) => !t.pending && !t.overCap).length;
    this._popoverSelectedEl.setText(
      "Selected: " + formatTokens(total) + " tokens" +
      " (" + count + "/" + selectableCount + ")"
    );
  }

  async copySelectedAtPathsOnly(opts) {
    const filterPaths = opts && opts.paths instanceof Set ? opts.paths : null;
    if (!filterPaths || filterPaths.size === 0) {
      new Notice("No @paths selected.");
      return;
    }
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) {
      new Notice("No active note.");
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file.");
      return;
    }
    const content = mdView.editor.getValue();
    const refs = scanAtPathRefs(content, this.app, activeFile.path);
    const seen = new Set();
    const blocks = [];
    const failed = [];
    const skippedFolders = [];
    const sizeCapBytes = this.settings.maxFileSizeMB * 1024 * 1024;
    const maxFiles = this.settings.maxFolderFiles || 500;

    for (const ref of refs) {
      const resolvedRef = this.core.resolveAtPathTarget(ref, activeFile.path);
      const vaultPath = resolvedRef.normalizedPath;
      if (!vaultPath || seen.has(vaultPath)) continue;
      seen.add(vaultPath);
      if (!filterPaths.has(vaultPath)) continue;

      if (resolvedRef.kind === "folder") {
        const folderTarget = resolvedRef.target;
        if (!(folderTarget instanceof TFolder)) {
          failed.push(ref.displayPath);
          continue;
        }
        const folderFiles = [];
        let overCap = false;
        const walk = (node) => {
          if (overCap) return;
          for (const c of node.children) {
            if (overCap) return;
            if (c instanceof TFolder) {
              walk(c);
            } else if (c instanceof TFile) {
              if (this.core.isIgnored(c.path)) continue;
              if (c.stat.size > sizeCapBytes) continue;
              const fext = c.extension.toLowerCase();
              if (BINARY_EXTENSIONS.has(fext)) continue;
              folderFiles.push(c);
              if (folderFiles.length > maxFiles) { overCap = true; return; }
            }
          }
        };
        walk(folderTarget);
        if (overCap) {
          skippedFolders.push(ref.displayPath);
          continue;
        }

        let folderTokenTotal = 0;
        const folderBlocks = [];
        for (const f of folderFiles) {
          try {
            const fc = await this.app.vault.cachedRead(f);
            const tk = await this.getTokenCount(f.path);
            if (tk != null) folderTokenTotal += tk;
            folderBlocks.push({ type: "file", relPath: f.path, content: fc });
          } catch (_) { /* skip */ }
        }
        if (folderBlocks.length > 0) {
          blocks.push({
            type: "header",
            text: "--- @" + ref.displayPath + " (" + folderBlocks.length +
              (folderBlocks.length === 1 ? " file, " : " files, ") +
              formatTokens(folderTokenTotal) + " tokens) ---",
          });
          for (const fb of folderBlocks) blocks.push(fb);
        }
        continue;
      }

      if (resolvedRef.kind !== "file" || !(resolvedRef.target instanceof TFile)) {
        failed.push(ref.displayPath);
        continue;
      }
      const fileTarget = resolvedRef.target;
      const fileExt = (fileTarget.extension || "").toLowerCase();
      if (BINARY_EXTENSIONS.has(fileExt)) continue;
      if (fileTarget.stat && fileTarget.stat.size > sizeCapBytes) {
        failed.push(ref.displayPath);
        continue;
      }
      try {
        const fileContent = await this.app.vault.cachedRead(fileTarget);
        blocks.push({ type: "file", relPath: ref.displayPath, content: fileContent });
      } catch (_) {
        failed.push(ref.displayPath);
      }
    }

    if (blocks.length === 0) {
      new Notice("Nothing to copy — no readable selected @paths.");
      if (skippedFolders.length > 0) {
        new Notice(
          "Skipped " + skippedFolders.length + " folder(s) over the max-files limit: " +
          skippedFolders.join(", "),
          0
        );
      }
      return;
    }

    let output = "";
    for (const b of blocks) {
      if (b.type === "header") {
        output += b.text + "\n\n";
      } else {
        const fence = makeFence(b.content);
        output += "## @" + b.relPath + "\n\n" + fence + "\n" + b.content + "\n" + fence + "\n\n---\n\n";
      }
    }
    output = output.replace(/\n+$/, "") + "\n";

    try {
      await copyToClipboard(output);
    } catch (e) {
      new Notice("Failed to copy to clipboard: " + e.message, 0);
      return;
    }

    const fileBlockCount = blocks.filter((b) => b.type === "file").length;
    if (failed.length > 0) {
      const frag = document.createDocumentFragment();
      const header = document.createElement("div");
      header.textContent = "Copied " + fileBlockCount + " file(s), but " + failed.length + " @path(s) failed:";
      frag.appendChild(header);
      for (const p of failed) {
        const line = document.createElement("div");
        line.textContent = "  • @" + p;
        frag.appendChild(line);
      }
      new Notice(frag, 0);
    } else {
      new Notice("Copied " + fileBlockCount + " selected file(s) to clipboard.", 5000);
    }
    if (skippedFolders.length > 0) {
      new Notice(
        "Skipped " + skippedFolders.length + " folder(s) over the max-files limit: " +
        skippedFolders.join(", "),
        0
      );
    }
  }

  async copyNoteWithAtPaths(opts) {
    const filterPaths = opts && opts.paths instanceof Set ? opts.paths : null;
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) {
      new Notice("No active note to copy.");
      return;
    }
    const content = mdView.editor.getValue();
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file.");
      return;
    }

    const refs = scanAtPathRefs(content, this.app, activeFile.path);
    const seen = new Set();
    const blocks = []; // [{type:"file", relPath, content} | {type:"header", text}]
    const failed = [];
    const skippedFolders = [];
    const sizeCapBytes = this.settings.maxFileSizeMB * 1024 * 1024;
    const maxFiles = this.settings.maxFolderFiles || 500;

    for (const ref of refs) {
      const resolvedRef = this.core.resolveAtPathTarget(ref, activeFile.path);
      const vaultPath = resolvedRef.normalizedPath;
      if (!vaultPath || seen.has(vaultPath)) continue;
      seen.add(vaultPath);

      if (filterPaths && !filterPaths.has(vaultPath)) continue;

      if (resolvedRef.kind === "folder") {
        const folderTarget = resolvedRef.target;
        if (!(folderTarget instanceof TFolder)) {
          failed.push(ref.displayPath);
          continue;
        }

        const folderFiles = [];
        let overCap = false;
        const walk = (node) => {
          if (overCap) return;
          for (const c of node.children) {
            if (overCap) return;
            if (c instanceof TFolder) {
              walk(c);
            } else if (c instanceof TFile) {
              if (this.core.isIgnored(c.path)) continue;
              if (c.stat.size > sizeCapBytes) continue;
              const fext = c.extension.toLowerCase();
              if (BINARY_EXTENSIONS.has(fext)) continue;
              folderFiles.push(c);
              if (folderFiles.length > maxFiles) { overCap = true; return; }
            }
          }
        };
        walk(folderTarget);
        if (overCap) {
          skippedFolders.push(ref.displayPath);
          continue;
        }

        let folderTokenTotal = 0;
        const folderBlocks = [];
        for (const f of folderFiles) {
          try {
            const fc = await this.app.vault.cachedRead(f);
            const tk = await this.getTokenCount(f.path);
            if (tk != null) folderTokenTotal += tk;
            folderBlocks.push({ type: "file", relPath: f.path, content: fc });
          } catch (_) { /* skip unreadable file inside folder */ }
        }

        blocks.push({
          type: "header",
          text: "--- @" + ref.displayPath + " (" + folderBlocks.length +
            (folderBlocks.length === 1 ? " file, " : " files, ") +
            formatTokens(folderTokenTotal) + " tokens) ---",
        });
        for (const fb of folderBlocks) blocks.push(fb);
        continue;
      }

      // File branch
      const ext = ref.displayPath.split(".").pop().toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      if (resolvedRef.kind !== "file" || !(resolvedRef.target instanceof TFile)) {
        failed.push(ref.displayPath);
        continue;
      }
      try {
        const fileContent = await this.app.vault.cachedRead(resolvedRef.target);
        blocks.push({ type: "file", relPath: ref.displayPath, content: fileContent });
      } catch (e) {
        failed.push(ref.displayPath);
      }
    }

    // Strip wikilink syntax for clean clipboard output
    let output = content.replace(new RegExp(WIKILINK_ATPATH_RE.source, WIKILINK_ATPATH_RE.flags), (_, _target, display) => "@" + display);
    const fileBlockCount = blocks.filter((b) => b.type === "file").length;
    if (blocks.length > 0) {
      output += "\n\n---\n";
      for (const b of blocks) {
        if (b.type === "header") {
          output += "\n" + b.text + "\n";
        } else {
          const fence = makeFence(b.content);
          output += "\n## @" + b.relPath + "\n\n" + fence + "\n" + b.content + "\n" + fence + "\n\n---\n";
        }
      }
    }

    try {
      await copyToClipboard(output);
    } catch (e) {
      new Notice("Failed to copy to clipboard: " + e.message, 0);
      return;
    }

    if (failed.length > 0) {
      const frag = document.createDocumentFragment();
      const header = document.createElement("div");
      header.textContent = "Copied note, but " + failed.length + " @path(s) failed to resolve:";
      frag.appendChild(header);
      for (const p of failed) {
        const line = document.createElement("div");
        line.textContent = "  • @" + p;
        frag.appendChild(line);
      }
      new Notice(frag, 0);
    } else if (fileBlockCount > 0) {
      new Notice("Copied note + " + fileBlockCount + " file(s) to clipboard.", 5000);
    } else {
      new Notice("Copied note to clipboard (no @path references found).", 5000);
    }
    if (skippedFolders.length > 0) {
      new Notice(
        "Skipped " + skippedFolders.length + " folder(s) over the max-files limit: " +
        skippedFolders.join(", "),
        0
      );
    }
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

  getRepoRoots() {
    return discoverRepoRoots(this);
  }

  async collectAtPathFiles(content, activeFile) {
    const refs = scanAtPathRefs(content, this.app, activeFile.path);
    const seen = new Set();
    const atPathFiles = [];

    for (const ref of refs) {
      if (ref.kind === "folder") continue; // HTML publish inlines files only
      const relPath = ref.displayPath;
      const resolvedRef = this.core.resolveAtPathTarget(ref, activeFile.path);
      const vaultPath = resolvedRef.normalizedPath;
      if (!vaultPath || seen.has(vaultPath)) continue;
      seen.add(vaultPath);

      const ext = relPath.split(".").pop().toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      if (resolvedRef.kind !== "file" || !(resolvedRef.target instanceof TFile)) continue;

      try {
        const fileContent = await this.app.vault.cachedRead(resolvedRef.target);
        atPathFiles.push({ relPath, content: fileContent });
      } catch (_) { /* skip */ }
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

    this.trayBarEl.setText("...");

    try {
      const atPathSlugs = new Map();
      for (const f of atPathFiles) {
        atPathSlugs.set(f.relPath, slugifyPath(f.relPath));
      }

      let resolvedContent = await this.resolveLocalImages(content, activeFile);

      // Build slug map for file:/// HTML bundles and rewrite links
      const fileProtoSlugs = new Map();
      const usedSlugs = new Set(atPathSlugs.values());
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

      const mainHtml = buildMainPage(noteTitle, resolvedContent, atPathSlugs, contactUrl, contactLabel, compactLinks, siteIconDataUrl);

      const subPages = {};
      const deployFiles = [];

      for (const f of atPathFiles) {
        const slug = atPathSlugs.get(f.relPath);
        const ext = f.relPath.split(".").pop().toLowerCase();
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
          const atContent = await this.resolveLocalImages(f.content, activeFile);
          const pageTitle = f.relPath.split("/").pop();
          const pageHtml = buildAtPathPage(pageTitle, atContent, noteTitle, contactUrl, contactLabel, siteIconDataUrl);
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
          onProgress: (msg) => this.trayBarEl.setText(msg),
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
          onProgress: (msg) => this.trayBarEl.setText(msg),
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

      this.trayBarEl.setText("@Path");

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
      this.trayBarEl.setText("@Path");
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

    this.trayBarEl.setText("...");

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
          onProgress: (msg) => this.trayBarEl.setText(msg),
        });
      } else {
        result = await deployToVercel(token, siteTitle, deployFiles, {
          projectName,
          onProgress: (msg) => this.trayBarEl.setText(msg),
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

      this.trayBarEl.setText("@Path");

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
      this.trayBarEl.setText("@Path");
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

    plugin.trayBarEl.setText("...");

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

      plugin.trayBarEl.setText("@Path");
      new Notice("Unpublished \"" + title + "\". You can republish at any time.");
    } catch (e) {
      plugin.trayBarEl.setText("@Path");
      new PublishResultModal(plugin.app, { success: false, error: e.message || String(e) }).open();
    }
  }

  async dryRunMigration() {
    const mdFiles = this.app.vault.getMarkdownFiles();
    let resolvable = 0;
    let unresolvable = 0;
    let filesAffected = 0;

    for (const mdFile of mdFiles) {
      const content = await this.app.vault.cachedRead(mdFile);
      const refs = scanAtPathRefs(content).filter(r => r.format === "legacy" && r.kind !== "folder");
      if (refs.length === 0) continue;
      filesAffected++;
      for (const ref of refs) {
        const vaultPath = resolveAtPathBroad(ref.displayPath, mdFile.path, this);
        if (!vaultPath) { unresolvable++; continue; }
        const file = this.app.vault.getAbstractFileByPath(vaultPath);
        if (file instanceof TFile) {
          resolvable++;
        } else {
          unresolvable++;
        }
      }
    }

    const total = resolvable + unresolvable;
    new Notice(
      "Migration preview: " + total + " legacy @path ref(s) in " + filesAffected + " file(s).\n" +
      resolvable + " resolvable, " + unresolvable + " unresolvable (will be skipped).",
      0
    );
  }

  async migrateToWikilinks() {
    const mdFiles = this.app.vault.getMarkdownFiles();
    let converted = 0;
    let skipped = 0;
    let filesModified = 0;

    for (const mdFile of mdFiles) {
      const content = await this.app.vault.read(mdFile);
      const refs = scanAtPathRefs(content).filter(r => r.format === "legacy" && r.kind !== "folder");
      if (refs.length === 0) continue;

      let updated = content;
      // Process in reverse order so indices stay valid
      for (let i = refs.length - 1; i >= 0; i--) {
        const ref = refs[i];
        const vaultPath = resolveAtPathBroad(ref.displayPath, mdFile.path, this);
        if (!vaultPath) { skipped++; continue; }
        const file = this.app.vault.getAbstractFileByPath(vaultPath);
        if (!(file instanceof TFile)) {
          skipped++;
          continue;
        }
        const wikilink = this.app.fileManager.generateMarkdownLink(
          file, mdFile.path, undefined, "@" + ref.displayPath
        );
        updated = updated.substring(0, ref.start) + wikilink + updated.substring(ref.end);
        converted++;
      }

      if (updated !== content) {
        await this.app.vault.modify(mdFile, updated);
        filesModified++;
      }
    }

    this.settings.linkFormat = "wikilink";
    await this.saveSettings();

    new Notice(
      "Migration complete: converted " + converted + " ref(s) in " + filesModified + " file(s)." +
      (skipped > 0 ? " Skipped " + skipped + " unresolvable." : ""),
      0
    );
  }

  onTokenSettingsChanged() {
    this.tokenCacheDirty = true;
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mdView && mdView.editor && mdView.editor.cm) {
      try { mdView.editor.cm.dispatch(); } catch (e) {}
    }
    this.updateStatusBar();
  }

  async updateAtPathReferences(file, oldPath) {
    const oldRepoRoot = getRepoRoot(oldPath);
    const newRepoRoot = getRepoRoot(file.path);

    const oldRel = oldRepoRoot ? toRepoRelative(oldPath, oldRepoRoot) : oldPath;
    const newRel = newRepoRoot ? toRepoRelative(file.path, newRepoRoot) : file.path;

    const isFolder = !file.path.includes('.') || file.children !== undefined;
    const mdFiles = this.app.vault.getMarkdownFiles();

    // Pass 0: Wikilink alias repair
    // Obsidian updates link targets (short or full): [[target|@display]] → [[new_target|@display]]
    // We fix the display alias to match the new relative path
    if (!isFolder) {
      for (const mdFile of mdFiles) {
        const content = await this.app.vault.read(mdFile);
        const wlRe = new RegExp(WIKILINK_ATPATH_RE.source, WIKILINK_ATPATH_RE.flags);
        let match;
        let updated = content;
        let offset = 0;
        while ((match = wlRe.exec(content)) !== null) {
          const linkTarget = match[1];
          // Resolve the (possibly short) link target to check if it points to the renamed file
          const resolved = this.app.metadataCache.getFirstLinkpathDest(linkTarget, mdFile.path);
          if (!resolved || resolved.path !== file.path) continue;

          // Compute correct display for this referencing file
          const refRepoRoot = getRepoRoot(mdFile.path);
          let correctDisplay;
          if (newRepoRoot && refRepoRoot === newRepoRoot) {
            correctDisplay = toRepoRelative(file.path, newRepoRoot);
          } else if (newRepoRoot) {
            const repoName = newRepoRoot.substring(newRepoRoot.lastIndexOf("/") + 1);
            correctDisplay = repoName + "/" + toRepoRelative(file.path, newRepoRoot);
          } else {
            correctDisplay = file.path;
          }

          const replacement = "[[" + linkTarget + "|@" + correctDisplay + "]]";
          const start = match.index + offset;
          const end = start + match[0].length;
          updated = updated.substring(0, start) + replacement + updated.substring(end);
          offset += replacement.length - match[0].length;
        }
        if (updated !== content) {
          await this.app.vault.modify(mdFile, updated);
        }
      }
    }

    // Pass 1: repo-relative references (files inside the same repo)
    if (oldRel !== newRel) {
      const escaped = oldRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = isFolder
        ? `(?<=(?:^|[\\s(]))@${escaped}/`
        : `(?<=(?:^|[\\s(]))@${escaped}(?=$|[\\s)\\]},;:!?])`;
      const re = new RegExp(pattern, 'gm');
      const replacement = isFolder ? '@' + newRel + '/' : '@' + newRel;
      const scope = oldRepoRoot || "";

      for (const mdFile of mdFiles) {
        if (scope && !mdFile.path.startsWith(scope + "/")) continue;
        if (!scope && getRepoRoot(mdFile.path)) continue;

        const content = await this.app.vault.read(mdFile);
        if (!re.test(content)) continue;
        re.lastIndex = 0;
        const updated = content.replace(re, replacement);
        if (updated !== content) {
          await this.app.vault.modify(mdFile, updated);
        }
      }
    }

    // Pass 2: full-vault-path references (files outside the repo use @full/vault/path)
    if (oldRepoRoot && oldPath !== file.path) {
      const escaped = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = isFolder
        ? `(?<=(?:^|[\\s(]))@${escaped}/`
        : `(?<=(?:^|[\\s(]))@${escaped}(?=$|[\\s)\\]},;:!?])`;
      const re = new RegExp(pattern, 'gm');
      const replacement = isFolder ? '@' + file.path + '/' : '@' + file.path;

      for (const mdFile of mdFiles) {
        if (getRepoRoot(mdFile.path) === oldRepoRoot) continue;

        const content = await this.app.vault.read(mdFile);
        if (!re.test(content)) continue;
        re.lastIndex = 0;
        const updated = content.replace(re, replacement);
        if (updated !== content) {
          await this.app.vault.modify(mdFile, updated);
        }
      }
    }

    // Pass 3: cross-repo format references (@reponame/old-rel-path → @reponame/new-rel-path)
    if (oldRepoRoot && oldRel !== newRel) {
      const oldRepoName = oldRepoRoot.substring(oldRepoRoot.lastIndexOf("/") + 1);
      const newRepoName = newRepoRoot ? newRepoRoot.substring(newRepoRoot.lastIndexOf("/") + 1) : "";
      const oldCrossRef = oldRepoName + "/" + oldRel;
      const newCrossRef = newRepoName ? newRepoName + "/" + newRel : file.path;

      const escaped3 = oldCrossRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern3 = isFolder
        ? `(?<=(?:^|[\\s(]))@${escaped3}/`
        : `(?<=(?:^|[\\s(]))@${escaped3}(?=$|[\\s)\\]},;:!?])`;
      const re3 = new RegExp(pattern3, 'gm');
      const replacement3 = isFolder ? '@' + newCrossRef + '/' : '@' + newCrossRef;

      for (const mdFile of mdFiles) {
        if (getRepoRoot(mdFile.path) === oldRepoRoot) continue;

        const content = await this.app.vault.read(mdFile);
        if (!re3.test(content)) continue;
        re3.lastIndex = 0;
        const updated = content.replace(re3, replacement3);
        if (updated !== content) {
          await this.app.vault.modify(mdFile, updated);
        }
      }
    }
  }
}

module.exports = AtPathPlugin;
