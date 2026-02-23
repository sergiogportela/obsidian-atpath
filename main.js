// obsidian-atpath — Autocomplete and navigate @path/to/file references
// Pure JS, no build step. Uses Obsidian API + CodeMirror 6.

const { Plugin, EditorSuggest, MarkdownView } = require("obsidian");
const { ViewPlugin, Decoration, MatchDecorator, EditorView, WidgetType } = require("@codemirror/view");
const { RangeSetBuilder } = require("@codemirror/state");

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

const AT_PATH_RE = /(?<=^|[\s(])@([\w./_-]+\.[\w]+|[\w./_-][\w./ _()-]+?\.[\w]+)/g;

function buildAtPathViewPlugin(plugin) {
  const decorator = new MatchDecorator({
    regexp: AT_PATH_RE,
    decoration: (match) =>
      Decoration.mark({ class: "atpath-link", attributes: { "data-atpath": match[1] } }),
  });

  return ViewPlugin.define(
    (view) => ({
      decorations: decorator.createDeco(view),
      update(update) {
        this.decorations = decorator.updateDeco(update, this.decorations);
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
          if (resolved) {
            plugin.app.workspace.openLinkText(vaultPath, "", false);
          }
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
    const regex = /(?:^|(?<=[\s(]))@([\w./_-]+\.[\w]+|[\w./_-][\w./ _()-]+?\.[\w]+)/g;
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
        plugin.app.workspace.openLinkText(vaultPath, "", false);
      });

      const parent = node.parentNode;
      if (after) parent.insertBefore(document.createTextNode(after), node.nextSibling);
      parent.insertBefore(link, node.nextSibling);
      node.textContent = before;
    }
  });
}

// ─── E) Plugin lifecycle ─────────────────────────────────────────────

class AtPathPlugin extends Plugin {
  async onload() {
    this.registerEditorSuggest(new AtPathSuggest(this));
    this.registerEditorExtension(buildAtPathViewPlugin(this));
    registerPostProcessor(this);
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.updateAtPathReferences(file, oldPath);
      })
    );
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
