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

// Cheap case-insensitive subsequence test: do all chars of `query` appear in
// `text` in order? This is the same matching predicate Obsidian's
// `prepareFuzzySearch` uses to decide *whether* a string matches, but without
// the expensive scoring DP. Used as a prefilter in the autocomplete hot path
// so the costly fuzzy scorer only runs on strings that can actually match.
// It is intentionally a *superset* of fuzzy's matcher (ASCII-lowercase, no
// diacritic folding) so it never drops a candidate the scorer would keep.
function isSubsequenceCI(query, text) {
  if (!query) return true;
  if (!text) return false;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

// Heuristic: does this decoded string look like binary data rather than text?
// Mirrors git / grep -I / file(1): a NUL byte is a hard binary signal; a high
// ratio of U+FFFD (failed UTF-8 decode) or non-whitespace control chars over a
// leading 4096-char sample means binary. Genuine UTF-8 text/code/data scores ~0
// and is never skipped, so token counts for real text stay byte-identical. Two
// edge cases are false positives that degrade safely to "no count" (UTF-16/32
// text, tiny control-heavy files); a binary whose first 4096 chars are clean
// ASCII (a >4096-char preamble) is instead a bounded false negative — it passes
// the sniff and reaches encode(), capped by maxFileSizeMB. See plan 002
// "Sniff limitations".
// Precondition: `content` is a UTF-8-decoded string (as returned by
// vault.cachedRead); the U+FFFD branch only registers failed decodes under
// UTF-8, so the heuristic assumes that decoding.
function looksBinary(content) {
  const sample = content.slice(0, 4096);
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;                            // NUL -> binary (git rule)
    if (c === 0xFFFD) suspicious++;                      // U+FFFD: failed UTF-8 decode
    else if (c < 9 || (c > 13 && c < 32)) suspicious++;  // control chars (allow \t \n \v \f \r = codes 9..13)
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
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
  const folderTokenInflight = new Map();
  let folderTokenEpoch = 0;

  function getPerf() {
    if (typeof window !== "undefined" && window.__atpath_perf) return window.__atpath_perf;
    return { inc: () => {}, record: () => {}, time: (_l, fn) => fn(), timeAsync: async (_l, fn) => fn(), enabled: false };
  }

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

  // getFolderTokens returns either:
  //   - a number (sum of file token counts), or
  //   - a sentinel { overCap: true, fileCount } when the walk hit
  //     settings.maxFolderFiles (fileCount is > maxFolderFiles, not exact).
  // Callers must handle both shapes via formatLinkedTargetCount(t).
  async function getFolderTokens(folderPath) {
    const perf = getPerf();
    perf.inc("getFolderTokens.calls");
    const folder = app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return 0;
    if (folderTokenMemo.has(folderPath)) return folderTokenMemo.get(folderPath);

    const existing = folderTokenInflight.get(folderPath);
    if (existing) return existing;

    const promise = (async () => {
      const settings = plugin.settings || {};
      const sizeCapBytes = (settings.maxFileSizeMB || 5) * 1024 * 1024;
      const maxFiles = settings.maxFolderFiles || 500;
      const batchSize = settings.folderEncodeBatchSize || 1;
      const startEpoch = folderTokenEpoch;

      const paths = [];
      let overCap = false;
      (function walk(node) {
        if (overCap) return;
        for (const c of node.children) {
          if (overCap) return;
          if (c instanceof TFolder) {
            walk(c);
          } else if (c instanceof TFile && !isIgnored(c.path)) {
            perf.inc("getFolderTokens.walkedFiles");
            if (c.stat.size > sizeCapBytes) {
              perf.inc("getFolderTokens.skippedTooLarge");
              continue;
            }
            paths.push(c.path);
            if (paths.length > maxFiles) { overCap = true; return; }
          }
        }
      })(folder);

      if (overCap) {
        perf.inc("getFolderTokens.overCap");
        const sentinel = { overCap: true, fileCount: paths.length };
        if (folderTokenEpoch === startEpoch) folderTokenMemo.set(folderPath, sentinel);
        return sentinel;
      }

      let total = 0;
      for (let i = 0; i < paths.length; i += batchSize) {
        const slice = paths.slice(i, i + batchSize);
        const counts = await perf.timeAsync(
          "getFolderTokens.batch",
          () => Promise.all(slice.map((p) => {
            perf.inc("getFolderTokens.encoded");
            const f = app.vault.getAbstractFileByPath(p);
            if (f && f.stat) {
              const sz = f.stat.size;
              const bucket = sz < 1024 ? "lt1k"
                : sz < 5 * 1024 ? "1-5k"
                : sz < 20 * 1024 ? "5-20k"
                : sz < 100 * 1024 ? "20-100k"
                : "100k+";
              perf.inc("getFolderTokens.encodeSize." + bucket);
            }
            return getFileTokens(p);
          }))
        );
        for (const n of counts) total += n || 0;
        if (i + batchSize < paths.length) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (folderTokenEpoch === startEpoch) folderTokenMemo.set(folderPath, total);
      return total;
    })();

    folderTokenInflight.set(folderPath, promise);
    try { return await promise; }
    finally { folderTokenInflight.delete(folderPath); }
  }

  // Returns the memoized result for `folderPath`, or null if not yet
  // computed. The result is either a number (token sum) or a sentinel
  // { overCap: true, fileCount } when the prior walk hit the file cap.
  function getCachedFolderTokens(folderPath) {
    return folderTokenMemo.has(folderPath) ? folderTokenMemo.get(folderPath) : null;
  }

  function clearFolderTokenMemo(folderPath) {
    folderTokenEpoch++;
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

// Resolve raw drag-source paths (captured at dragstart from the
// file-explorer DOM, plus any DataTransfer MIME fallbacks) into the
// `{kind, vaultPath, target}` shape the editor insertion helper expects.
// Pure — takes `app`, `sourcePath`, `currentDragRefs` explicitly so it
// can be exercised from unit tests without a live Obsidian runtime.
function extractDraggedVaultPaths(dataTransfer, app, sourcePath, currentDragRefs) {
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
  // drags, so the caller sniffs `data-path` attributes itself and passes
  // the result in via `currentDragRefs`.
  if (Array.isArray(currentDragRefs) && currentDragRefs.length > 0) {
    for (const r of currentDragRefs) addPath(r && r.vaultPath);
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

module.exports = {
  createAtPathCore,
  REPOS_SEGMENT,
  getRepoRoot,
  toRepoRelative,
  discoverRepoRoots,
  resolveAtPathFromSource,
  resolveAtPathFolderFromSource,
  computeDisplayPath,
  isSubsequenceCI,
  extractDraggedVaultPaths,
  looksBinary,
};
