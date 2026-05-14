"use strict";

const { TFile, TFolder } = require("obsidian");

const REPOS_SEGMENT = "_repos/";

function getRepoRoot(filePath) {
  if (!filePath) return "";
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
  if (sourceRepoRoot) {
    const candidate = sourceRepoRoot + "/" + relPath;
    if (plugin.app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
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
  if (plugin.app.vault.getAbstractFileByPath(relPath)) return relPath;
  return sourceRepoRoot ? sourceRepoRoot + "/" + relPath : relPath;
}

function resolveAtPathFolderFromSource(relPath, sourceFilePath, plugin) {
  const trimmed = relPath.replace(/\/+$/, "");
  const sourceRepoRoot = getRepoRoot(sourceFilePath);
  if (sourceRepoRoot) {
    const candidate = sourceRepoRoot + "/" + trimmed;
    const f = plugin.app.vault.getAbstractFileByPath(candidate);
    if (f instanceof TFolder) return candidate;
  }
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx !== -1) {
    const firstSegment = trimmed.substring(0, slashIdx);
    const rest = trimmed.substring(slashIdx + 1);
    const repoRoots = discoverRepoRoots(plugin);
    const repoRoot = repoRoots.get(firstSegment);
    if (repoRoot) {
      const candidate = repoRoot + "/" + rest;
      const f = plugin.app.vault.getAbstractFileByPath(candidate);
      if (f instanceof TFolder) return candidate;
    }
  }
  const direct = plugin.app.vault.getAbstractFileByPath(trimmed);
  if (direct instanceof TFolder) return trimmed;
  return sourceRepoRoot ? sourceRepoRoot + "/" + trimmed : trimmed;
}

function computeDisplayPath(targetPath, sourcePath) {
  const sourceRepoRoot = getRepoRoot(sourcePath);
  if (sourceRepoRoot && targetPath.startsWith(sourceRepoRoot + "/")) {
    return toRepoRelative(targetPath, sourceRepoRoot);
  }
  const targetRepoRoot = getRepoRoot(targetPath);
  if (targetRepoRoot) {
    const repoName = targetRepoRoot.substring(targetRepoRoot.lastIndexOf("/") + 1);
    return repoName + "/" + toRepoRelative(targetPath, targetRepoRoot);
  }
  return targetPath;
}

function fuzzyScore(query, candidate) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c.includes(q)) return 1 + (q.length / Math.max(c.length, 1));
  let qi = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) qi++;
  }
  return qi === q.length ? 0.5 : 0;
}

