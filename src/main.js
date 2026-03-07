// obsidian-atpath — Autocomplete and navigate @path/to/file references
// Uses Obsidian API + CodeMirror 6.

const { Plugin, EditorSuggest, MarkdownView, TFile, Menu, PluginSettingTab, Setting, Notice } = require("obsidian");
const { ViewPlugin, Decoration, MatchDecorator, EditorView, WidgetType } = require("@codemirror/view");
const { RangeSetBuilder } = require("@codemirror/state");
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
  ignoreEvent() { return false; }
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

const { buildMainPage, buildAtPathPage, slugifyPath, AT_PATH_RE: HTML_AT_PATH_RE } = require("./html-builder");
const { deployToVercel } = require("./vercel-api");

const DEFAULT_SETTINGS = {
  showTokenCounts: true,
  maxFileSizeMB: 5,
  vercelToken: "",
  contactUrl: "",
  contactLabel: "Entre em contato",
};

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

function resolveAtPath(relPath, plugin) {
  const activeFile = plugin.app.workspace.getActiveFile();
  if (!activeFile) return relPath;
  const repoRoot = getRepoRoot(activeFile.path);
  return repoRoot ? repoRoot + "/" + relPath : relPath;
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
    const query = context.query.toLowerCase();

    const results = [];
    for (const f of allFiles) {
      if (!f.path.startsWith(repoRoot ? repoRoot + "/" : "")) continue;
      const rel = repoRoot ? toRepoRelative(f.path, repoRoot) : f.path;
      if (query && !rel.toLowerCase().includes(query)) continue;
      results.push({ file: f, display: rel, repoRoot });
      if (results.length >= 50) break;
    }
    return results;
  }

  renderSuggestion(value, el) {
    el.setText(value.display);
  }

  selectSuggestion(value, evt) {
    const { editor } = this.context;
    const { start, end } = this.context;
    editor.replaceRange("@" + value.display + " ", start, end);
  }
}

// ─── C) CM6 ViewPlugin — Clickable links in Live Preview ─────────────

const AT_PATH_RE = /(?<=^|[\s(])@([\w\p{L}\p{M}./_-]+\.[\w]+|[\w\p{L}\p{M}./_-][\w\p{L}\p{M}./ _()&-]+?\.[\w]+)/gu;

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
        click(event, view) {
          const target = event.target;
          if (!target.classList.contains("atpath-link")) return false;
          const relPath = target.dataset.atpath;
          if (!relPath) return false;

          event.preventDefault();
          const activeFile = plugin.app.workspace.getActiveFile();
          if (!activeFile) return false;

          const repoRoot = getRepoRoot(activeFile.path);
          const vaultPath = repoRoot ? repoRoot + "/" + relPath : relPath;
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

          const repoRoot = getRepoRoot(activeFile.path);
          const vaultPath = repoRoot ? repoRoot + "/" + relPath : relPath;
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
        const sourcePath = ctx.sourcePath;
        const repoRoot = getRepoRoot(sourcePath);
        const vaultPath = repoRoot ? repoRoot + "/" + capture : capture;
        const resolved = plugin.app.vault.getAbstractFileByPath(vaultPath);
        if (resolved instanceof TFile) {
          openFileByViewState(plugin, resolved);
        }
      });
      link.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const sourcePath = ctx.sourcePath;
        const repoRoot = getRepoRoot(sourcePath);
        const vaultPath = repoRoot ? repoRoot + "/" + capture : capture;
        showAtPathMenu(plugin, e, vaultPath);
      });

      const parent = node.parentNode;
      if (after) parent.insertBefore(document.createTextNode(after), node.nextSibling);

      // Token count span (Reading mode)
      if (plugin.settings.showTokenCounts) {
        const tokenSpan = document.createElement("span");
        tokenSpan.className = "atpath-token-count";
        const sourcePath = ctx.sourcePath;
        const repoRoot = getRepoRoot(sourcePath);
        const vaultPath = repoRoot ? repoRoot + "/" + capture : capture;
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

    containerEl.createEl("h3", { text: "Publishing" });

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
  }
}

