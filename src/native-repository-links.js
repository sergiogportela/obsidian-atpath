"use strict";

// Obsidian 1.15 stores parsed metadata by content hash, shared across files.
// Keep repository-specific projections by source path and leave that store alone.
function f_installNativeRepositoryLinks({ metadataCache, vault, scan, resolve }) {
  const methods = ["getCache", "getFirstLinkpathDest", "iterateAllRefs"];
  if (![...methods, "on", "offref", "queueFileForLinkResolution", "resolveLinks"]
    .every(name => typeof metadataCache?.[name] === "function")
    || !["on", "offref", "getFileByPath", "getMarkdownFiles", "cachedRead"]
      .every(name => typeof vault?.[name] === "function")) return null;

  const descriptors = methods.map(name => Object.getOwnPropertyDescriptor(metadataCache, name));
  if (descriptors.some(descriptor => descriptor && !descriptor.configurable)
    || (!Object.isExtensible(metadataCache) && descriptors.some(descriptor => !descriptor))) return null;

  const getCache = metadataCache.getCache;
  const getFirstLinkpathDest = metadataCache.getFirstLinkpathDest;
  const iterateAllRefs = metadataCache.iterateAllRefs;
  const entries = new Map();
  let active = true;
  let pendingRefresh;
  let reprojectQueued = false;
  let reprojection;
  let reprojectAgain = false;

  function f_currentEntry(sourcePath) {
    const entry = entries.get(sourcePath);
    return entry && entry.base === getCache.call(metadataCache, sourcePath) ? entry : undefined;
  }

  const patches = [
    function f_getCache(sourcePath) {
      const base = getCache.call(this, sourcePath);
      const entry = entries.get(sourcePath);
      return entry && entry.base === base && entry.overlay ? entry.overlay : base;
    },
    function f_getFirstLinkpathDest(linkPath, sourcePath) {
      const target = entries.get(sourcePath)?.targets.get(linkPath);
      if (target !== undefined && f_currentEntry(sourcePath)) return target ? vault.getFileByPath(target) : null;
      return getFirstLinkpathDest.call(this, linkPath, sourcePath);
    },
    function f_iterateAllRefs(visit) {
      const stopped = new Set();
      const result = iterateAllRefs.call(this, (sourcePath, reference) => {
        if (entries.get(sourcePath)?.removedReferences.has(reference) && f_currentEntry(sourcePath)) return;
        if (visit(sourcePath, reference) === true) {
          stopped.add(sourcePath);
          return true;
        }
      });
      for (const [sourcePath, entry] of entries) {
        if (!entry.references.length || stopped.has(sourcePath) || !f_currentEntry(sourcePath)) continue;
        for (const reference of entry.references) {
          if (visit(sourcePath, reference) === true) break;
        }
      }
      return result;
    },
  ];
  for (const [index, name] of methods.entries()) {
    Object.defineProperty(metadataCache, name, { configurable: true, writable: true, value: patches[index] });
  }

  function f_project(sourcePath, entry) {
    const targets = new Map();
    const removed = new Set();
    const managed = [];
    for (const reference of entry.links) {
      const { destination, position } = reference;
      const result = resolve(destination, sourcePath);
      if (!result) continue;
      removed.add(position.start.offset);
      managed.push({ reference, path: result.file?.path ?? null });
    }
    if (!managed.length && !entry.removed.size) return false;

    const removedReferences = new Set();
    const ordinaryLinks = (entry.base.links ?? []).filter(reference => {
      if (!removed.has(reference.position?.start.offset)) return true;
      removedReferences.add(reference);
      return false;
    });
    const ordinaryPaths = new Set([...ordinaryLinks, ...(entry.base.embeds ?? []), ...(entry.base.frontmatterLinks ?? [])]
      .map(({ link }) => link.split("#", 1)[0]));
    const references = [];
    const visibleReferences = [];
    for (const { reference: { destination, label, position, original }, path } of managed) {
      const [linkPath] = destination.split("#", 1);
      const opaque = "\0atpath:" + position.start.offset;
      // The native lookup receives only source and link text. Keep ordinary
      // references authoritative if the same text occurs in both formats.
      const displayPath = ordinaryPaths.has(linkPath) ? opaque : linkPath;
      targets.set(displayPath, path);
      if (!path) continue;
      // Native rename traverses iterateAllRefs. Its fragment-free key cannot
      // be mistaken for a native file path or a heading reference.
      targets.set(opaque, path);
      references.push({ link: opaque, original, displayText: label, position });
      visibleReferences.push({
        link: displayPath + destination.slice(linkPath.length), original, displayText: label, position,
      });
    }

    const changed = removed.size !== entry.removed.size
      || [...removed].some(offset => !entry.removed.has(offset))
      || targets.size !== entry.targets.size
      || [...targets].some(([key, path]) => entry.targets.get(key) !== path);
    if (!changed) return false;
    entry.targets = targets;
    entry.removed = removed;
    entry.removedReferences = removedReferences;
    entry.references = references;
    entry.overlay = removed.size ? {
      ...entry.base,
      links: [...ordinaryLinks, ...visibleReferences]
        .sort((left, right) => left.position.start.offset - right.position.start.offset),
    } : null;
    return true;
  }

  function f_index(file, text, base) {
    if (!active || !base || file.extension !== "md" || vault.getFileByPath(file.path) !== file) return;
    const sourcePath = file.path;
    const previous = entries.get(sourcePath);
    const links = scan(text).filter(({ destination }) =>
      (destination.startsWith("/") && !destination.startsWith("//"))
      || /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\//i.test(destination))
      .map(link => ({
        ...link,
        original: text.slice(link.position.start.offset, link.position.end.offset),
      }));
    const entry = {
      base, links, targets: new Map(), removed: new Set(), removedReferences: new Set(), references: [], overlay: null,
    };
    entries.set(sourcePath, entry);
    if (f_project(sourcePath, entry) || previous?.overlay) metadataCache.queueFileForLinkResolution(file);
  }

  async function f_read(file) {
    const path = file.path;
    const { mtime, size } = file.stat;
    const base = getCache.call(metadataCache, path);
    if (!base || entries.get(path)?.base === base) return;
    let text;
    try {
      text = await vault.cachedRead(file);
    } catch (error) {
      if (active && vault.getFileByPath(path) === file && error?.code !== "ENOENT") {
        console.warn("AtPath could not read repository links in " + path, error);
      }
      return;
    }
    if (file.path === path && file.stat.mtime === mtime && file.stat.size === size
      && getCache.call(metadataCache, path) === base && entries.get(path)?.base !== base) {
      f_index(file, text, base);
    }
  }

  function f_reproject() {
    if (reprojection) {
      reprojectAgain = true;
      return reprojection;
    }
    reprojection = (async () => {
      do {
        reprojectAgain = false;
        let batchStart = Date.now();
        for (const [sourcePath, entry] of entries) {
          if (!active) return;
          if (entry.links.length && f_currentEntry(sourcePath)) {
            const file = vault.getFileByPath(sourcePath);
            if (file && f_project(sourcePath, entry)) metadataCache.queueFileForLinkResolution(file);
          }
          if (Date.now() - batchStart >= 8) {
            await new Promise(resolveDelay => setTimeout(resolveDelay, 0));
            batchStart = Date.now();
          }
        }
      } while (reprojectAgain);
    })().finally(() => { reprojection = null; });
    return reprojection;
  }

  function f_queueReprojection() {
    if (reprojectQueued) return;
    reprojectQueued = true;
    queueMicrotask(() => {
      reprojectQueued = false;
      if (active) void f_reproject().catch(error => console.warn("AtPath metadata refresh failed", error));
    });
  }

  const metadataEvent = metadataCache.on("changed", f_index);
  const vaultEvents = [
    vault.on("create", f_queueReprojection),
    vault.on("delete", file => {
      entries.delete(file.path);
      f_queueReprojection();
    }),
    vault.on("rename", (file, oldPath) => {
      const oldEntry = entries.get(oldPath);
      entries.delete(oldPath);
      if (file.extension === "md") {
        if (oldEntry && oldEntry.base === getCache.call(metadataCache, file.path)) {
          entries.set(file.path, oldEntry);
          f_project(file.path, oldEntry);
          metadataCache.queueFileForLinkResolution(file);
        } else {
          void f_read(file).catch(error => console.warn("AtPath metadata refresh failed", error));
        }
      }
      f_queueReprojection();
    }),
  ];

  return {
    async refresh() {
      if (!active) return;
      if (!pendingRefresh) {
        pendingRefresh = (async () => {
          let batchSize = 0;
          let batchStart = Date.now();
          for (const file of vault.getMarkdownFiles()) {
            if (!active) break;
            await f_read(file);
            if (++batchSize >= 16 || Date.now() - batchStart >= 8) {
              await new Promise(resolveDelay => setTimeout(resolveDelay, 0));
              batchSize = 0;
              batchStart = Date.now();
            }
          }
        })().finally(() => { pendingRefresh = null; });
      }
      await pendingRefresh;
      if (active) await f_reproject();
    },
    unload() {
      if (!active) return;
      active = false;
      metadataCache.offref(metadataEvent);
      for (const event of vaultEvents) vault.offref(event);
      for (const [index, name] of methods.entries()) {
        if (metadataCache[name] !== patches[index]) continue;
        const descriptor = descriptors[index];
        if (descriptor) Object.defineProperty(metadataCache, name, descriptor);
        else delete metadataCache[name];
      }
      for (const [sourcePath, entry] of entries) {
        const file = entry.overlay && vault.getFileByPath(sourcePath);
        if (file) metadataCache.queueFileForLinkResolution(file);
      }
      entries.clear();
    },
  };
}

module.exports = { f_installNativeRepositoryLinks };
