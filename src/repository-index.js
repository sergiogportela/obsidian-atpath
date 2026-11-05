"use strict";

const { f_originIdentity } = require("./repository-links");

const REPOSITORY_MAP_PATH = "repository-map.json";
const SKIP_DIRECTORIES = new Set(["data", "node_modules", "venv", "dist", "build", "__pycache__"]);

function f_git(cwd, args) {
  const { execFile } = require("child_process");
  const { promisify } = require("util");
  return promisify(execFile)("git", args, { cwd, timeout: 5000 });
}

async function f_readGitCheckout(cwd, root) {
  const [origin, refs] = await Promise.allSettled([
    f_git(cwd, ["config", "--local", "--get", "remote.origin.url"]),
    f_git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]),
  ]);
  const identity = origin.status === "fulfilled" ? f_originIdentity(origin.value.stdout) : null;
  const names = refs.status === "fulfilled" ? refs.value.stdout.split("\n").filter(Boolean).map(ref =>
    ref.replace(/^refs\/(?:heads\/|tags\/|remotes\/[^/]+\/)/, "")
  ) : [];
  return { root, identity, refs: [...new Set(names)].sort() };
}

function f_isPrunedSourcePath(sourcePath) {
  return sourcePath.split("/").slice(0, -1).some(part => part.startsWith(".") || SKIP_DIRECTORIES.has(part));
}

async function f_discoverSourceCheckout(basePath, sourcePath) {
  const { lstat, realpath } = require("fs").promises;
  const { dirname, isAbsolute, join, relative, resolve, sep } = require("path");
  const base = await realpath(basePath);
  const sourceDirectory = sourcePath.split("/").slice(0, -1).join("/");
  const directory = await realpath(resolve(base, sourceDirectory));
  if (relative(base, directory).split(sep).join("/") !== sourceDirectory) {
    throw new Error("Source directory is outside the vault or uses a symbolic link: " + sourcePath);
  }
  let marker;
  for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
    try {
      await lstat(join(ancestor, ".git"));
      marker = ancestor;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (ancestor === base) break;
  }
  let checkout;
  try {
    const { stdout } = await f_git(directory, ["rev-parse", "--show-toplevel"]);
    checkout = await realpath(stdout.trim());
  } catch {
    throw new Error((marker ? "Invalid Git marker at " + relative(base, marker) + "/.git" :
      "No Git checkout found") + " for source " + sourcePath);
  }
  if (marker && checkout !== marker) {
    throw new Error("Invalid Git marker at " + relative(base, marker) + "/.git for source " + sourcePath);
  }
  const root = relative(base, checkout);
  if (root === ".." || root.startsWith(".." + sep) || isAbsolute(root)) {
    throw new Error("Source Git checkout is outside the vault: " + sourcePath);
  }
  return f_readGitCheckout(checkout, root.split(sep).join("/"));
}

async function f_discoverRepositories(basePath) {
  const { readdir, realpath } = require("fs").promises;
  const { join } = require("path");
  const repositories = [];
  const pending = [""];
  while (pending.length) {
    const root = pending.pop();
    const cwd = join(basePath, root);
    let entries;
    try {
      entries = await readdir(cwd, { withFileTypes: true });
    } catch (error) {
      if (root && ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error.code)) continue;
      throw error;
    }
    if (entries.some(entry => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
      let topLevel;
      try {
        ({ stdout: topLevel } = await f_git(cwd, ["rev-parse", "--show-toplevel"]));
      } catch (error) {
        // A Git command error can reject an individual marker. Spawn errors
        // mean discovery itself failed and the caller must keep its map.
        if (typeof error.code !== "number") throw error;
      }
      if (topLevel && await realpath(topLevel.trim()) === await realpath(cwd)) {
        repositories.push(await f_readGitCheckout(cwd, root));
      } else {
        console.warn("AtPath skipped invalid Git marker: " + join(cwd, ".git"));
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRECTORIES.has(entry.name)) {
        pending.push(root ? root + "/" + entry.name : entry.name);
      }
    }
  }
  return repositories.sort((left, right) => left.root.localeCompare(right.root));
}

function f_parseRepositoryMap(text) {
  const map = JSON.parse(text);
  if (map.version !== 1 || !Array.isArray(map.repositories)) throw new Error("Unsupported repository map");
  for (const repo of map.repositories) {
    const { root, identity, refs, aliases } = repo;
    if ((root !== undefined && (typeof root !== "string" || (root && root.split("/").some(part =>
      !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part)))))
      || (identity !== null && !/^[\w.-]+\/[\w.-]+$/.test(identity))
      || (refs !== undefined && (!Array.isArray(refs) || refs.some(ref => typeof ref !== "string")))
      || (aliases !== undefined && (!Array.isArray(aliases) || aliases.some(alias => !/^[\w.-]+\/[\w.-]+$/.test(alias))))) {
      throw new Error("Invalid repository map entry " + JSON.stringify({ root, identity }));
    }
  }
  return map.repositories;
}

async function f_writeRepositoryMap(adapter, repositories) {
  const text = JSON.stringify({ version: 1, repositories }, null, 2) + "\n";
  if (await adapter.exists(REPOSITORY_MAP_PATH) && await adapter.read(REPOSITORY_MAP_PATH) === text) return;
  await adapter.write(REPOSITORY_MAP_PATH, text);
}

async function f_readRepositoryMap(adapter) {
  return await adapter.exists(REPOSITORY_MAP_PATH) ? f_parseRepositoryMap(await adapter.read(REPOSITORY_MAP_PATH)) : [];
}

async function f_lookupRenamedRepository(identity) {
  const { execFile } = require("child_process");
  const { promisify } = require("util");
  const options = { timeout: 8000 };
  if (process.platform === "darwin") {
    // Finder launches may omit the standard Homebrew binary directories.
    options.env = { ...process.env, PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":") };
  }
  const { stdout } = await promisify(execFile)(
    "gh", ["api", "repos/" + identity, "--jq", ".full_name"], options
  );
  return f_originIdentity("github.com/" + stdout.trim());
}

module.exports = {
  REPOSITORY_MAP_PATH, f_discoverRepositories, f_discoverSourceCheckout, f_isPrunedSourcePath, f_lookupRenamedRepository,
  f_readRepositoryMap, f_writeRepositoryMap,
};
