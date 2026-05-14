"use strict";

// Tier 2: atpath-core helpers with a fake vault.
//
// We build a small in-memory vault tree and wire it to `plugin.app.vault`
// via the same getters atpath-core uses:
//   - getAbstractFileByPath(path) → TFile | TFolder | null
//   - getFiles() → TFile[] (flat list, used by enumerateFolderCandidates)
//   - getRoot() → TFolder (root, used by listAllFolders)
//
// `formatAtPathInsertion` tests also stub `app.fileManager.generateMarkdownLink`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { TFile, TFolder } = require("obsidian");
const { createAtPathCore } = require("../src/atpath-core.js");

// ───────── vault helpers ─────────

function buildVault() {
  // Tree:
  //   notes/
  //     index.md      (file)
  //     api/          (folder)
  //       v1.md
  //       v2.md
  //     drafts/       (folder, empty)
  //   archive/
  //     old.md

  const indexMd = new TFile("notes/index.md", { size: 100 });
  const v1 = new TFile("notes/api/v1.md", { size: 200 });
  const v2 = new TFile("notes/api/v2.md", { size: 300 });
  const oldMd = new TFile("archive/old.md", { size: 50 });

  const apiFolder = new TFolder("notes/api", [v1, v2]);
  const draftsFolder = new TFolder("notes/drafts", []);
  const notesFolder = new TFolder("notes", [indexMd, apiFolder, draftsFolder]);
  const archiveFolder = new TFolder("archive", [oldMd]);
  const root = new TFolder("", [notesFolder, archiveFolder]);

  const allFiles = [indexMd, v1, v2, oldMd];
  const byPath = new Map();
  function index(node) {
    byPath.set(node.path, node);
    if (node instanceof TFolder) for (const c of node.children) index(c);
  }
  index(notesFolder);
  index(archiveFolder);

  return { root, byPath, allFiles, indexMd, apiFolder, draftsFolder, notesFolder, archiveFolder, v1, v2, oldMd };
}

function buildPlugin(vault, overrides = {}) {
  return {
    app: {
      vault: {
        getAbstractFileByPath: (p) => vault.byPath.get(p) || null,
        getFiles: () => vault.allFiles,
        getRoot: () => vault.root,
      },
      fileManager: overrides.fileManager || {
        generateMarkdownLink: () => "[[stub]]",
      },
    },
    settings: { maxFileSizeMB: 5 },
    getTokenCount: async () => 0,
  };
}

// ───────── resolveAtPathTarget ─────────

test("resolveAtPathTarget: folder ref → kind 'folder'", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const result = core.resolveAtPathTarget(
    { kind: "folder", displayPath: "notes/api", vaultPath: "notes/api" },
    "",
  );
  assert.equal(result.kind, "folder");
  assert.equal(result.target, v.apiFolder);
  assert.equal(result.normalizedPath, "notes/api");
});

test("resolveAtPathTarget: folder ref with trailing slash in displayPath resolves", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const result = core.resolveAtPathTarget(
    { kind: "folder", displayPath: "notes/api/" },
    "",
  );
  assert.equal(result.kind, "folder");
  assert.equal(result.normalizedPath, "notes/api");
});

test("resolveAtPathTarget: missing folder → kind 'missing'", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const result = core.resolveAtPathTarget(
    { kind: "folder", displayPath: "notes/does-not-exist", vaultPath: "notes/does-not-exist" },
    "",
  );
  assert.equal(result.kind, "missing");
  assert.equal(result.target, null);
});

test("resolveAtPathTarget: file ref → kind 'file'", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const result = core.resolveAtPathTarget(
    { displayPath: "notes/index.md", vaultPath: "notes/index.md" },
    "",
  );
  assert.equal(result.kind, "file");
  assert.equal(result.target, v.indexMd);
  assert.equal(result.normalizedPath, "notes/index.md");
});

test("resolveAtPathTarget: missing file → kind 'missing'", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const result = core.resolveAtPathTarget(
    { displayPath: "ghost.md" },
    "",
  );
  assert.equal(result.kind, "missing");
});

test("resolveAtPathTarget: empty ref → kind 'missing'", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const result = core.resolveAtPathTarget({}, "");
  assert.equal(result.kind, "missing");
});

// ───────── enumerateFolderCandidates ─────────

test("enumerateFolderCandidates: 'notes/' (resolved folder) → immediate children only", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const out = core.enumerateFolderCandidates("notes/", "");
  // Children of `notes`: index.md (file), api (folder), drafts (folder).
  // Folders come first by the sort contract.
  const displays = out.map((e) => e.display);
  assert.deepEqual(displays.sort(), ["notes/api/", "notes/drafts/", "notes/index.md"].sort());
  // Folders first, then files.
  const kinds = out.map((e) => e.kind);
  assert.deepEqual(kinds, ["folder", "folder", "file"]);
});