// ─── F) Plugin lifecycle ─────────────────────────────────────────────

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

    // Publish button in status bar
    this.publishBarEl = this.addStatusBarItem();
    this.publishBarEl.addClass("mod-clickable", "atpath-publish-btn");
    this.publishBarEl.setText("Publish");
    this.publishBarEl.addEventListener("click", () => this.publishToVercel());

    this.statusBarEl.addEventListener("click", () => this.copyNoteWithAtPaths());
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

    // Find all @paths and count their tokens
    const regex = new RegExp(AT_PATH_RE.source, AT_PATH_RE.flags);
    const repoRoot = getRepoRoot(activeFile.path);
    const seenPaths = new Set();
    let linkedTokens = 0;
    let linkedCount = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const vaultPath = repoRoot ? repoRoot + "/" + match[1] : match[1];
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

    const regex = new RegExp(AT_PATH_RE.source, AT_PATH_RE.flags);
    const repoRoot = getRepoRoot(activeFile.path);
    const seen = new Set();
    const resolved = [];
    const failed = [];
    let match;

    while ((match = regex.exec(content)) !== null) {
      const relPath = match[1];
      const vaultPath = repoRoot ? repoRoot + "/" + relPath : relPath;
      if (seen.has(vaultPath)) continue;
      seen.add(vaultPath);

      const ext = relPath.split(".").pop().toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(file instanceof TFile)) {
        failed.push(relPath);
        continue;
      }
      try {
        const fileContent = await this.app.vault.cachedRead(file);
        resolved.push({ relPath, content: fileContent });
      } catch (e) {
        failed.push(relPath);
      }
    }

    let output = content;
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

  async publishToVercel() {
    const { vercelToken, contactUrl, contactLabel } = this.settings;
    if (!vercelToken) {
      new Notice("Set your Vercel API token in AtPath settings first.", 0);
      this.app.setting.open();
      return;
    }

    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) { new Notice("No active note to publish."); return; }

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) { new Notice("No active file."); return; }

    const noteTitle = activeFile.basename;
    this.publishBarEl.setText("Publishing...");

    try {
      let content = mdView.editor.getValue();
      const repoRoot = getRepoRoot(activeFile.path);

      // Collect first-level @path files
      const regex = new RegExp(AT_PATH_RE.source, AT_PATH_RE.flags);
      const seen = new Set();
      const atPathFiles = [];
      let m;

      while ((m = regex.exec(content)) !== null) {
        const relPath = m[1];
        if (seen.has(relPath)) continue;
        seen.add(relPath);

        const ext = relPath.split(".").pop().toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;

        const vaultPath = repoRoot ? repoRoot + "/" + relPath : relPath;
        const file = this.app.vault.getAbstractFileByPath(vaultPath);
        if (!(file instanceof TFile)) continue;

        try {
          const fileContent = await this.app.vault.cachedRead(file);
          atPathFiles.push({ relPath, content: fileContent });
        } catch (_) { /* skip */ }
      }

      // Build slug map for @path links
      const atPathSlugs = new Map();
      for (const f of atPathFiles) {
        atPathSlugs.set(f.relPath, slugifyPath(f.relPath));
      }

      // Resolve images in main note
      content = await this.resolveLocalImages(content, activeFile);

      // Build main page
      const mainHtml = buildMainPage(noteTitle, content, atPathSlugs, contactUrl, contactLabel);

      // Build @path pages
      const deployFiles = [{ path: "index.html", content: mainHtml }];

      for (const f of atPathFiles) {
        const slug = atPathSlugs.get(f.relPath);
        let atContent = await this.resolveLocalImages(f.content, activeFile);
        const pageTitle = f.relPath.split("/").pop();
        const pageHtml = buildAtPathPage(pageTitle, atContent, noteTitle, contactUrl, contactLabel);
        deployFiles.push({ path: "atpath/" + slug + ".html", content: pageHtml });
      }

      // Deploy
      const result = await deployToVercel(vercelToken, noteTitle, deployFiles);

      this.publishBarEl.setText("Publish");
      new Notice("Published! " + result.url, 10000);

      try { await copyToClipboard(result.url); } catch (_) {}
    } catch (e) {
      this.publishBarEl.setText("Publish");
      new Notice("Publish failed: " + (e.message || e), 0);
    }
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
  }
}

module.exports = AtPathPlugin;
