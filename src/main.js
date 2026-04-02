// obsidian-atpath — Autocomplete and navigate @path/to/file references
// Uses Obsidian API + CodeMirror 6.

const { Plugin, EditorSuggest, MarkdownView, TFile, Menu, PluginSettingTab, Setting, Notice, Modal, prepareFuzzySearch, renderResults, requestUrl } = require("obsidian");
const { ViewPlugin, Decoration, MatchDecorator, EditorView, WidgetType } = require("@codemirror/view");
const { encode } = require("gpt-tokenizer/model/gpt-4o");

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
  ta.style.position = "fixed";
  ta.style.opacity = "0";
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

const { buildMainPage, buildAtPathPage, buildUnpublishedPage, slugifyPath, AT_PATH_RE: HTML_AT_PATH_RE } = require("./html-builder");
const { deployToVercel, ensureProject, checkProjectAvailability, slugify } = require("./vercel-api");
const { buildAuthShell } = require("./auth-shell-builder");
const { buildAuthFunction, buildApproveFunction } = require("./auth-function-template");
const { applySiteIconToDeployFiles, injectSiteIconIntoHtml } = require("./site-icon");
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

const REPOS_SEGMENT = "_repos/";

function getRepoRoot(filePath) {
  const idx = filePath.indexOf(REPOS_SEGMENT);
  if (idx === -1) return "";
  const afterRepos = filePath.substring(idx + REPOS_SEGMENT.length);
  const slash = afterRepos.indexOf("/");
  if (slash === -1) return "";
  return filePath.substring(0, idx + REPOS_SEGMENT.length + slash);
}

function toRepoRelative(filePath, repoRoot) {
  if (!repoRoot) return filePath;
  return filePath.substring(repoRoot.length + 1);
}

function discoverRepoRoots(plugin) {
  const now = Date.now();
  if (plugin._repoRootsCache && now - plugin._repoRootsCacheTime < 5000) {
    return plugin._repoRootsCache;
  }
  const roots = new Map();
  for (const file of plugin.app.vault.getFiles()) {
    const idx = file.path.indexOf(REPOS_SEGMENT);
    if (idx === -1) continue;
    const afterRepos = file.path.substring(idx + REPOS_SEGMENT.length);
    const slash = afterRepos.indexOf("/");
    if (slash === -1) continue;
    const repoName = afterRepos.substring(0, slash);
    if (!roots.has(repoName)) {
      roots.set(repoName, file.path.substring(0, idx + REPOS_SEGMENT.length + slash));
    }
  }
  plugin._repoRootsCache = roots;
  plugin._repoRootsCacheTime = now;
  return roots;
}

