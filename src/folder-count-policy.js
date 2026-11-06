"use strict";

const DEFAULT_FOLDER_COUNT_EXCLUSIONS = "90_archive";

// A bare name matches that folder anywhere; a slash selects one vault-relative
// folder. These are boundaries, not file exclusions: count inside, stop outside.
function f_parseFolderCountExclusions(text = DEFAULT_FOLDER_COUNT_EXCLUSIONS) {
  if (typeof text !== "string") throw new TypeError("Folder exclusions must be one name or path per line");
  const rules = new Set();
  for (const line of text.split(/\r?\n/)) {
    const rule = line.trim().replace(/^\/+|\/+$/g, "");
    if (!rule) continue;
    if (rule.includes("\\") || rule.split("/").some(part => !part || part === "." || part === "..") || /[*?]/.test(rule)) {
      throw new Error("Use a folder name or vault-relative path without wildcards: " + line.trim());
    }
    rules.add(rule);
  }
  return [...rules];
}

function f_isFolderCountBoundary(path, rules) {
  return rules.some(rule => rule.includes("/") ? path === rule : path.slice(path.lastIndexOf("/") + 1) === rule);
}

function f_folderCountIncludes(folder, target, rules, targetIsFolder = false) {
  const root = folder === "/" ? "" : folder;
  if (!target.startsWith(root ? root + "/" : "") || target === root) return false;
  let parent = targetIsFolder ? target : target.slice(0, Math.max(0, target.lastIndexOf("/")));
  while (parent !== root) {
    if (f_isFolderCountBoundary(parent, rules)) return false;
    parent = parent.slice(0, Math.max(0, parent.lastIndexOf("/")));
  }
  return true;
}

module.exports = { DEFAULT_FOLDER_COUNT_EXCLUSIONS, f_parseFolderCountExclusions, f_isFolderCountBoundary, f_folderCountIncludes };