function createAtPathCore(plugin) {
  const { app } = plugin;
  const folderTokenMemo = new Map();

  function resolveAtPathTarget(ref, sourcePath) {
    if (ref && ref.kind === "folder") {
      const rel = ref.vaultPath || (ref.displayPath || "").replace(/\/+$/, "");
      const path = resolveAtPathFolderFromSource(rel, sourcePath || "", plugin);
      const folder = app.vault.getAbstractFileByPath(path);
      if (folder instanceof TFolder) {
        return { kind: "folder", target: folder, normalizedPath: folder.path };
      }
      return { kind: "missing", target: null, normalizedPath: path };
    }
    const rel = (ref && (ref.displayPath || ref.vaultPath)) || "";
    if (!rel) return { kind: "missing", target: null, normalizedPath: "" };
    const path = resolveAtPathFromSource(rel, sourcePath || "", plugin);
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return { kind: "file", target: file, normalizedPath: file.path };
    }
    return { kind: "missing", target: null, normalizedPath: path };
  }

  function getFileTokens(path) {
    return plugin.getTokenCount(path);
  }

  function isIgnored(_vaultPath) {
    return false;
  }

  async function getFolderTokens(folderPath) {
    const folder = app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return 0;
    if (folderTokenMemo.has(folderPath)) return folderTokenMemo.get(folderPath);
    const sizeCapBytes = (plugin.settings && plugin.settings.maxFileSizeMB
      ? plugin.settings.maxFileSizeMB
      : 5) * 1024 * 1024;
    const tasks = [];
    (function walk(node) {
      for (const c of node.children) {
        if (c instanceof TFolder) {
          walk(c);
        } else if (c instanceof TFile && !isIgnored(c.path) && c.stat.size <= sizeCapBytes) {
          tasks.push(getFileTokens(c.path));
        }
      }
    })(folder);
    const counts = await Promise.all(tasks);
    const total = counts.reduce((a, b) => a + (b || 0), 0);
    folderTokenMemo.set(folderPath, total);
    return total;
  }

  function getCachedFolderTokens(folderPath) {
    return folderTokenMemo.has(folderPath) ? folderTokenMemo.get(folderPath) : null;
  }

  function clearFolderTokenMemo(folderPath) {
    if (folderPath) folderTokenMemo.delete(folderPath);
    else folderTokenMemo.clear();
  }

  function* walkFolders(root) {
    for (const c of root.children) {
      if (c instanceof TFolder) {
        yield c;
        yield* walkFolders(c);
      }
    }
  }

  function listAllFolders() {
    if (plugin._allFoldersCache) return plugin._allFoldersCache;
    const list = [...walkFolders(app.vault.getRoot())];
    plugin._allFoldersCache = list;
    return list;
  }

  function clearFoldersCache() {
    plugin._allFoldersCache = null;
  }

  function enumerateFolderCandidates(query, sourcePath) {
    const sp = sourcePath || "";
    const sourceRepoRoot = getRepoRoot(sp);
    const trimmed = (query || "").replace(/^@/, "");
    if (trimmed.endsWith("/")) {
      const prefix = trimmed.replace(/\/+$/, "");
      if (sourceRepoRoot) {
        const sameRepoCandidate = sourceRepoRoot + "/" + prefix;
        const same = app.vault.getAbstractFileByPath(sameRepoCandidate);
        if (same instanceof TFolder) {
          return immediateChildren(same, sp, "same-repo");
        }
      }
      const direct = app.vault.getAbstractFileByPath(prefix);
      if (direct instanceof TFolder) {
        return immediateChildren(direct, sp, "vault-abs");
      }
      return prefixMatch(prefix, sp);
    }
    return fuzzyAll(trimmed, sp);
  }

  function immediateChildren(folder, sourcePath, mode) {
    const out = [];
    for (const c of folder.children) {
      const isFolder = c instanceof TFolder;
      const isFile = c instanceof TFile;
      if (!isFolder && !isFile) continue;
      out.push({
        kind: isFolder ? "folder" : "file",
        target: c,
        display: computeDisplayPath(c.path, sourcePath) + (isFolder ? "/" : ""),
        repoMode: mode,
        score: 1,
      });
    }
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.display.localeCompare(b.display);
    });
    return out.slice(0, 50);
  }

  function prefixMatch(prefix, sourcePath) {
    const lower = prefix.toLowerCase();
    const folders = listAllFolders();
    const files = app.vault.getFiles();
    const matches = [];
    for (const f of folders) {
      if (f.path.toLowerCase().startsWith(lower)) {
        matches.push({
          kind: "folder",
          target: f,
          display: computeDisplayPath(f.path, sourcePath) + "/",
          score: 1.3,
        });
      }
    }
    for (const f of files) {
      if (f.path.toLowerCase().startsWith(lower)) {
        matches.push({
          kind: "file",
          target: f,
          display: computeDisplayPath(f.path, sourcePath),
          score: 1,
        });
      }
    }
    matches.sort((a, b) => b.score - a.score || a.display.localeCompare(b.display));
    return matches.slice(0, 50);
  }

  function fuzzyAll(query, sourcePath) {
    const folders = listAllFolders();
    const files = app.vault.getFiles();
    const sourceRepoRoot = getRepoRoot(sourcePath);
    const sameRepo = [];
    const crossRepo = [];
    const loose = [];

    function place(entry) {
      const targetRepoRoot = getRepoRoot(entry.target.path);
      if (sourceRepoRoot && entry.target.path.startsWith(sourceRepoRoot + "/")) sameRepo.push(entry);
      else if (targetRepoRoot) crossRepo.push(entry);
      else loose.push(entry);
    }

    for (const f of folders) {
      const display = computeDisplayPath(f.path, sourcePath);
      const base = fuzzyScore(query, display);
      if (!query || base > 0) {
        place({
          kind: "folder",
          target: f,
          display: display + "/",
          score: base * 1.3,
        });
      }
    }
    for (const f of files) {
      const display = computeDisplayPath(f.path, sourcePath);
      const base = fuzzyScore(query, display);
      if (!query || base > 0) {
        place({
          kind: "file",
          target: f,
          display,
          score: base,
        });
      }
    }

    const all = [...sameRepo, ...crossRepo, ...loose];
    if (query) all.sort((a, b) => b.score - a.score);
    return all.slice(0, 50);
  }

  function formatAtPathInsertion(target, sourcePath, mode) {
    const isFolder = target instanceof TFolder;
    const displayPath = computeDisplayPath(target.path, sourcePath || "");
    if (isFolder) {
      return "@" + displayPath + "/";
    }
    if (mode === "wikilink") {
      return app.fileManager.generateMarkdownLink(target, sourcePath || "", "", "@" + displayPath);
    }
    return "@" + displayPath;
  }

  return {
    resolveAtPathTarget,
    getFileTokens,
    getFolderTokens,
    isIgnored,
    enumerateFolderCandidates,
    formatAtPathInsertion,
    getCachedFolderTokens,
    clearFolderTokenMemo,
    clearFoldersCache,
    listAllFolders,
    computeDisplayPath: (t, s) => computeDisplayPath(t, s),
  };
}

module.exports = {
  createAtPathCore,
  REPOS_SEGMENT,
  getRepoRoot,
  toRepoRelative,
  discoverRepoRoots,
  resolveAtPathFromSource,
  resolveAtPathFolderFromSource,
  computeDisplayPath,
};
