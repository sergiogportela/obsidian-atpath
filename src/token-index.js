"use strict";

const TOKEN_ESTIMATE_DISCLOSURE = "Approximate (characters / 4). A workspace sample against o200k_base had errors from −66% to +96% and a total 19% too low. JSON/CSV can need nearly 3× this count. Observed results, not bounds or hard context limits.";

const ESTIMATOR_VERSION = 1;
const CHECKPOINT_INTERVAL_MS = 5000;
const EMPTY = { tokens: 0, pending: 0, skipped: 0, counted: 0 };
const EMPTY_FOLDER = { ...EMPTY, candidates: 0 };

function f_estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function f_createTokenIndex({
  getFiles, read, isEligible, looksBinary, load, save, enabled = true,
  tokenCache = new Map(), onError = () => {},
}) {
  const entries = new Map();
  const folders = new Map();
  const background = new Set();
  const priority = new Set();
  const listeners = new Set();
  let persisted = new Map();
  let inventory;
  let touched;
  let initialization;
  let inventoried = false;
  let disposed = false;
  let reading = false;
  let readTimer;
  let notifyTimer;
  let saveTimer;
  let saving;
  let dirty = false;

  function f_notify() {
    if (disposed || notifyTimer != null) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const notify of listeners) notify();
    }, 40);
  }

  function f_adjust(entry, direction) {
    if (entry.file.localOnly) return;
    let folder = entry.path;
    do {
      folder = folder.slice(0, Math.max(0, folder.lastIndexOf("/")));
      const total = folders.get(folder) ?? { ...EMPTY_FOLDER };
      total[entry.state] += direction;
      if (entry.eligible) total.candidates += direction;
      total.tokens += direction * (entry.tokens ?? 0);
      if (total.pending || total.counted || total.skipped) folders.set(folder, total);
      else folders.delete(folder);
    } while (folder);
  }

  async function f_flush() {
    if (!save || !dirty) return saving;
    if (saving) return saving;
    saving = (async () => {
      while (dirty) {
        dirty = false;
        const files = new Map(persisted);
        for (const { path, mtime, size, tokens, cacheable } of entries.values()) {
          if (cacheable) files.set(path, { mtime, size, tokens });
        }
        try {
          await save({ version: ESTIMATOR_VERSION, files: Object.fromEntries(files) });
        } catch (error) {
          onError(error);
        }
      }
    })().finally(() => { saving = null; });
    return saving;
  }

  function f_scheduleSave() {
    if (!save) return;
    dirty = true;
    if (saving || disposed || saveTimer != null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void f_flush();
    }, CHECKPOINT_INTERVAL_MS);
  }

  function f_drop(path) {
    const entry = entries.get(path);
    if (!entry) return;
    entries.delete(path);
    tokenCache.delete(path);
    background.delete(entry);
    priority.delete(entry);
    f_adjust(entry, -1);
    entry.resolve?.(null);
    if (entry.cacheable) f_scheduleSave();
    f_notify();
  }

  function f_finish(entry, tokens, cacheable, persist = cacheable) {
    f_adjust(entry, -1);
    entry.tokens = tokens;
    entry.state = tokens == null ? "skipped" : "counted";
    entry.cacheable = cacheable;
    if (tokens != null) tokenCache.set(entry.path, { mtime: entry.mtime, size: entry.size, tokens });
    f_adjust(entry, 1);
    entry.resolve?.(tokens);
    if (persist) f_scheduleSave();
    f_notify();
  }

  function f_queueRead() {
    if (disposed || !enabled || reading || readTimer != null || (!priority.size && !background.size)) return;
    readTimer = setTimeout(() => {
      readTimer = null;
      void f_readNext();
    }, 0);
  }

  async function f_readNext() {
    const queue = priority.size ? priority : background;
    const entry = queue.values().next().value;
    if (!entry || disposed || !enabled) return;
    queue.delete(entry);
    reading = true;
    try {
      const text = await read(entry.file);
      if (!disposed && entries.get(entry.path) === entry && entry.file.path === entry.path) {
        f_finish(entry, looksBinary(text) ? null : f_estimateTokens(text), true);
      }
    } catch (error) {
      if (!disposed && entries.get(entry.path) === entry && entry.file.path === entry.path) {
        f_finish(entry, null, false);
        onError(error, entry.path);
      }
    } finally {
      reading = false;
      f_queueRead();
    }
  }

  function f_upsert(file, isEvent = false, moved) {
    if (disposed || !file?.stat) return;
    const { path, stat: { mtime, size } } = file;
    if (isEvent) touched?.add(path);
    const eligible = !!isEligible(file);
    const current = entries.get(path);
    if (current?.file === file && current.mtime === mtime && current.size === size
      && current.eligible === eligible) return current;
    f_drop(path);
    const cached = moved?.cacheable ? moved : persisted.get(path);
    persisted.delete(path);
    const useCache = eligible && cached && cached.mtime === mtime && cached.size === size;
    if (cached && !useCache) f_scheduleSave();
    const entry = { file, path, mtime, size, eligible, state: "pending", tokens: null, cacheable: false };
    entries.set(path, entry);
    f_adjust(entry, 1);
    if (!eligible || useCache) f_finish(entry, useCache ? cached.tokens : null, !!useCache, !!moved?.cacheable);
    else {
      background.add(entry);
      f_queueRead();
      f_notify();
    }
    return entry;
  }

  function f_remove(path) {
    touched?.add(path);
    persisted.delete(path);
    const knownFile = entries.has(path);
    f_drop(path);
    if (knownFile) return;
    const prefix = path + "/";
    touched?.add(prefix);
    for (const current of entries.keys()) {
      if (current.startsWith(prefix)) {
        touched?.add(current);
        persisted.delete(current);
        f_drop(current);
      }
    }
  }

  function f_sync() {
    if (disposed) return Promise.resolve();
    if (inventory) return inventory;
    inventoried = false;
    touched = new Set();
    const seen = new Set();
    inventory = (async () => {
      const files = getFiles();
      for (let index = 0; index < files.length && !disposed; index++) {
        const file = files[index];
        seen.add(file.path);
        let source = file.path;
        let changed = touched.has(source);
        while (!changed && source.includes("/")) {
          source = source.slice(0, source.lastIndexOf("/"));
          changed = touched.has(source + "/");
        }
        if (!changed) f_upsert(file);
        if ((index + 1) % 64 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (disposed) return;
      for (const path of entries.keys()) {
        if (!seen.has(path) && !touched.has(path)) f_drop(path);
      }
      if (persisted.size) f_scheduleSave();
      persisted.clear();
      inventoried = true;
      f_notify();
    })().finally(() => { inventory = null; touched = null; });
    return inventory;
  }

  function f_prioritize(path) {
    const entry = entries.get(path);
    if (entry && background.delete(entry)) {
      priority.add(entry);
      f_queueRead();
    }
  }

  return {
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      if (enabled) {
        f_queueRead();
        return;
      }
      clearTimeout(readTimer);
      readTimer = null;
      for (const entry of entries.values()) {
        if (entry.state !== "pending" || !entry.resolve) continue;
        entry.resolve(null);
        entry.resolve = null;
        entry.promise = null;
      }
    },
    start() {
      if (!initialization) initialization = (async () => {
        try {
          const saved = await load?.();
          if (saved?.version === ESTIMATOR_VERSION && saved.files && typeof saved.files === "object") {
            persisted = new Map(Object.entries(saved.files).filter(([, entry]) =>
              Number.isFinite(entry?.mtime) && Number.isFinite(entry?.size)
              && (entry.tokens === null || Number.isSafeInteger(entry.tokens) && entry.tokens >= 0)));
          }
        } catch (error) {
          onError(error);
        }
        await f_sync();
      })();
      return initialization;
    },
    sync: f_sync,
    upsert(file) { f_upsert(file, true); },
    remove: f_remove,
    rename(file, oldPath) {
      if (file.stat) {
        const moved = entries.get(oldPath);
        touched?.add(oldPath);
        persisted.delete(oldPath);
        f_drop(oldPath);
        f_upsert(file, true, moved);
      } else {
        f_remove(oldPath);
        const stack = [...(file.children ?? [])];
        while (stack.length) {
          const child = stack.pop();
          if (child.stat) {
            // Native adapters may emit the folder rename before its children.
            if (child.path.startsWith(file.path + "/")) f_upsert(child, true);
          }
          else stack.push(...(child.children ?? []));
        }
      }
    },
    get(path, isFolder = false) {
      if (isFolder) {
        const total = folders.get(path === "/" ? "" : path) ?? EMPTY_FOLDER;
        return { ...total, pending: total.pending + (inventoried ? 0 : 1) };
      }
      const entry = entries.get(path);
      return entry ? { ...EMPTY, tokens: entry.tokens ?? 0, [entry.state]: 1 } : null;
    },
    prioritize: f_prioritize,
    request(file) {
      if (!enabled) return Promise.resolve(null);
      const entry = f_upsert(file, true);
      if (!entry || entry.state !== "pending") return Promise.resolve(entry?.tokens ?? null);
      f_prioritize(entry.path);
      if (!entry.promise) entry.promise = new Promise(resolve => { entry.resolve = resolve; });
      return entry.promise;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return saving;
      disposed = true;
      for (const timer of [readTimer, notifyTimer, saveTimer]) clearTimeout(timer);
      for (const entry of entries.values()) entry.resolve?.(null);
      listeners.clear();
      background.clear();
      priority.clear();
      return f_flush();
    },
  };
}

module.exports = { f_createTokenIndex, f_estimateTokens, TOKEN_ESTIMATE_DISCLOSURE };