function resolveAtPathFromSource(relPath, sourceFilePath, plugin) {
  const sourceRepoRoot = getRepoRoot(sourceFilePath);

  // 1. Same-repo
  if (sourceRepoRoot) {
    const candidate = sourceRepoRoot + "/" + relPath;
    if (plugin.app.vault.getAbstractFileByPath(candidate)) return candidate;
  }

  // 2. Cross-repo: first segment may be a repo name
  const slashIdx = relPath.indexOf("/");
  if (slashIdx !== -1) {
    const firstSegment = relPath.substring(0, slashIdx);
    const rest = relPath.substring(slashIdx + 1);
    const repoRoots = discoverRepoRoots(plugin);
    const repoRoot = repoRoots.get(firstSegment);
    if (repoRoot) {
      const candidate = repoRoot + "/" + rest;
      if (plugin.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
  }

  // 3. Vault-relative
  if (plugin.app.vault.getAbstractFileByPath(relPath)) return relPath;

  // 4. Fallback: same-repo concat (preserves old behavior)
  return sourceRepoRoot ? sourceRepoRoot + "/" + relPath : relPath;
}

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

    const repoRoot = getRepoRoot(file.path);
    const allFiles = this.app.vault.getFiles();
    const query = context.query;

    const fuzzy = query ? prepareFuzzySearch(query) : null;

    const sameRepo = [];
    const crossRepo = [];
    const loose = [];

    for (const f of allFiles) {
      if (repoRoot && f.path.startsWith(repoRoot + "/")) {
        const rel = toRepoRelative(f.path, repoRoot);
        const candidate = { file: f, display: rel, repoRoot, fuzzyResult: null };
        if (fuzzy) {
          const result = fuzzy(rel);
          if (!result) continue;
          candidate.fuzzyResult = result;
        }
        sameRepo.push(candidate);
      } else {
        const fRepoRoot = getRepoRoot(f.path);
        if (fRepoRoot) {
          const repoName = fRepoRoot.substring(fRepoRoot.lastIndexOf("/") + 1);
          const rel = repoName + "/" + toRepoRelative(f.path, fRepoRoot);
          const candidate = { file: f, display: rel, repoRoot: fRepoRoot, fuzzyResult: null };
          if (fuzzy) {
            const result = fuzzy(rel);
            if (!result) continue;
            candidate.fuzzyResult = result;
          }
          crossRepo.push(candidate);
        } else {
          const candidate = { file: f, display: f.path, repoRoot: "", fuzzyResult: null };
          if (fuzzy) {
            const result = fuzzy(f.path);
            if (!result) continue;
            candidate.fuzzyResult = result;
          }
          loose.push(candidate);
        }
      }
    }

    const all = [...sameRepo, ...crossRepo, ...loose];
    if (fuzzy) {
      all.sort((a, b) => b.fuzzyResult.score - a.fuzzyResult.score);
    }
    return all.slice(0, 50);
  }

  renderSuggestion(value, el) {
    const titleEl = el.createDiv();
    if (value.fuzzyResult) {
      renderResults(titleEl, value.display, value.fuzzyResult);
    } else {
      titleEl.setText(value.display);
    }
  }

  selectSuggestion(value, evt) {
    const { editor } = this.context;
    const { start, end } = this.context;
    if (this.plugin.settings.linkFormat === "wikilink") {
      const sourcePath = this.context.file?.path || "";
      const link = this.plugin.app.fileManager.generateMarkdownLink(
        value.file, sourcePath, undefined, "@" + value.display
      );
      editor.replaceRange(link + " ", start, end);
    } else {
      editor.replaceRange("@" + value.display + " ", start, end);
    }
  }
}

// ─── C) CM6 ViewPlugin — Clickable links in Live Preview ─────────────

