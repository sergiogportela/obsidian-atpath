"use strict";

// Explorer-only items: never register aliases as TFiles or metadata entries.
// Their file field is the existing target, so native drag and token badges
// use the original content. Folder totals continue to use the vault index.
function f_createFileSymlinkReader(basePath) {
  const fs = require("fs").promises;
  const path = require("path");
  let root;
  const f_root = () => root ||= fs.realpath(basePath);
  const f_inside = (base, target) => {
    const relative = path.relative(base, target);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  async function f_resolve(aliasPath) {
    const base = await f_root();
    const absolute = path.resolve(base, aliasPath);
    if (!f_inside(base, absolute)) return null;
    try {
      if (await fs.realpath(path.dirname(absolute)) !== path.dirname(absolute)) return null;
      if (!(await fs.lstat(absolute)).isSymbolicLink()) return null;
      const target = await fs.realpath(absolute);
      if (!f_inside(base, target) || !(await fs.stat(target)).isFile()) return null;
      return { path: aliasPath, name: path.basename(aliasPath), targetPath: path.relative(base, target).split(path.sep).join("/") };
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return null;
      throw error;
    }
  }
  return {
    resolve: f_resolve,
    async list(folderPath) {
      const base = await f_root();
      const directory = path.resolve(base, folderPath === "/" ? "" : folderPath);
      if (!f_inside(base, directory) || await fs.realpath(directory) !== directory) return [];
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const aliases = [];
      for (const entry of entries) {
        if (!entry.isSymbolicLink()) continue;
        const aliasPath = folderPath === "/" ? entry.name : folderPath + "/" + entry.name;
        const alias = await f_resolve(aliasPath);
        if (alias) aliases.push(alias);
      }
      return aliases;
    },
  };
}

function f_mergeShortcutItems(items, shortcuts, order) {
  if (!shortcuts.length) return items;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const name = item => item.shortcut?.name || item.file.name;
  const modes = {
    alphabetical: (a, b) => collator.compare(name(a), name(b)),
    alphabeticalReverse: (a, b) => collator.compare(name(b), name(a)),
    byModifiedTime: (a, b) => b.file.stat.mtime - a.file.stat.mtime,
    byModifiedTimeReverse: (a, b) => a.file.stat.mtime - b.file.stat.mtime,
    byCreatedTime: (a, b) => b.file.stat.ctime - a.file.stat.ctime,
    byCreatedTimeReverse: (a, b) => a.file.stat.ctime - b.file.stat.ctime,
  };
  const compare = modes[order];
  if (!compare) return [...items, ...shortcuts];
  return [...items.filter(item => item.collapsible),
    ...[...items.filter(item => !item.collapsible), ...shortcuts].sort(compare)];
}

function f_installExplorerSymlinkShortcuts({ app, setIcon, open, menu, onError }) {
  const { workspace, vault } = app;
  if (typeof vault.adapter.getBasePath !== "function" || typeof workspace.getLeavesOfType !== "function") return null;
  const reader = f_createFileSymlinkReader(vault.adapter.getBasePath());
  const views = new Map();
  let disposed = false;
  let timer = null;
  let running = false;
  let again = false;
  let scanError = false;
  const f_parent = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
  const f_target = alias => {
    const file = vault.getAbstractFileByPath(alias.targetPath);
    return file && !Array.isArray(file.children) ? file : null;
  };
  async function f_activate(alias, pane) {
    try {
      // A shortcut can be retargeted/deleted between directory scans and click.
      const current = await reader.resolve(alias.path);
      const target = current && f_target(current);
      if (!target) throw new Error("Shortcut target is no longer available: " + alias.path);
      if (!disposed) await open(target, pane);
    } catch (error) { if (!disposed) onError(error, true); }
  }
  function f_refresh() {
    if (disposed) return;
    if (running) { again = true; return; }
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; void f_scan(); }, 80);
  }
  function f_attach(view) {
    const sample = Object.values(view.fileItems || {}).find(item => item.file?.extension && !item.collapsible);
    if (!sample || typeof view.getSortedFolderItems !== "function" || typeof view.sort !== "function" ||
      typeof view.tree?.getNodeId !== "function" || typeof view.tree?.setSearchFilter !== "function") return null;
    const NativeFileItem = sample.constructor;
    const original = view.getSortedFolderItems;
    const originalNodeId = view.tree.getNodeId;
    const originalSetFilter = view.tree.setSearchFilter;
    let baseFilter = view.tree.filter;
    const folders = new Map();
    let closed = false;
    class ShortcutItem extends NativeFileItem {
      constructor(alias, target) {
        super(view, target);
        this.shortcut = alias;
        this.selectable = false;
        this.selfEl.tabIndex = 0;
        this.selfEl.addEventListener("contextmenu", event => {
          event.preventDefault(); event.stopImmediatePropagation();
          menu(event, alias, pane => f_activate(alias, pane));
        }, true);
        this.selfEl.addEventListener("keydown", event => {
          if (["Enter", " "].includes(event.key)) {
            event.preventDefault(); event.stopImmediatePropagation();
            void f_activate(alias, event.metaKey || event.ctrlKey ? "tab" : false);
          } else if (["Delete", "Backspace", "F2"].includes(event.key)) {
            event.preventDefault(); event.stopImmediatePropagation();
          }
        }, true);
      }
      getTitle() { return this.shortcut?.name || super.getTitle(); }
      updateTitle() {
        super.updateTitle();
        if (!this.shortcut) return;
        this.selfEl.classList.add("atpath-symlink-shortcut");
        this.selfEl.setAttribute("data-atpath-symlink-path", this.shortcut.path);
        this.selfEl.setAttribute("aria-label", this.shortcut.name + ", shortcut to " + this.shortcut.targetPath);
        this.selfEl.title = this.shortcut.path + " → " + this.shortcut.targetPath + ". Opens the original file; counted once in folder totals.";
        if (!this.shortcutIcon) {
          this.shortcutIcon = this.selfEl.ownerDocument.createElement("span");
          this.shortcutIcon.className = "atpath-symlink-icon";
          this.shortcutIcon.setAttribute("aria-hidden", "true");
          setIcon(this.shortcutIcon, "corner-up-right");
          this.innerEl.before(this.shortcutIcon);
        }
      }
      onSelfClick(event) {
        event.preventDefault(); event.stopPropagation();
        void f_activate(this.shortcut, event.metaKey || event.ctrlKey || event.button === 1 ? "tab" : false);
      }
      // Explorer rename/delete selection must never act on an alias's target.
      startRename() {}
    }
    const wrapper = function (folder) {
      const native = original.call(this, folder);
      const shortcuts = [...(folders.get(folder.path)?.values() || [])].filter(item =>
        !vault.getAbstractFileByPath(item.shortcut.path) && f_target(item.shortcut) === item.file);
      return closed ? native : f_mergeShortcutItems(native, shortcuts, this.sortOrder);
    };
    view.getSortedFolderItems = wrapper;
    const nodeIdWrapper = function (item) {
      return !closed && item.shortcut ? item.shortcut.path : originalNodeId.call(this, item);
    };
    const filterWrapper = function (filter) {
      baseFilter = filter;
      return originalSetFilter.call(this, filter ? item =>
        !closed && item.shortcut && view.searchQuery
          ? item.shouldDisplay() && !!view.searchQuery.matchFilepath(item.shortcut.path)
          : filter(item) : filter);
    };
    view.tree.getNodeId = nodeIdWrapper;
    view.tree.setSearchFilter = filterWrapper;
    if (baseFilter) filterWrapper.call(view.tree, baseFilter);
    const observer = new view.containerEl.ownerDocument.defaultView.MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes]
        .some(node => node.nodeType === 1 && !node.closest?.(".atpath-symlink-shortcut") &&
          !node.classList?.contains("atpath-explorer-token-badge")))) f_refresh();
    });
    observer.observe(view.containerEl, { childList: true, subtree: true });
    view.containerEl.addEventListener("scroll", f_refresh, true);
    return {
      folders,
      async scan() {
        const list = view.containerEl.querySelector(".nav-files-container");
        if (!list || !view.containerEl.isConnected) return;
        const viewport = list.getBoundingClientRect();
        if (!viewport.height || !viewport.width) return;
        const visible = new Set(["/"]);
        for (const row of list.querySelectorAll(".nav-file-title[data-path], .nav-folder-title[data-path]")) {
          const rect = row.getBoundingClientRect();
          if (!rect.height || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
          const path = row.getAttribute("data-atpath-symlink-path") || row.getAttribute("data-path");
          visible.add(f_parent(path));
          if (view.fileItems[path]?.collapsed === false) visible.add(path);
        }
        let changed = false;
        let scanFailed = false;
        for (const folder of folders.keys()) {
          if (folder !== "/" && !vault.getAbstractFileByPath(folder)) { folders.delete(folder); changed = true; }
        }
        for (const folder of visible) {
          let aliases;
          try { aliases = await reader.list(folder); }
          catch (error) {
            aliases = [];
            if (!["ENOENT", "ENOTDIR"].includes(error.code)) {
              if (!this.lastError) onError(error);
              this.lastError = true;
              scanFailed = true;
            }
          }
          if (disposed || closed) return;
          const previous = folders.get(folder) || new Map();
          const next = new Map();
          for (const alias of aliases) {
            const target = f_target(alias);
            if (!target || vault.getAbstractFileByPath(alias.path)) continue;
            const existing = previous.get(alias.path);
            const item = existing?.file === target && existing.shortcut.targetPath === alias.targetPath
              ? existing : new ShortcutItem(alias, target);
            if (item !== existing) changed = true;
            next.set(alias.path, item);
          }
          if (previous.size !== next.size) changed = true;
          folders.set(folder, next);
        }
        this.lastError = scanFailed;
        if (changed) view.sort();
      },
      close() {
        closed = true;
        observer.disconnect();
        view.containerEl.removeEventListener("scroll", f_refresh, true);
        if (view.getSortedFolderItems === wrapper) view.getSortedFolderItems = original;
        folders.clear();
        view.sort();
        if (view.tree.getNodeId === nodeIdWrapper) view.tree.getNodeId = originalNodeId;
        if (view.tree.setSearchFilter === filterWrapper) {
          view.tree.setSearchFilter = originalSetFilter;
          view.tree.setSearchFilter(baseFilter);
        }
      },
    };
  }
  async function f_scan() {
    if (disposed || running) return;
    running = true;
    try {
      const active = new Set(workspace.getLeavesOfType("file-explorer").map(leaf => leaf.view));
      for (const [view, state] of views) if (!active.has(view)) { state.close(); views.delete(view); }
      for (const view of active) {
        if (!views.has(view)) {
          const state = f_attach(view);
          if (state) views.set(view, state);
        }
        await views.get(view)?.scan();
        if (disposed) break;
      }
      scanError = false;
    } catch (error) { if (!disposed && !scanError) onError(error); scanError = true; }
    finally { running = false; if (again) { again = false; f_refresh(); } }
  }
  const events = [workspace.on("layout-change", f_refresh)];
  // Obsidian does not emit vault events for ignored symlinks. Recheck only
  // visible folders, not the vault tree, and never read their file contents.
  const interval = setInterval(f_refresh, 3000);
  f_refresh();
  return {
    refresh: f_refresh,
    dispose() {
      disposed = true;
      clearTimeout(timer); clearInterval(interval);
      for (const event of events) workspace.offref(event);
      for (const state of views.values()) state.close();
      views.clear();
    },
  };
}

module.exports = { f_createFileSymlinkReader, f_mergeShortcutItems, f_installExplorerSymlinkShortcuts };
