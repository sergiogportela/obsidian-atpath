// html-app-publish.js — helpers for publishing standalone HTML apps.

const HTML_APP_SCOPE_SINGLE_FILE = "single-file";
const HTML_APP_SCOPE_FOLDER = "folder";

const DIRECTORY_BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "ico", "webp", "avif",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "zip", "gz", "tar", "rar", "7z", "bz2",
  "mp3", "wav", "ogg", "flac", "aac", "m4a",
  "mp4", "avi", "mkv", "mov", "webm", "wmv",
  "woff", "woff2", "ttf", "otf", "eot",
  "exe", "dll", "so", "dylib", "bin",
  "sqlite", "db",
]);

function isHtmlExtension(ext) {
  const normalized = String(ext || "").toLowerCase();
  return normalized === "html" || normalized === "htm";
}

function stripHtmlExtension(fileName) {
  return String(fileName || "").replace(/\.html?$/i, "");
}

function splitPath(filePath) {
  return String(filePath || "").split("/").filter(Boolean);
}

function getFileName(filePath) {
  const parts = splitPath(filePath);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function getParentFolderName(filePath) {
  const parts = splitPath(filePath);
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

function slugifyProjectName(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function humanizeName(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeBasicEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractHtmlTitle(html) {
  if (typeof html !== "string" || !html) return "";
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeBasicEntities(match[1]).replace(/\s+/g, " ").trim();
}

function getDefaultHtmlAppProjectName(filePath, scope) {
  const fileName = getFileName(filePath);
  const fallback = scope === HTML_APP_SCOPE_FOLDER
    ? (getParentFolderName(filePath) || stripHtmlExtension(fileName))
    : stripHtmlExtension(fileName);
  return slugifyProjectName(fallback);
}

function getDefaultHtmlAppTitle(filePath, scope, entryHtml) {
  const extractedTitle = extractHtmlTitle(entryHtml);
  if (extractedTitle) return extractedTitle;

  const fileName = getFileName(filePath);
  const fallback = scope === HTML_APP_SCOPE_FOLDER
    ? (getParentFolderName(filePath) || stripHtmlExtension(fileName))
    : stripHtmlExtension(fileName);
  return humanizeName(fallback) || "HTML app";
}

function buildHtmlAppDefaults({ filePath, scope, entryHtml, existingState }) {
  const defaultProjectName = getDefaultHtmlAppProjectName(filePath, scope);
  const projectName = existingState && existingState.projectName
    ? existingState.projectName
    : defaultProjectName;
  const siteTitle = existingState && existingState.siteTitle
    ? existingState.siteTitle
    : getDefaultHtmlAppTitle(filePath, scope, entryHtml);

  return {
    defaultProjectName,
    projectName,
    siteTitle,
    domain: projectName + ".vercel.app",
  };
}

function normalizeDeployPath(relPath) {
  return String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function getHtmlAppPageKey(deployPath) {
  const normalized = normalizeDeployPath(deployPath).replace(/\.html?$/i, "");
  if (!normalized || normalized === "index") return "main";
  return normalized;
}

function buildHtmlAppDeployFiles({ scope, entryFilePath, entryHtml, folderFiles }) {
  if (scope === HTML_APP_SCOPE_SINGLE_FILE) {
    return [{ path: "index.html", content: entryHtml, encoding: "utf-8" }];
  }

  const entryRelPath = normalizeDeployPath(getFileName(entryFilePath) || entryFilePath);
  const deployFiles = [];
  const seenPaths = new Set();

  for (const file of folderFiles || []) {
    const deployPath = normalizeDeployPath(file.relPath);
    if (!deployPath) continue;
    if (deployPath === "index.html" && entryRelPath !== "index.html") continue;
    if (seenPaths.has(deployPath)) continue;

    seenPaths.add(deployPath);
    deployFiles.push({
      path: deployPath,
      content: file.content,
      encoding: file.encoding || "utf-8",
    });
  }

  if (entryRelPath !== "index.html") {
    deployFiles.unshift({ path: "index.html", content: entryHtml, encoding: "utf-8" });
    if (!seenPaths.has(entryRelPath)) {
      deployFiles.push({ path: entryRelPath, content: entryHtml, encoding: "utf-8" });
    }
  } else if (!seenPaths.has("index.html")) {
    deployFiles.unshift({ path: "index.html", content: entryHtml, encoding: "utf-8" });
  }

  return deployFiles;
}

function partitionHtmlAppDeployFiles(deployFiles) {
  const htmlPages = {};
  const staticFiles = [];

  for (const file of deployFiles || []) {
    const deployPath = normalizeDeployPath(file.path || file.relPath);
    if (!deployPath) continue;

    const ext = (deployPath.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || "";
    if (isHtmlExtension(ext)) {
      htmlPages[getHtmlAppPageKey(deployPath)] = file.content;
      continue;
    }

    staticFiles.push({
      path: deployPath,
      content: file.content,
      encoding: file.encoding || "utf-8",
    });
  }

  return { htmlPages, staticFiles };
}

function getPublishedHtmlAppState(settings, filePath) {
  return settings && settings.publishedHtmlApps ? settings.publishedHtmlApps[filePath] : undefined;
}

function setPublishedHtmlAppState(settings, filePath, state) {
  if (!settings.publishedHtmlApps || typeof settings.publishedHtmlApps !== "object") {
    settings.publishedHtmlApps = {};
  }
  settings.publishedHtmlApps[filePath] = state;
  return state;
}

function renamePublishedHtmlAppState(settings, oldPath, newPath) {
  if (!settings || !settings.publishedHtmlApps || !settings.publishedHtmlApps[oldPath]) {
    return false;
  }

  settings.publishedHtmlApps[newPath] = settings.publishedHtmlApps[oldPath];
  delete settings.publishedHtmlApps[oldPath];
  return true;
}

async function collectDirectoryFiles(dirPath, opts) {
  let fs;
  let pathMod;
  try {
    fs = require("fs").promises;
    pathMod = require("path");
  } catch (_) {
    return [];
  }

  const files = [];
  const maxFiles = (opts && opts.maxFiles) || 500;
  const maxTotalBytes = (opts && opts.maxTotalBytes) || (50 * 1024 * 1024);
  let totalBytes = 0;

  async function walk(dir, prefix) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = pathMod.join(dir, entry.name);
      const relPath = prefix ? prefix + "/" + entry.name : entry.name;

      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }

      if (!entry.isFile() || files.length >= maxFiles) continue;

      const stat = await fs.stat(fullPath);
      if (totalBytes + stat.size > maxTotalBytes) continue;
      totalBytes += stat.size;

      const ext = (entry.name.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || "";
      if (DIRECTORY_BINARY_EXTENSIONS.has(ext)) {
        const buf = await fs.readFile(fullPath);
        files.push({ relPath, content: buf.toString("base64"), encoding: "base64" });
      } else {
        const text = await fs.readFile(fullPath, "utf-8");
        files.push({ relPath, content: text, encoding: "utf-8" });
      }
    }
  }

  await walk(dirPath, "");
  return files;
}

module.exports = {
  HTML_APP_SCOPE_SINGLE_FILE,
  HTML_APP_SCOPE_FOLDER,
  isHtmlExtension,
  extractHtmlTitle,
  getDefaultHtmlAppProjectName,
  buildHtmlAppDefaults,
  buildHtmlAppDeployFiles,
  partitionHtmlAppDeployFiles,
  getPublishedHtmlAppState,
  setPublishedHtmlAppState,
  renamePublishedHtmlAppState,
  collectDirectoryFiles,
};