const AT_PATH_RE = /(?<=^|[\s(])@([\w\p{L}\p{M}./_-]+\.[\w]+|[\w\p{L}\p{M}./_-][\w\p{L}\p{M}./ _()&-]+?\.[\w]+)/gu;

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

  // Pass 1: wikilink format
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
      vaultPath,
      displayPath: m[2],
      format: "wikilink",
      fullMatch: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // Pass 2: legacy format — skip matches that overlap wikilink hits
  const legacyRe = new RegExp(AT_PATH_RE.source, AT_PATH_RE.flags);
  while ((m = legacyRe.exec(content)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (isInExcludedRange(start, excluded)) continue;
    const overlaps = results.some(r => start < r.end && end > r.start);
    if (overlaps) continue;
    results.push({
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
  const decorator = new MatchDecorator({
    regexp: AT_PATH_RE,
    decoration: (match, view, pos) => {
      const end = pos + match[0].length;
      const cursorInside = view.state.selection.ranges.some(
        r => r.from >= pos && r.to <= end
      );

      const attrs = { "data-atpath": match[1] };
      let tokenStr = null;
      if (plugin.settings.showTokenCounts) {
        const vaultPath = resolveAtPath(match[1], plugin);
        const cached = plugin.tokenCache.get(vaultPath);
        if (cached) tokenStr = formatTokens(cached.tokens);
        else plugin.scheduleTokenFetch(vaultPath, view);
      }

      if (!cursorInside) {
        return Decoration.replace({
          widget: new AtPathWidget(match[0], match[1], tokenStr),
        });
      }

      // Cursor inside — use mark so user can edit the text
      if (tokenStr) attrs["data-tokens"] = tokenStr;
      return Decoration.mark({ class: "atpath-link", attributes: attrs });
    },
  });

  return ViewPlugin.define(
    (view) => ({
      decorations: decorator.createDeco(view),
      update(update) {
        if (plugin.tokenCacheDirty || update.selectionSet) {
          this.decorations = decorator.createDeco(update.view);
          plugin.tokenCacheDirty = false;
        } else {
          this.decorations = decorator.updateDeco(update, this.decorations);
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

          const vaultPath = resolveAtPathFromSource(relPath, activeFile.path, plugin);
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
      decorations: decorator.createDeco(view),
      update(update) {
        if (plugin.tokenCacheDirty || update.selectionSet) {
          this.decorations = decorator.createDeco(update.view);
          plugin.tokenCacheDirty = false;
        } else {
          this.decorations = decorator.updateDeco(update, this.decorations);
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
          plugin.getTokenCount(vaultPath).then((tokens) => {
            if (tokens != null) {
              tokenSpan.textContent = " (" + formatTokens(tokens) + ")";
            }
          });
        }
        link.after(tokenSpan);
      }
    }

    // ── Legacy @path references (plain text matched by regex) ──
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const regex = /(?:^|(?<=[\s(]))@([\w\p{L}\p{M}./_-]+\.[\w]+|[\w\p{L}\p{M}./_-][\w\p{L}\p{M}./ _()&-]+?\.[\w]+)/gu;
    const replacements = [];

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        replacements.push({ node, match: match[0], capture: match[1], index: match.index });
      }
    }

    // Process in reverse so indices stay valid
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { node, match, capture, index } = replacements[i];
      const before = node.textContent.substring(0, index);
      const after = node.textContent.substring(index + match.length);

      const link = document.createElement("a");
      link.className = "atpath-link";
      link.textContent = match;
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

      const parent = node.parentNode;
      if (after) parent.insertBefore(document.createTextNode(after), node.nextSibling);

      // Token count span (Reading mode)
      if (plugin.settings.showTokenCounts) {
        const tokenSpan = document.createElement("span");
        tokenSpan.className = "atpath-token-count";
        const vaultPath = resolveAtPathFromSource(capture, ctx.sourcePath, plugin);
        const cached = plugin.tokenCache.get(vaultPath);
        if (cached) {
          tokenSpan.textContent = " (" + formatTokens(cached.tokens) + ")";
        } else {
          plugin.getTokenCount(vaultPath).then((tokens) => {
            if (tokens != null) {
              tokenSpan.textContent = " (" + formatTokens(tokens) + ")";
            }
          });
        }
        parent.insertBefore(tokenSpan, node.nextSibling);
      }

      parent.insertBefore(link, node.nextSibling);
      node.textContent = before;
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
          }
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
      const refs = scanAtPathRefs(content).filter(r => r.format === "legacy");
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
    this._rafScheduled = false;
    this._lastEditorView = null;
    this._statusBarGen = 0;

    this.registerEditorSuggest(new AtPathSuggest(this));
    this.registerEditorExtension(buildAtPathViewPlugin(this));
    this.registerEditorExtension(buildWikilinkViewPlugin(this));
    registerPostProcessor(this);

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("mod-clickable");
    this.updateStatusBar();

    // Cache invalidation via vault events
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.tokenCache.delete(file.path);
        this._debouncedUpdateStatusBar();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.tokenCache.delete(file.path);
        this._debouncedUpdateStatusBar();
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.tokenCache.delete(oldPath);
        this.updateAtPathReferences(file, oldPath);
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
          this.saveSettings();
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
    this.trayBarEl = this.addStatusBarItem();
    this.trayBarEl.addClass("mod-clickable", "atpath-tray-btn");
    this.trayBarEl.setText("@Path");
    this.trayBarEl.addEventListener("click", (event) => this.showTrayMenu(event));

    this.statusBarEl.addEventListener("click", () => this.copyNoteWithAtPaths());

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

  async getTokenCount(vaultPath) {
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) return null;
    const ext = file.extension.toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return null;
    if (file.stat.size > this.settings.maxFileSizeMB * 1024 * 1024) return null;
    const cached = this.tokenCache.get(vaultPath);
    if (cached && cached.mtime === file.stat.mtime) return cached.tokens;
    const content = await this.app.vault.cachedRead(file);
    const tokens = encode(content).length;
    this.tokenCache.set(vaultPath, { mtime: file.stat.mtime, tokens });
    return tokens;
  }

  scheduleTokenFetch(vaultPath, view) {
    if (!this.settings.showTokenCounts) return;
    if (this._inFlightTokenFetches.has(vaultPath)) return;
    this._inFlightTokenFetches.add(vaultPath);
    this._lastEditorView = view;
    this.getTokenCount(vaultPath).then((tokens) => {
      this._inFlightTokenFetches.delete(vaultPath);
      if (tokens != null) {
        this.tokenCacheDirty = true;
        this._scheduleRefresh();
      }
    });
  }

  _scheduleRefresh() {
    if (this._rafScheduled) return;
    this._rafScheduled = true;
    requestAnimationFrame(() => {
      this._rafScheduled = false;
      if (this._lastEditorView) {
        try { this._lastEditorView.dispatch(); } catch (e) {}
      }
      this.updateStatusBar();
    });
  }

  _debouncedUpdateStatusBar() {
    if (this._statusBarTimeout) clearTimeout(this._statusBarTimeout);
    this._statusBarTimeout = setTimeout(() => this.updateStatusBar(), 300);
  }

  async updateStatusBar() {
    if (!this.settings.showTokenCounts) {
      this.statusBarEl.empty();
      this.statusBarEl.removeAttribute("aria-label");
      return;
    }

    const gen = ++this._statusBarGen;

    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) {
      this.statusBarEl.empty();
      this.statusBarEl.removeAttribute("aria-label");
      return;
    }

    const content = mdView.editor.getValue();
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      this.statusBarEl.empty();
      this.statusBarEl.removeAttribute("aria-label");
      return;
    }

    // Count current file tokens
    const noteTokens = await this.getTokenCount(activeFile.path) || 0;
    if (gen !== this._statusBarGen) return;

    // Find all @paths (both formats) and count their tokens
    const refs = scanAtPathRefs(content, this.app, activeFile.path);
    const seenPaths = new Set();
    let linkedTokens = 0;
    let linkedCount = 0;
    for (const ref of refs) {
      const vaultPath = ref.vaultPath || resolveAtPathFromSource(ref.displayPath, activeFile.path, this);
      if (seenPaths.has(vaultPath)) continue;
      seenPaths.add(vaultPath);
      const tokens = await this.getTokenCount(vaultPath);
      if (gen !== this._statusBarGen) return;
      if (tokens != null) {
        linkedTokens += tokens;
        linkedCount++;
      }
    }

    const total = noteTokens + linkedTokens;
    if (total === 0) {
      this.statusBarEl.empty();
      this.statusBarEl.removeAttribute("aria-label");
      return;
    }

    this.statusBarEl.setText("Tokens: " + formatTokens(total));
    const tooltipLines = ["Note: " + formatTokens(noteTokens)];
    if (linkedCount > 0) {
      tooltipLines.push("@paths (" + linkedCount + "): " + formatTokens(linkedTokens));
    }
    tooltipLines.push("Total: " + formatTokens(total));
    tooltipLines.push("Click to copy with @path contents");
    this.statusBarEl.setAttribute("aria-label", tooltipLines.join("\n"));
  }

  async copyNoteWithAtPaths() {
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
    const resolved = [];
    const failed = [];

    for (const ref of refs) {
      const vaultPath = ref.vaultPath || resolveAtPathFromSource(ref.displayPath, activeFile.path, this);
      if (seen.has(vaultPath)) continue;
      seen.add(vaultPath);

      const ext = ref.displayPath.split(".").pop().toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(file instanceof TFile)) {
        failed.push(ref.displayPath);
        continue;
      }
      try {
        const fileContent = await this.app.vault.cachedRead(file);
        resolved.push({ relPath: ref.displayPath, content: fileContent });
      } catch (e) {
        failed.push(ref.displayPath);
      }
    }

    // Strip wikilink syntax for clean clipboard output
    let output = content.replace(new RegExp(WIKILINK_ATPATH_RE.source, WIKILINK_ATPATH_RE.flags), (_, _target, display) => "@" + display);
    if (resolved.length > 0) {
      output += "\n\n---\n";
      for (const { relPath, content: fileContent } of resolved) {
        const fence = makeFence(fileContent);
        output += "\n## @" + relPath + "\n\n" + fence + "\n" + fileContent + "\n" + fence + "\n\n---\n";
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
    } else if (resolved.length > 0) {
      new Notice("Copied note + " + resolved.length + " @path(s) to clipboard.", 5000);
    } else {
      new Notice("Copied note to clipboard (no @path references found).", 5000);
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
      const relPath = ref.displayPath;
      const vaultPath = ref.vaultPath || resolveAtPathFromSource(relPath, activeFile.path, this);
      if (seen.has(vaultPath)) continue;
      seen.add(vaultPath);

      const ext = relPath.split(".").pop().toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(file instanceof TFile)) continue;

      try {
        const fileContent = await this.app.vault.cachedRead(file);
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
      const refs = scanAtPathRefs(content).filter(r => r.format === "legacy");
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
      const refs = scanAtPathRefs(content).filter(r => r.format === "legacy");
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
