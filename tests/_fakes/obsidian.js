"use strict";

// Minimal fake of the `obsidian` module surface that `src/atpath-core.js`
// touches. Only what tests need — TFile, TFolder, plus a few no-op classes
// that other parts of the plugin import (kept here so this fake stays
// drop-in if more imports show up later).

class TAbstractFile {
  constructor(path) {
    this.path = path || "";
    this.name = this.path.split("/").pop() || "";
    this.parent = null;
  }
}

class TFile extends TAbstractFile {
  constructor(path, opts = {}) {
    super(path);
    const dot = this.name.lastIndexOf(".");
    this.extension = dot >= 0 ? this.name.substring(dot + 1) : "";
    this.basename = dot >= 0 ? this.name.substring(0, dot) : this.name;
    this.stat = {
      size: opts.size != null ? opts.size : 0,
      mtime: opts.mtime != null ? opts.mtime : 0,
      ctime: opts.ctime != null ? opts.ctime : 0,
    };
  }
}

class TFolder extends TAbstractFile {
  constructor(path, children = []) {
    super(path);
    this.children = children;
    for (const c of children) c.parent = this;
  }
  isRoot() {
    return this.path === "" || this.path === "/";
  }
}

// The following are imported elsewhere in the plugin. Stubbed so that any
// future test file that incidentally requires `obsidian` doesn't blow up.
class Plugin {}
class PluginSettingTab {}
class Modal {}
class Notice {
  constructor(msg) { this.msg = msg; }
}
class Setting {
  constructor() { return this; }
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addToggle() { return this; }
  addDropdown() { return this; }
  addButton() { return this; }
  addSlider() { return this; }
}
class MarkdownView {}
class EditorSuggest {}
class FuzzySuggestModal {}

function normalizePath(p) {
  return (p || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

const requestUrl = async () => ({ status: 200, text: "", json: {}, arrayBuffer: new ArrayBuffer(0) });

module.exports = {
  TAbstractFile,
  TFile,
  TFolder,
  Plugin,
  PluginSettingTab,
  Modal,
  Notice,
  Setting,
  MarkdownView,
  EditorSuggest,
  FuzzySuggestModal,
  normalizePath,
  requestUrl,
};