test("enumerateFolderCandidates: 'ghost/' (unresolved prefix) → prefix match list", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  // No folder named "ghost" exists, so falls through to prefixMatch.
  // "ghost" doesn't prefix anything → empty.
  const out = core.enumerateFolderCandidates("ghost/", "");
  assert.equal(out.length, 0);
});

test("enumerateFolderCandidates: 'notes/ap/' (unresolved prefix) → prefix match list with folder + files", () => {
  // A trailing-slash query against a non-existent folder falls through to
  // prefixMatch, which scans both folders and files for paths starting
  // with the prefix (lowercased).
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const out = core.enumerateFolderCandidates("notes/ap/", "");
  const folderDisplays = out.filter((e) => e.kind === "folder").map((e) => e.display);
  const fileDisplays = out.filter((e) => e.kind === "file").map((e) => e.display);
  // Folder "notes/api" matches the "notes/ap" prefix.
  assert.deepEqual(folderDisplays, ["notes/api/"]);
  // Files "notes/api/v1.md" and "notes/api/v2.md" also match the prefix.
  assert.deepEqual(fileDisplays.sort(), ["notes/api/v1.md", "notes/api/v2.md"]);
  // Folder gets score 1.3 vs files at 1.0, so folder sorts first.
  assert.equal(out[0].kind, "folder");
});

test("enumerateFolderCandidates: 'zzz/' (no prefix hits) → empty list", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const out = core.enumerateFolderCandidates("zzz/", "");
  assert.equal(out.length, 0);
});

test("enumerateFolderCandidates: non-slash query 'api' → mixed results with 1.3x folder bias", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const out = core.enumerateFolderCandidates("api", "");
  // Both folder "notes/api" and file "notes/api/v1.md" should match by substring.
  const apiFolderEntry = out.find((e) => e.kind === "folder" && e.display === "notes/api/");
  const v1Entry = out.find((e) => e.kind === "file" && e.display === "notes/api/v1.md");
  assert.ok(apiFolderEntry, "expected notes/api/ folder entry");
  assert.ok(v1Entry, "expected notes/api/v1.md file entry");
  // Folder gets 1.3× bias on top of its base fuzzy score.
  // For substring match: base = 1 + (q.length / candidate.length).
  // Folder display "notes/api" → 1 + 3/9 = 1.333..., then ×1.3.
  // File display   "notes/api/v1.md" → 1 + 3/15 = 1.2, no bias.
  // So folder score must exceed file score.
  assert.ok(apiFolderEntry.score > v1Entry.score, `folder ${apiFolderEntry.score} should beat file ${v1Entry.score}`);
});

test("enumerateFolderCandidates: empty query returns full mixed list (no filter)", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const out = core.enumerateFolderCandidates("", "");
  // 4 folders (notes, notes/api, notes/drafts, archive) + 4 files
  // = 8 entries. listAllFolders() walks all but root.
  assert.equal(out.length, 8);
});

// ───────── formatAtPathInsertion ─────────

test("formatAtPathInsertion: file in legacy mode → '@<path>'", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const out = core.formatAtPathInsertion(v.indexMd, "", "legacy");
  assert.equal(out, "@notes/index.md");
});

test("formatAtPathInsertion: file in wikilink mode → delegates to fileManager.generateMarkdownLink", () => {
  const v = buildVault();
  const calls = [];
  const fileManager = {
    generateMarkdownLink: (...args) => {
      calls.push(args);
      return "WIKILINK_SENTINEL";
    },
  };
  const plugin = buildPlugin(v, { fileManager });
  const core = createAtPathCore(plugin);
  const out = core.formatAtPathInsertion(v.indexMd, "some/source.md", "wikilink");
  assert.equal(out, "WIKILINK_SENTINEL");
  assert.equal(calls.length, 1);
  // Args contract: (target, sourcePath, subpath, alias)
  assert.equal(calls[0][0], v.indexMd);
  assert.equal(calls[0][1], "some/source.md");
  assert.equal(calls[0][2], "");
  assert.equal(calls[0][3], "@notes/index.md");
});

test("formatAtPathInsertion: folder in legacy mode → '@<path>/'", () => {
  const v = buildVault();
  const plugin = buildPlugin(v);
  const core = createAtPathCore(plugin);
  const out = core.formatAtPathInsertion(v.apiFolder, "", "legacy");
  assert.equal(out, "@notes/api/");
});

test("formatAtPathInsertion: folder in wikilink mode → '@<path>/' (no generateMarkdownLink call)", () => {
  const v = buildVault();
  let called = false;
  const fileManager = {
    generateMarkdownLink: () => {
      called = true;
      return "SHOULD_NOT_BE_USED";
    },
  };
  const plugin = buildPlugin(v, { fileManager });
  const core = createAtPathCore(plugin);
  const out = core.formatAtPathInsertion(v.apiFolder, "", "wikilink");
  assert.equal(out, "@notes/api/");
  assert.equal(called, false);
});
