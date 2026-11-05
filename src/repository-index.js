"use strict";

const { f_originIdentity } = require("./repository-links");

const REPOSITORY_MAP_PATH = "repository-map.json";
const SKIP_DIRECTORIES = new Set(["data", "node_modules", "venv", "dist", "build", "__pycache__"]);

async function f_discoverRepositories(basePath) {
  const { readdir } = require("fs").promises;
  const { join } = require("path");
  const { execFile } = require("child_process");
  const { promisify } = require("util");
  const run = promisify(execFile);
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
      const [origin, refs] = await Promise.allSettled([
        run("git", ["config", "--local", "--get", "remote.origin.url"], { cwd, timeout: 5000 }),
        run("git", ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"], { cwd, timeout: 5000 }),
      ]);
      const identity = origin.status === "fulfilled" ? f_originIdentity(origin.value.stdout) : null;
      const names = refs.status === "fulfilled" ? refs.value.stdout.split("\n").filter(Boolean).map(ref =>
        ref.replace(/^refs\/(?:heads\/|tags\/|remotes\/[^/]+\/)/, "")
      ) : [];
      repositories.push({ root, identity, refs: [...new Set(names)].sort() });
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
  const { stdout } = await promisify(execFile)(
    "gh", ["api", "repos/" + identity, "--jq", ".full_name"], { timeout: 8000 }
  );
  return f_originIdentity("github.com/" + stdout.trim());
}

module.exports = {
  REPOSITORY_MAP_PATH, f_discoverRepositories, f_lookupRenamedRepository,
  f_readRepositoryMap, f_writeRepositoryMap,
};
