var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/token-index.js
var require_token_index = __commonJS({
  "src/token-index.js"(exports2, module2) {
    "use strict";
    var ESTIMATOR_VERSION = 1;
    var EMPTY = { tokens: 0, pending: 0, skipped: 0, counted: 0 };
    function f_estimateTokens2(text) {
      return Math.ceil(text.length / 4);
    }
    function f_createTokenIndex2({
      getFiles,
      read,
      isEligible,
      looksBinary: looksBinary2,
      load,
      save,
      tokenCache = /* @__PURE__ */ new Map(),
      onError = () => {
      }
    }) {
      const entries = /* @__PURE__ */ new Map();
      const folders = /* @__PURE__ */ new Map();
      const background = /* @__PURE__ */ new Set();
      const priority = /* @__PURE__ */ new Set();
      const listeners = /* @__PURE__ */ new Set();
      let persisted = /* @__PURE__ */ new Map();
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
        let folder = entry.path;
        do {
          folder = folder.slice(0, Math.max(0, folder.lastIndexOf("/")));
          const total = folders.get(folder) ?? { ...EMPTY };
          total[entry.state] += direction;
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
        })().finally(() => {
          saving = null;
        });
        return saving;
      }
      function f_scheduleSave() {
        if (!save) return;
        dirty = true;
        if (saving || disposed) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          saveTimer = null;
          void f_flush();
        }, 750);
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
        if (disposed || reading || readTimer != null || !priority.size && !background.size) return;
        readTimer = setTimeout(() => {
          readTimer = null;
          void f_readNext();
        }, 0);
      }
      async function f_readNext() {
        const queue = priority.size ? priority : background;
        const entry = queue.values().next().value;
        if (!entry || disposed) return;
        queue.delete(entry);
        reading = true;
        try {
          const text = await read(entry.file);
          if (!disposed && entries.get(entry.path) === entry && entry.file.path === entry.path) {
            f_finish(entry, looksBinary2(text) ? null : f_estimateTokens2(text), true);
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
        if (current?.file === file && current.mtime === mtime && current.size === size && current.eligible === eligible) return current;
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
        touched = /* @__PURE__ */ new Set();
        const seen = /* @__PURE__ */ new Set();
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
            if ((index + 1) % 64 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
          }
          if (disposed) return;
          for (const path of entries.keys()) {
            if (!seen.has(path) && !touched.has(path)) f_drop(path);
          }
          if (persisted.size) f_scheduleSave();
          persisted.clear();
          inventoried = true;
          f_notify();
        })().finally(() => {
          inventory = null;
          touched = null;
        });
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
        start() {
          if (!initialization) initialization = (async () => {
            try {
              const saved = await load?.();
              if (saved?.version === ESTIMATOR_VERSION && saved.files && typeof saved.files === "object") {
                persisted = new Map(Object.entries(saved.files).filter(([, entry]) => Number.isFinite(entry?.mtime) && Number.isFinite(entry?.size) && (entry.tokens === null || Number.isSafeInteger(entry.tokens) && entry.tokens >= 0)));
              }
            } catch (error) {
              onError(error);
            }
            await f_sync();
          })();
          return initialization;
        },
        sync: f_sync,
        upsert(file) {
          f_upsert(file, true);
        },
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
            const stack = [...file.children ?? []];
            while (stack.length) {
              const child = stack.pop();
              if (child.stat) {
                if (child.path.startsWith(file.path + "/")) f_upsert(child, true);
              } else stack.push(...child.children ?? []);
            }
          }
        },
        get(path, isFolder = false) {
          if (isFolder) {
            const total = folders.get(path === "/" ? "" : path) ?? EMPTY;
            return { ...total, pending: total.pending + (inventoried ? 0 : 1) };
          }
          const entry = entries.get(path);
          return entry ? { ...EMPTY, tokens: entry.tokens ?? 0, [entry.state]: 1 } : null;
        },
        prioritize: f_prioritize,
        request(file) {
          const entry = f_upsert(file, true);
          if (!entry || entry.state !== "pending") return Promise.resolve(entry?.tokens ?? null);
          f_prioritize(entry.path);
          if (!entry.promise) entry.promise = new Promise((resolve) => {
            entry.resolve = resolve;
          });
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
        }
      };
    }
    module2.exports = { f_createTokenIndex: f_createTokenIndex2, f_estimateTokens: f_estimateTokens2 };
  }
});

// src/explorer-token-badges.js
var require_explorer_token_badges = __commonJS({
  "src/explorer-token-badges.js"(exports2, module2) {
    "use strict";
    var ROW = ".nav-file-title[data-path], .nav-folder-title[data-path]";
    var BADGE = "atpath-explorer-token-badge";
    function f_describeTokenBadge(snapshot, formatTokens2) {
      if (!snapshot) {
        return { text: "\u2026", title: "Token estimate pending" };
      }
      const { tokens, counted, pending, skipped } = snapshot;
      const notes = [];
      if (counted || !skipped && !pending) notes.push("About " + tokens.toLocaleString() + " tokens, estimated as characters divided by four");
      if (pending) notes.push(counted ? "Some files are still pending" : "Token estimate pending");
      if (skipped) notes.push(skipped + (skipped === 1 ? " file skipped" : " files skipped"));
      return {
        text: !counted && pending ? "\u2026" : !counted && skipped ? "\u2014" : "~" + formatTokens2(tokens) + (pending ? " \u2026" : skipped ? " *" : ""),
        title: notes.join(". ")
      };
    }
    function f_installExplorerTokenBadges2({ workspace, index, formatTokens: formatTokens2, isEnabled = () => true }) {
      if (!["getLeavesOfType", "on", "offref"].every((name) => typeof workspace?.[name] === "function")) return null;
      const watched = /* @__PURE__ */ new Map();
      const badges = /* @__PURE__ */ new Map();
      let timer;
      let disposed = false;
      function f_refresh() {
        if (disposed || timer != null) return;
        timer = setTimeout(() => {
          timer = null;
          f_paint();
        }, 50);
      }
      function f_paint() {
        const containers = /* @__PURE__ */ new Set();
        if (isEnabled()) {
          for (const leaf of workspace.getLeavesOfType("file-explorer")) {
            const container = leaf.view?.containerEl;
            if (container?.isConnected && container.ownerDocument.defaultView?.MutationObserver) containers.add(container);
          }
        }
        for (const [container, stop] of watched) {
          if (!containers.has(container)) {
            stop();
            watched.delete(container);
          }
        }
        const visible = /* @__PURE__ */ new Map();
        for (const container of containers) {
          if (!watched.has(container)) {
            const observer = new container.ownerDocument.defaultView.MutationObserver((mutations) => {
              if (mutations.some((mutation) => {
                if (mutation.target.closest?.("." + BADGE)) return false;
                if (mutation.type === "attributes") return true;
                return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => !node.classList?.contains(BADGE));
              })) f_refresh();
            });
            observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-path"] });
            container.addEventListener("scroll", f_refresh, true);
            watched.set(container, () => {
              observer.disconnect();
              container.removeEventListener("scroll", f_refresh, true);
            });
          }
          const list = container.querySelector(".nav-files-container");
          if (!list) continue;
          const viewport = list.getBoundingClientRect();
          if (!viewport.height || !viewport.width) continue;
          for (const row of list.querySelectorAll(ROW)) {
            const rect = row.getBoundingClientRect();
            if (!rect.height || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
            const path = row.getAttribute("data-path");
            const folder = row.classList.contains("nav-folder-title");
            const snapshot = index.get(path, folder);
            if (!folder && snapshot?.pending) index.prioritize(path);
            visible.set(row, f_describeTokenBadge(snapshot, formatTokens2));
          }
        }
        for (const [row, badge] of badges) {
          if (!visible.has(row)) {
            badge.remove();
            badges.delete(row);
          }
        }
        for (const [row, { text, title }] of visible) {
          let badge = badges.get(row);
          if (!badge || badge.parentElement !== row) {
            badge = row.ownerDocument.createElement("span");
            badge.className = BADGE;
            row.appendChild(badge);
            badges.set(row, badge);
          }
          if (badge.textContent !== text) badge.textContent = text;
          if (badge.title !== title) {
            badge.title = title;
            badge.setAttribute("aria-label", title);
          }
        }
      }
      const layout = workspace.on("layout-change", f_refresh);
      const unsubscribe = index.subscribe(f_refresh);
      f_refresh();
      return {
        refresh: f_refresh,
        dispose() {
          if (disposed) return;
          disposed = true;
          clearTimeout(timer);
          workspace.offref(layout);
          unsubscribe();
          for (const stop of watched.values()) stop();
          for (const badge of badges.values()) badge.remove();
          watched.clear();
          badges.clear();
        }
      };
    }
    module2.exports = { f_installExplorerTokenBadges: f_installExplorerTokenBadges2, f_describeTokenBadge };
  }
});

// src/token-cache-storage.js
var require_token_cache_storage = __commonJS({
  "src/token-cache-storage.js"(exports2, module2) {
    "use strict";
    var databasePromise;
    function f_openTokenCache() {
      if (!databasePromise) {
        databasePromise = new Promise((resolve, reject) => {
          const request = indexedDB.open("atpath-token-cache", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("vaults");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            database.onversionchange = () => {
              database.close();
              databasePromise = null;
            };
            resolve(database);
          };
        }).catch((error) => {
          databasePromise = null;
          throw error;
        });
      }
      return databasePromise;
    }
    async function f_loadTokenCache2(vaultIdentity) {
      if (!vaultIdentity) throw new Error("A vault identity is required for the token cache");
      const database = await f_openTokenCache();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("vaults", "readonly");
        const request = transaction.objectStore("vaults").get(vaultIdentity);
        transaction.oncomplete = () => resolve(request.result ?? null);
        transaction.onabort = () => reject(transaction.error || new Error("Token cache read aborted"));
        transaction.onerror = () => reject(transaction.error);
      });
    }
    async function f_saveTokenCache2(vaultIdentity, payload) {
      if (!vaultIdentity) throw new Error("A vault identity is required for the token cache");
      const database = await f_openTokenCache();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("vaults", "readwrite");
        transaction.objectStore("vaults").put(payload, vaultIdentity);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error("Token cache write aborted"));
        transaction.onerror = () => reject(transaction.error);
      });
    }
    module2.exports = { f_loadTokenCache: f_loadTokenCache2, f_saveTokenCache: f_saveTokenCache2 };
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/mdurl/build/index.cjs.js
var require_index_cjs = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/mdurl/build/index.cjs.js"(exports2) {
    "use strict";
    var decodeCache = {};
    function getDecodeCache(exclude) {
      let cache = decodeCache[exclude];
      if (cache) {
        return cache;
      }
      cache = decodeCache[exclude] = [];
      for (let i = 0; i < 128; i++) {
        const ch = String.fromCharCode(i);
        cache.push(ch);
      }
      for (let i = 0; i < exclude.length; i++) {
        const ch = exclude.charCodeAt(i);
        cache[ch] = "%" + ("0" + ch.toString(16).toUpperCase()).slice(-2);
      }
      return cache;
    }
    function decode(string, exclude) {
      if (typeof exclude !== "string") {
        exclude = decode.defaultChars;
      }
      const cache = getDecodeCache(exclude);
      return string.replace(/(%[a-f0-9]{2})+/gi, function(seq) {
        let result = "";
        for (let i = 0, l = seq.length; i < l; i += 3) {
          const b1 = parseInt(seq.slice(i + 1, i + 3), 16);
          if (b1 < 128) {
            result += cache[b1];
            continue;
          }
          if ((b1 & 224) === 192 && i + 3 < l) {
            const b2 = parseInt(seq.slice(i + 4, i + 6), 16);
            if ((b2 & 192) === 128) {
              const chr = b1 << 6 & 1984 | b2 & 63;
              if (chr < 128) {
                result += "\uFFFD\uFFFD";
              } else {
                result += String.fromCharCode(chr);
              }
              i += 3;
              continue;
            }
          }
          if ((b1 & 240) === 224 && i + 6 < l) {
            const b2 = parseInt(seq.slice(i + 4, i + 6), 16);
            const b3 = parseInt(seq.slice(i + 7, i + 9), 16);
            if ((b2 & 192) === 128 && (b3 & 192) === 128) {
              const chr = b1 << 12 & 61440 | b2 << 6 & 4032 | b3 & 63;
              if (chr < 2048 || chr >= 55296 && chr <= 57343) {
                result += "\uFFFD\uFFFD\uFFFD";
              } else {
                result += String.fromCharCode(chr);
              }
              i += 6;
              continue;
            }
          }
          if ((b1 & 248) === 240 && i + 9 < l) {
            const b2 = parseInt(seq.slice(i + 4, i + 6), 16);
            const b3 = parseInt(seq.slice(i + 7, i + 9), 16);
            const b4 = parseInt(seq.slice(i + 10, i + 12), 16);
            if ((b2 & 192) === 128 && (b3 & 192) === 128 && (b4 & 192) === 128) {
              let chr = b1 << 18 & 1835008 | b2 << 12 & 258048 | b3 << 6 & 4032 | b4 & 63;
              if (chr < 65536 || chr > 1114111) {
                result += "\uFFFD\uFFFD\uFFFD\uFFFD";
              } else {
                chr -= 65536;
                result += String.fromCharCode(55296 + (chr >> 10), 56320 + (chr & 1023));
              }
              i += 9;
              continue;
            }
          }
          result += "\uFFFD";
        }
        return result;
      });
    }
    decode.defaultChars = ";/?:@&=+$,#";
    decode.componentChars = "";
    var encodeCache = {};
    function getEncodeCache(exclude) {
      let cache = encodeCache[exclude];
      if (cache) {
        return cache;
      }
      cache = encodeCache[exclude] = [];
      for (let i = 0; i < 128; i++) {
        const ch = String.fromCharCode(i);
        if (/^[0-9a-z]$/i.test(ch)) {
          cache.push(ch);
        } else {
          cache.push("%" + ("0" + i.toString(16).toUpperCase()).slice(-2));
        }
      }
      for (let i = 0; i < exclude.length; i++) {
        cache[exclude.charCodeAt(i)] = exclude[i];
      }
      return cache;
    }
    function encode(string, exclude, keepEscaped) {
      if (typeof exclude !== "string") {
        keepEscaped = exclude;
        exclude = encode.defaultChars;
      }
      if (typeof keepEscaped === "undefined") {
        keepEscaped = true;
      }
      const cache = getEncodeCache(exclude);
      let result = "";
      for (let i = 0, l = string.length; i < l; i++) {
        const code = string.charCodeAt(i);
        if (keepEscaped && code === 37 && i + 2 < l) {
          if (/^[0-9a-f]{2}$/i.test(string.slice(i + 1, i + 3))) {
            result += string.slice(i, i + 3);
            i += 2;
            continue;
          }
        }
        if (code < 128) {
          result += cache[code];
          continue;
        }
        if (code >= 55296 && code <= 57343) {
          if (code >= 55296 && code <= 56319 && i + 1 < l) {
            const nextCode = string.charCodeAt(i + 1);
            if (nextCode >= 56320 && nextCode <= 57343) {
              result += encodeURIComponent(string[i] + string[i + 1]);
              i++;
              continue;
            }
          }
          result += "%EF%BF%BD";
          continue;
        }
        result += encodeURIComponent(string[i]);
      }
      return result;
    }
    encode.defaultChars = ";/?:@&=+$,-_.!~*'()#";
    encode.componentChars = "-_.!~*'()";
    function format(url) {
      let result = "";
      result += url.protocol || "";
      result += url.slashes ? "//" : "";
      result += url.auth ? url.auth + "@" : "";
      if (url.hostname && url.hostname.indexOf(":") !== -1) {
        result += "[" + url.hostname + "]";
      } else {
        result += url.hostname || "";
      }
      result += url.port ? ":" + url.port : "";
      result += url.pathname || "";
      result += url.search || "";
      result += url.hash || "";
      return result;
    }
    function Url() {
      this.protocol = null;
      this.slashes = null;
      this.auth = null;
      this.port = null;
      this.hostname = null;
      this.hash = null;
      this.search = null;
      this.pathname = null;
    }
    var protocolPattern = /^([a-z0-9.+-]+:)/i;
    var portPattern = /:[0-9]*$/;
    var simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/;
    var delims = ["<", ">", '"', "`", " ", "\r", "\n", "	"];
    var unwise = ["{", "}", "|", "\\", "^", "`"].concat(delims);
    var autoEscape = ["'"].concat(unwise);
    var nonHostChars = ["%", "/", "?", ";", "#"].concat(autoEscape);
    var hostEndingChars = ["/", "?", "#"];
    var hostnameMaxLen = 255;
    var hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/;
    var hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/;
    var hostlessProtocol = {
      javascript: true,
      "javascript:": true
    };
    var slashedProtocol = {
      http: true,
      https: true,
      ftp: true,
      gopher: true,
      file: true,
      "http:": true,
      "https:": true,
      "ftp:": true,
      "gopher:": true,
      "file:": true
    };
    function urlParse(url, slashesDenoteHost) {
      if (url && url instanceof Url) return url;
      const u = new Url();
      u.parse(url, slashesDenoteHost);
      return u;
    }
    Url.prototype.parse = function(url, slashesDenoteHost) {
      let lowerProto, hec, slashes;
      let rest = url;
      rest = rest.trim();
      if (!slashesDenoteHost && url.split("#").length === 1) {
        const simplePath = simplePathPattern.exec(rest);
        if (simplePath) {
          this.pathname = simplePath[1];
          if (simplePath[2]) {
            this.search = simplePath[2];
          }
          return this;
        }
      }
      let proto = protocolPattern.exec(rest);
      if (proto) {
        proto = proto[0];
        lowerProto = proto.toLowerCase();
        this.protocol = proto;
        rest = rest.substr(proto.length);
      }
      if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
        slashes = rest.substr(0, 2) === "//";
        if (slashes && !(proto && hostlessProtocol[proto])) {
          rest = rest.substr(2);
          this.slashes = true;
        }
      }
      if (!hostlessProtocol[proto] && (slashes || proto && !slashedProtocol[proto])) {
        let hostEnd = -1;
        for (let i = 0; i < hostEndingChars.length; i++) {
          hec = rest.indexOf(hostEndingChars[i]);
          if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) {
            hostEnd = hec;
          }
        }
        let auth, atSign;
        if (hostEnd === -1) {
          atSign = rest.lastIndexOf("@");
        } else {
          atSign = rest.lastIndexOf("@", hostEnd);
        }
        if (atSign !== -1) {
          auth = rest.slice(0, atSign);
          rest = rest.slice(atSign + 1);
          this.auth = auth;
        }
        hostEnd = -1;
        for (let i = 0; i < nonHostChars.length; i++) {
          hec = rest.indexOf(nonHostChars[i]);
          if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) {
            hostEnd = hec;
          }
        }
        if (hostEnd === -1) {
          hostEnd = rest.length;
        }
        if (rest[hostEnd - 1] === ":") {
          hostEnd--;
        }
        const host = rest.slice(0, hostEnd);
        rest = rest.slice(hostEnd);
        this.parseHost(host);
        this.hostname = this.hostname || "";
        const ipv6Hostname = this.hostname[0] === "[" && this.hostname[this.hostname.length - 1] === "]";
        if (!ipv6Hostname) {
          const hostparts = this.hostname.split(/\./);
          for (let i = 0, l = hostparts.length; i < l; i++) {
            const part = hostparts[i];
            if (!part) {
              continue;
            }
            if (!part.match(hostnamePartPattern)) {
              let newpart = "";
              for (let j = 0, k = part.length; j < k; j++) {
                if (part.charCodeAt(j) > 127) {
                  newpart += "x";
                } else {
                  newpart += part[j];
                }
              }
              if (!newpart.match(hostnamePartPattern)) {
                const validParts = hostparts.slice(0, i);
                const notHost = hostparts.slice(i + 1);
                const bit = part.match(hostnamePartStart);
                if (bit) {
                  validParts.push(bit[1]);
                  notHost.unshift(bit[2]);
                }
                if (notHost.length) {
                  rest = notHost.join(".") + rest;
                }
                this.hostname = validParts.join(".");
                break;
              }
            }
          }
        }
        if (this.hostname.length > hostnameMaxLen) {
          this.hostname = "";
        }
        if (ipv6Hostname) {
          this.hostname = this.hostname.substr(1, this.hostname.length - 2);
        }
      }
      const hash = rest.indexOf("#");
      if (hash !== -1) {
        this.hash = rest.substr(hash);
        rest = rest.slice(0, hash);
      }
      const qm = rest.indexOf("?");
      if (qm !== -1) {
        this.search = rest.substr(qm);
        rest = rest.slice(0, qm);
      }
      if (rest) {
        this.pathname = rest;
      }
      if (slashedProtocol[lowerProto] && this.hostname && !this.pathname) {
        this.pathname = "";
      }
      return this;
    };
    Url.prototype.parseHost = function(host) {
      let port = portPattern.exec(host);
      if (port) {
        port = port[0];
        if (port !== ":") {
          this.port = port.substr(1);
        }
        host = host.substr(0, host.length - port.length);
      }
      if (host) {
        this.hostname = host;
      }
    };
    exports2.decode = decode;
    exports2.encode = encode;
    exports2.format = format;
    exports2.parse = urlParse;
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/uc.micro/build/index.cjs.js
var require_index_cjs2 = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/uc.micro/build/index.cjs.js"(exports2) {
    "use strict";
    var regex$5 = /[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
    var regex$4 = /[\0-\x1F\x7F-\x9F]/;
    var regex$3 = /[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/;
    var regex$2 = /[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1B7D\u1B7E\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDEAD\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD83A[\uDD5E\uDD5F]/;
    var regex$1 = /[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C0\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2426\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2B95\u2B97-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E3\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBC2\uFD40-\uFD4F\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED7\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDF76\uDF7B-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0\uDCB1\uDD00-\uDE53\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE88\uDE90-\uDEBD\uDEBF-\uDEC5\uDECE-\uDEDB\uDEE0-\uDEE8\uDEF0-\uDEF8\uDF00-\uDF92\uDF94-\uDFCA]/;
    var regex = /[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
    exports2.Any = regex$5;
    exports2.Cc = regex$4;
    exports2.Cf = regex$3;
    exports2.P = regex$2;
    exports2.S = regex$1;
    exports2.Z = regex;
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/generated/decode-data-html.js
var require_decode_data_html = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/generated/decode-data-html.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.default = new Uint16Array(
      // prettier-ignore
      '\u1D41<\xD5\u0131\u028A\u049D\u057B\u05D0\u0675\u06DE\u07A2\u07D6\u080F\u0A4A\u0A91\u0DA1\u0E6D\u0F09\u0F26\u10CA\u1228\u12E1\u1415\u149D\u14C3\u14DF\u1525\0\0\0\0\0\0\u156B\u16CD\u198D\u1C12\u1DDD\u1F7E\u2060\u21B0\u228D\u23C0\u23FB\u2442\u2824\u2912\u2D08\u2E48\u2FCE\u3016\u32BA\u3639\u37AC\u38FE\u3A28\u3A71\u3AE0\u3B2E\u0800EMabcfglmnoprstu\\bfms\x7F\x84\x8B\x90\x95\x98\xA6\xB3\xB9\xC8\xCFlig\u803B\xC6\u40C6P\u803B&\u4026cute\u803B\xC1\u40C1reve;\u4102\u0100iyx}rc\u803B\xC2\u40C2;\u4410r;\uC000\u{1D504}rave\u803B\xC0\u40C0pha;\u4391acr;\u4100d;\u6A53\u0100gp\x9D\xA1on;\u4104f;\uC000\u{1D538}plyFunction;\u6061ing\u803B\xC5\u40C5\u0100cs\xBE\xC3r;\uC000\u{1D49C}ign;\u6254ilde\u803B\xC3\u40C3ml\u803B\xC4\u40C4\u0400aceforsu\xE5\xFB\xFE\u0117\u011C\u0122\u0127\u012A\u0100cr\xEA\xF2kslash;\u6216\u0176\xF6\xF8;\u6AE7ed;\u6306y;\u4411\u0180crt\u0105\u010B\u0114ause;\u6235noullis;\u612Ca;\u4392r;\uC000\u{1D505}pf;\uC000\u{1D539}eve;\u42D8c\xF2\u0113mpeq;\u624E\u0700HOacdefhilorsu\u014D\u0151\u0156\u0180\u019E\u01A2\u01B5\u01B7\u01BA\u01DC\u0215\u0273\u0278\u027Ecy;\u4427PY\u803B\xA9\u40A9\u0180cpy\u015D\u0162\u017Aute;\u4106\u0100;i\u0167\u0168\u62D2talDifferentialD;\u6145leys;\u612D\u0200aeio\u0189\u018E\u0194\u0198ron;\u410Cdil\u803B\xC7\u40C7rc;\u4108nint;\u6230ot;\u410A\u0100dn\u01A7\u01ADilla;\u40B8terDot;\u40B7\xF2\u017Fi;\u43A7rcle\u0200DMPT\u01C7\u01CB\u01D1\u01D6ot;\u6299inus;\u6296lus;\u6295imes;\u6297o\u0100cs\u01E2\u01F8kwiseContourIntegral;\u6232eCurly\u0100DQ\u0203\u020FoubleQuote;\u601Duote;\u6019\u0200lnpu\u021E\u0228\u0247\u0255on\u0100;e\u0225\u0226\u6237;\u6A74\u0180git\u022F\u0236\u023Aruent;\u6261nt;\u622FourIntegral;\u622E\u0100fr\u024C\u024E;\u6102oduct;\u6210nterClockwiseContourIntegral;\u6233oss;\u6A2Fcr;\uC000\u{1D49E}p\u0100;C\u0284\u0285\u62D3ap;\u624D\u0580DJSZacefios\u02A0\u02AC\u02B0\u02B4\u02B8\u02CB\u02D7\u02E1\u02E6\u0333\u048D\u0100;o\u0179\u02A5trahd;\u6911cy;\u4402cy;\u4405cy;\u440F\u0180grs\u02BF\u02C4\u02C7ger;\u6021r;\u61A1hv;\u6AE4\u0100ay\u02D0\u02D5ron;\u410E;\u4414l\u0100;t\u02DD\u02DE\u6207a;\u4394r;\uC000\u{1D507}\u0100af\u02EB\u0327\u0100cm\u02F0\u0322ritical\u0200ADGT\u0300\u0306\u0316\u031Ccute;\u40B4o\u0174\u030B\u030D;\u42D9bleAcute;\u42DDrave;\u4060ilde;\u42DCond;\u62C4ferentialD;\u6146\u0470\u033D\0\0\0\u0342\u0354\0\u0405f;\uC000\u{1D53B}\u0180;DE\u0348\u0349\u034D\u40A8ot;\u60DCqual;\u6250ble\u0300CDLRUV\u0363\u0372\u0382\u03CF\u03E2\u03F8ontourIntegra\xEC\u0239o\u0274\u0379\0\0\u037B\xBB\u0349nArrow;\u61D3\u0100eo\u0387\u03A4ft\u0180ART\u0390\u0396\u03A1rrow;\u61D0ightArrow;\u61D4e\xE5\u02CAng\u0100LR\u03AB\u03C4eft\u0100AR\u03B3\u03B9rrow;\u67F8ightArrow;\u67FAightArrow;\u67F9ight\u0100AT\u03D8\u03DErrow;\u61D2ee;\u62A8p\u0241\u03E9\0\0\u03EFrrow;\u61D1ownArrow;\u61D5erticalBar;\u6225n\u0300ABLRTa\u0412\u042A\u0430\u045E\u047F\u037Crrow\u0180;BU\u041D\u041E\u0422\u6193ar;\u6913pArrow;\u61F5reve;\u4311eft\u02D2\u043A\0\u0446\0\u0450ightVector;\u6950eeVector;\u695Eector\u0100;B\u0459\u045A\u61BDar;\u6956ight\u01D4\u0467\0\u0471eeVector;\u695Fector\u0100;B\u047A\u047B\u61C1ar;\u6957ee\u0100;A\u0486\u0487\u62A4rrow;\u61A7\u0100ct\u0492\u0497r;\uC000\u{1D49F}rok;\u4110\u0800NTacdfglmopqstux\u04BD\u04C0\u04C4\u04CB\u04DE\u04E2\u04E7\u04EE\u04F5\u0521\u052F\u0536\u0552\u055D\u0560\u0565G;\u414AH\u803B\xD0\u40D0cute\u803B\xC9\u40C9\u0180aiy\u04D2\u04D7\u04DCron;\u411Arc\u803B\xCA\u40CA;\u442Dot;\u4116r;\uC000\u{1D508}rave\u803B\xC8\u40C8ement;\u6208\u0100ap\u04FA\u04FEcr;\u4112ty\u0253\u0506\0\0\u0512mallSquare;\u65FBerySmallSquare;\u65AB\u0100gp\u0526\u052Aon;\u4118f;\uC000\u{1D53C}silon;\u4395u\u0100ai\u053C\u0549l\u0100;T\u0542\u0543\u6A75ilde;\u6242librium;\u61CC\u0100ci\u0557\u055Ar;\u6130m;\u6A73a;\u4397ml\u803B\xCB\u40CB\u0100ip\u056A\u056Fsts;\u6203onentialE;\u6147\u0280cfios\u0585\u0588\u058D\u05B2\u05CCy;\u4424r;\uC000\u{1D509}lled\u0253\u0597\0\0\u05A3mallSquare;\u65FCerySmallSquare;\u65AA\u0370\u05BA\0\u05BF\0\0\u05C4f;\uC000\u{1D53D}All;\u6200riertrf;\u6131c\xF2\u05CB\u0600JTabcdfgorst\u05E8\u05EC\u05EF\u05FA\u0600\u0612\u0616\u061B\u061D\u0623\u066C\u0672cy;\u4403\u803B>\u403Emma\u0100;d\u05F7\u05F8\u4393;\u43DCreve;\u411E\u0180eiy\u0607\u060C\u0610dil;\u4122rc;\u411C;\u4413ot;\u4120r;\uC000\u{1D50A};\u62D9pf;\uC000\u{1D53E}eater\u0300EFGLST\u0635\u0644\u064E\u0656\u065B\u0666qual\u0100;L\u063E\u063F\u6265ess;\u62DBullEqual;\u6267reater;\u6AA2ess;\u6277lantEqual;\u6A7Eilde;\u6273cr;\uC000\u{1D4A2};\u626B\u0400Aacfiosu\u0685\u068B\u0696\u069B\u069E\u06AA\u06BE\u06CARDcy;\u442A\u0100ct\u0690\u0694ek;\u42C7;\u405Eirc;\u4124r;\u610ClbertSpace;\u610B\u01F0\u06AF\0\u06B2f;\u610DizontalLine;\u6500\u0100ct\u06C3\u06C5\xF2\u06A9rok;\u4126mp\u0144\u06D0\u06D8ownHum\xF0\u012Fqual;\u624F\u0700EJOacdfgmnostu\u06FA\u06FE\u0703\u0707\u070E\u071A\u071E\u0721\u0728\u0744\u0778\u078B\u078F\u0795cy;\u4415lig;\u4132cy;\u4401cute\u803B\xCD\u40CD\u0100iy\u0713\u0718rc\u803B\xCE\u40CE;\u4418ot;\u4130r;\u6111rave\u803B\xCC\u40CC\u0180;ap\u0720\u072F\u073F\u0100cg\u0734\u0737r;\u412AinaryI;\u6148lie\xF3\u03DD\u01F4\u0749\0\u0762\u0100;e\u074D\u074E\u622C\u0100gr\u0753\u0758ral;\u622Bsection;\u62C2isible\u0100CT\u076C\u0772omma;\u6063imes;\u6062\u0180gpt\u077F\u0783\u0788on;\u412Ef;\uC000\u{1D540}a;\u4399cr;\u6110ilde;\u4128\u01EB\u079A\0\u079Ecy;\u4406l\u803B\xCF\u40CF\u0280cfosu\u07AC\u07B7\u07BC\u07C2\u07D0\u0100iy\u07B1\u07B5rc;\u4134;\u4419r;\uC000\u{1D50D}pf;\uC000\u{1D541}\u01E3\u07C7\0\u07CCr;\uC000\u{1D4A5}rcy;\u4408kcy;\u4404\u0380HJacfos\u07E4\u07E8\u07EC\u07F1\u07FD\u0802\u0808cy;\u4425cy;\u440Cppa;\u439A\u0100ey\u07F6\u07FBdil;\u4136;\u441Ar;\uC000\u{1D50E}pf;\uC000\u{1D542}cr;\uC000\u{1D4A6}\u0580JTaceflmost\u0825\u0829\u082C\u0850\u0863\u09B3\u09B8\u09C7\u09CD\u0A37\u0A47cy;\u4409\u803B<\u403C\u0280cmnpr\u0837\u083C\u0841\u0844\u084Dute;\u4139bda;\u439Bg;\u67EAlacetrf;\u6112r;\u619E\u0180aey\u0857\u085C\u0861ron;\u413Ddil;\u413B;\u441B\u0100fs\u0868\u0970t\u0500ACDFRTUVar\u087E\u08A9\u08B1\u08E0\u08E6\u08FC\u092F\u095B\u0390\u096A\u0100nr\u0883\u088FgleBracket;\u67E8row\u0180;BR\u0899\u089A\u089E\u6190ar;\u61E4ightArrow;\u61C6eiling;\u6308o\u01F5\u08B7\0\u08C3bleBracket;\u67E6n\u01D4\u08C8\0\u08D2eeVector;\u6961ector\u0100;B\u08DB\u08DC\u61C3ar;\u6959loor;\u630Aight\u0100AV\u08EF\u08F5rrow;\u6194ector;\u694E\u0100er\u0901\u0917e\u0180;AV\u0909\u090A\u0910\u62A3rrow;\u61A4ector;\u695Aiangle\u0180;BE\u0924\u0925\u0929\u62B2ar;\u69CFqual;\u62B4p\u0180DTV\u0937\u0942\u094CownVector;\u6951eeVector;\u6960ector\u0100;B\u0956\u0957\u61BFar;\u6958ector\u0100;B\u0965\u0966\u61BCar;\u6952ight\xE1\u039Cs\u0300EFGLST\u097E\u098B\u0995\u099D\u09A2\u09ADqualGreater;\u62DAullEqual;\u6266reater;\u6276ess;\u6AA1lantEqual;\u6A7Dilde;\u6272r;\uC000\u{1D50F}\u0100;e\u09BD\u09BE\u62D8ftarrow;\u61DAidot;\u413F\u0180npw\u09D4\u0A16\u0A1Bg\u0200LRlr\u09DE\u09F7\u0A02\u0A10eft\u0100AR\u09E6\u09ECrrow;\u67F5ightArrow;\u67F7ightArrow;\u67F6eft\u0100ar\u03B3\u0A0Aight\xE1\u03BFight\xE1\u03CAf;\uC000\u{1D543}er\u0100LR\u0A22\u0A2CeftArrow;\u6199ightArrow;\u6198\u0180cht\u0A3E\u0A40\u0A42\xF2\u084C;\u61B0rok;\u4141;\u626A\u0400acefiosu\u0A5A\u0A5D\u0A60\u0A77\u0A7C\u0A85\u0A8B\u0A8Ep;\u6905y;\u441C\u0100dl\u0A65\u0A6FiumSpace;\u605Flintrf;\u6133r;\uC000\u{1D510}nusPlus;\u6213pf;\uC000\u{1D544}c\xF2\u0A76;\u439C\u0480Jacefostu\u0AA3\u0AA7\u0AAD\u0AC0\u0B14\u0B19\u0D91\u0D97\u0D9Ecy;\u440Acute;\u4143\u0180aey\u0AB4\u0AB9\u0ABEron;\u4147dil;\u4145;\u441D\u0180gsw\u0AC7\u0AF0\u0B0Eative\u0180MTV\u0AD3\u0ADF\u0AE8ediumSpace;\u600Bhi\u0100cn\u0AE6\u0AD8\xEB\u0AD9eryThi\xEE\u0AD9ted\u0100GL\u0AF8\u0B06reaterGreate\xF2\u0673essLes\xF3\u0A48Line;\u400Ar;\uC000\u{1D511}\u0200Bnpt\u0B22\u0B28\u0B37\u0B3Areak;\u6060BreakingSpace;\u40A0f;\u6115\u0680;CDEGHLNPRSTV\u0B55\u0B56\u0B6A\u0B7C\u0BA1\u0BEB\u0C04\u0C5E\u0C84\u0CA6\u0CD8\u0D61\u0D85\u6AEC\u0100ou\u0B5B\u0B64ngruent;\u6262pCap;\u626DoubleVerticalBar;\u6226\u0180lqx\u0B83\u0B8A\u0B9Bement;\u6209ual\u0100;T\u0B92\u0B93\u6260ilde;\uC000\u2242\u0338ists;\u6204reater\u0380;EFGLST\u0BB6\u0BB7\u0BBD\u0BC9\u0BD3\u0BD8\u0BE5\u626Fqual;\u6271ullEqual;\uC000\u2267\u0338reater;\uC000\u226B\u0338ess;\u6279lantEqual;\uC000\u2A7E\u0338ilde;\u6275ump\u0144\u0BF2\u0BFDownHump;\uC000\u224E\u0338qual;\uC000\u224F\u0338e\u0100fs\u0C0A\u0C27tTriangle\u0180;BE\u0C1A\u0C1B\u0C21\u62EAar;\uC000\u29CF\u0338qual;\u62ECs\u0300;EGLST\u0C35\u0C36\u0C3C\u0C44\u0C4B\u0C58\u626Equal;\u6270reater;\u6278ess;\uC000\u226A\u0338lantEqual;\uC000\u2A7D\u0338ilde;\u6274ested\u0100GL\u0C68\u0C79reaterGreater;\uC000\u2AA2\u0338essLess;\uC000\u2AA1\u0338recedes\u0180;ES\u0C92\u0C93\u0C9B\u6280qual;\uC000\u2AAF\u0338lantEqual;\u62E0\u0100ei\u0CAB\u0CB9verseElement;\u620CghtTriangle\u0180;BE\u0CCB\u0CCC\u0CD2\u62EBar;\uC000\u29D0\u0338qual;\u62ED\u0100qu\u0CDD\u0D0CuareSu\u0100bp\u0CE8\u0CF9set\u0100;E\u0CF0\u0CF3\uC000\u228F\u0338qual;\u62E2erset\u0100;E\u0D03\u0D06\uC000\u2290\u0338qual;\u62E3\u0180bcp\u0D13\u0D24\u0D4Eset\u0100;E\u0D1B\u0D1E\uC000\u2282\u20D2qual;\u6288ceeds\u0200;EST\u0D32\u0D33\u0D3B\u0D46\u6281qual;\uC000\u2AB0\u0338lantEqual;\u62E1ilde;\uC000\u227F\u0338erset\u0100;E\u0D58\u0D5B\uC000\u2283\u20D2qual;\u6289ilde\u0200;EFT\u0D6E\u0D6F\u0D75\u0D7F\u6241qual;\u6244ullEqual;\u6247ilde;\u6249erticalBar;\u6224cr;\uC000\u{1D4A9}ilde\u803B\xD1\u40D1;\u439D\u0700Eacdfgmoprstuv\u0DBD\u0DC2\u0DC9\u0DD5\u0DDB\u0DE0\u0DE7\u0DFC\u0E02\u0E20\u0E22\u0E32\u0E3F\u0E44lig;\u4152cute\u803B\xD3\u40D3\u0100iy\u0DCE\u0DD3rc\u803B\xD4\u40D4;\u441Eblac;\u4150r;\uC000\u{1D512}rave\u803B\xD2\u40D2\u0180aei\u0DEE\u0DF2\u0DF6cr;\u414Cga;\u43A9cron;\u439Fpf;\uC000\u{1D546}enCurly\u0100DQ\u0E0E\u0E1AoubleQuote;\u601Cuote;\u6018;\u6A54\u0100cl\u0E27\u0E2Cr;\uC000\u{1D4AA}ash\u803B\xD8\u40D8i\u016C\u0E37\u0E3Cde\u803B\xD5\u40D5es;\u6A37ml\u803B\xD6\u40D6er\u0100BP\u0E4B\u0E60\u0100ar\u0E50\u0E53r;\u603Eac\u0100ek\u0E5A\u0E5C;\u63DEet;\u63B4arenthesis;\u63DC\u0480acfhilors\u0E7F\u0E87\u0E8A\u0E8F\u0E92\u0E94\u0E9D\u0EB0\u0EFCrtialD;\u6202y;\u441Fr;\uC000\u{1D513}i;\u43A6;\u43A0usMinus;\u40B1\u0100ip\u0EA2\u0EADncareplan\xE5\u069Df;\u6119\u0200;eio\u0EB9\u0EBA\u0EE0\u0EE4\u6ABBcedes\u0200;EST\u0EC8\u0EC9\u0ECF\u0EDA\u627Aqual;\u6AAFlantEqual;\u627Cilde;\u627Eme;\u6033\u0100dp\u0EE9\u0EEEuct;\u620Fortion\u0100;a\u0225\u0EF9l;\u621D\u0100ci\u0F01\u0F06r;\uC000\u{1D4AB};\u43A8\u0200Ufos\u0F11\u0F16\u0F1B\u0F1FOT\u803B"\u4022r;\uC000\u{1D514}pf;\u611Acr;\uC000\u{1D4AC}\u0600BEacefhiorsu\u0F3E\u0F43\u0F47\u0F60\u0F73\u0FA7\u0FAA\u0FAD\u1096\u10A9\u10B4\u10BEarr;\u6910G\u803B\xAE\u40AE\u0180cnr\u0F4E\u0F53\u0F56ute;\u4154g;\u67EBr\u0100;t\u0F5C\u0F5D\u61A0l;\u6916\u0180aey\u0F67\u0F6C\u0F71ron;\u4158dil;\u4156;\u4420\u0100;v\u0F78\u0F79\u611Cerse\u0100EU\u0F82\u0F99\u0100lq\u0F87\u0F8Eement;\u620Builibrium;\u61CBpEquilibrium;\u696Fr\xBB\u0F79o;\u43A1ght\u0400ACDFTUVa\u0FC1\u0FEB\u0FF3\u1022\u1028\u105B\u1087\u03D8\u0100nr\u0FC6\u0FD2gleBracket;\u67E9row\u0180;BL\u0FDC\u0FDD\u0FE1\u6192ar;\u61E5eftArrow;\u61C4eiling;\u6309o\u01F5\u0FF9\0\u1005bleBracket;\u67E7n\u01D4\u100A\0\u1014eeVector;\u695Dector\u0100;B\u101D\u101E\u61C2ar;\u6955loor;\u630B\u0100er\u102D\u1043e\u0180;AV\u1035\u1036\u103C\u62A2rrow;\u61A6ector;\u695Biangle\u0180;BE\u1050\u1051\u1055\u62B3ar;\u69D0qual;\u62B5p\u0180DTV\u1063\u106E\u1078ownVector;\u694FeeVector;\u695Cector\u0100;B\u1082\u1083\u61BEar;\u6954ector\u0100;B\u1091\u1092\u61C0ar;\u6953\u0100pu\u109B\u109Ef;\u611DndImplies;\u6970ightarrow;\u61DB\u0100ch\u10B9\u10BCr;\u611B;\u61B1leDelayed;\u69F4\u0680HOacfhimoqstu\u10E4\u10F1\u10F7\u10FD\u1119\u111E\u1151\u1156\u1161\u1167\u11B5\u11BB\u11BF\u0100Cc\u10E9\u10EEHcy;\u4429y;\u4428FTcy;\u442Ccute;\u415A\u0280;aeiy\u1108\u1109\u110E\u1113\u1117\u6ABCron;\u4160dil;\u415Erc;\u415C;\u4421r;\uC000\u{1D516}ort\u0200DLRU\u112A\u1134\u113E\u1149ownArrow\xBB\u041EeftArrow\xBB\u089AightArrow\xBB\u0FDDpArrow;\u6191gma;\u43A3allCircle;\u6218pf;\uC000\u{1D54A}\u0272\u116D\0\0\u1170t;\u621Aare\u0200;ISU\u117B\u117C\u1189\u11AF\u65A1ntersection;\u6293u\u0100bp\u118F\u119Eset\u0100;E\u1197\u1198\u628Fqual;\u6291erset\u0100;E\u11A8\u11A9\u6290qual;\u6292nion;\u6294cr;\uC000\u{1D4AE}ar;\u62C6\u0200bcmp\u11C8\u11DB\u1209\u120B\u0100;s\u11CD\u11CE\u62D0et\u0100;E\u11CD\u11D5qual;\u6286\u0100ch\u11E0\u1205eeds\u0200;EST\u11ED\u11EE\u11F4\u11FF\u627Bqual;\u6AB0lantEqual;\u627Dilde;\u627FTh\xE1\u0F8C;\u6211\u0180;es\u1212\u1213\u1223\u62D1rset\u0100;E\u121C\u121D\u6283qual;\u6287et\xBB\u1213\u0580HRSacfhiors\u123E\u1244\u1249\u1255\u125E\u1271\u1276\u129F\u12C2\u12C8\u12D1ORN\u803B\xDE\u40DEADE;\u6122\u0100Hc\u124E\u1252cy;\u440By;\u4426\u0100bu\u125A\u125C;\u4009;\u43A4\u0180aey\u1265\u126A\u126Fron;\u4164dil;\u4162;\u4422r;\uC000\u{1D517}\u0100ei\u127B\u1289\u01F2\u1280\0\u1287efore;\u6234a;\u4398\u0100cn\u128E\u1298kSpace;\uC000\u205F\u200ASpace;\u6009lde\u0200;EFT\u12AB\u12AC\u12B2\u12BC\u623Cqual;\u6243ullEqual;\u6245ilde;\u6248pf;\uC000\u{1D54B}ipleDot;\u60DB\u0100ct\u12D6\u12DBr;\uC000\u{1D4AF}rok;\u4166\u0AE1\u12F7\u130E\u131A\u1326\0\u132C\u1331\0\0\0\0\0\u1338\u133D\u1377\u1385\0\u13FF\u1404\u140A\u1410\u0100cr\u12FB\u1301ute\u803B\xDA\u40DAr\u0100;o\u1307\u1308\u619Fcir;\u6949r\u01E3\u1313\0\u1316y;\u440Eve;\u416C\u0100iy\u131E\u1323rc\u803B\xDB\u40DB;\u4423blac;\u4170r;\uC000\u{1D518}rave\u803B\xD9\u40D9acr;\u416A\u0100di\u1341\u1369er\u0100BP\u1348\u135D\u0100ar\u134D\u1350r;\u405Fac\u0100ek\u1357\u1359;\u63DFet;\u63B5arenthesis;\u63DDon\u0100;P\u1370\u1371\u62C3lus;\u628E\u0100gp\u137B\u137Fon;\u4172f;\uC000\u{1D54C}\u0400ADETadps\u1395\u13AE\u13B8\u13C4\u03E8\u13D2\u13D7\u13F3rrow\u0180;BD\u1150\u13A0\u13A4ar;\u6912ownArrow;\u61C5ownArrow;\u6195quilibrium;\u696Eee\u0100;A\u13CB\u13CC\u62A5rrow;\u61A5own\xE1\u03F3er\u0100LR\u13DE\u13E8eftArrow;\u6196ightArrow;\u6197i\u0100;l\u13F9\u13FA\u43D2on;\u43A5ing;\u416Ecr;\uC000\u{1D4B0}ilde;\u4168ml\u803B\xDC\u40DC\u0480Dbcdefosv\u1427\u142C\u1430\u1433\u143E\u1485\u148A\u1490\u1496ash;\u62ABar;\u6AEBy;\u4412ash\u0100;l\u143B\u143C\u62A9;\u6AE6\u0100er\u1443\u1445;\u62C1\u0180bty\u144C\u1450\u147Aar;\u6016\u0100;i\u144F\u1455cal\u0200BLST\u1461\u1465\u146A\u1474ar;\u6223ine;\u407Ceparator;\u6758ilde;\u6240ThinSpace;\u600Ar;\uC000\u{1D519}pf;\uC000\u{1D54D}cr;\uC000\u{1D4B1}dash;\u62AA\u0280cefos\u14A7\u14AC\u14B1\u14B6\u14BCirc;\u4174dge;\u62C0r;\uC000\u{1D51A}pf;\uC000\u{1D54E}cr;\uC000\u{1D4B2}\u0200fios\u14CB\u14D0\u14D2\u14D8r;\uC000\u{1D51B};\u439Epf;\uC000\u{1D54F}cr;\uC000\u{1D4B3}\u0480AIUacfosu\u14F1\u14F5\u14F9\u14FD\u1504\u150F\u1514\u151A\u1520cy;\u442Fcy;\u4407cy;\u442Ecute\u803B\xDD\u40DD\u0100iy\u1509\u150Drc;\u4176;\u442Br;\uC000\u{1D51C}pf;\uC000\u{1D550}cr;\uC000\u{1D4B4}ml;\u4178\u0400Hacdefos\u1535\u1539\u153F\u154B\u154F\u155D\u1560\u1564cy;\u4416cute;\u4179\u0100ay\u1544\u1549ron;\u417D;\u4417ot;\u417B\u01F2\u1554\0\u155BoWidt\xE8\u0AD9a;\u4396r;\u6128pf;\u6124cr;\uC000\u{1D4B5}\u0BE1\u1583\u158A\u1590\0\u15B0\u15B6\u15BF\0\0\0\0\u15C6\u15DB\u15EB\u165F\u166D\0\u1695\u169B\u16B2\u16B9\0\u16BEcute\u803B\xE1\u40E1reve;\u4103\u0300;Ediuy\u159C\u159D\u15A1\u15A3\u15A8\u15AD\u623E;\uC000\u223E\u0333;\u623Frc\u803B\xE2\u40E2te\u80BB\xB4\u0306;\u4430lig\u803B\xE6\u40E6\u0100;r\xB2\u15BA;\uC000\u{1D51E}rave\u803B\xE0\u40E0\u0100ep\u15CA\u15D6\u0100fp\u15CF\u15D4sym;\u6135\xE8\u15D3ha;\u43B1\u0100ap\u15DFc\u0100cl\u15E4\u15E7r;\u4101g;\u6A3F\u0264\u15F0\0\0\u160A\u0280;adsv\u15FA\u15FB\u15FF\u1601\u1607\u6227nd;\u6A55;\u6A5Clope;\u6A58;\u6A5A\u0380;elmrsz\u1618\u1619\u161B\u161E\u163F\u164F\u1659\u6220;\u69A4e\xBB\u1619sd\u0100;a\u1625\u1626\u6221\u0461\u1630\u1632\u1634\u1636\u1638\u163A\u163C\u163E;\u69A8;\u69A9;\u69AA;\u69AB;\u69AC;\u69AD;\u69AE;\u69AFt\u0100;v\u1645\u1646\u621Fb\u0100;d\u164C\u164D\u62BE;\u699D\u0100pt\u1654\u1657h;\u6222\xBB\xB9arr;\u637C\u0100gp\u1663\u1667on;\u4105f;\uC000\u{1D552}\u0380;Eaeiop\u12C1\u167B\u167D\u1682\u1684\u1687\u168A;\u6A70cir;\u6A6F;\u624Ad;\u624Bs;\u4027rox\u0100;e\u12C1\u1692\xF1\u1683ing\u803B\xE5\u40E5\u0180cty\u16A1\u16A6\u16A8r;\uC000\u{1D4B6};\u402Amp\u0100;e\u12C1\u16AF\xF1\u0288ilde\u803B\xE3\u40E3ml\u803B\xE4\u40E4\u0100ci\u16C2\u16C8onin\xF4\u0272nt;\u6A11\u0800Nabcdefiklnoprsu\u16ED\u16F1\u1730\u173C\u1743\u1748\u1778\u177D\u17E0\u17E6\u1839\u1850\u170D\u193D\u1948\u1970ot;\u6AED\u0100cr\u16F6\u171Ek\u0200ceps\u1700\u1705\u170D\u1713ong;\u624Cpsilon;\u43F6rime;\u6035im\u0100;e\u171A\u171B\u623Dq;\u62CD\u0176\u1722\u1726ee;\u62BDed\u0100;g\u172C\u172D\u6305e\xBB\u172Drk\u0100;t\u135C\u1737brk;\u63B6\u0100oy\u1701\u1741;\u4431quo;\u601E\u0280cmprt\u1753\u175B\u1761\u1764\u1768aus\u0100;e\u010A\u0109ptyv;\u69B0s\xE9\u170Cno\xF5\u0113\u0180ahw\u176F\u1771\u1773;\u43B2;\u6136een;\u626Cr;\uC000\u{1D51F}g\u0380costuvw\u178D\u179D\u17B3\u17C1\u17D5\u17DB\u17DE\u0180aiu\u1794\u1796\u179A\xF0\u0760rc;\u65EFp\xBB\u1371\u0180dpt\u17A4\u17A8\u17ADot;\u6A00lus;\u6A01imes;\u6A02\u0271\u17B9\0\0\u17BEcup;\u6A06ar;\u6605riangle\u0100du\u17CD\u17D2own;\u65BDp;\u65B3plus;\u6A04e\xE5\u1444\xE5\u14ADarow;\u690D\u0180ako\u17ED\u1826\u1835\u0100cn\u17F2\u1823k\u0180lst\u17FA\u05AB\u1802ozenge;\u69EBriangle\u0200;dlr\u1812\u1813\u1818\u181D\u65B4own;\u65BEeft;\u65C2ight;\u65B8k;\u6423\u01B1\u182B\0\u1833\u01B2\u182F\0\u1831;\u6592;\u65914;\u6593ck;\u6588\u0100eo\u183E\u184D\u0100;q\u1843\u1846\uC000=\u20E5uiv;\uC000\u2261\u20E5t;\u6310\u0200ptwx\u1859\u185E\u1867\u186Cf;\uC000\u{1D553}\u0100;t\u13CB\u1863om\xBB\u13CCtie;\u62C8\u0600DHUVbdhmptuv\u1885\u1896\u18AA\u18BB\u18D7\u18DB\u18EC\u18FF\u1905\u190A\u1910\u1921\u0200LRlr\u188E\u1890\u1892\u1894;\u6557;\u6554;\u6556;\u6553\u0280;DUdu\u18A1\u18A2\u18A4\u18A6\u18A8\u6550;\u6566;\u6569;\u6564;\u6567\u0200LRlr\u18B3\u18B5\u18B7\u18B9;\u655D;\u655A;\u655C;\u6559\u0380;HLRhlr\u18CA\u18CB\u18CD\u18CF\u18D1\u18D3\u18D5\u6551;\u656C;\u6563;\u6560;\u656B;\u6562;\u655Fox;\u69C9\u0200LRlr\u18E4\u18E6\u18E8\u18EA;\u6555;\u6552;\u6510;\u650C\u0280;DUdu\u06BD\u18F7\u18F9\u18FB\u18FD;\u6565;\u6568;\u652C;\u6534inus;\u629Flus;\u629Eimes;\u62A0\u0200LRlr\u1919\u191B\u191D\u191F;\u655B;\u6558;\u6518;\u6514\u0380;HLRhlr\u1930\u1931\u1933\u1935\u1937\u1939\u193B\u6502;\u656A;\u6561;\u655E;\u653C;\u6524;\u651C\u0100ev\u0123\u1942bar\u803B\xA6\u40A6\u0200ceio\u1951\u1956\u195A\u1960r;\uC000\u{1D4B7}mi;\u604Fm\u0100;e\u171A\u171Cl\u0180;bh\u1968\u1969\u196B\u405C;\u69C5sub;\u67C8\u016C\u1974\u197El\u0100;e\u1979\u197A\u6022t\xBB\u197Ap\u0180;Ee\u012F\u1985\u1987;\u6AAE\u0100;q\u06DC\u06DB\u0CE1\u19A7\0\u19E8\u1A11\u1A15\u1A32\0\u1A37\u1A50\0\0\u1AB4\0\0\u1AC1\0\0\u1B21\u1B2E\u1B4D\u1B52\0\u1BFD\0\u1C0C\u0180cpr\u19AD\u19B2\u19DDute;\u4107\u0300;abcds\u19BF\u19C0\u19C4\u19CA\u19D5\u19D9\u6229nd;\u6A44rcup;\u6A49\u0100au\u19CF\u19D2p;\u6A4Bp;\u6A47ot;\u6A40;\uC000\u2229\uFE00\u0100eo\u19E2\u19E5t;\u6041\xEE\u0693\u0200aeiu\u19F0\u19FB\u1A01\u1A05\u01F0\u19F5\0\u19F8s;\u6A4Don;\u410Ddil\u803B\xE7\u40E7rc;\u4109ps\u0100;s\u1A0C\u1A0D\u6A4Cm;\u6A50ot;\u410B\u0180dmn\u1A1B\u1A20\u1A26il\u80BB\xB8\u01ADptyv;\u69B2t\u8100\xA2;e\u1A2D\u1A2E\u40A2r\xE4\u01B2r;\uC000\u{1D520}\u0180cei\u1A3D\u1A40\u1A4Dy;\u4447ck\u0100;m\u1A47\u1A48\u6713ark\xBB\u1A48;\u43C7r\u0380;Ecefms\u1A5F\u1A60\u1A62\u1A6B\u1AA4\u1AAA\u1AAE\u65CB;\u69C3\u0180;el\u1A69\u1A6A\u1A6D\u42C6q;\u6257e\u0261\u1A74\0\0\u1A88rrow\u0100lr\u1A7C\u1A81eft;\u61BAight;\u61BB\u0280RSacd\u1A92\u1A94\u1A96\u1A9A\u1A9F\xBB\u0F47;\u64C8st;\u629Birc;\u629Aash;\u629Dnint;\u6A10id;\u6AEFcir;\u69C2ubs\u0100;u\u1ABB\u1ABC\u6663it\xBB\u1ABC\u02EC\u1AC7\u1AD4\u1AFA\0\u1B0Aon\u0100;e\u1ACD\u1ACE\u403A\u0100;q\xC7\xC6\u026D\u1AD9\0\0\u1AE2a\u0100;t\u1ADE\u1ADF\u402C;\u4040\u0180;fl\u1AE8\u1AE9\u1AEB\u6201\xEE\u1160e\u0100mx\u1AF1\u1AF6ent\xBB\u1AE9e\xF3\u024D\u01E7\u1AFE\0\u1B07\u0100;d\u12BB\u1B02ot;\u6A6Dn\xF4\u0246\u0180fry\u1B10\u1B14\u1B17;\uC000\u{1D554}o\xE4\u0254\u8100\xA9;s\u0155\u1B1Dr;\u6117\u0100ao\u1B25\u1B29rr;\u61B5ss;\u6717\u0100cu\u1B32\u1B37r;\uC000\u{1D4B8}\u0100bp\u1B3C\u1B44\u0100;e\u1B41\u1B42\u6ACF;\u6AD1\u0100;e\u1B49\u1B4A\u6AD0;\u6AD2dot;\u62EF\u0380delprvw\u1B60\u1B6C\u1B77\u1B82\u1BAC\u1BD4\u1BF9arr\u0100lr\u1B68\u1B6A;\u6938;\u6935\u0270\u1B72\0\0\u1B75r;\u62DEc;\u62DFarr\u0100;p\u1B7F\u1B80\u61B6;\u693D\u0300;bcdos\u1B8F\u1B90\u1B96\u1BA1\u1BA5\u1BA8\u622Arcap;\u6A48\u0100au\u1B9B\u1B9Ep;\u6A46p;\u6A4Aot;\u628Dr;\u6A45;\uC000\u222A\uFE00\u0200alrv\u1BB5\u1BBF\u1BDE\u1BE3rr\u0100;m\u1BBC\u1BBD\u61B7;\u693Cy\u0180evw\u1BC7\u1BD4\u1BD8q\u0270\u1BCE\0\0\u1BD2re\xE3\u1B73u\xE3\u1B75ee;\u62CEedge;\u62CFen\u803B\xA4\u40A4earrow\u0100lr\u1BEE\u1BF3eft\xBB\u1B80ight\xBB\u1BBDe\xE4\u1BDD\u0100ci\u1C01\u1C07onin\xF4\u01F7nt;\u6231lcty;\u632D\u0980AHabcdefhijlorstuwz\u1C38\u1C3B\u1C3F\u1C5D\u1C69\u1C75\u1C8A\u1C9E\u1CAC\u1CB7\u1CFB\u1CFF\u1D0D\u1D7B\u1D91\u1DAB\u1DBB\u1DC6\u1DCDr\xF2\u0381ar;\u6965\u0200glrs\u1C48\u1C4D\u1C52\u1C54ger;\u6020eth;\u6138\xF2\u1133h\u0100;v\u1C5A\u1C5B\u6010\xBB\u090A\u016B\u1C61\u1C67arow;\u690Fa\xE3\u0315\u0100ay\u1C6E\u1C73ron;\u410F;\u4434\u0180;ao\u0332\u1C7C\u1C84\u0100gr\u02BF\u1C81r;\u61CAtseq;\u6A77\u0180glm\u1C91\u1C94\u1C98\u803B\xB0\u40B0ta;\u43B4ptyv;\u69B1\u0100ir\u1CA3\u1CA8sht;\u697F;\uC000\u{1D521}ar\u0100lr\u1CB3\u1CB5\xBB\u08DC\xBB\u101E\u0280aegsv\u1CC2\u0378\u1CD6\u1CDC\u1CE0m\u0180;os\u0326\u1CCA\u1CD4nd\u0100;s\u0326\u1CD1uit;\u6666amma;\u43DDin;\u62F2\u0180;io\u1CE7\u1CE8\u1CF8\u40F7de\u8100\xF7;o\u1CE7\u1CF0ntimes;\u62C7n\xF8\u1CF7cy;\u4452c\u026F\u1D06\0\0\u1D0Arn;\u631Eop;\u630D\u0280lptuw\u1D18\u1D1D\u1D22\u1D49\u1D55lar;\u4024f;\uC000\u{1D555}\u0280;emps\u030B\u1D2D\u1D37\u1D3D\u1D42q\u0100;d\u0352\u1D33ot;\u6251inus;\u6238lus;\u6214quare;\u62A1blebarwedg\xE5\xFAn\u0180adh\u112E\u1D5D\u1D67ownarrow\xF3\u1C83arpoon\u0100lr\u1D72\u1D76ef\xF4\u1CB4igh\xF4\u1CB6\u0162\u1D7F\u1D85karo\xF7\u0F42\u026F\u1D8A\0\0\u1D8Ern;\u631Fop;\u630C\u0180cot\u1D98\u1DA3\u1DA6\u0100ry\u1D9D\u1DA1;\uC000\u{1D4B9};\u4455l;\u69F6rok;\u4111\u0100dr\u1DB0\u1DB4ot;\u62F1i\u0100;f\u1DBA\u1816\u65BF\u0100ah\u1DC0\u1DC3r\xF2\u0429a\xF2\u0FA6angle;\u69A6\u0100ci\u1DD2\u1DD5y;\u445Fgrarr;\u67FF\u0900Dacdefglmnopqrstux\u1E01\u1E09\u1E19\u1E38\u0578\u1E3C\u1E49\u1E61\u1E7E\u1EA5\u1EAF\u1EBD\u1EE1\u1F2A\u1F37\u1F44\u1F4E\u1F5A\u0100Do\u1E06\u1D34o\xF4\u1C89\u0100cs\u1E0E\u1E14ute\u803B\xE9\u40E9ter;\u6A6E\u0200aioy\u1E22\u1E27\u1E31\u1E36ron;\u411Br\u0100;c\u1E2D\u1E2E\u6256\u803B\xEA\u40EAlon;\u6255;\u444Dot;\u4117\u0100Dr\u1E41\u1E45ot;\u6252;\uC000\u{1D522}\u0180;rs\u1E50\u1E51\u1E57\u6A9Aave\u803B\xE8\u40E8\u0100;d\u1E5C\u1E5D\u6A96ot;\u6A98\u0200;ils\u1E6A\u1E6B\u1E72\u1E74\u6A99nters;\u63E7;\u6113\u0100;d\u1E79\u1E7A\u6A95ot;\u6A97\u0180aps\u1E85\u1E89\u1E97cr;\u4113ty\u0180;sv\u1E92\u1E93\u1E95\u6205et\xBB\u1E93p\u01001;\u1E9D\u1EA4\u0133\u1EA1\u1EA3;\u6004;\u6005\u6003\u0100gs\u1EAA\u1EAC;\u414Bp;\u6002\u0100gp\u1EB4\u1EB8on;\u4119f;\uC000\u{1D556}\u0180als\u1EC4\u1ECE\u1ED2r\u0100;s\u1ECA\u1ECB\u62D5l;\u69E3us;\u6A71i\u0180;lv\u1EDA\u1EDB\u1EDF\u43B5on\xBB\u1EDB;\u43F5\u0200csuv\u1EEA\u1EF3\u1F0B\u1F23\u0100io\u1EEF\u1E31rc\xBB\u1E2E\u0269\u1EF9\0\0\u1EFB\xED\u0548ant\u0100gl\u1F02\u1F06tr\xBB\u1E5Dess\xBB\u1E7A\u0180aei\u1F12\u1F16\u1F1Als;\u403Dst;\u625Fv\u0100;D\u0235\u1F20D;\u6A78parsl;\u69E5\u0100Da\u1F2F\u1F33ot;\u6253rr;\u6971\u0180cdi\u1F3E\u1F41\u1EF8r;\u612Fo\xF4\u0352\u0100ah\u1F49\u1F4B;\u43B7\u803B\xF0\u40F0\u0100mr\u1F53\u1F57l\u803B\xEB\u40EBo;\u60AC\u0180cip\u1F61\u1F64\u1F67l;\u4021s\xF4\u056E\u0100eo\u1F6C\u1F74ctatio\xEE\u0559nential\xE5\u0579\u09E1\u1F92\0\u1F9E\0\u1FA1\u1FA7\0\0\u1FC6\u1FCC\0\u1FD3\0\u1FE6\u1FEA\u2000\0\u2008\u205Allingdotse\xF1\u1E44y;\u4444male;\u6640\u0180ilr\u1FAD\u1FB3\u1FC1lig;\u8000\uFB03\u0269\u1FB9\0\0\u1FBDg;\u8000\uFB00ig;\u8000\uFB04;\uC000\u{1D523}lig;\u8000\uFB01lig;\uC000fj\u0180alt\u1FD9\u1FDC\u1FE1t;\u666Dig;\u8000\uFB02ns;\u65B1of;\u4192\u01F0\u1FEE\0\u1FF3f;\uC000\u{1D557}\u0100ak\u05BF\u1FF7\u0100;v\u1FFC\u1FFD\u62D4;\u6AD9artint;\u6A0D\u0100ao\u200C\u2055\u0100cs\u2011\u2052\u03B1\u201A\u2030\u2038\u2045\u2048\0\u2050\u03B2\u2022\u2025\u2027\u202A\u202C\0\u202E\u803B\xBD\u40BD;\u6153\u803B\xBC\u40BC;\u6155;\u6159;\u615B\u01B3\u2034\0\u2036;\u6154;\u6156\u02B4\u203E\u2041\0\0\u2043\u803B\xBE\u40BE;\u6157;\u615C5;\u6158\u01B6\u204C\0\u204E;\u615A;\u615D8;\u615El;\u6044wn;\u6322cr;\uC000\u{1D4BB}\u0880Eabcdefgijlnorstv\u2082\u2089\u209F\u20A5\u20B0\u20B4\u20F0\u20F5\u20FA\u20FF\u2103\u2112\u2138\u0317\u213E\u2152\u219E\u0100;l\u064D\u2087;\u6A8C\u0180cmp\u2090\u2095\u209Dute;\u41F5ma\u0100;d\u209C\u1CDA\u43B3;\u6A86reve;\u411F\u0100iy\u20AA\u20AErc;\u411D;\u4433ot;\u4121\u0200;lqs\u063E\u0642\u20BD\u20C9\u0180;qs\u063E\u064C\u20C4lan\xF4\u0665\u0200;cdl\u0665\u20D2\u20D5\u20E5c;\u6AA9ot\u0100;o\u20DC\u20DD\u6A80\u0100;l\u20E2\u20E3\u6A82;\u6A84\u0100;e\u20EA\u20ED\uC000\u22DB\uFE00s;\u6A94r;\uC000\u{1D524}\u0100;g\u0673\u061Bmel;\u6137cy;\u4453\u0200;Eaj\u065A\u210C\u210E\u2110;\u6A92;\u6AA5;\u6AA4\u0200Eaes\u211B\u211D\u2129\u2134;\u6269p\u0100;p\u2123\u2124\u6A8Arox\xBB\u2124\u0100;q\u212E\u212F\u6A88\u0100;q\u212E\u211Bim;\u62E7pf;\uC000\u{1D558}\u0100ci\u2143\u2146r;\u610Am\u0180;el\u066B\u214E\u2150;\u6A8E;\u6A90\u8300>;cdlqr\u05EE\u2160\u216A\u216E\u2173\u2179\u0100ci\u2165\u2167;\u6AA7r;\u6A7Aot;\u62D7Par;\u6995uest;\u6A7C\u0280adels\u2184\u216A\u2190\u0656\u219B\u01F0\u2189\0\u218Epro\xF8\u209Er;\u6978q\u0100lq\u063F\u2196les\xF3\u2088i\xED\u066B\u0100en\u21A3\u21ADrtneqq;\uC000\u2269\uFE00\xC5\u21AA\u0500Aabcefkosy\u21C4\u21C7\u21F1\u21F5\u21FA\u2218\u221D\u222F\u2268\u227Dr\xF2\u03A0\u0200ilmr\u21D0\u21D4\u21D7\u21DBrs\xF0\u1484f\xBB\u2024il\xF4\u06A9\u0100dr\u21E0\u21E4cy;\u444A\u0180;cw\u08F4\u21EB\u21EFir;\u6948;\u61ADar;\u610Firc;\u4125\u0180alr\u2201\u220E\u2213rts\u0100;u\u2209\u220A\u6665it\xBB\u220Alip;\u6026con;\u62B9r;\uC000\u{1D525}s\u0100ew\u2223\u2229arow;\u6925arow;\u6926\u0280amopr\u223A\u223E\u2243\u225E\u2263rr;\u61FFtht;\u623Bk\u0100lr\u2249\u2253eftarrow;\u61A9ightarrow;\u61AAf;\uC000\u{1D559}bar;\u6015\u0180clt\u226F\u2274\u2278r;\uC000\u{1D4BD}as\xE8\u21F4rok;\u4127\u0100bp\u2282\u2287ull;\u6043hen\xBB\u1C5B\u0AE1\u22A3\0\u22AA\0\u22B8\u22C5\u22CE\0\u22D5\u22F3\0\0\u22F8\u2322\u2367\u2362\u237F\0\u2386\u23AA\u23B4cute\u803B\xED\u40ED\u0180;iy\u0771\u22B0\u22B5rc\u803B\xEE\u40EE;\u4438\u0100cx\u22BC\u22BFy;\u4435cl\u803B\xA1\u40A1\u0100fr\u039F\u22C9;\uC000\u{1D526}rave\u803B\xEC\u40EC\u0200;ino\u073E\u22DD\u22E9\u22EE\u0100in\u22E2\u22E6nt;\u6A0Ct;\u622Dfin;\u69DCta;\u6129lig;\u4133\u0180aop\u22FE\u231A\u231D\u0180cgt\u2305\u2308\u2317r;\u412B\u0180elp\u071F\u230F\u2313in\xE5\u078Ear\xF4\u0720h;\u4131f;\u62B7ed;\u41B5\u0280;cfot\u04F4\u232C\u2331\u233D\u2341are;\u6105in\u0100;t\u2338\u2339\u621Eie;\u69DDdo\xF4\u2319\u0280;celp\u0757\u234C\u2350\u235B\u2361al;\u62BA\u0100gr\u2355\u2359er\xF3\u1563\xE3\u234Darhk;\u6A17rod;\u6A3C\u0200cgpt\u236F\u2372\u2376\u237By;\u4451on;\u412Ff;\uC000\u{1D55A}a;\u43B9uest\u803B\xBF\u40BF\u0100ci\u238A\u238Fr;\uC000\u{1D4BE}n\u0280;Edsv\u04F4\u239B\u239D\u23A1\u04F3;\u62F9ot;\u62F5\u0100;v\u23A6\u23A7\u62F4;\u62F3\u0100;i\u0777\u23AElde;\u4129\u01EB\u23B8\0\u23BCcy;\u4456l\u803B\xEF\u40EF\u0300cfmosu\u23CC\u23D7\u23DC\u23E1\u23E7\u23F5\u0100iy\u23D1\u23D5rc;\u4135;\u4439r;\uC000\u{1D527}ath;\u4237pf;\uC000\u{1D55B}\u01E3\u23EC\0\u23F1r;\uC000\u{1D4BF}rcy;\u4458kcy;\u4454\u0400acfghjos\u240B\u2416\u2422\u2427\u242D\u2431\u2435\u243Bppa\u0100;v\u2413\u2414\u43BA;\u43F0\u0100ey\u241B\u2420dil;\u4137;\u443Ar;\uC000\u{1D528}reen;\u4138cy;\u4445cy;\u445Cpf;\uC000\u{1D55C}cr;\uC000\u{1D4C0}\u0B80ABEHabcdefghjlmnoprstuv\u2470\u2481\u2486\u248D\u2491\u250E\u253D\u255A\u2580\u264E\u265E\u2665\u2679\u267D\u269A\u26B2\u26D8\u275D\u2768\u278B\u27C0\u2801\u2812\u0180art\u2477\u247A\u247Cr\xF2\u09C6\xF2\u0395ail;\u691Barr;\u690E\u0100;g\u0994\u248B;\u6A8Bar;\u6962\u0963\u24A5\0\u24AA\0\u24B1\0\0\0\0\0\u24B5\u24BA\0\u24C6\u24C8\u24CD\0\u24F9ute;\u413Amptyv;\u69B4ra\xEE\u084Cbda;\u43BBg\u0180;dl\u088E\u24C1\u24C3;\u6991\xE5\u088E;\u6A85uo\u803B\xAB\u40ABr\u0400;bfhlpst\u0899\u24DE\u24E6\u24E9\u24EB\u24EE\u24F1\u24F5\u0100;f\u089D\u24E3s;\u691Fs;\u691D\xEB\u2252p;\u61ABl;\u6939im;\u6973l;\u61A2\u0180;ae\u24FF\u2500\u2504\u6AABil;\u6919\u0100;s\u2509\u250A\u6AAD;\uC000\u2AAD\uFE00\u0180abr\u2515\u2519\u251Drr;\u690Crk;\u6772\u0100ak\u2522\u252Cc\u0100ek\u2528\u252A;\u407B;\u405B\u0100es\u2531\u2533;\u698Bl\u0100du\u2539\u253B;\u698F;\u698D\u0200aeuy\u2546\u254B\u2556\u2558ron;\u413E\u0100di\u2550\u2554il;\u413C\xEC\u08B0\xE2\u2529;\u443B\u0200cqrs\u2563\u2566\u256D\u257Da;\u6936uo\u0100;r\u0E19\u1746\u0100du\u2572\u2577har;\u6967shar;\u694Bh;\u61B2\u0280;fgqs\u258B\u258C\u0989\u25F3\u25FF\u6264t\u0280ahlrt\u2598\u25A4\u25B7\u25C2\u25E8rrow\u0100;t\u0899\u25A1a\xE9\u24F6arpoon\u0100du\u25AF\u25B4own\xBB\u045Ap\xBB\u0966eftarrows;\u61C7ight\u0180ahs\u25CD\u25D6\u25DErrow\u0100;s\u08F4\u08A7arpoon\xF3\u0F98quigarro\xF7\u21F0hreetimes;\u62CB\u0180;qs\u258B\u0993\u25FAlan\xF4\u09AC\u0280;cdgs\u09AC\u260A\u260D\u261D\u2628c;\u6AA8ot\u0100;o\u2614\u2615\u6A7F\u0100;r\u261A\u261B\u6A81;\u6A83\u0100;e\u2622\u2625\uC000\u22DA\uFE00s;\u6A93\u0280adegs\u2633\u2639\u263D\u2649\u264Bppro\xF8\u24C6ot;\u62D6q\u0100gq\u2643\u2645\xF4\u0989gt\xF2\u248C\xF4\u099Bi\xED\u09B2\u0180ilr\u2655\u08E1\u265Asht;\u697C;\uC000\u{1D529}\u0100;E\u099C\u2663;\u6A91\u0161\u2669\u2676r\u0100du\u25B2\u266E\u0100;l\u0965\u2673;\u696Alk;\u6584cy;\u4459\u0280;acht\u0A48\u2688\u268B\u2691\u2696r\xF2\u25C1orne\xF2\u1D08ard;\u696Bri;\u65FA\u0100io\u269F\u26A4dot;\u4140ust\u0100;a\u26AC\u26AD\u63B0che\xBB\u26AD\u0200Eaes\u26BB\u26BD\u26C9\u26D4;\u6268p\u0100;p\u26C3\u26C4\u6A89rox\xBB\u26C4\u0100;q\u26CE\u26CF\u6A87\u0100;q\u26CE\u26BBim;\u62E6\u0400abnoptwz\u26E9\u26F4\u26F7\u271A\u272F\u2741\u2747\u2750\u0100nr\u26EE\u26F1g;\u67ECr;\u61FDr\xEB\u08C1g\u0180lmr\u26FF\u270D\u2714eft\u0100ar\u09E6\u2707ight\xE1\u09F2apsto;\u67FCight\xE1\u09FDparrow\u0100lr\u2725\u2729ef\xF4\u24EDight;\u61AC\u0180afl\u2736\u2739\u273Dr;\u6985;\uC000\u{1D55D}us;\u6A2Dimes;\u6A34\u0161\u274B\u274Fst;\u6217\xE1\u134E\u0180;ef\u2757\u2758\u1800\u65CAnge\xBB\u2758ar\u0100;l\u2764\u2765\u4028t;\u6993\u0280achmt\u2773\u2776\u277C\u2785\u2787r\xF2\u08A8orne\xF2\u1D8Car\u0100;d\u0F98\u2783;\u696D;\u600Eri;\u62BF\u0300achiqt\u2798\u279D\u0A40\u27A2\u27AE\u27BBquo;\u6039r;\uC000\u{1D4C1}m\u0180;eg\u09B2\u27AA\u27AC;\u6A8D;\u6A8F\u0100bu\u252A\u27B3o\u0100;r\u0E1F\u27B9;\u601Arok;\u4142\u8400<;cdhilqr\u082B\u27D2\u2639\u27DC\u27E0\u27E5\u27EA\u27F0\u0100ci\u27D7\u27D9;\u6AA6r;\u6A79re\xE5\u25F2mes;\u62C9arr;\u6976uest;\u6A7B\u0100Pi\u27F5\u27F9ar;\u6996\u0180;ef\u2800\u092D\u181B\u65C3r\u0100du\u2807\u280Dshar;\u694Ahar;\u6966\u0100en\u2817\u2821rtneqq;\uC000\u2268\uFE00\xC5\u281E\u0700Dacdefhilnopsu\u2840\u2845\u2882\u288E\u2893\u28A0\u28A5\u28A8\u28DA\u28E2\u28E4\u0A83\u28F3\u2902Dot;\u623A\u0200clpr\u284E\u2852\u2863\u287Dr\u803B\xAF\u40AF\u0100et\u2857\u2859;\u6642\u0100;e\u285E\u285F\u6720se\xBB\u285F\u0100;s\u103B\u2868to\u0200;dlu\u103B\u2873\u2877\u287Bow\xEE\u048Cef\xF4\u090F\xF0\u13D1ker;\u65AE\u0100oy\u2887\u288Cmma;\u6A29;\u443Cash;\u6014asuredangle\xBB\u1626r;\uC000\u{1D52A}o;\u6127\u0180cdn\u28AF\u28B4\u28C9ro\u803B\xB5\u40B5\u0200;acd\u1464\u28BD\u28C0\u28C4s\xF4\u16A7ir;\u6AF0ot\u80BB\xB7\u01B5us\u0180;bd\u28D2\u1903\u28D3\u6212\u0100;u\u1D3C\u28D8;\u6A2A\u0163\u28DE\u28E1p;\u6ADB\xF2\u2212\xF0\u0A81\u0100dp\u28E9\u28EEels;\u62A7f;\uC000\u{1D55E}\u0100ct\u28F8\u28FDr;\uC000\u{1D4C2}pos\xBB\u159D\u0180;lm\u2909\u290A\u290D\u43BCtimap;\u62B8\u0C00GLRVabcdefghijlmoprstuvw\u2942\u2953\u297E\u2989\u2998\u29DA\u29E9\u2A15\u2A1A\u2A58\u2A5D\u2A83\u2A95\u2AA4\u2AA8\u2B04\u2B07\u2B44\u2B7F\u2BAE\u2C34\u2C67\u2C7C\u2CE9\u0100gt\u2947\u294B;\uC000\u22D9\u0338\u0100;v\u2950\u0BCF\uC000\u226B\u20D2\u0180elt\u295A\u2972\u2976ft\u0100ar\u2961\u2967rrow;\u61CDightarrow;\u61CE;\uC000\u22D8\u0338\u0100;v\u297B\u0C47\uC000\u226A\u20D2ightarrow;\u61CF\u0100Dd\u298E\u2993ash;\u62AFash;\u62AE\u0280bcnpt\u29A3\u29A7\u29AC\u29B1\u29CCla\xBB\u02DEute;\u4144g;\uC000\u2220\u20D2\u0280;Eiop\u0D84\u29BC\u29C0\u29C5\u29C8;\uC000\u2A70\u0338d;\uC000\u224B\u0338s;\u4149ro\xF8\u0D84ur\u0100;a\u29D3\u29D4\u666El\u0100;s\u29D3\u0B38\u01F3\u29DF\0\u29E3p\u80BB\xA0\u0B37mp\u0100;e\u0BF9\u0C00\u0280aeouy\u29F4\u29FE\u2A03\u2A10\u2A13\u01F0\u29F9\0\u29FB;\u6A43on;\u4148dil;\u4146ng\u0100;d\u0D7E\u2A0Aot;\uC000\u2A6D\u0338p;\u6A42;\u443Dash;\u6013\u0380;Aadqsx\u0B92\u2A29\u2A2D\u2A3B\u2A41\u2A45\u2A50rr;\u61D7r\u0100hr\u2A33\u2A36k;\u6924\u0100;o\u13F2\u13F0ot;\uC000\u2250\u0338ui\xF6\u0B63\u0100ei\u2A4A\u2A4Ear;\u6928\xED\u0B98ist\u0100;s\u0BA0\u0B9Fr;\uC000\u{1D52B}\u0200Eest\u0BC5\u2A66\u2A79\u2A7C\u0180;qs\u0BBC\u2A6D\u0BE1\u0180;qs\u0BBC\u0BC5\u2A74lan\xF4\u0BE2i\xED\u0BEA\u0100;r\u0BB6\u2A81\xBB\u0BB7\u0180Aap\u2A8A\u2A8D\u2A91r\xF2\u2971rr;\u61AEar;\u6AF2\u0180;sv\u0F8D\u2A9C\u0F8C\u0100;d\u2AA1\u2AA2\u62FC;\u62FAcy;\u445A\u0380AEadest\u2AB7\u2ABA\u2ABE\u2AC2\u2AC5\u2AF6\u2AF9r\xF2\u2966;\uC000\u2266\u0338rr;\u619Ar;\u6025\u0200;fqs\u0C3B\u2ACE\u2AE3\u2AEFt\u0100ar\u2AD4\u2AD9rro\xF7\u2AC1ightarro\xF7\u2A90\u0180;qs\u0C3B\u2ABA\u2AEAlan\xF4\u0C55\u0100;s\u0C55\u2AF4\xBB\u0C36i\xED\u0C5D\u0100;r\u0C35\u2AFEi\u0100;e\u0C1A\u0C25i\xE4\u0D90\u0100pt\u2B0C\u2B11f;\uC000\u{1D55F}\u8180\xAC;in\u2B19\u2B1A\u2B36\u40ACn\u0200;Edv\u0B89\u2B24\u2B28\u2B2E;\uC000\u22F9\u0338ot;\uC000\u22F5\u0338\u01E1\u0B89\u2B33\u2B35;\u62F7;\u62F6i\u0100;v\u0CB8\u2B3C\u01E1\u0CB8\u2B41\u2B43;\u62FE;\u62FD\u0180aor\u2B4B\u2B63\u2B69r\u0200;ast\u0B7B\u2B55\u2B5A\u2B5Flle\xEC\u0B7Bl;\uC000\u2AFD\u20E5;\uC000\u2202\u0338lint;\u6A14\u0180;ce\u0C92\u2B70\u2B73u\xE5\u0CA5\u0100;c\u0C98\u2B78\u0100;e\u0C92\u2B7D\xF1\u0C98\u0200Aait\u2B88\u2B8B\u2B9D\u2BA7r\xF2\u2988rr\u0180;cw\u2B94\u2B95\u2B99\u619B;\uC000\u2933\u0338;\uC000\u219D\u0338ghtarrow\xBB\u2B95ri\u0100;e\u0CCB\u0CD6\u0380chimpqu\u2BBD\u2BCD\u2BD9\u2B04\u0B78\u2BE4\u2BEF\u0200;cer\u0D32\u2BC6\u0D37\u2BC9u\xE5\u0D45;\uC000\u{1D4C3}ort\u026D\u2B05\0\0\u2BD6ar\xE1\u2B56m\u0100;e\u0D6E\u2BDF\u0100;q\u0D74\u0D73su\u0100bp\u2BEB\u2BED\xE5\u0CF8\xE5\u0D0B\u0180bcp\u2BF6\u2C11\u2C19\u0200;Ees\u2BFF\u2C00\u0D22\u2C04\u6284;\uC000\u2AC5\u0338et\u0100;e\u0D1B\u2C0Bq\u0100;q\u0D23\u2C00c\u0100;e\u0D32\u2C17\xF1\u0D38\u0200;Ees\u2C22\u2C23\u0D5F\u2C27\u6285;\uC000\u2AC6\u0338et\u0100;e\u0D58\u2C2Eq\u0100;q\u0D60\u2C23\u0200gilr\u2C3D\u2C3F\u2C45\u2C47\xEC\u0BD7lde\u803B\xF1\u40F1\xE7\u0C43iangle\u0100lr\u2C52\u2C5Ceft\u0100;e\u0C1A\u2C5A\xF1\u0C26ight\u0100;e\u0CCB\u2C65\xF1\u0CD7\u0100;m\u2C6C\u2C6D\u43BD\u0180;es\u2C74\u2C75\u2C79\u4023ro;\u6116p;\u6007\u0480DHadgilrs\u2C8F\u2C94\u2C99\u2C9E\u2CA3\u2CB0\u2CB6\u2CD3\u2CE3ash;\u62ADarr;\u6904p;\uC000\u224D\u20D2ash;\u62AC\u0100et\u2CA8\u2CAC;\uC000\u2265\u20D2;\uC000>\u20D2nfin;\u69DE\u0180Aet\u2CBD\u2CC1\u2CC5rr;\u6902;\uC000\u2264\u20D2\u0100;r\u2CCA\u2CCD\uC000<\u20D2ie;\uC000\u22B4\u20D2\u0100At\u2CD8\u2CDCrr;\u6903rie;\uC000\u22B5\u20D2im;\uC000\u223C\u20D2\u0180Aan\u2CF0\u2CF4\u2D02rr;\u61D6r\u0100hr\u2CFA\u2CFDk;\u6923\u0100;o\u13E7\u13E5ear;\u6927\u1253\u1A95\0\0\0\0\0\0\0\0\0\0\0\0\0\u2D2D\0\u2D38\u2D48\u2D60\u2D65\u2D72\u2D84\u1B07\0\0\u2D8D\u2DAB\0\u2DC8\u2DCE\0\u2DDC\u2E19\u2E2B\u2E3E\u2E43\u0100cs\u2D31\u1A97ute\u803B\xF3\u40F3\u0100iy\u2D3C\u2D45r\u0100;c\u1A9E\u2D42\u803B\xF4\u40F4;\u443E\u0280abios\u1AA0\u2D52\u2D57\u01C8\u2D5Alac;\u4151v;\u6A38old;\u69BClig;\u4153\u0100cr\u2D69\u2D6Dir;\u69BF;\uC000\u{1D52C}\u036F\u2D79\0\0\u2D7C\0\u2D82n;\u42DBave\u803B\xF2\u40F2;\u69C1\u0100bm\u2D88\u0DF4ar;\u69B5\u0200acit\u2D95\u2D98\u2DA5\u2DA8r\xF2\u1A80\u0100ir\u2D9D\u2DA0r;\u69BEoss;\u69BBn\xE5\u0E52;\u69C0\u0180aei\u2DB1\u2DB5\u2DB9cr;\u414Dga;\u43C9\u0180cdn\u2DC0\u2DC5\u01CDron;\u43BF;\u69B6pf;\uC000\u{1D560}\u0180ael\u2DD4\u2DD7\u01D2r;\u69B7rp;\u69B9\u0380;adiosv\u2DEA\u2DEB\u2DEE\u2E08\u2E0D\u2E10\u2E16\u6228r\xF2\u1A86\u0200;efm\u2DF7\u2DF8\u2E02\u2E05\u6A5Dr\u0100;o\u2DFE\u2DFF\u6134f\xBB\u2DFF\u803B\xAA\u40AA\u803B\xBA\u40BAgof;\u62B6r;\u6A56lope;\u6A57;\u6A5B\u0180clo\u2E1F\u2E21\u2E27\xF2\u2E01ash\u803B\xF8\u40F8l;\u6298i\u016C\u2E2F\u2E34de\u803B\xF5\u40F5es\u0100;a\u01DB\u2E3As;\u6A36ml\u803B\xF6\u40F6bar;\u633D\u0AE1\u2E5E\0\u2E7D\0\u2E80\u2E9D\0\u2EA2\u2EB9\0\0\u2ECB\u0E9C\0\u2F13\0\0\u2F2B\u2FBC\0\u2FC8r\u0200;ast\u0403\u2E67\u2E72\u0E85\u8100\xB6;l\u2E6D\u2E6E\u40B6le\xEC\u0403\u0269\u2E78\0\0\u2E7Bm;\u6AF3;\u6AFDy;\u443Fr\u0280cimpt\u2E8B\u2E8F\u2E93\u1865\u2E97nt;\u4025od;\u402Eil;\u6030enk;\u6031r;\uC000\u{1D52D}\u0180imo\u2EA8\u2EB0\u2EB4\u0100;v\u2EAD\u2EAE\u43C6;\u43D5ma\xF4\u0A76ne;\u660E\u0180;tv\u2EBF\u2EC0\u2EC8\u43C0chfork\xBB\u1FFD;\u43D6\u0100au\u2ECF\u2EDFn\u0100ck\u2ED5\u2EDDk\u0100;h\u21F4\u2EDB;\u610E\xF6\u21F4s\u0480;abcdemst\u2EF3\u2EF4\u1908\u2EF9\u2EFD\u2F04\u2F06\u2F0A\u2F0E\u402Bcir;\u6A23ir;\u6A22\u0100ou\u1D40\u2F02;\u6A25;\u6A72n\u80BB\xB1\u0E9Dim;\u6A26wo;\u6A27\u0180ipu\u2F19\u2F20\u2F25ntint;\u6A15f;\uC000\u{1D561}nd\u803B\xA3\u40A3\u0500;Eaceinosu\u0EC8\u2F3F\u2F41\u2F44\u2F47\u2F81\u2F89\u2F92\u2F7E\u2FB6;\u6AB3p;\u6AB7u\xE5\u0ED9\u0100;c\u0ECE\u2F4C\u0300;acens\u0EC8\u2F59\u2F5F\u2F66\u2F68\u2F7Eppro\xF8\u2F43urlye\xF1\u0ED9\xF1\u0ECE\u0180aes\u2F6F\u2F76\u2F7Approx;\u6AB9qq;\u6AB5im;\u62E8i\xED\u0EDFme\u0100;s\u2F88\u0EAE\u6032\u0180Eas\u2F78\u2F90\u2F7A\xF0\u2F75\u0180dfp\u0EEC\u2F99\u2FAF\u0180als\u2FA0\u2FA5\u2FAAlar;\u632Eine;\u6312urf;\u6313\u0100;t\u0EFB\u2FB4\xEF\u0EFBrel;\u62B0\u0100ci\u2FC0\u2FC5r;\uC000\u{1D4C5};\u43C8ncsp;\u6008\u0300fiopsu\u2FDA\u22E2\u2FDF\u2FE5\u2FEB\u2FF1r;\uC000\u{1D52E}pf;\uC000\u{1D562}rime;\u6057cr;\uC000\u{1D4C6}\u0180aeo\u2FF8\u3009\u3013t\u0100ei\u2FFE\u3005rnion\xF3\u06B0nt;\u6A16st\u0100;e\u3010\u3011\u403F\xF1\u1F19\xF4\u0F14\u0A80ABHabcdefhilmnoprstux\u3040\u3051\u3055\u3059\u30E0\u310E\u312B\u3147\u3162\u3172\u318E\u3206\u3215\u3224\u3229\u3258\u326E\u3272\u3290\u32B0\u32B7\u0180art\u3047\u304A\u304Cr\xF2\u10B3\xF2\u03DDail;\u691Car\xF2\u1C65ar;\u6964\u0380cdenqrt\u3068\u3075\u3078\u307F\u308F\u3094\u30CC\u0100eu\u306D\u3071;\uC000\u223D\u0331te;\u4155i\xE3\u116Emptyv;\u69B3g\u0200;del\u0FD1\u3089\u308B\u308D;\u6992;\u69A5\xE5\u0FD1uo\u803B\xBB\u40BBr\u0580;abcfhlpstw\u0FDC\u30AC\u30AF\u30B7\u30B9\u30BC\u30BE\u30C0\u30C3\u30C7\u30CAp;\u6975\u0100;f\u0FE0\u30B4s;\u6920;\u6933s;\u691E\xEB\u225D\xF0\u272El;\u6945im;\u6974l;\u61A3;\u619D\u0100ai\u30D1\u30D5il;\u691Ao\u0100;n\u30DB\u30DC\u6236al\xF3\u0F1E\u0180abr\u30E7\u30EA\u30EEr\xF2\u17E5rk;\u6773\u0100ak\u30F3\u30FDc\u0100ek\u30F9\u30FB;\u407D;\u405D\u0100es\u3102\u3104;\u698Cl\u0100du\u310A\u310C;\u698E;\u6990\u0200aeuy\u3117\u311C\u3127\u3129ron;\u4159\u0100di\u3121\u3125il;\u4157\xEC\u0FF2\xE2\u30FA;\u4440\u0200clqs\u3134\u3137\u313D\u3144a;\u6937dhar;\u6969uo\u0100;r\u020E\u020Dh;\u61B3\u0180acg\u314E\u315F\u0F44l\u0200;ips\u0F78\u3158\u315B\u109Cn\xE5\u10BBar\xF4\u0FA9t;\u65AD\u0180ilr\u3169\u1023\u316Esht;\u697D;\uC000\u{1D52F}\u0100ao\u3177\u3186r\u0100du\u317D\u317F\xBB\u047B\u0100;l\u1091\u3184;\u696C\u0100;v\u318B\u318C\u43C1;\u43F1\u0180gns\u3195\u31F9\u31FCht\u0300ahlrst\u31A4\u31B0\u31C2\u31D8\u31E4\u31EErrow\u0100;t\u0FDC\u31ADa\xE9\u30C8arpoon\u0100du\u31BB\u31BFow\xEE\u317Ep\xBB\u1092eft\u0100ah\u31CA\u31D0rrow\xF3\u0FEAarpoon\xF3\u0551ightarrows;\u61C9quigarro\xF7\u30CBhreetimes;\u62CCg;\u42DAingdotse\xF1\u1F32\u0180ahm\u320D\u3210\u3213r\xF2\u0FEAa\xF2\u0551;\u600Foust\u0100;a\u321E\u321F\u63B1che\xBB\u321Fmid;\u6AEE\u0200abpt\u3232\u323D\u3240\u3252\u0100nr\u3237\u323Ag;\u67EDr;\u61FEr\xEB\u1003\u0180afl\u3247\u324A\u324Er;\u6986;\uC000\u{1D563}us;\u6A2Eimes;\u6A35\u0100ap\u325D\u3267r\u0100;g\u3263\u3264\u4029t;\u6994olint;\u6A12ar\xF2\u31E3\u0200achq\u327B\u3280\u10BC\u3285quo;\u603Ar;\uC000\u{1D4C7}\u0100bu\u30FB\u328Ao\u0100;r\u0214\u0213\u0180hir\u3297\u329B\u32A0re\xE5\u31F8mes;\u62CAi\u0200;efl\u32AA\u1059\u1821\u32AB\u65B9tri;\u69CEluhar;\u6968;\u611E\u0D61\u32D5\u32DB\u32DF\u332C\u3338\u3371\0\u337A\u33A4\0\0\u33EC\u33F0\0\u3428\u3448\u345A\u34AD\u34B1\u34CA\u34F1\0\u3616\0\0\u3633cute;\u415Bqu\xEF\u27BA\u0500;Eaceinpsy\u11ED\u32F3\u32F5\u32FF\u3302\u330B\u330F\u331F\u3326\u3329;\u6AB4\u01F0\u32FA\0\u32FC;\u6AB8on;\u4161u\xE5\u11FE\u0100;d\u11F3\u3307il;\u415Frc;\u415D\u0180Eas\u3316\u3318\u331B;\u6AB6p;\u6ABAim;\u62E9olint;\u6A13i\xED\u1204;\u4441ot\u0180;be\u3334\u1D47\u3335\u62C5;\u6A66\u0380Aacmstx\u3346\u334A\u3357\u335B\u335E\u3363\u336Drr;\u61D8r\u0100hr\u3350\u3352\xEB\u2228\u0100;o\u0A36\u0A34t\u803B\xA7\u40A7i;\u403Bwar;\u6929m\u0100in\u3369\xF0nu\xF3\xF1t;\u6736r\u0100;o\u3376\u2055\uC000\u{1D530}\u0200acoy\u3382\u3386\u3391\u33A0rp;\u666F\u0100hy\u338B\u338Fcy;\u4449;\u4448rt\u026D\u3399\0\0\u339Ci\xE4\u1464ara\xEC\u2E6F\u803B\xAD\u40AD\u0100gm\u33A8\u33B4ma\u0180;fv\u33B1\u33B2\u33B2\u43C3;\u43C2\u0400;deglnpr\u12AB\u33C5\u33C9\u33CE\u33D6\u33DE\u33E1\u33E6ot;\u6A6A\u0100;q\u12B1\u12B0\u0100;E\u33D3\u33D4\u6A9E;\u6AA0\u0100;E\u33DB\u33DC\u6A9D;\u6A9Fe;\u6246lus;\u6A24arr;\u6972ar\xF2\u113D\u0200aeit\u33F8\u3408\u340F\u3417\u0100ls\u33FD\u3404lsetm\xE9\u336Ahp;\u6A33parsl;\u69E4\u0100dl\u1463\u3414e;\u6323\u0100;e\u341C\u341D\u6AAA\u0100;s\u3422\u3423\u6AAC;\uC000\u2AAC\uFE00\u0180flp\u342E\u3433\u3442tcy;\u444C\u0100;b\u3438\u3439\u402F\u0100;a\u343E\u343F\u69C4r;\u633Ff;\uC000\u{1D564}a\u0100dr\u344D\u0402es\u0100;u\u3454\u3455\u6660it\xBB\u3455\u0180csu\u3460\u3479\u349F\u0100au\u3465\u346Fp\u0100;s\u1188\u346B;\uC000\u2293\uFE00p\u0100;s\u11B4\u3475;\uC000\u2294\uFE00u\u0100bp\u347F\u348F\u0180;es\u1197\u119C\u3486et\u0100;e\u1197\u348D\xF1\u119D\u0180;es\u11A8\u11AD\u3496et\u0100;e\u11A8\u349D\xF1\u11AE\u0180;af\u117B\u34A6\u05B0r\u0165\u34AB\u05B1\xBB\u117Car\xF2\u1148\u0200cemt\u34B9\u34BE\u34C2\u34C5r;\uC000\u{1D4C8}tm\xEE\xF1i\xEC\u3415ar\xE6\u11BE\u0100ar\u34CE\u34D5r\u0100;f\u34D4\u17BF\u6606\u0100an\u34DA\u34EDight\u0100ep\u34E3\u34EApsilo\xEE\u1EE0h\xE9\u2EAFs\xBB\u2852\u0280bcmnp\u34FB\u355E\u1209\u358B\u358E\u0480;Edemnprs\u350E\u350F\u3511\u3515\u351E\u3523\u352C\u3531\u3536\u6282;\u6AC5ot;\u6ABD\u0100;d\u11DA\u351Aot;\u6AC3ult;\u6AC1\u0100Ee\u3528\u352A;\u6ACB;\u628Alus;\u6ABFarr;\u6979\u0180eiu\u353D\u3552\u3555t\u0180;en\u350E\u3545\u354Bq\u0100;q\u11DA\u350Feq\u0100;q\u352B\u3528m;\u6AC7\u0100bp\u355A\u355C;\u6AD5;\u6AD3c\u0300;acens\u11ED\u356C\u3572\u3579\u357B\u3326ppro\xF8\u32FAurlye\xF1\u11FE\xF1\u11F3\u0180aes\u3582\u3588\u331Bppro\xF8\u331Aq\xF1\u3317g;\u666A\u0680123;Edehlmnps\u35A9\u35AC\u35AF\u121C\u35B2\u35B4\u35C0\u35C9\u35D5\u35DA\u35DF\u35E8\u35ED\u803B\xB9\u40B9\u803B\xB2\u40B2\u803B\xB3\u40B3;\u6AC6\u0100os\u35B9\u35BCt;\u6ABEub;\u6AD8\u0100;d\u1222\u35C5ot;\u6AC4s\u0100ou\u35CF\u35D2l;\u67C9b;\u6AD7arr;\u697Bult;\u6AC2\u0100Ee\u35E4\u35E6;\u6ACC;\u628Blus;\u6AC0\u0180eiu\u35F4\u3609\u360Ct\u0180;en\u121C\u35FC\u3602q\u0100;q\u1222\u35B2eq\u0100;q\u35E7\u35E4m;\u6AC8\u0100bp\u3611\u3613;\u6AD4;\u6AD6\u0180Aan\u361C\u3620\u362Drr;\u61D9r\u0100hr\u3626\u3628\xEB\u222E\u0100;o\u0A2B\u0A29war;\u692Alig\u803B\xDF\u40DF\u0BE1\u3651\u365D\u3660\u12CE\u3673\u3679\0\u367E\u36C2\0\0\0\0\0\u36DB\u3703\0\u3709\u376C\0\0\0\u3787\u0272\u3656\0\0\u365Bget;\u6316;\u43C4r\xEB\u0E5F\u0180aey\u3666\u366B\u3670ron;\u4165dil;\u4163;\u4442lrec;\u6315r;\uC000\u{1D531}\u0200eiko\u3686\u369D\u36B5\u36BC\u01F2\u368B\0\u3691e\u01004f\u1284\u1281a\u0180;sv\u3698\u3699\u369B\u43B8ym;\u43D1\u0100cn\u36A2\u36B2k\u0100as\u36A8\u36AEppro\xF8\u12C1im\xBB\u12ACs\xF0\u129E\u0100as\u36BA\u36AE\xF0\u12C1rn\u803B\xFE\u40FE\u01EC\u031F\u36C6\u22E7es\u8180\xD7;bd\u36CF\u36D0\u36D8\u40D7\u0100;a\u190F\u36D5r;\u6A31;\u6A30\u0180eps\u36E1\u36E3\u3700\xE1\u2A4D\u0200;bcf\u0486\u36EC\u36F0\u36F4ot;\u6336ir;\u6AF1\u0100;o\u36F9\u36FC\uC000\u{1D565}rk;\u6ADA\xE1\u3362rime;\u6034\u0180aip\u370F\u3712\u3764d\xE5\u1248\u0380adempst\u3721\u374D\u3740\u3751\u3757\u375C\u375Fngle\u0280;dlqr\u3730\u3731\u3736\u3740\u3742\u65B5own\xBB\u1DBBeft\u0100;e\u2800\u373E\xF1\u092E;\u625Cight\u0100;e\u32AA\u374B\xF1\u105Aot;\u65ECinus;\u6A3Alus;\u6A39b;\u69CDime;\u6A3Bezium;\u63E2\u0180cht\u3772\u377D\u3781\u0100ry\u3777\u377B;\uC000\u{1D4C9};\u4446cy;\u445Brok;\u4167\u0100io\u378B\u378Ex\xF4\u1777head\u0100lr\u3797\u37A0eftarro\xF7\u084Fightarrow\xBB\u0F5D\u0900AHabcdfghlmoprstuw\u37D0\u37D3\u37D7\u37E4\u37F0\u37FC\u380E\u381C\u3823\u3834\u3851\u385D\u386B\u38A9\u38CC\u38D2\u38EA\u38F6r\xF2\u03EDar;\u6963\u0100cr\u37DC\u37E2ute\u803B\xFA\u40FA\xF2\u1150r\u01E3\u37EA\0\u37EDy;\u445Eve;\u416D\u0100iy\u37F5\u37FArc\u803B\xFB\u40FB;\u4443\u0180abh\u3803\u3806\u380Br\xF2\u13ADlac;\u4171a\xF2\u13C3\u0100ir\u3813\u3818sht;\u697E;\uC000\u{1D532}rave\u803B\xF9\u40F9\u0161\u3827\u3831r\u0100lr\u382C\u382E\xBB\u0957\xBB\u1083lk;\u6580\u0100ct\u3839\u384D\u026F\u383F\0\0\u384Arn\u0100;e\u3845\u3846\u631Cr\xBB\u3846op;\u630Fri;\u65F8\u0100al\u3856\u385Acr;\u416B\u80BB\xA8\u0349\u0100gp\u3862\u3866on;\u4173f;\uC000\u{1D566}\u0300adhlsu\u114B\u3878\u387D\u1372\u3891\u38A0own\xE1\u13B3arpoon\u0100lr\u3888\u388Cef\xF4\u382Digh\xF4\u382Fi\u0180;hl\u3899\u389A\u389C\u43C5\xBB\u13FAon\xBB\u389Aparrows;\u61C8\u0180cit\u38B0\u38C4\u38C8\u026F\u38B6\0\0\u38C1rn\u0100;e\u38BC\u38BD\u631Dr\xBB\u38BDop;\u630Eng;\u416Fri;\u65F9cr;\uC000\u{1D4CA}\u0180dir\u38D9\u38DD\u38E2ot;\u62F0lde;\u4169i\u0100;f\u3730\u38E8\xBB\u1813\u0100am\u38EF\u38F2r\xF2\u38A8l\u803B\xFC\u40FCangle;\u69A7\u0780ABDacdeflnoprsz\u391C\u391F\u3929\u392D\u39B5\u39B8\u39BD\u39DF\u39E4\u39E8\u39F3\u39F9\u39FD\u3A01\u3A20r\xF2\u03F7ar\u0100;v\u3926\u3927\u6AE8;\u6AE9as\xE8\u03E1\u0100nr\u3932\u3937grt;\u699C\u0380eknprst\u34E3\u3946\u394B\u3952\u395D\u3964\u3996app\xE1\u2415othin\xE7\u1E96\u0180hir\u34EB\u2EC8\u3959op\xF4\u2FB5\u0100;h\u13B7\u3962\xEF\u318D\u0100iu\u3969\u396Dgm\xE1\u33B3\u0100bp\u3972\u3984setneq\u0100;q\u397D\u3980\uC000\u228A\uFE00;\uC000\u2ACB\uFE00setneq\u0100;q\u398F\u3992\uC000\u228B\uFE00;\uC000\u2ACC\uFE00\u0100hr\u399B\u399Fet\xE1\u369Ciangle\u0100lr\u39AA\u39AFeft\xBB\u0925ight\xBB\u1051y;\u4432ash\xBB\u1036\u0180elr\u39C4\u39D2\u39D7\u0180;be\u2DEA\u39CB\u39CFar;\u62BBq;\u625Alip;\u62EE\u0100bt\u39DC\u1468a\xF2\u1469r;\uC000\u{1D533}tr\xE9\u39AEsu\u0100bp\u39EF\u39F1\xBB\u0D1C\xBB\u0D59pf;\uC000\u{1D567}ro\xF0\u0EFBtr\xE9\u39B4\u0100cu\u3A06\u3A0Br;\uC000\u{1D4CB}\u0100bp\u3A10\u3A18n\u0100Ee\u3980\u3A16\xBB\u397En\u0100Ee\u3992\u3A1E\xBB\u3990igzag;\u699A\u0380cefoprs\u3A36\u3A3B\u3A56\u3A5B\u3A54\u3A61\u3A6Airc;\u4175\u0100di\u3A40\u3A51\u0100bg\u3A45\u3A49ar;\u6A5Fe\u0100;q\u15FA\u3A4F;\u6259erp;\u6118r;\uC000\u{1D534}pf;\uC000\u{1D568}\u0100;e\u1479\u3A66at\xE8\u1479cr;\uC000\u{1D4CC}\u0AE3\u178E\u3A87\0\u3A8B\0\u3A90\u3A9B\0\0\u3A9D\u3AA8\u3AAB\u3AAF\0\0\u3AC3\u3ACE\0\u3AD8\u17DC\u17DFtr\xE9\u17D1r;\uC000\u{1D535}\u0100Aa\u3A94\u3A97r\xF2\u03C3r\xF2\u09F6;\u43BE\u0100Aa\u3AA1\u3AA4r\xF2\u03B8r\xF2\u09EBa\xF0\u2713is;\u62FB\u0180dpt\u17A4\u3AB5\u3ABE\u0100fl\u3ABA\u17A9;\uC000\u{1D569}im\xE5\u17B2\u0100Aa\u3AC7\u3ACAr\xF2\u03CEr\xF2\u0A01\u0100cq\u3AD2\u17B8r;\uC000\u{1D4CD}\u0100pt\u17D6\u3ADCr\xE9\u17D4\u0400acefiosu\u3AF0\u3AFD\u3B08\u3B0C\u3B11\u3B15\u3B1B\u3B21c\u0100uy\u3AF6\u3AFBte\u803B\xFD\u40FD;\u444F\u0100iy\u3B02\u3B06rc;\u4177;\u444Bn\u803B\xA5\u40A5r;\uC000\u{1D536}cy;\u4457pf;\uC000\u{1D56A}cr;\uC000\u{1D4CE}\u0100cm\u3B26\u3B29y;\u444El\u803B\xFF\u40FF\u0500acdefhiosw\u3B42\u3B48\u3B54\u3B58\u3B64\u3B69\u3B6D\u3B74\u3B7A\u3B80cute;\u417A\u0100ay\u3B4D\u3B52ron;\u417E;\u4437ot;\u417C\u0100et\u3B5D\u3B61tr\xE6\u155Fa;\u43B6r;\uC000\u{1D537}cy;\u4436grarr;\u61DDpf;\uC000\u{1D56B}cr;\uC000\u{1D4CF}\u0100jn\u3B85\u3B87;\u600Dj;\u600C'.split("").map(function(c) {
        return c.charCodeAt(0);
      })
    );
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/generated/decode-data-xml.js
var require_decode_data_xml = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/generated/decode-data-xml.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.default = new Uint16Array(
      // prettier-ignore
      "\u0200aglq	\x1B\u026D\0\0p;\u4026os;\u4027t;\u403Et;\u403Cuot;\u4022".split("").map(function(c) {
        return c.charCodeAt(0);
      })
    );
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/decode_codepoint.js
var require_decode_codepoint = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/decode_codepoint.js"(exports2) {
    "use strict";
    var _a;
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.replaceCodePoint = exports2.fromCodePoint = void 0;
    var decodeMap = /* @__PURE__ */ new Map([
      [0, 65533],
      // C1 Unicode control character reference replacements
      [128, 8364],
      [130, 8218],
      [131, 402],
      [132, 8222],
      [133, 8230],
      [134, 8224],
      [135, 8225],
      [136, 710],
      [137, 8240],
      [138, 352],
      [139, 8249],
      [140, 338],
      [142, 381],
      [145, 8216],
      [146, 8217],
      [147, 8220],
      [148, 8221],
      [149, 8226],
      [150, 8211],
      [151, 8212],
      [152, 732],
      [153, 8482],
      [154, 353],
      [155, 8250],
      [156, 339],
      [158, 382],
      [159, 376]
    ]);
    exports2.fromCodePoint = // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, node/no-unsupported-features/es-builtins
    (_a = String.fromCodePoint) !== null && _a !== void 0 ? _a : function(codePoint) {
      var output = "";
      if (codePoint > 65535) {
        codePoint -= 65536;
        output += String.fromCharCode(codePoint >>> 10 & 1023 | 55296);
        codePoint = 56320 | codePoint & 1023;
      }
      output += String.fromCharCode(codePoint);
      return output;
    };
    function replaceCodePoint(codePoint) {
      var _a2;
      if (codePoint >= 55296 && codePoint <= 57343 || codePoint > 1114111) {
        return 65533;
      }
      return (_a2 = decodeMap.get(codePoint)) !== null && _a2 !== void 0 ? _a2 : codePoint;
    }
    exports2.replaceCodePoint = replaceCodePoint;
    function decodeCodePoint(codePoint) {
      return (0, exports2.fromCodePoint)(replaceCodePoint(codePoint));
    }
    exports2.default = decodeCodePoint;
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/decode.js
var require_decode = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/decode.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.decodeXML = exports2.decodeHTMLStrict = exports2.decodeHTMLAttribute = exports2.decodeHTML = exports2.determineBranch = exports2.EntityDecoder = exports2.DecodingMode = exports2.BinTrieFlags = exports2.fromCodePoint = exports2.replaceCodePoint = exports2.decodeCodePoint = exports2.xmlDecodeTree = exports2.htmlDecodeTree = void 0;
    var decode_data_html_js_1 = __importDefault(require_decode_data_html());
    exports2.htmlDecodeTree = decode_data_html_js_1.default;
    var decode_data_xml_js_1 = __importDefault(require_decode_data_xml());
    exports2.xmlDecodeTree = decode_data_xml_js_1.default;
    var decode_codepoint_js_1 = __importStar(require_decode_codepoint());
    exports2.decodeCodePoint = decode_codepoint_js_1.default;
    var decode_codepoint_js_2 = require_decode_codepoint();
    Object.defineProperty(exports2, "replaceCodePoint", { enumerable: true, get: function() {
      return decode_codepoint_js_2.replaceCodePoint;
    } });
    Object.defineProperty(exports2, "fromCodePoint", { enumerable: true, get: function() {
      return decode_codepoint_js_2.fromCodePoint;
    } });
    var CharCodes;
    (function(CharCodes2) {
      CharCodes2[CharCodes2["NUM"] = 35] = "NUM";
      CharCodes2[CharCodes2["SEMI"] = 59] = "SEMI";
      CharCodes2[CharCodes2["EQUALS"] = 61] = "EQUALS";
      CharCodes2[CharCodes2["ZERO"] = 48] = "ZERO";
      CharCodes2[CharCodes2["NINE"] = 57] = "NINE";
      CharCodes2[CharCodes2["LOWER_A"] = 97] = "LOWER_A";
      CharCodes2[CharCodes2["LOWER_F"] = 102] = "LOWER_F";
      CharCodes2[CharCodes2["LOWER_X"] = 120] = "LOWER_X";
      CharCodes2[CharCodes2["LOWER_Z"] = 122] = "LOWER_Z";
      CharCodes2[CharCodes2["UPPER_A"] = 65] = "UPPER_A";
      CharCodes2[CharCodes2["UPPER_F"] = 70] = "UPPER_F";
      CharCodes2[CharCodes2["UPPER_Z"] = 90] = "UPPER_Z";
    })(CharCodes || (CharCodes = {}));
    var TO_LOWER_BIT = 32;
    var BinTrieFlags;
    (function(BinTrieFlags2) {
      BinTrieFlags2[BinTrieFlags2["VALUE_LENGTH"] = 49152] = "VALUE_LENGTH";
      BinTrieFlags2[BinTrieFlags2["BRANCH_LENGTH"] = 16256] = "BRANCH_LENGTH";
      BinTrieFlags2[BinTrieFlags2["JUMP_TABLE"] = 127] = "JUMP_TABLE";
    })(BinTrieFlags = exports2.BinTrieFlags || (exports2.BinTrieFlags = {}));
    function isNumber(code) {
      return code >= CharCodes.ZERO && code <= CharCodes.NINE;
    }
    function isHexadecimalCharacter(code) {
      return code >= CharCodes.UPPER_A && code <= CharCodes.UPPER_F || code >= CharCodes.LOWER_A && code <= CharCodes.LOWER_F;
    }
    function isAsciiAlphaNumeric(code) {
      return code >= CharCodes.UPPER_A && code <= CharCodes.UPPER_Z || code >= CharCodes.LOWER_A && code <= CharCodes.LOWER_Z || isNumber(code);
    }
    function isEntityInAttributeInvalidEnd(code) {
      return code === CharCodes.EQUALS || isAsciiAlphaNumeric(code);
    }
    var EntityDecoderState;
    (function(EntityDecoderState2) {
      EntityDecoderState2[EntityDecoderState2["EntityStart"] = 0] = "EntityStart";
      EntityDecoderState2[EntityDecoderState2["NumericStart"] = 1] = "NumericStart";
      EntityDecoderState2[EntityDecoderState2["NumericDecimal"] = 2] = "NumericDecimal";
      EntityDecoderState2[EntityDecoderState2["NumericHex"] = 3] = "NumericHex";
      EntityDecoderState2[EntityDecoderState2["NamedEntity"] = 4] = "NamedEntity";
    })(EntityDecoderState || (EntityDecoderState = {}));
    var DecodingMode;
    (function(DecodingMode2) {
      DecodingMode2[DecodingMode2["Legacy"] = 0] = "Legacy";
      DecodingMode2[DecodingMode2["Strict"] = 1] = "Strict";
      DecodingMode2[DecodingMode2["Attribute"] = 2] = "Attribute";
    })(DecodingMode = exports2.DecodingMode || (exports2.DecodingMode = {}));
    var EntityDecoder = (
      /** @class */
      (function() {
        function EntityDecoder2(decodeTree, emitCodePoint, errors) {
          this.decodeTree = decodeTree;
          this.emitCodePoint = emitCodePoint;
          this.errors = errors;
          this.state = EntityDecoderState.EntityStart;
          this.consumed = 1;
          this.result = 0;
          this.treeIndex = 0;
          this.excess = 1;
          this.decodeMode = DecodingMode.Strict;
        }
        EntityDecoder2.prototype.startEntity = function(decodeMode) {
          this.decodeMode = decodeMode;
          this.state = EntityDecoderState.EntityStart;
          this.result = 0;
          this.treeIndex = 0;
          this.excess = 1;
          this.consumed = 1;
        };
        EntityDecoder2.prototype.write = function(str, offset) {
          switch (this.state) {
            case EntityDecoderState.EntityStart: {
              if (str.charCodeAt(offset) === CharCodes.NUM) {
                this.state = EntityDecoderState.NumericStart;
                this.consumed += 1;
                return this.stateNumericStart(str, offset + 1);
              }
              this.state = EntityDecoderState.NamedEntity;
              return this.stateNamedEntity(str, offset);
            }
            case EntityDecoderState.NumericStart: {
              return this.stateNumericStart(str, offset);
            }
            case EntityDecoderState.NumericDecimal: {
              return this.stateNumericDecimal(str, offset);
            }
            case EntityDecoderState.NumericHex: {
              return this.stateNumericHex(str, offset);
            }
            case EntityDecoderState.NamedEntity: {
              return this.stateNamedEntity(str, offset);
            }
          }
        };
        EntityDecoder2.prototype.stateNumericStart = function(str, offset) {
          if (offset >= str.length) {
            return -1;
          }
          if ((str.charCodeAt(offset) | TO_LOWER_BIT) === CharCodes.LOWER_X) {
            this.state = EntityDecoderState.NumericHex;
            this.consumed += 1;
            return this.stateNumericHex(str, offset + 1);
          }
          this.state = EntityDecoderState.NumericDecimal;
          return this.stateNumericDecimal(str, offset);
        };
        EntityDecoder2.prototype.addToNumericResult = function(str, start, end, base) {
          if (start !== end) {
            var digitCount = end - start;
            this.result = this.result * Math.pow(base, digitCount) + parseInt(str.substr(start, digitCount), base);
            this.consumed += digitCount;
          }
        };
        EntityDecoder2.prototype.stateNumericHex = function(str, offset) {
          var startIdx = offset;
          while (offset < str.length) {
            var char = str.charCodeAt(offset);
            if (isNumber(char) || isHexadecimalCharacter(char)) {
              offset += 1;
            } else {
              this.addToNumericResult(str, startIdx, offset, 16);
              return this.emitNumericEntity(char, 3);
            }
          }
          this.addToNumericResult(str, startIdx, offset, 16);
          return -1;
        };
        EntityDecoder2.prototype.stateNumericDecimal = function(str, offset) {
          var startIdx = offset;
          while (offset < str.length) {
            var char = str.charCodeAt(offset);
            if (isNumber(char)) {
              offset += 1;
            } else {
              this.addToNumericResult(str, startIdx, offset, 10);
              return this.emitNumericEntity(char, 2);
            }
          }
          this.addToNumericResult(str, startIdx, offset, 10);
          return -1;
        };
        EntityDecoder2.prototype.emitNumericEntity = function(lastCp, expectedLength) {
          var _a;
          if (this.consumed <= expectedLength) {
            (_a = this.errors) === null || _a === void 0 ? void 0 : _a.absenceOfDigitsInNumericCharacterReference(this.consumed);
            return 0;
          }
          if (lastCp === CharCodes.SEMI) {
            this.consumed += 1;
          } else if (this.decodeMode === DecodingMode.Strict) {
            return 0;
          }
          this.emitCodePoint((0, decode_codepoint_js_1.replaceCodePoint)(this.result), this.consumed);
          if (this.errors) {
            if (lastCp !== CharCodes.SEMI) {
              this.errors.missingSemicolonAfterCharacterReference();
            }
            this.errors.validateNumericCharacterReference(this.result);
          }
          return this.consumed;
        };
        EntityDecoder2.prototype.stateNamedEntity = function(str, offset) {
          var decodeTree = this.decodeTree;
          var current = decodeTree[this.treeIndex];
          var valueLength = (current & BinTrieFlags.VALUE_LENGTH) >> 14;
          for (; offset < str.length; offset++, this.excess++) {
            var char = str.charCodeAt(offset);
            this.treeIndex = determineBranch(decodeTree, current, this.treeIndex + Math.max(1, valueLength), char);
            if (this.treeIndex < 0) {
              return this.result === 0 || // If we are parsing an attribute
              this.decodeMode === DecodingMode.Attribute && // We shouldn't have consumed any characters after the entity,
              (valueLength === 0 || // And there should be no invalid characters.
              isEntityInAttributeInvalidEnd(char)) ? 0 : this.emitNotTerminatedNamedEntity();
            }
            current = decodeTree[this.treeIndex];
            valueLength = (current & BinTrieFlags.VALUE_LENGTH) >> 14;
            if (valueLength !== 0) {
              if (char === CharCodes.SEMI) {
                return this.emitNamedEntityData(this.treeIndex, valueLength, this.consumed + this.excess);
              }
              if (this.decodeMode !== DecodingMode.Strict) {
                this.result = this.treeIndex;
                this.consumed += this.excess;
                this.excess = 0;
              }
            }
          }
          return -1;
        };
        EntityDecoder2.prototype.emitNotTerminatedNamedEntity = function() {
          var _a;
          var _b = this, result = _b.result, decodeTree = _b.decodeTree;
          var valueLength = (decodeTree[result] & BinTrieFlags.VALUE_LENGTH) >> 14;
          this.emitNamedEntityData(result, valueLength, this.consumed);
          (_a = this.errors) === null || _a === void 0 ? void 0 : _a.missingSemicolonAfterCharacterReference();
          return this.consumed;
        };
        EntityDecoder2.prototype.emitNamedEntityData = function(result, valueLength, consumed) {
          var decodeTree = this.decodeTree;
          this.emitCodePoint(valueLength === 1 ? decodeTree[result] & ~BinTrieFlags.VALUE_LENGTH : decodeTree[result + 1], consumed);
          if (valueLength === 3) {
            this.emitCodePoint(decodeTree[result + 2], consumed);
          }
          return consumed;
        };
        EntityDecoder2.prototype.end = function() {
          var _a;
          switch (this.state) {
            case EntityDecoderState.NamedEntity: {
              return this.result !== 0 && (this.decodeMode !== DecodingMode.Attribute || this.result === this.treeIndex) ? this.emitNotTerminatedNamedEntity() : 0;
            }
            // Otherwise, emit a numeric entity if we have one.
            case EntityDecoderState.NumericDecimal: {
              return this.emitNumericEntity(0, 2);
            }
            case EntityDecoderState.NumericHex: {
              return this.emitNumericEntity(0, 3);
            }
            case EntityDecoderState.NumericStart: {
              (_a = this.errors) === null || _a === void 0 ? void 0 : _a.absenceOfDigitsInNumericCharacterReference(this.consumed);
              return 0;
            }
            case EntityDecoderState.EntityStart: {
              return 0;
            }
          }
        };
        return EntityDecoder2;
      })()
    );
    exports2.EntityDecoder = EntityDecoder;
    function getDecoder(decodeTree) {
      var ret = "";
      var decoder = new EntityDecoder(decodeTree, function(str) {
        return ret += (0, decode_codepoint_js_1.fromCodePoint)(str);
      });
      return function decodeWithTrie(str, decodeMode) {
        var lastIndex = 0;
        var offset = 0;
        while ((offset = str.indexOf("&", offset)) >= 0) {
          ret += str.slice(lastIndex, offset);
          decoder.startEntity(decodeMode);
          var len = decoder.write(
            str,
            // Skip the "&"
            offset + 1
          );
          if (len < 0) {
            lastIndex = offset + decoder.end();
            break;
          }
          lastIndex = offset + len;
          offset = len === 0 ? lastIndex + 1 : lastIndex;
        }
        var result = ret + str.slice(lastIndex);
        ret = "";
        return result;
      };
    }
    function determineBranch(decodeTree, current, nodeIdx, char) {
      var branchCount = (current & BinTrieFlags.BRANCH_LENGTH) >> 7;
      var jumpOffset = current & BinTrieFlags.JUMP_TABLE;
      if (branchCount === 0) {
        return jumpOffset !== 0 && char === jumpOffset ? nodeIdx : -1;
      }
      if (jumpOffset) {
        var value = char - jumpOffset;
        return value < 0 || value >= branchCount ? -1 : decodeTree[nodeIdx + value] - 1;
      }
      var lo = nodeIdx;
      var hi = lo + branchCount - 1;
      while (lo <= hi) {
        var mid = lo + hi >>> 1;
        var midVal = decodeTree[mid];
        if (midVal < char) {
          lo = mid + 1;
        } else if (midVal > char) {
          hi = mid - 1;
        } else {
          return decodeTree[mid + branchCount];
        }
      }
      return -1;
    }
    exports2.determineBranch = determineBranch;
    var htmlDecoder = getDecoder(decode_data_html_js_1.default);
    var xmlDecoder = getDecoder(decode_data_xml_js_1.default);
    function decodeHTML(str, mode) {
      if (mode === void 0) {
        mode = DecodingMode.Legacy;
      }
      return htmlDecoder(str, mode);
    }
    exports2.decodeHTML = decodeHTML;
    function decodeHTMLAttribute(str) {
      return htmlDecoder(str, DecodingMode.Attribute);
    }
    exports2.decodeHTMLAttribute = decodeHTMLAttribute;
    function decodeHTMLStrict(str) {
      return htmlDecoder(str, DecodingMode.Strict);
    }
    exports2.decodeHTMLStrict = decodeHTMLStrict;
    function decodeXML(str) {
      return xmlDecoder(str, DecodingMode.Strict);
    }
    exports2.decodeXML = decodeXML;
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/generated/encode-html.js
var require_encode_html = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/generated/encode-html.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    function restoreDiff(arr) {
      for (var i = 1; i < arr.length; i++) {
        arr[i][0] += arr[i - 1][0] + 1;
      }
      return arr;
    }
    exports2.default = new Map(/* @__PURE__ */ restoreDiff([[9, "&Tab;"], [0, "&NewLine;"], [22, "&excl;"], [0, "&quot;"], [0, "&num;"], [0, "&dollar;"], [0, "&percnt;"], [0, "&amp;"], [0, "&apos;"], [0, "&lpar;"], [0, "&rpar;"], [0, "&ast;"], [0, "&plus;"], [0, "&comma;"], [1, "&period;"], [0, "&sol;"], [10, "&colon;"], [0, "&semi;"], [0, { v: "&lt;", n: 8402, o: "&nvlt;" }], [0, { v: "&equals;", n: 8421, o: "&bne;" }], [0, { v: "&gt;", n: 8402, o: "&nvgt;" }], [0, "&quest;"], [0, "&commat;"], [26, "&lbrack;"], [0, "&bsol;"], [0, "&rbrack;"], [0, "&Hat;"], [0, "&lowbar;"], [0, "&DiacriticalGrave;"], [5, { n: 106, o: "&fjlig;" }], [20, "&lbrace;"], [0, "&verbar;"], [0, "&rbrace;"], [34, "&nbsp;"], [0, "&iexcl;"], [0, "&cent;"], [0, "&pound;"], [0, "&curren;"], [0, "&yen;"], [0, "&brvbar;"], [0, "&sect;"], [0, "&die;"], [0, "&copy;"], [0, "&ordf;"], [0, "&laquo;"], [0, "&not;"], [0, "&shy;"], [0, "&circledR;"], [0, "&macr;"], [0, "&deg;"], [0, "&PlusMinus;"], [0, "&sup2;"], [0, "&sup3;"], [0, "&acute;"], [0, "&micro;"], [0, "&para;"], [0, "&centerdot;"], [0, "&cedil;"], [0, "&sup1;"], [0, "&ordm;"], [0, "&raquo;"], [0, "&frac14;"], [0, "&frac12;"], [0, "&frac34;"], [0, "&iquest;"], [0, "&Agrave;"], [0, "&Aacute;"], [0, "&Acirc;"], [0, "&Atilde;"], [0, "&Auml;"], [0, "&angst;"], [0, "&AElig;"], [0, "&Ccedil;"], [0, "&Egrave;"], [0, "&Eacute;"], [0, "&Ecirc;"], [0, "&Euml;"], [0, "&Igrave;"], [0, "&Iacute;"], [0, "&Icirc;"], [0, "&Iuml;"], [0, "&ETH;"], [0, "&Ntilde;"], [0, "&Ograve;"], [0, "&Oacute;"], [0, "&Ocirc;"], [0, "&Otilde;"], [0, "&Ouml;"], [0, "&times;"], [0, "&Oslash;"], [0, "&Ugrave;"], [0, "&Uacute;"], [0, "&Ucirc;"], [0, "&Uuml;"], [0, "&Yacute;"], [0, "&THORN;"], [0, "&szlig;"], [0, "&agrave;"], [0, "&aacute;"], [0, "&acirc;"], [0, "&atilde;"], [0, "&auml;"], [0, "&aring;"], [0, "&aelig;"], [0, "&ccedil;"], [0, "&egrave;"], [0, "&eacute;"], [0, "&ecirc;"], [0, "&euml;"], [0, "&igrave;"], [0, "&iacute;"], [0, "&icirc;"], [0, "&iuml;"], [0, "&eth;"], [0, "&ntilde;"], [0, "&ograve;"], [0, "&oacute;"], [0, "&ocirc;"], [0, "&otilde;"], [0, "&ouml;"], [0, "&div;"], [0, "&oslash;"], [0, "&ugrave;"], [0, "&uacute;"], [0, "&ucirc;"], [0, "&uuml;"], [0, "&yacute;"], [0, "&thorn;"], [0, "&yuml;"], [0, "&Amacr;"], [0, "&amacr;"], [0, "&Abreve;"], [0, "&abreve;"], [0, "&Aogon;"], [0, "&aogon;"], [0, "&Cacute;"], [0, "&cacute;"], [0, "&Ccirc;"], [0, "&ccirc;"], [0, "&Cdot;"], [0, "&cdot;"], [0, "&Ccaron;"], [0, "&ccaron;"], [0, "&Dcaron;"], [0, "&dcaron;"], [0, "&Dstrok;"], [0, "&dstrok;"], [0, "&Emacr;"], [0, "&emacr;"], [2, "&Edot;"], [0, "&edot;"], [0, "&Eogon;"], [0, "&eogon;"], [0, "&Ecaron;"], [0, "&ecaron;"], [0, "&Gcirc;"], [0, "&gcirc;"], [0, "&Gbreve;"], [0, "&gbreve;"], [0, "&Gdot;"], [0, "&gdot;"], [0, "&Gcedil;"], [1, "&Hcirc;"], [0, "&hcirc;"], [0, "&Hstrok;"], [0, "&hstrok;"], [0, "&Itilde;"], [0, "&itilde;"], [0, "&Imacr;"], [0, "&imacr;"], [2, "&Iogon;"], [0, "&iogon;"], [0, "&Idot;"], [0, "&imath;"], [0, "&IJlig;"], [0, "&ijlig;"], [0, "&Jcirc;"], [0, "&jcirc;"], [0, "&Kcedil;"], [0, "&kcedil;"], [0, "&kgreen;"], [0, "&Lacute;"], [0, "&lacute;"], [0, "&Lcedil;"], [0, "&lcedil;"], [0, "&Lcaron;"], [0, "&lcaron;"], [0, "&Lmidot;"], [0, "&lmidot;"], [0, "&Lstrok;"], [0, "&lstrok;"], [0, "&Nacute;"], [0, "&nacute;"], [0, "&Ncedil;"], [0, "&ncedil;"], [0, "&Ncaron;"], [0, "&ncaron;"], [0, "&napos;"], [0, "&ENG;"], [0, "&eng;"], [0, "&Omacr;"], [0, "&omacr;"], [2, "&Odblac;"], [0, "&odblac;"], [0, "&OElig;"], [0, "&oelig;"], [0, "&Racute;"], [0, "&racute;"], [0, "&Rcedil;"], [0, "&rcedil;"], [0, "&Rcaron;"], [0, "&rcaron;"], [0, "&Sacute;"], [0, "&sacute;"], [0, "&Scirc;"], [0, "&scirc;"], [0, "&Scedil;"], [0, "&scedil;"], [0, "&Scaron;"], [0, "&scaron;"], [0, "&Tcedil;"], [0, "&tcedil;"], [0, "&Tcaron;"], [0, "&tcaron;"], [0, "&Tstrok;"], [0, "&tstrok;"], [0, "&Utilde;"], [0, "&utilde;"], [0, "&Umacr;"], [0, "&umacr;"], [0, "&Ubreve;"], [0, "&ubreve;"], [0, "&Uring;"], [0, "&uring;"], [0, "&Udblac;"], [0, "&udblac;"], [0, "&Uogon;"], [0, "&uogon;"], [0, "&Wcirc;"], [0, "&wcirc;"], [0, "&Ycirc;"], [0, "&ycirc;"], [0, "&Yuml;"], [0, "&Zacute;"], [0, "&zacute;"], [0, "&Zdot;"], [0, "&zdot;"], [0, "&Zcaron;"], [0, "&zcaron;"], [19, "&fnof;"], [34, "&imped;"], [63, "&gacute;"], [65, "&jmath;"], [142, "&circ;"], [0, "&caron;"], [16, "&breve;"], [0, "&DiacriticalDot;"], [0, "&ring;"], [0, "&ogon;"], [0, "&DiacriticalTilde;"], [0, "&dblac;"], [51, "&DownBreve;"], [127, "&Alpha;"], [0, "&Beta;"], [0, "&Gamma;"], [0, "&Delta;"], [0, "&Epsilon;"], [0, "&Zeta;"], [0, "&Eta;"], [0, "&Theta;"], [0, "&Iota;"], [0, "&Kappa;"], [0, "&Lambda;"], [0, "&Mu;"], [0, "&Nu;"], [0, "&Xi;"], [0, "&Omicron;"], [0, "&Pi;"], [0, "&Rho;"], [1, "&Sigma;"], [0, "&Tau;"], [0, "&Upsilon;"], [0, "&Phi;"], [0, "&Chi;"], [0, "&Psi;"], [0, "&ohm;"], [7, "&alpha;"], [0, "&beta;"], [0, "&gamma;"], [0, "&delta;"], [0, "&epsi;"], [0, "&zeta;"], [0, "&eta;"], [0, "&theta;"], [0, "&iota;"], [0, "&kappa;"], [0, "&lambda;"], [0, "&mu;"], [0, "&nu;"], [0, "&xi;"], [0, "&omicron;"], [0, "&pi;"], [0, "&rho;"], [0, "&sigmaf;"], [0, "&sigma;"], [0, "&tau;"], [0, "&upsi;"], [0, "&phi;"], [0, "&chi;"], [0, "&psi;"], [0, "&omega;"], [7, "&thetasym;"], [0, "&Upsi;"], [2, "&phiv;"], [0, "&piv;"], [5, "&Gammad;"], [0, "&digamma;"], [18, "&kappav;"], [0, "&rhov;"], [3, "&epsiv;"], [0, "&backepsilon;"], [10, "&IOcy;"], [0, "&DJcy;"], [0, "&GJcy;"], [0, "&Jukcy;"], [0, "&DScy;"], [0, "&Iukcy;"], [0, "&YIcy;"], [0, "&Jsercy;"], [0, "&LJcy;"], [0, "&NJcy;"], [0, "&TSHcy;"], [0, "&KJcy;"], [1, "&Ubrcy;"], [0, "&DZcy;"], [0, "&Acy;"], [0, "&Bcy;"], [0, "&Vcy;"], [0, "&Gcy;"], [0, "&Dcy;"], [0, "&IEcy;"], [0, "&ZHcy;"], [0, "&Zcy;"], [0, "&Icy;"], [0, "&Jcy;"], [0, "&Kcy;"], [0, "&Lcy;"], [0, "&Mcy;"], [0, "&Ncy;"], [0, "&Ocy;"], [0, "&Pcy;"], [0, "&Rcy;"], [0, "&Scy;"], [0, "&Tcy;"], [0, "&Ucy;"], [0, "&Fcy;"], [0, "&KHcy;"], [0, "&TScy;"], [0, "&CHcy;"], [0, "&SHcy;"], [0, "&SHCHcy;"], [0, "&HARDcy;"], [0, "&Ycy;"], [0, "&SOFTcy;"], [0, "&Ecy;"], [0, "&YUcy;"], [0, "&YAcy;"], [0, "&acy;"], [0, "&bcy;"], [0, "&vcy;"], [0, "&gcy;"], [0, "&dcy;"], [0, "&iecy;"], [0, "&zhcy;"], [0, "&zcy;"], [0, "&icy;"], [0, "&jcy;"], [0, "&kcy;"], [0, "&lcy;"], [0, "&mcy;"], [0, "&ncy;"], [0, "&ocy;"], [0, "&pcy;"], [0, "&rcy;"], [0, "&scy;"], [0, "&tcy;"], [0, "&ucy;"], [0, "&fcy;"], [0, "&khcy;"], [0, "&tscy;"], [0, "&chcy;"], [0, "&shcy;"], [0, "&shchcy;"], [0, "&hardcy;"], [0, "&ycy;"], [0, "&softcy;"], [0, "&ecy;"], [0, "&yucy;"], [0, "&yacy;"], [1, "&iocy;"], [0, "&djcy;"], [0, "&gjcy;"], [0, "&jukcy;"], [0, "&dscy;"], [0, "&iukcy;"], [0, "&yicy;"], [0, "&jsercy;"], [0, "&ljcy;"], [0, "&njcy;"], [0, "&tshcy;"], [0, "&kjcy;"], [1, "&ubrcy;"], [0, "&dzcy;"], [7074, "&ensp;"], [0, "&emsp;"], [0, "&emsp13;"], [0, "&emsp14;"], [1, "&numsp;"], [0, "&puncsp;"], [0, "&ThinSpace;"], [0, "&hairsp;"], [0, "&NegativeMediumSpace;"], [0, "&zwnj;"], [0, "&zwj;"], [0, "&lrm;"], [0, "&rlm;"], [0, "&dash;"], [2, "&ndash;"], [0, "&mdash;"], [0, "&horbar;"], [0, "&Verbar;"], [1, "&lsquo;"], [0, "&CloseCurlyQuote;"], [0, "&lsquor;"], [1, "&ldquo;"], [0, "&CloseCurlyDoubleQuote;"], [0, "&bdquo;"], [1, "&dagger;"], [0, "&Dagger;"], [0, "&bull;"], [2, "&nldr;"], [0, "&hellip;"], [9, "&permil;"], [0, "&pertenk;"], [0, "&prime;"], [0, "&Prime;"], [0, "&tprime;"], [0, "&backprime;"], [3, "&lsaquo;"], [0, "&rsaquo;"], [3, "&oline;"], [2, "&caret;"], [1, "&hybull;"], [0, "&frasl;"], [10, "&bsemi;"], [7, "&qprime;"], [7, { v: "&MediumSpace;", n: 8202, o: "&ThickSpace;" }], [0, "&NoBreak;"], [0, "&af;"], [0, "&InvisibleTimes;"], [0, "&ic;"], [72, "&euro;"], [46, "&tdot;"], [0, "&DotDot;"], [37, "&complexes;"], [2, "&incare;"], [4, "&gscr;"], [0, "&hamilt;"], [0, "&Hfr;"], [0, "&Hopf;"], [0, "&planckh;"], [0, "&hbar;"], [0, "&imagline;"], [0, "&Ifr;"], [0, "&lagran;"], [0, "&ell;"], [1, "&naturals;"], [0, "&numero;"], [0, "&copysr;"], [0, "&weierp;"], [0, "&Popf;"], [0, "&Qopf;"], [0, "&realine;"], [0, "&real;"], [0, "&reals;"], [0, "&rx;"], [3, "&trade;"], [1, "&integers;"], [2, "&mho;"], [0, "&zeetrf;"], [0, "&iiota;"], [2, "&bernou;"], [0, "&Cayleys;"], [1, "&escr;"], [0, "&Escr;"], [0, "&Fouriertrf;"], [1, "&Mellintrf;"], [0, "&order;"], [0, "&alefsym;"], [0, "&beth;"], [0, "&gimel;"], [0, "&daleth;"], [12, "&CapitalDifferentialD;"], [0, "&dd;"], [0, "&ee;"], [0, "&ii;"], [10, "&frac13;"], [0, "&frac23;"], [0, "&frac15;"], [0, "&frac25;"], [0, "&frac35;"], [0, "&frac45;"], [0, "&frac16;"], [0, "&frac56;"], [0, "&frac18;"], [0, "&frac38;"], [0, "&frac58;"], [0, "&frac78;"], [49, "&larr;"], [0, "&ShortUpArrow;"], [0, "&rarr;"], [0, "&darr;"], [0, "&harr;"], [0, "&updownarrow;"], [0, "&nwarr;"], [0, "&nearr;"], [0, "&LowerRightArrow;"], [0, "&LowerLeftArrow;"], [0, "&nlarr;"], [0, "&nrarr;"], [1, { v: "&rarrw;", n: 824, o: "&nrarrw;" }], [0, "&Larr;"], [0, "&Uarr;"], [0, "&Rarr;"], [0, "&Darr;"], [0, "&larrtl;"], [0, "&rarrtl;"], [0, "&LeftTeeArrow;"], [0, "&mapstoup;"], [0, "&map;"], [0, "&DownTeeArrow;"], [1, "&hookleftarrow;"], [0, "&hookrightarrow;"], [0, "&larrlp;"], [0, "&looparrowright;"], [0, "&harrw;"], [0, "&nharr;"], [1, "&lsh;"], [0, "&rsh;"], [0, "&ldsh;"], [0, "&rdsh;"], [1, "&crarr;"], [0, "&cularr;"], [0, "&curarr;"], [2, "&circlearrowleft;"], [0, "&circlearrowright;"], [0, "&leftharpoonup;"], [0, "&DownLeftVector;"], [0, "&RightUpVector;"], [0, "&LeftUpVector;"], [0, "&rharu;"], [0, "&DownRightVector;"], [0, "&dharr;"], [0, "&dharl;"], [0, "&RightArrowLeftArrow;"], [0, "&udarr;"], [0, "&LeftArrowRightArrow;"], [0, "&leftleftarrows;"], [0, "&upuparrows;"], [0, "&rightrightarrows;"], [0, "&ddarr;"], [0, "&leftrightharpoons;"], [0, "&Equilibrium;"], [0, "&nlArr;"], [0, "&nhArr;"], [0, "&nrArr;"], [0, "&DoubleLeftArrow;"], [0, "&DoubleUpArrow;"], [0, "&DoubleRightArrow;"], [0, "&dArr;"], [0, "&DoubleLeftRightArrow;"], [0, "&DoubleUpDownArrow;"], [0, "&nwArr;"], [0, "&neArr;"], [0, "&seArr;"], [0, "&swArr;"], [0, "&lAarr;"], [0, "&rAarr;"], [1, "&zigrarr;"], [6, "&larrb;"], [0, "&rarrb;"], [15, "&DownArrowUpArrow;"], [7, "&loarr;"], [0, "&roarr;"], [0, "&hoarr;"], [0, "&forall;"], [0, "&comp;"], [0, { v: "&part;", n: 824, o: "&npart;" }], [0, "&exist;"], [0, "&nexist;"], [0, "&empty;"], [1, "&Del;"], [0, "&Element;"], [0, "&NotElement;"], [1, "&ni;"], [0, "&notni;"], [2, "&prod;"], [0, "&coprod;"], [0, "&sum;"], [0, "&minus;"], [0, "&MinusPlus;"], [0, "&dotplus;"], [1, "&Backslash;"], [0, "&lowast;"], [0, "&compfn;"], [1, "&radic;"], [2, "&prop;"], [0, "&infin;"], [0, "&angrt;"], [0, { v: "&ang;", n: 8402, o: "&nang;" }], [0, "&angmsd;"], [0, "&angsph;"], [0, "&mid;"], [0, "&nmid;"], [0, "&DoubleVerticalBar;"], [0, "&NotDoubleVerticalBar;"], [0, "&and;"], [0, "&or;"], [0, { v: "&cap;", n: 65024, o: "&caps;" }], [0, { v: "&cup;", n: 65024, o: "&cups;" }], [0, "&int;"], [0, "&Int;"], [0, "&iiint;"], [0, "&conint;"], [0, "&Conint;"], [0, "&Cconint;"], [0, "&cwint;"], [0, "&ClockwiseContourIntegral;"], [0, "&awconint;"], [0, "&there4;"], [0, "&becaus;"], [0, "&ratio;"], [0, "&Colon;"], [0, "&dotminus;"], [1, "&mDDot;"], [0, "&homtht;"], [0, { v: "&sim;", n: 8402, o: "&nvsim;" }], [0, { v: "&backsim;", n: 817, o: "&race;" }], [0, { v: "&ac;", n: 819, o: "&acE;" }], [0, "&acd;"], [0, "&VerticalTilde;"], [0, "&NotTilde;"], [0, { v: "&eqsim;", n: 824, o: "&nesim;" }], [0, "&sime;"], [0, "&NotTildeEqual;"], [0, "&cong;"], [0, "&simne;"], [0, "&ncong;"], [0, "&ap;"], [0, "&nap;"], [0, "&ape;"], [0, { v: "&apid;", n: 824, o: "&napid;" }], [0, "&backcong;"], [0, { v: "&asympeq;", n: 8402, o: "&nvap;" }], [0, { v: "&bump;", n: 824, o: "&nbump;" }], [0, { v: "&bumpe;", n: 824, o: "&nbumpe;" }], [0, { v: "&doteq;", n: 824, o: "&nedot;" }], [0, "&doteqdot;"], [0, "&efDot;"], [0, "&erDot;"], [0, "&Assign;"], [0, "&ecolon;"], [0, "&ecir;"], [0, "&circeq;"], [1, "&wedgeq;"], [0, "&veeeq;"], [1, "&triangleq;"], [2, "&equest;"], [0, "&ne;"], [0, { v: "&Congruent;", n: 8421, o: "&bnequiv;" }], [0, "&nequiv;"], [1, { v: "&le;", n: 8402, o: "&nvle;" }], [0, { v: "&ge;", n: 8402, o: "&nvge;" }], [0, { v: "&lE;", n: 824, o: "&nlE;" }], [0, { v: "&gE;", n: 824, o: "&ngE;" }], [0, { v: "&lnE;", n: 65024, o: "&lvertneqq;" }], [0, { v: "&gnE;", n: 65024, o: "&gvertneqq;" }], [0, { v: "&ll;", n: new Map(/* @__PURE__ */ restoreDiff([[824, "&nLtv;"], [7577, "&nLt;"]])) }], [0, { v: "&gg;", n: new Map(/* @__PURE__ */ restoreDiff([[824, "&nGtv;"], [7577, "&nGt;"]])) }], [0, "&between;"], [0, "&NotCupCap;"], [0, "&nless;"], [0, "&ngt;"], [0, "&nle;"], [0, "&nge;"], [0, "&lesssim;"], [0, "&GreaterTilde;"], [0, "&nlsim;"], [0, "&ngsim;"], [0, "&LessGreater;"], [0, "&gl;"], [0, "&NotLessGreater;"], [0, "&NotGreaterLess;"], [0, "&pr;"], [0, "&sc;"], [0, "&prcue;"], [0, "&sccue;"], [0, "&PrecedesTilde;"], [0, { v: "&scsim;", n: 824, o: "&NotSucceedsTilde;" }], [0, "&NotPrecedes;"], [0, "&NotSucceeds;"], [0, { v: "&sub;", n: 8402, o: "&NotSubset;" }], [0, { v: "&sup;", n: 8402, o: "&NotSuperset;" }], [0, "&nsub;"], [0, "&nsup;"], [0, "&sube;"], [0, "&supe;"], [0, "&NotSubsetEqual;"], [0, "&NotSupersetEqual;"], [0, { v: "&subne;", n: 65024, o: "&varsubsetneq;" }], [0, { v: "&supne;", n: 65024, o: "&varsupsetneq;" }], [1, "&cupdot;"], [0, "&UnionPlus;"], [0, { v: "&sqsub;", n: 824, o: "&NotSquareSubset;" }], [0, { v: "&sqsup;", n: 824, o: "&NotSquareSuperset;" }], [0, "&sqsube;"], [0, "&sqsupe;"], [0, { v: "&sqcap;", n: 65024, o: "&sqcaps;" }], [0, { v: "&sqcup;", n: 65024, o: "&sqcups;" }], [0, "&CirclePlus;"], [0, "&CircleMinus;"], [0, "&CircleTimes;"], [0, "&osol;"], [0, "&CircleDot;"], [0, "&circledcirc;"], [0, "&circledast;"], [1, "&circleddash;"], [0, "&boxplus;"], [0, "&boxminus;"], [0, "&boxtimes;"], [0, "&dotsquare;"], [0, "&RightTee;"], [0, "&dashv;"], [0, "&DownTee;"], [0, "&bot;"], [1, "&models;"], [0, "&DoubleRightTee;"], [0, "&Vdash;"], [0, "&Vvdash;"], [0, "&VDash;"], [0, "&nvdash;"], [0, "&nvDash;"], [0, "&nVdash;"], [0, "&nVDash;"], [0, "&prurel;"], [1, "&LeftTriangle;"], [0, "&RightTriangle;"], [0, { v: "&LeftTriangleEqual;", n: 8402, o: "&nvltrie;" }], [0, { v: "&RightTriangleEqual;", n: 8402, o: "&nvrtrie;" }], [0, "&origof;"], [0, "&imof;"], [0, "&multimap;"], [0, "&hercon;"], [0, "&intcal;"], [0, "&veebar;"], [1, "&barvee;"], [0, "&angrtvb;"], [0, "&lrtri;"], [0, "&bigwedge;"], [0, "&bigvee;"], [0, "&bigcap;"], [0, "&bigcup;"], [0, "&diam;"], [0, "&sdot;"], [0, "&sstarf;"], [0, "&divideontimes;"], [0, "&bowtie;"], [0, "&ltimes;"], [0, "&rtimes;"], [0, "&leftthreetimes;"], [0, "&rightthreetimes;"], [0, "&backsimeq;"], [0, "&curlyvee;"], [0, "&curlywedge;"], [0, "&Sub;"], [0, "&Sup;"], [0, "&Cap;"], [0, "&Cup;"], [0, "&fork;"], [0, "&epar;"], [0, "&lessdot;"], [0, "&gtdot;"], [0, { v: "&Ll;", n: 824, o: "&nLl;" }], [0, { v: "&Gg;", n: 824, o: "&nGg;" }], [0, { v: "&leg;", n: 65024, o: "&lesg;" }], [0, { v: "&gel;", n: 65024, o: "&gesl;" }], [2, "&cuepr;"], [0, "&cuesc;"], [0, "&NotPrecedesSlantEqual;"], [0, "&NotSucceedsSlantEqual;"], [0, "&NotSquareSubsetEqual;"], [0, "&NotSquareSupersetEqual;"], [2, "&lnsim;"], [0, "&gnsim;"], [0, "&precnsim;"], [0, "&scnsim;"], [0, "&nltri;"], [0, "&NotRightTriangle;"], [0, "&nltrie;"], [0, "&NotRightTriangleEqual;"], [0, "&vellip;"], [0, "&ctdot;"], [0, "&utdot;"], [0, "&dtdot;"], [0, "&disin;"], [0, "&isinsv;"], [0, "&isins;"], [0, { v: "&isindot;", n: 824, o: "&notindot;" }], [0, "&notinvc;"], [0, "&notinvb;"], [1, { v: "&isinE;", n: 824, o: "&notinE;" }], [0, "&nisd;"], [0, "&xnis;"], [0, "&nis;"], [0, "&notnivc;"], [0, "&notnivb;"], [6, "&barwed;"], [0, "&Barwed;"], [1, "&lceil;"], [0, "&rceil;"], [0, "&LeftFloor;"], [0, "&rfloor;"], [0, "&drcrop;"], [0, "&dlcrop;"], [0, "&urcrop;"], [0, "&ulcrop;"], [0, "&bnot;"], [1, "&profline;"], [0, "&profsurf;"], [1, "&telrec;"], [0, "&target;"], [5, "&ulcorn;"], [0, "&urcorn;"], [0, "&dlcorn;"], [0, "&drcorn;"], [2, "&frown;"], [0, "&smile;"], [9, "&cylcty;"], [0, "&profalar;"], [7, "&topbot;"], [6, "&ovbar;"], [1, "&solbar;"], [60, "&angzarr;"], [51, "&lmoustache;"], [0, "&rmoustache;"], [2, "&OverBracket;"], [0, "&bbrk;"], [0, "&bbrktbrk;"], [37, "&OverParenthesis;"], [0, "&UnderParenthesis;"], [0, "&OverBrace;"], [0, "&UnderBrace;"], [2, "&trpezium;"], [4, "&elinters;"], [59, "&blank;"], [164, "&circledS;"], [55, "&boxh;"], [1, "&boxv;"], [9, "&boxdr;"], [3, "&boxdl;"], [3, "&boxur;"], [3, "&boxul;"], [3, "&boxvr;"], [7, "&boxvl;"], [7, "&boxhd;"], [7, "&boxhu;"], [7, "&boxvh;"], [19, "&boxH;"], [0, "&boxV;"], [0, "&boxdR;"], [0, "&boxDr;"], [0, "&boxDR;"], [0, "&boxdL;"], [0, "&boxDl;"], [0, "&boxDL;"], [0, "&boxuR;"], [0, "&boxUr;"], [0, "&boxUR;"], [0, "&boxuL;"], [0, "&boxUl;"], [0, "&boxUL;"], [0, "&boxvR;"], [0, "&boxVr;"], [0, "&boxVR;"], [0, "&boxvL;"], [0, "&boxVl;"], [0, "&boxVL;"], [0, "&boxHd;"], [0, "&boxhD;"], [0, "&boxHD;"], [0, "&boxHu;"], [0, "&boxhU;"], [0, "&boxHU;"], [0, "&boxvH;"], [0, "&boxVh;"], [0, "&boxVH;"], [19, "&uhblk;"], [3, "&lhblk;"], [3, "&block;"], [8, "&blk14;"], [0, "&blk12;"], [0, "&blk34;"], [13, "&square;"], [8, "&blacksquare;"], [0, "&EmptyVerySmallSquare;"], [1, "&rect;"], [0, "&marker;"], [2, "&fltns;"], [1, "&bigtriangleup;"], [0, "&blacktriangle;"], [0, "&triangle;"], [2, "&blacktriangleright;"], [0, "&rtri;"], [3, "&bigtriangledown;"], [0, "&blacktriangledown;"], [0, "&dtri;"], [2, "&blacktriangleleft;"], [0, "&ltri;"], [6, "&loz;"], [0, "&cir;"], [32, "&tridot;"], [2, "&bigcirc;"], [8, "&ultri;"], [0, "&urtri;"], [0, "&lltri;"], [0, "&EmptySmallSquare;"], [0, "&FilledSmallSquare;"], [8, "&bigstar;"], [0, "&star;"], [7, "&phone;"], [49, "&female;"], [1, "&male;"], [29, "&spades;"], [2, "&clubs;"], [1, "&hearts;"], [0, "&diamondsuit;"], [3, "&sung;"], [2, "&flat;"], [0, "&natural;"], [0, "&sharp;"], [163, "&check;"], [3, "&cross;"], [8, "&malt;"], [21, "&sext;"], [33, "&VerticalSeparator;"], [25, "&lbbrk;"], [0, "&rbbrk;"], [84, "&bsolhsub;"], [0, "&suphsol;"], [28, "&LeftDoubleBracket;"], [0, "&RightDoubleBracket;"], [0, "&lang;"], [0, "&rang;"], [0, "&Lang;"], [0, "&Rang;"], [0, "&loang;"], [0, "&roang;"], [7, "&longleftarrow;"], [0, "&longrightarrow;"], [0, "&longleftrightarrow;"], [0, "&DoubleLongLeftArrow;"], [0, "&DoubleLongRightArrow;"], [0, "&DoubleLongLeftRightArrow;"], [1, "&longmapsto;"], [2, "&dzigrarr;"], [258, "&nvlArr;"], [0, "&nvrArr;"], [0, "&nvHarr;"], [0, "&Map;"], [6, "&lbarr;"], [0, "&bkarow;"], [0, "&lBarr;"], [0, "&dbkarow;"], [0, "&drbkarow;"], [0, "&DDotrahd;"], [0, "&UpArrowBar;"], [0, "&DownArrowBar;"], [2, "&Rarrtl;"], [2, "&latail;"], [0, "&ratail;"], [0, "&lAtail;"], [0, "&rAtail;"], [0, "&larrfs;"], [0, "&rarrfs;"], [0, "&larrbfs;"], [0, "&rarrbfs;"], [2, "&nwarhk;"], [0, "&nearhk;"], [0, "&hksearow;"], [0, "&hkswarow;"], [0, "&nwnear;"], [0, "&nesear;"], [0, "&seswar;"], [0, "&swnwar;"], [8, { v: "&rarrc;", n: 824, o: "&nrarrc;" }], [1, "&cudarrr;"], [0, "&ldca;"], [0, "&rdca;"], [0, "&cudarrl;"], [0, "&larrpl;"], [2, "&curarrm;"], [0, "&cularrp;"], [7, "&rarrpl;"], [2, "&harrcir;"], [0, "&Uarrocir;"], [0, "&lurdshar;"], [0, "&ldrushar;"], [2, "&LeftRightVector;"], [0, "&RightUpDownVector;"], [0, "&DownLeftRightVector;"], [0, "&LeftUpDownVector;"], [0, "&LeftVectorBar;"], [0, "&RightVectorBar;"], [0, "&RightUpVectorBar;"], [0, "&RightDownVectorBar;"], [0, "&DownLeftVectorBar;"], [0, "&DownRightVectorBar;"], [0, "&LeftUpVectorBar;"], [0, "&LeftDownVectorBar;"], [0, "&LeftTeeVector;"], [0, "&RightTeeVector;"], [0, "&RightUpTeeVector;"], [0, "&RightDownTeeVector;"], [0, "&DownLeftTeeVector;"], [0, "&DownRightTeeVector;"], [0, "&LeftUpTeeVector;"], [0, "&LeftDownTeeVector;"], [0, "&lHar;"], [0, "&uHar;"], [0, "&rHar;"], [0, "&dHar;"], [0, "&luruhar;"], [0, "&ldrdhar;"], [0, "&ruluhar;"], [0, "&rdldhar;"], [0, "&lharul;"], [0, "&llhard;"], [0, "&rharul;"], [0, "&lrhard;"], [0, "&udhar;"], [0, "&duhar;"], [0, "&RoundImplies;"], [0, "&erarr;"], [0, "&simrarr;"], [0, "&larrsim;"], [0, "&rarrsim;"], [0, "&rarrap;"], [0, "&ltlarr;"], [1, "&gtrarr;"], [0, "&subrarr;"], [1, "&suplarr;"], [0, "&lfisht;"], [0, "&rfisht;"], [0, "&ufisht;"], [0, "&dfisht;"], [5, "&lopar;"], [0, "&ropar;"], [4, "&lbrke;"], [0, "&rbrke;"], [0, "&lbrkslu;"], [0, "&rbrksld;"], [0, "&lbrksld;"], [0, "&rbrkslu;"], [0, "&langd;"], [0, "&rangd;"], [0, "&lparlt;"], [0, "&rpargt;"], [0, "&gtlPar;"], [0, "&ltrPar;"], [3, "&vzigzag;"], [1, "&vangrt;"], [0, "&angrtvbd;"], [6, "&ange;"], [0, "&range;"], [0, "&dwangle;"], [0, "&uwangle;"], [0, "&angmsdaa;"], [0, "&angmsdab;"], [0, "&angmsdac;"], [0, "&angmsdad;"], [0, "&angmsdae;"], [0, "&angmsdaf;"], [0, "&angmsdag;"], [0, "&angmsdah;"], [0, "&bemptyv;"], [0, "&demptyv;"], [0, "&cemptyv;"], [0, "&raemptyv;"], [0, "&laemptyv;"], [0, "&ohbar;"], [0, "&omid;"], [0, "&opar;"], [1, "&operp;"], [1, "&olcross;"], [0, "&odsold;"], [1, "&olcir;"], [0, "&ofcir;"], [0, "&olt;"], [0, "&ogt;"], [0, "&cirscir;"], [0, "&cirE;"], [0, "&solb;"], [0, "&bsolb;"], [3, "&boxbox;"], [3, "&trisb;"], [0, "&rtriltri;"], [0, { v: "&LeftTriangleBar;", n: 824, o: "&NotLeftTriangleBar;" }], [0, { v: "&RightTriangleBar;", n: 824, o: "&NotRightTriangleBar;" }], [11, "&iinfin;"], [0, "&infintie;"], [0, "&nvinfin;"], [4, "&eparsl;"], [0, "&smeparsl;"], [0, "&eqvparsl;"], [5, "&blacklozenge;"], [8, "&RuleDelayed;"], [1, "&dsol;"], [9, "&bigodot;"], [0, "&bigoplus;"], [0, "&bigotimes;"], [1, "&biguplus;"], [1, "&bigsqcup;"], [5, "&iiiint;"], [0, "&fpartint;"], [2, "&cirfnint;"], [0, "&awint;"], [0, "&rppolint;"], [0, "&scpolint;"], [0, "&npolint;"], [0, "&pointint;"], [0, "&quatint;"], [0, "&intlarhk;"], [10, "&pluscir;"], [0, "&plusacir;"], [0, "&simplus;"], [0, "&plusdu;"], [0, "&plussim;"], [0, "&plustwo;"], [1, "&mcomma;"], [0, "&minusdu;"], [2, "&loplus;"], [0, "&roplus;"], [0, "&Cross;"], [0, "&timesd;"], [0, "&timesbar;"], [1, "&smashp;"], [0, "&lotimes;"], [0, "&rotimes;"], [0, "&otimesas;"], [0, "&Otimes;"], [0, "&odiv;"], [0, "&triplus;"], [0, "&triminus;"], [0, "&tritime;"], [0, "&intprod;"], [2, "&amalg;"], [0, "&capdot;"], [1, "&ncup;"], [0, "&ncap;"], [0, "&capand;"], [0, "&cupor;"], [0, "&cupcap;"], [0, "&capcup;"], [0, "&cupbrcap;"], [0, "&capbrcup;"], [0, "&cupcup;"], [0, "&capcap;"], [0, "&ccups;"], [0, "&ccaps;"], [2, "&ccupssm;"], [2, "&And;"], [0, "&Or;"], [0, "&andand;"], [0, "&oror;"], [0, "&orslope;"], [0, "&andslope;"], [1, "&andv;"], [0, "&orv;"], [0, "&andd;"], [0, "&ord;"], [1, "&wedbar;"], [6, "&sdote;"], [3, "&simdot;"], [2, { v: "&congdot;", n: 824, o: "&ncongdot;" }], [0, "&easter;"], [0, "&apacir;"], [0, { v: "&apE;", n: 824, o: "&napE;" }], [0, "&eplus;"], [0, "&pluse;"], [0, "&Esim;"], [0, "&Colone;"], [0, "&Equal;"], [1, "&ddotseq;"], [0, "&equivDD;"], [0, "&ltcir;"], [0, "&gtcir;"], [0, "&ltquest;"], [0, "&gtquest;"], [0, { v: "&leqslant;", n: 824, o: "&nleqslant;" }], [0, { v: "&geqslant;", n: 824, o: "&ngeqslant;" }], [0, "&lesdot;"], [0, "&gesdot;"], [0, "&lesdoto;"], [0, "&gesdoto;"], [0, "&lesdotor;"], [0, "&gesdotol;"], [0, "&lap;"], [0, "&gap;"], [0, "&lne;"], [0, "&gne;"], [0, "&lnap;"], [0, "&gnap;"], [0, "&lEg;"], [0, "&gEl;"], [0, "&lsime;"], [0, "&gsime;"], [0, "&lsimg;"], [0, "&gsiml;"], [0, "&lgE;"], [0, "&glE;"], [0, "&lesges;"], [0, "&gesles;"], [0, "&els;"], [0, "&egs;"], [0, "&elsdot;"], [0, "&egsdot;"], [0, "&el;"], [0, "&eg;"], [2, "&siml;"], [0, "&simg;"], [0, "&simlE;"], [0, "&simgE;"], [0, { v: "&LessLess;", n: 824, o: "&NotNestedLessLess;" }], [0, { v: "&GreaterGreater;", n: 824, o: "&NotNestedGreaterGreater;" }], [1, "&glj;"], [0, "&gla;"], [0, "&ltcc;"], [0, "&gtcc;"], [0, "&lescc;"], [0, "&gescc;"], [0, "&smt;"], [0, "&lat;"], [0, { v: "&smte;", n: 65024, o: "&smtes;" }], [0, { v: "&late;", n: 65024, o: "&lates;" }], [0, "&bumpE;"], [0, { v: "&PrecedesEqual;", n: 824, o: "&NotPrecedesEqual;" }], [0, { v: "&sce;", n: 824, o: "&NotSucceedsEqual;" }], [2, "&prE;"], [0, "&scE;"], [0, "&precneqq;"], [0, "&scnE;"], [0, "&prap;"], [0, "&scap;"], [0, "&precnapprox;"], [0, "&scnap;"], [0, "&Pr;"], [0, "&Sc;"], [0, "&subdot;"], [0, "&supdot;"], [0, "&subplus;"], [0, "&supplus;"], [0, "&submult;"], [0, "&supmult;"], [0, "&subedot;"], [0, "&supedot;"], [0, { v: "&subE;", n: 824, o: "&nsubE;" }], [0, { v: "&supE;", n: 824, o: "&nsupE;" }], [0, "&subsim;"], [0, "&supsim;"], [2, { v: "&subnE;", n: 65024, o: "&varsubsetneqq;" }], [0, { v: "&supnE;", n: 65024, o: "&varsupsetneqq;" }], [2, "&csub;"], [0, "&csup;"], [0, "&csube;"], [0, "&csupe;"], [0, "&subsup;"], [0, "&supsub;"], [0, "&subsub;"], [0, "&supsup;"], [0, "&suphsub;"], [0, "&supdsub;"], [0, "&forkv;"], [0, "&topfork;"], [0, "&mlcp;"], [8, "&Dashv;"], [1, "&Vdashl;"], [0, "&Barv;"], [0, "&vBar;"], [0, "&vBarv;"], [1, "&Vbar;"], [0, "&Not;"], [0, "&bNot;"], [0, "&rnmid;"], [0, "&cirmid;"], [0, "&midcir;"], [0, "&topcir;"], [0, "&nhpar;"], [0, "&parsim;"], [9, { v: "&parsl;", n: 8421, o: "&nparsl;" }], [44343, { n: new Map(/* @__PURE__ */ restoreDiff([[56476, "&Ascr;"], [1, "&Cscr;"], [0, "&Dscr;"], [2, "&Gscr;"], [2, "&Jscr;"], [0, "&Kscr;"], [2, "&Nscr;"], [0, "&Oscr;"], [0, "&Pscr;"], [0, "&Qscr;"], [1, "&Sscr;"], [0, "&Tscr;"], [0, "&Uscr;"], [0, "&Vscr;"], [0, "&Wscr;"], [0, "&Xscr;"], [0, "&Yscr;"], [0, "&Zscr;"], [0, "&ascr;"], [0, "&bscr;"], [0, "&cscr;"], [0, "&dscr;"], [1, "&fscr;"], [1, "&hscr;"], [0, "&iscr;"], [0, "&jscr;"], [0, "&kscr;"], [0, "&lscr;"], [0, "&mscr;"], [0, "&nscr;"], [1, "&pscr;"], [0, "&qscr;"], [0, "&rscr;"], [0, "&sscr;"], [0, "&tscr;"], [0, "&uscr;"], [0, "&vscr;"], [0, "&wscr;"], [0, "&xscr;"], [0, "&yscr;"], [0, "&zscr;"], [52, "&Afr;"], [0, "&Bfr;"], [1, "&Dfr;"], [0, "&Efr;"], [0, "&Ffr;"], [0, "&Gfr;"], [2, "&Jfr;"], [0, "&Kfr;"], [0, "&Lfr;"], [0, "&Mfr;"], [0, "&Nfr;"], [0, "&Ofr;"], [0, "&Pfr;"], [0, "&Qfr;"], [1, "&Sfr;"], [0, "&Tfr;"], [0, "&Ufr;"], [0, "&Vfr;"], [0, "&Wfr;"], [0, "&Xfr;"], [0, "&Yfr;"], [1, "&afr;"], [0, "&bfr;"], [0, "&cfr;"], [0, "&dfr;"], [0, "&efr;"], [0, "&ffr;"], [0, "&gfr;"], [0, "&hfr;"], [0, "&ifr;"], [0, "&jfr;"], [0, "&kfr;"], [0, "&lfr;"], [0, "&mfr;"], [0, "&nfr;"], [0, "&ofr;"], [0, "&pfr;"], [0, "&qfr;"], [0, "&rfr;"], [0, "&sfr;"], [0, "&tfr;"], [0, "&ufr;"], [0, "&vfr;"], [0, "&wfr;"], [0, "&xfr;"], [0, "&yfr;"], [0, "&zfr;"], [0, "&Aopf;"], [0, "&Bopf;"], [1, "&Dopf;"], [0, "&Eopf;"], [0, "&Fopf;"], [0, "&Gopf;"], [1, "&Iopf;"], [0, "&Jopf;"], [0, "&Kopf;"], [0, "&Lopf;"], [0, "&Mopf;"], [1, "&Oopf;"], [3, "&Sopf;"], [0, "&Topf;"], [0, "&Uopf;"], [0, "&Vopf;"], [0, "&Wopf;"], [0, "&Xopf;"], [0, "&Yopf;"], [1, "&aopf;"], [0, "&bopf;"], [0, "&copf;"], [0, "&dopf;"], [0, "&eopf;"], [0, "&fopf;"], [0, "&gopf;"], [0, "&hopf;"], [0, "&iopf;"], [0, "&jopf;"], [0, "&kopf;"], [0, "&lopf;"], [0, "&mopf;"], [0, "&nopf;"], [0, "&oopf;"], [0, "&popf;"], [0, "&qopf;"], [0, "&ropf;"], [0, "&sopf;"], [0, "&topf;"], [0, "&uopf;"], [0, "&vopf;"], [0, "&wopf;"], [0, "&xopf;"], [0, "&yopf;"], [0, "&zopf;"]])) }], [8906, "&fflig;"], [0, "&filig;"], [0, "&fllig;"], [0, "&ffilig;"], [0, "&ffllig;"]]));
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/escape.js
var require_escape = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/escape.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.escapeText = exports2.escapeAttribute = exports2.escapeUTF8 = exports2.escape = exports2.encodeXML = exports2.getCodePoint = exports2.xmlReplacer = void 0;
    exports2.xmlReplacer = /["&'<>$\x80-\uFFFF]/g;
    var xmlCodeMap = /* @__PURE__ */ new Map([
      [34, "&quot;"],
      [38, "&amp;"],
      [39, "&apos;"],
      [60, "&lt;"],
      [62, "&gt;"]
    ]);
    exports2.getCodePoint = // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    String.prototype.codePointAt != null ? function(str, index) {
      return str.codePointAt(index);
    } : (
      // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
      function(c, index) {
        return (c.charCodeAt(index) & 64512) === 55296 ? (c.charCodeAt(index) - 55296) * 1024 + c.charCodeAt(index + 1) - 56320 + 65536 : c.charCodeAt(index);
      }
    );
    function encodeXML(str) {
      var ret = "";
      var lastIdx = 0;
      var match;
      while ((match = exports2.xmlReplacer.exec(str)) !== null) {
        var i = match.index;
        var char = str.charCodeAt(i);
        var next = xmlCodeMap.get(char);
        if (next !== void 0) {
          ret += str.substring(lastIdx, i) + next;
          lastIdx = i + 1;
        } else {
          ret += "".concat(str.substring(lastIdx, i), "&#x").concat((0, exports2.getCodePoint)(str, i).toString(16), ";");
          lastIdx = exports2.xmlReplacer.lastIndex += Number((char & 64512) === 55296);
        }
      }
      return ret + str.substr(lastIdx);
    }
    exports2.encodeXML = encodeXML;
    exports2.escape = encodeXML;
    function getEscaper(regex, map) {
      return function escape(data) {
        var match;
        var lastIdx = 0;
        var result = "";
        while (match = regex.exec(data)) {
          if (lastIdx !== match.index) {
            result += data.substring(lastIdx, match.index);
          }
          result += map.get(match[0].charCodeAt(0));
          lastIdx = match.index + 1;
        }
        return result + data.substring(lastIdx);
      };
    }
    exports2.escapeUTF8 = getEscaper(/[&<>'"]/g, xmlCodeMap);
    exports2.escapeAttribute = getEscaper(/["&\u00A0]/g, /* @__PURE__ */ new Map([
      [34, "&quot;"],
      [38, "&amp;"],
      [160, "&nbsp;"]
    ]));
    exports2.escapeText = getEscaper(/[&<>\u00A0]/g, /* @__PURE__ */ new Map([
      [38, "&amp;"],
      [60, "&lt;"],
      [62, "&gt;"],
      [160, "&nbsp;"]
    ]));
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/encode.js
var require_encode = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/encode.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.encodeNonAsciiHTML = exports2.encodeHTML = void 0;
    var encode_html_js_1 = __importDefault(require_encode_html());
    var escape_js_1 = require_escape();
    var htmlReplacer = /[\t\n!-,./:-@[-`\f{-}$\x80-\uFFFF]/g;
    function encodeHTML(data) {
      return encodeHTMLTrieRe(htmlReplacer, data);
    }
    exports2.encodeHTML = encodeHTML;
    function encodeNonAsciiHTML(data) {
      return encodeHTMLTrieRe(escape_js_1.xmlReplacer, data);
    }
    exports2.encodeNonAsciiHTML = encodeNonAsciiHTML;
    function encodeHTMLTrieRe(regExp, str) {
      var ret = "";
      var lastIdx = 0;
      var match;
      while ((match = regExp.exec(str)) !== null) {
        var i = match.index;
        ret += str.substring(lastIdx, i);
        var char = str.charCodeAt(i);
        var next = encode_html_js_1.default.get(char);
        if (typeof next === "object") {
          if (i + 1 < str.length) {
            var nextChar = str.charCodeAt(i + 1);
            var value = typeof next.n === "number" ? next.n === nextChar ? next.o : void 0 : next.n.get(nextChar);
            if (value !== void 0) {
              ret += value;
              lastIdx = regExp.lastIndex += 1;
              continue;
            }
          }
          next = next.v;
        }
        if (next !== void 0) {
          ret += next;
          lastIdx = i + 1;
        } else {
          var cp = (0, escape_js_1.getCodePoint)(str, i);
          ret += "&#x".concat(cp.toString(16), ";");
          lastIdx = regExp.lastIndex += Number(cp !== char);
        }
      }
      return ret + str.substr(lastIdx);
    }
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/index.js
var require_lib = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/entities/lib/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.decodeXMLStrict = exports2.decodeHTML5Strict = exports2.decodeHTML4Strict = exports2.decodeHTML5 = exports2.decodeHTML4 = exports2.decodeHTMLAttribute = exports2.decodeHTMLStrict = exports2.decodeHTML = exports2.decodeXML = exports2.DecodingMode = exports2.EntityDecoder = exports2.encodeHTML5 = exports2.encodeHTML4 = exports2.encodeNonAsciiHTML = exports2.encodeHTML = exports2.escapeText = exports2.escapeAttribute = exports2.escapeUTF8 = exports2.escape = exports2.encodeXML = exports2.encode = exports2.decodeStrict = exports2.decode = exports2.EncodingMode = exports2.EntityLevel = void 0;
    var decode_js_1 = require_decode();
    var encode_js_1 = require_encode();
    var escape_js_1 = require_escape();
    var EntityLevel;
    (function(EntityLevel2) {
      EntityLevel2[EntityLevel2["XML"] = 0] = "XML";
      EntityLevel2[EntityLevel2["HTML"] = 1] = "HTML";
    })(EntityLevel = exports2.EntityLevel || (exports2.EntityLevel = {}));
    var EncodingMode;
    (function(EncodingMode2) {
      EncodingMode2[EncodingMode2["UTF8"] = 0] = "UTF8";
      EncodingMode2[EncodingMode2["ASCII"] = 1] = "ASCII";
      EncodingMode2[EncodingMode2["Extensive"] = 2] = "Extensive";
      EncodingMode2[EncodingMode2["Attribute"] = 3] = "Attribute";
      EncodingMode2[EncodingMode2["Text"] = 4] = "Text";
    })(EncodingMode = exports2.EncodingMode || (exports2.EncodingMode = {}));
    function decode(data, options) {
      if (options === void 0) {
        options = EntityLevel.XML;
      }
      var level = typeof options === "number" ? options : options.level;
      if (level === EntityLevel.HTML) {
        var mode = typeof options === "object" ? options.mode : void 0;
        return (0, decode_js_1.decodeHTML)(data, mode);
      }
      return (0, decode_js_1.decodeXML)(data);
    }
    exports2.decode = decode;
    function decodeStrict(data, options) {
      var _a;
      if (options === void 0) {
        options = EntityLevel.XML;
      }
      var opts = typeof options === "number" ? { level: options } : options;
      (_a = opts.mode) !== null && _a !== void 0 ? _a : opts.mode = decode_js_1.DecodingMode.Strict;
      return decode(data, opts);
    }
    exports2.decodeStrict = decodeStrict;
    function encode(data, options) {
      if (options === void 0) {
        options = EntityLevel.XML;
      }
      var opts = typeof options === "number" ? { level: options } : options;
      if (opts.mode === EncodingMode.UTF8)
        return (0, escape_js_1.escapeUTF8)(data);
      if (opts.mode === EncodingMode.Attribute)
        return (0, escape_js_1.escapeAttribute)(data);
      if (opts.mode === EncodingMode.Text)
        return (0, escape_js_1.escapeText)(data);
      if (opts.level === EntityLevel.HTML) {
        if (opts.mode === EncodingMode.ASCII) {
          return (0, encode_js_1.encodeNonAsciiHTML)(data);
        }
        return (0, encode_js_1.encodeHTML)(data);
      }
      return (0, escape_js_1.encodeXML)(data);
    }
    exports2.encode = encode;
    var escape_js_2 = require_escape();
    Object.defineProperty(exports2, "encodeXML", { enumerable: true, get: function() {
      return escape_js_2.encodeXML;
    } });
    Object.defineProperty(exports2, "escape", { enumerable: true, get: function() {
      return escape_js_2.escape;
    } });
    Object.defineProperty(exports2, "escapeUTF8", { enumerable: true, get: function() {
      return escape_js_2.escapeUTF8;
    } });
    Object.defineProperty(exports2, "escapeAttribute", { enumerable: true, get: function() {
      return escape_js_2.escapeAttribute;
    } });
    Object.defineProperty(exports2, "escapeText", { enumerable: true, get: function() {
      return escape_js_2.escapeText;
    } });
    var encode_js_2 = require_encode();
    Object.defineProperty(exports2, "encodeHTML", { enumerable: true, get: function() {
      return encode_js_2.encodeHTML;
    } });
    Object.defineProperty(exports2, "encodeNonAsciiHTML", { enumerable: true, get: function() {
      return encode_js_2.encodeNonAsciiHTML;
    } });
    Object.defineProperty(exports2, "encodeHTML4", { enumerable: true, get: function() {
      return encode_js_2.encodeHTML;
    } });
    Object.defineProperty(exports2, "encodeHTML5", { enumerable: true, get: function() {
      return encode_js_2.encodeHTML;
    } });
    var decode_js_2 = require_decode();
    Object.defineProperty(exports2, "EntityDecoder", { enumerable: true, get: function() {
      return decode_js_2.EntityDecoder;
    } });
    Object.defineProperty(exports2, "DecodingMode", { enumerable: true, get: function() {
      return decode_js_2.DecodingMode;
    } });
    Object.defineProperty(exports2, "decodeXML", { enumerable: true, get: function() {
      return decode_js_2.decodeXML;
    } });
    Object.defineProperty(exports2, "decodeHTML", { enumerable: true, get: function() {
      return decode_js_2.decodeHTML;
    } });
    Object.defineProperty(exports2, "decodeHTMLStrict", { enumerable: true, get: function() {
      return decode_js_2.decodeHTMLStrict;
    } });
    Object.defineProperty(exports2, "decodeHTMLAttribute", { enumerable: true, get: function() {
      return decode_js_2.decodeHTMLAttribute;
    } });
    Object.defineProperty(exports2, "decodeHTML4", { enumerable: true, get: function() {
      return decode_js_2.decodeHTML;
    } });
    Object.defineProperty(exports2, "decodeHTML5", { enumerable: true, get: function() {
      return decode_js_2.decodeHTML;
    } });
    Object.defineProperty(exports2, "decodeHTML4Strict", { enumerable: true, get: function() {
      return decode_js_2.decodeHTMLStrict;
    } });
    Object.defineProperty(exports2, "decodeHTML5Strict", { enumerable: true, get: function() {
      return decode_js_2.decodeHTMLStrict;
    } });
    Object.defineProperty(exports2, "decodeXMLStrict", { enumerable: true, get: function() {
      return decode_js_2.decodeXML;
    } });
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/linkify-it/build/index.cjs.js
var require_index_cjs3 = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/linkify-it/build/index.cjs.js"(exports2, module2) {
    "use strict";
    var uc_micro = require_index_cjs2();
    function reFactory(opts) {
      const re = {};
      opts = opts || {};
      re.src_Any = uc_micro.Any.source;
      re.src_Cc = uc_micro.Cc.source;
      re.src_Z = uc_micro.Z.source;
      re.src_P = uc_micro.P.source;
      re.src_ZPCc = [re.src_Z, re.src_P, re.src_Cc].join("|");
      re.src_ZCc = [re.src_Z, re.src_Cc].join("|");
      const text_separators = "[><\uFF5C]";
      re.src_pseudo_letter = `(?:(?!${text_separators}|${re.src_ZPCc})${re.src_Any})`;
      re.src_ip4 = "(?:(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)";
      re.src_auth = `(?:(?:(?!${re.src_ZCc}|[@/\\[\\]()]).){1,50}@)?`;
      re.src_port = "(?::(?:6(?:[0-4]\\d{3}|5(?:[0-4]\\d{2}|5(?:[0-2]\\d|3[0-5])))|[1-5]?\\d{1,4}))?";
      re.src_host_terminator = `(?=$|${text_separators}|${re.src_ZPCc})(?!${opts["---"] ? "-(?!--)|" : "-|"}_|:\\d|\\.-|\\.(?!$|${re.src_ZPCc}))`;
      re.src_path = `(?:[/?#](?:(?!${re.src_ZCc}|${text_separators}|[()[\\]{}.,"'?!\\-;]).|\\[(?:(?!${re.src_ZCc}|\\]).)*\\]|\\((?:(?!${re.src_ZCc}|[)]).)*\\)|\\{(?:(?!${re.src_ZCc}|[}]).)*\\}|\\"(?:(?!${re.src_ZCc}|["]).)+\\"|\\'(?:(?!${re.src_ZCc}|[']).)+\\'|\\'(?=${re.src_pseudo_letter}|[-])|\\.{2,}[a-zA-Z0-9%/&]|\\.(?!${re.src_ZCc}|[.]|$)|` + (opts["---"] ? "\\-(?!--(?:[^-]|$))(?:-*)|" : "\\-+|") + // allow `,,,` in paths
      `,(?!${re.src_ZCc}|$)|;(?!${re.src_ZCc}|$)|\\!+(?!${re.src_ZCc}|[!]|$)|\\?(?!${re.src_ZCc}|[?]|$))+|\\/)?`;
      re.src_email_name = '[\\-;:&=\\+\\$,\\.a-zA-Z0-9_][\\-;:&=\\+\\$,\\"\\.a-zA-Z0-9_]{0,63}';
      re.src_xn = "xn--[a-z0-9\\-]{1,59}";
      re.src_domain_root = // Allow letters & digits (http://test1)
      "(?:" + re.src_xn + `|${re.src_pseudo_letter}{1,63})`;
      re.src_domain = "(?:" + re.src_xn + `|(?:${re.src_pseudo_letter})|(?:${re.src_pseudo_letter}(?:-|${re.src_pseudo_letter}){0,61}${re.src_pseudo_letter}))`;
      re.src_host = `(?:(?:(?:(?:${re.src_domain})\\.)*${re.src_domain}))`;
      re.tpl_host_fuzzy = "(?:" + re.src_ip4 + `|(?:(?:(?:${re.src_domain})\\.)+(?:%TLDS%)))`;
      re.tpl_host_no_ip_fuzzy = `(?:(?:(?:${re.src_domain})\\.)+(?:%TLDS%))`;
      re.src_host_strict = re.src_host + re.src_host_terminator;
      re.tpl_host_fuzzy_strict = re.tpl_host_fuzzy + re.src_host_terminator;
      re.src_host_port_strict = re.src_host + re.src_port + re.src_host_terminator;
      re.tpl_host_port_fuzzy_strict = re.tpl_host_fuzzy + re.src_port + re.src_host_terminator;
      re.tpl_host_port_no_ip_fuzzy_strict = re.tpl_host_no_ip_fuzzy + re.src_port + re.src_host_terminator;
      re.tpl_host_fuzzy_test = `localhost|www\\.|\\.\\d{1,3}\\.|(?:\\.(?:%TLDS%)(?:${re.src_ZPCc}|>|$))`;
      re.tpl_email_fuzzy = `(^|${text_separators}|"|\\(|${re.src_ZCc})(${re.src_email_name}@${re.tpl_host_fuzzy_strict})`;
      re.tpl_link_fuzzy = // Fuzzy link can't be prepended with .:/\- and non punctuation.
      // but can start with > (markdown blockquote)
      `(^|(?![.:/\\-_@])(?:[$+<=>^\`|\uFF5C]|${re.src_ZPCc}))((?![$+<=>^\`|\uFF5C])${re.tpl_host_port_fuzzy_strict}${re.src_path})`;
      re.tpl_link_no_ip_fuzzy = // Fuzzy link can't be prepended with .:/\- and non punctuation.
      // but can start with > (markdown blockquote)
      `(^|(?![.:/\\-_@])(?:[$+<=>^\`|\uFF5C]|${re.src_ZPCc}))((?![$+<=>^\`|\uFF5C])${re.tpl_host_port_no_ip_fuzzy_strict}${re.src_path})`;
      return re;
    }
    function assign(obj) {
      const sources = Array.prototype.slice.call(arguments, 1);
      sources.forEach(function(source) {
        if (!source) {
          return;
        }
        Object.keys(source).forEach(function(key) {
          obj[key] = source[key];
        });
      });
      return obj;
    }
    function _class(obj) {
      return Object.prototype.toString.call(obj);
    }
    function isString(obj) {
      return _class(obj) === "[object String]";
    }
    function isObject(obj) {
      return _class(obj) === "[object Object]";
    }
    function isRegExp(obj) {
      return _class(obj) === "[object RegExp]";
    }
    function isFunction(obj) {
      return _class(obj) === "[object Function]";
    }
    function escapeRE(str) {
      return str.replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&");
    }
    var defaultOptions = {
      fuzzyLink: true,
      fuzzyEmail: true,
      fuzzyIP: false
    };
    function isOptionsObj(obj) {
      return Object.keys(obj || {}).reduce(function(acc, k) {
        return acc || defaultOptions.hasOwnProperty(k);
      }, false);
    }
    var defaultSchemas = {
      "http:": {
        validate: function(text, pos, self) {
          const tail = text.slice(pos);
          if (!self.re.http) {
            self.re.http = new RegExp(
              `^\\/\\/${self.re.src_auth}${self.re.src_host_port_strict}${self.re.src_path}`,
              "i"
            );
          }
          if (self.re.http.test(tail)) {
            return tail.match(self.re.http)[0].length;
          }
          return 0;
        }
      },
      "https:": "http:",
      "ftp:": "http:",
      "//": {
        validate: function(text, pos, self) {
          const tail = text.slice(pos);
          if (!self.re.no_http) {
            self.re.no_http = new RegExp(
              "^" + self.re.src_auth + // Don't allow single-level domains, because of false positives like '//test'
              // with code comments
              `(?:localhost|(?:(?:${self.re.src_domain})\\.)+${self.re.src_domain_root})` + self.re.src_port + self.re.src_host_terminator + self.re.src_path,
              "i"
            );
          }
          if (self.re.no_http.test(tail)) {
            if (pos >= 3 && text[pos - 3] === ":") {
              return 0;
            }
            if (pos >= 3 && text[pos - 3] === "/") {
              return 0;
            }
            return tail.match(self.re.no_http)[0].length;
          }
          return 0;
        }
      },
      "mailto:": {
        validate: function(text, pos, self) {
          const tail = text.slice(pos);
          if (!self.re.mailto) {
            self.re.mailto = new RegExp(
              `^${self.re.src_email_name}@${self.re.src_host_strict}`,
              "i"
            );
          }
          if (self.re.mailto.test(tail)) {
            return tail.match(self.re.mailto)[0].length;
          }
          return 0;
        }
      }
    };
    var tlds_2ch_src_re = "a[cdefgilmnoqrstuwxz]|b[abdefghijmnorstvwyz]|c[acdfghiklmnoruvwxyz]|d[ejkmoz]|e[cegrstu]|f[ijkmor]|g[abdefghilmnpqrstuwy]|h[kmnrtu]|i[delmnoqrst]|j[emop]|k[eghimnprwyz]|l[abcikrstuvy]|m[acdeghklmnopqrstuvwxyz]|n[acefgilopruz]|om|p[aefghklmnrstwy]|qa|r[eosuw]|s[abcdeghijklmnortuvxyz]|t[cdfghjklmnortvwz]|u[agksyz]|v[aceginu]|w[fs]|y[et]|z[amw]";
    var tlds_default = "biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|\u0440\u0444".split("|");
    function createValidator(re) {
      return function(text, pos) {
        const tail = text.slice(pos);
        if (re.test(tail)) {
          return tail.match(re)[0].length;
        }
        return 0;
      };
    }
    function createNormalizer() {
      return function(match, self) {
        self.normalize(match);
      };
    }
    function compile(self) {
      const re = self.re = reFactory(self.__opts__);
      const tlds = self.__tlds__.slice();
      self.onCompile();
      if (!self.__tlds_replaced__) {
        tlds.push(tlds_2ch_src_re);
      }
      tlds.push(re.src_xn);
      re.src_tlds = tlds.join("|");
      function untpl(tpl) {
        return tpl.replace("%TLDS%", re.src_tlds);
      }
      re.email_fuzzy = RegExp(untpl(re.tpl_email_fuzzy), "i");
      re.email_fuzzy_global = RegExp(untpl(re.tpl_email_fuzzy), "ig");
      re.link_fuzzy = RegExp(untpl(re.tpl_link_fuzzy), "i");
      re.link_fuzzy_global = RegExp(untpl(re.tpl_link_fuzzy), "ig");
      re.link_no_ip_fuzzy = RegExp(untpl(re.tpl_link_no_ip_fuzzy), "i");
      re.link_no_ip_fuzzy_global = RegExp(untpl(re.tpl_link_no_ip_fuzzy), "ig");
      re.host_fuzzy_test = RegExp(untpl(re.tpl_host_fuzzy_test), "i");
      const aliases = [];
      self.__compiled__ = {};
      function schemaError(name, val) {
        throw new Error(`(LinkifyIt) Invalid schema "${name}": ${val}`);
      }
      Object.keys(self.__schemas__).forEach(function(name) {
        const val = self.__schemas__[name];
        if (val === null) {
          return;
        }
        const compiled = { validate: null, link: null };
        self.__compiled__[name] = compiled;
        if (isObject(val)) {
          if (isRegExp(val.validate)) {
            compiled.validate = createValidator(val.validate);
          } else if (isFunction(val.validate)) {
            compiled.validate = val.validate;
          } else {
            schemaError(name, val);
          }
          if (isFunction(val.normalize)) {
            compiled.normalize = val.normalize;
          } else if (!val.normalize) {
            compiled.normalize = createNormalizer();
          } else {
            schemaError(name, val);
          }
          return;
        }
        if (isString(val)) {
          aliases.push(name);
          return;
        }
        schemaError(name, val);
      });
      aliases.forEach(function(alias) {
        if (!self.__compiled__[self.__schemas__[alias]]) {
          return;
        }
        self.__compiled__[alias].validate = self.__compiled__[self.__schemas__[alias]].validate;
        self.__compiled__[alias].normalize = self.__compiled__[self.__schemas__[alias]].normalize;
      });
      self.__compiled__[""] = { validate: null, normalize: createNormalizer() };
      const slist = Object.keys(self.__compiled__).filter(function(name) {
        return name.length > 0 && self.__compiled__[name];
      }).map(escapeRE).join("|");
      self.re.schema_test = RegExp(`(^|(?!_)(?:[><\uFF5C]|${re.src_ZPCc}))(${slist})`, "i");
      self.re.schema_search = RegExp(`(^|(?!_)(?:[><\uFF5C]|${re.src_ZPCc}))(${slist})`, "ig");
      self.re.schema_at_start = RegExp(`^${self.re.schema_search.source}`, "i");
      self.re.pretest = RegExp(
        `(${self.re.schema_test.source})|(${self.re.host_fuzzy_test.source})|@`,
        "i"
      );
    }
    function Match(text, schema, index, lastIndex) {
      const raw = text.slice(index, lastIndex);
      this.schema = schema.toLowerCase();
      this.index = index;
      this.lastIndex = lastIndex;
      this.raw = raw;
      this.text = raw;
      this.url = raw;
    }
    function LinkifyIt(schemas, options) {
      if (!(this instanceof LinkifyIt)) {
        return new LinkifyIt(schemas, options);
      }
      if (!options) {
        if (isOptionsObj(schemas)) {
          options = schemas;
          schemas = {};
        }
      }
      this.__opts__ = assign({}, defaultOptions, options);
      this.__schemas__ = assign({}, defaultSchemas, schemas);
      this.__compiled__ = {};
      this.__tlds__ = tlds_default;
      this.__tlds_replaced__ = false;
      this.re = {};
      compile(this);
    }
    LinkifyIt.prototype.add = function add(schema, definition) {
      this.__schemas__[schema] = definition;
      compile(this);
      return this;
    };
    LinkifyIt.prototype.set = function set(options) {
      this.__opts__ = assign(this.__opts__, options);
      return this;
    };
    LinkifyIt.prototype.test = function test(text) {
      if (!text.length) {
        return false;
      }
      let m, re;
      if (this.re.schema_test.test(text)) {
        re = this.re.schema_search;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
          if (this.testSchemaAt(text, m[2], re.lastIndex)) {
            return true;
          }
        }
      }
      if (this.__opts__.fuzzyLink && this.__compiled__["http:"]) {
        if (text.search(this.re.host_fuzzy_test) >= 0) {
          if (text.match(this.__opts__.fuzzyIP ? this.re.link_fuzzy : this.re.link_no_ip_fuzzy) !== null) {
            return true;
          }
        }
      }
      if (this.__opts__.fuzzyEmail && this.__compiled__["mailto:"]) {
        if (text.indexOf("@") >= 0) {
          if (text.match(this.re.email_fuzzy) !== null) {
            return true;
          }
        }
      }
      return false;
    };
    LinkifyIt.prototype.pretest = function pretest(text) {
      return this.re.pretest.test(text);
    };
    LinkifyIt.prototype.testSchemaAt = function testSchemaAt(text, schema, pos) {
      if (!this.__compiled__[schema.toLowerCase()]) {
        return 0;
      }
      return this.__compiled__[schema.toLowerCase()].validate(text, pos, this);
    };
    LinkifyIt.prototype.match = function match(text) {
      const result = [];
      const type_schemed = [];
      const type_fuzzy_link = [];
      const type_fuzzy_email = [];
      let m, len, re;
      function choose(a, b) {
        if (!a) {
          return b;
        }
        if (!b) {
          return a;
        }
        if (a.index !== b.index) {
          return a.index < b.index ? a : b;
        }
        return a.lastIndex >= b.lastIndex ? a : b;
      }
      if (!text.length) {
        return null;
      }
      if (this.re.schema_test.test(text)) {
        re = this.re.schema_search;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
          len = this.testSchemaAt(text, m[2], re.lastIndex);
          if (len) {
            type_schemed.push({
              schema: m[2],
              index: m.index + m[1].length,
              lastIndex: m.index + m[0].length + len
            });
          }
        }
      }
      if (this.__opts__.fuzzyLink && this.__compiled__["http:"]) {
        re = this.__opts__.fuzzyIP ? this.re.link_fuzzy_global : this.re.link_no_ip_fuzzy_global;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
          type_fuzzy_link.push({
            schema: "",
            index: m.index + m[1].length,
            lastIndex: m.index + m[0].length
          });
        }
      }
      if (this.__opts__.fuzzyEmail && this.__compiled__["mailto:"]) {
        re = this.re.email_fuzzy_global;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
          type_fuzzy_email.push({
            schema: "mailto:",
            index: m.index + m[1].length,
            lastIndex: m.index + m[0].length
          });
        }
      }
      const indexes = [0, 0, 0];
      let lastIndex = 0;
      for (; ; ) {
        const candidates = [
          type_schemed[indexes[0]],
          type_fuzzy_email[indexes[1]],
          type_fuzzy_link[indexes[2]]
        ];
        const candidate = choose(choose(candidates[0], candidates[1]), candidates[2]);
        if (!candidate) {
          break;
        }
        if (candidate === candidates[0]) {
          indexes[0]++;
        } else if (candidate === candidates[1]) {
          indexes[1]++;
        } else {
          indexes[2]++;
        }
        if (candidate.index < lastIndex) {
          continue;
        }
        const match2 = new Match(text, candidate.schema, candidate.index, candidate.lastIndex);
        this.__compiled__[match2.schema].normalize(match2, this);
        result.push(match2);
        lastIndex = candidate.lastIndex;
      }
      if (result.length) {
        return result;
      }
      return null;
    };
    LinkifyIt.prototype.matchAtStart = function matchAtStart(text) {
      if (!text.length) return null;
      const m = this.re.schema_at_start.exec(text);
      if (!m) return null;
      const len = this.testSchemaAt(text, m[2], m[0].length);
      if (!len) return null;
      const match = new Match(text, m[2], m.index + m[1].length, m.index + m[0].length + len);
      this.__compiled__[match.schema].normalize(match, this);
      return match;
    };
    LinkifyIt.prototype.tlds = function tlds(list, keepOld) {
      list = Array.isArray(list) ? list : [list];
      if (!keepOld) {
        this.__tlds__ = list.slice();
        this.__tlds_replaced__ = true;
        compile(this);
        return this;
      }
      this.__tlds__ = this.__tlds__.concat(list).sort().filter(function(el, idx, arr) {
        return el !== arr[idx - 1];
      }).reverse();
      compile(this);
      return this;
    };
    LinkifyIt.prototype.normalize = function normalize(match) {
      if (!match.schema) {
        match.url = `http://${match.url}`;
      }
      if (match.schema === "mailto:" && !/^mailto:/i.test(match.url)) {
        match.url = `mailto:${match.url}`;
      }
    };
    LinkifyIt.prototype.onCompile = function onCompile() {
    };
    module2.exports = LinkifyIt;
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/punycode.js/punycode.js
var require_punycode = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/punycode.js/punycode.js"(exports2, module2) {
    "use strict";
    var maxInt = 2147483647;
    var base = 36;
    var tMin = 1;
    var tMax = 26;
    var skew = 38;
    var damp = 700;
    var initialBias = 72;
    var initialN = 128;
    var delimiter = "-";
    var regexPunycode = /^xn--/;
    var regexNonASCII = /[^\0-\x7F]/;
    var regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g;
    var errors = {
      "overflow": "Overflow: input needs wider integers to process",
      "not-basic": "Illegal input >= 0x80 (not a basic code point)",
      "invalid-input": "Invalid input"
    };
    var baseMinusTMin = base - tMin;
    var floor = Math.floor;
    var stringFromCharCode = String.fromCharCode;
    function error(type) {
      throw new RangeError(errors[type]);
    }
    function map(array, callback) {
      const result = [];
      let length = array.length;
      while (length--) {
        result[length] = callback(array[length]);
      }
      return result;
    }
    function mapDomain(domain, callback) {
      const parts = domain.split("@");
      let result = "";
      if (parts.length > 1) {
        result = parts[0] + "@";
        domain = parts[1];
      }
      domain = domain.replace(regexSeparators, ".");
      const labels = domain.split(".");
      const encoded = map(labels, callback).join(".");
      return result + encoded;
    }
    function ucs2decode(string) {
      const output = [];
      let counter = 0;
      const length = string.length;
      while (counter < length) {
        const value = string.charCodeAt(counter++);
        if (value >= 55296 && value <= 56319 && counter < length) {
          const extra = string.charCodeAt(counter++);
          if ((extra & 64512) == 56320) {
            output.push(((value & 1023) << 10) + (extra & 1023) + 65536);
          } else {
            output.push(value);
            counter--;
          }
        } else {
          output.push(value);
        }
      }
      return output;
    }
    var ucs2encode = (codePoints) => String.fromCodePoint(...codePoints);
    var basicToDigit = function(codePoint) {
      if (codePoint >= 48 && codePoint < 58) {
        return 26 + (codePoint - 48);
      }
      if (codePoint >= 65 && codePoint < 91) {
        return codePoint - 65;
      }
      if (codePoint >= 97 && codePoint < 123) {
        return codePoint - 97;
      }
      return base;
    };
    var digitToBasic = function(digit, flag) {
      return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
    };
    var adapt = function(delta, numPoints, firstTime) {
      let k = 0;
      delta = firstTime ? floor(delta / damp) : delta >> 1;
      delta += floor(delta / numPoints);
      for (; delta > baseMinusTMin * tMax >> 1; k += base) {
        delta = floor(delta / baseMinusTMin);
      }
      return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
    };
    var decode = function(input) {
      const output = [];
      const inputLength = input.length;
      let i = 0;
      let n = initialN;
      let bias = initialBias;
      let basic = input.lastIndexOf(delimiter);
      if (basic < 0) {
        basic = 0;
      }
      for (let j = 0; j < basic; ++j) {
        if (input.charCodeAt(j) >= 128) {
          error("not-basic");
        }
        output.push(input.charCodeAt(j));
      }
      for (let index = basic > 0 ? basic + 1 : 0; index < inputLength; ) {
        const oldi = i;
        for (let w = 1, k = base; ; k += base) {
          if (index >= inputLength) {
            error("invalid-input");
          }
          const digit = basicToDigit(input.charCodeAt(index++));
          if (digit >= base) {
            error("invalid-input");
          }
          if (digit > floor((maxInt - i) / w)) {
            error("overflow");
          }
          i += digit * w;
          const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
          if (digit < t) {
            break;
          }
          const baseMinusT = base - t;
          if (w > floor(maxInt / baseMinusT)) {
            error("overflow");
          }
          w *= baseMinusT;
        }
        const out = output.length + 1;
        bias = adapt(i - oldi, out, oldi == 0);
        if (floor(i / out) > maxInt - n) {
          error("overflow");
        }
        n += floor(i / out);
        i %= out;
        output.splice(i++, 0, n);
      }
      return String.fromCodePoint(...output);
    };
    var encode = function(input) {
      const output = [];
      input = ucs2decode(input);
      const inputLength = input.length;
      let n = initialN;
      let delta = 0;
      let bias = initialBias;
      for (const currentValue of input) {
        if (currentValue < 128) {
          output.push(stringFromCharCode(currentValue));
        }
      }
      const basicLength = output.length;
      let handledCPCount = basicLength;
      if (basicLength) {
        output.push(delimiter);
      }
      while (handledCPCount < inputLength) {
        let m = maxInt;
        for (const currentValue of input) {
          if (currentValue >= n && currentValue < m) {
            m = currentValue;
          }
        }
        const handledCPCountPlusOne = handledCPCount + 1;
        if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
          error("overflow");
        }
        delta += (m - n) * handledCPCountPlusOne;
        n = m;
        for (const currentValue of input) {
          if (currentValue < n && ++delta > maxInt) {
            error("overflow");
          }
          if (currentValue === n) {
            let q = delta;
            for (let k = base; ; k += base) {
              const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
              if (q < t) {
                break;
              }
              const qMinusT = q - t;
              const baseMinusT = base - t;
              output.push(
                stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
              );
              q = floor(qMinusT / baseMinusT);
            }
            output.push(stringFromCharCode(digitToBasic(q, 0)));
            bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
            delta = 0;
            ++handledCPCount;
          }
        }
        ++delta;
        ++n;
      }
      return output.join("");
    };
    var toUnicode = function(input) {
      return mapDomain(input, function(string) {
        return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string;
      });
    };
    var toASCII = function(input) {
      return mapDomain(input, function(string) {
        return regexNonASCII.test(string) ? "xn--" + encode(string) : string;
      });
    };
    var punycode = {
      /**
       * A string representing the current Punycode.js version number.
       * @memberOf punycode
       * @type String
       */
      "version": "2.3.1",
      /**
       * An object of methods to convert from JavaScript's internal character
       * representation (UCS-2) to Unicode code points, and back.
       * @see <https://mathiasbynens.be/notes/javascript-encoding>
       * @memberOf punycode
       * @type Object
       */
      "ucs2": {
        "decode": ucs2decode,
        "encode": ucs2encode
      },
      "decode": decode,
      "encode": encode,
      "toASCII": toASCII,
      "toUnicode": toUnicode
    };
    module2.exports = punycode;
  }
});

// ../../../../../../../obsidian_plugin_atpath/node_modules/markdown-it/dist/index.cjs.js
var require_index_cjs4 = __commonJS({
  "../../../../../../../obsidian_plugin_atpath/node_modules/markdown-it/dist/index.cjs.js"(exports2, module2) {
    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __getProtoOf = Object.getPrototypeOf;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __exportAll = (all, no_symbols) => {
      let target = {};
      for (var name in all) __defProp(target, name, {
        get: all[name],
        enumerable: true
      });
      if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
      return target;
    };
    var __copyProps = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames2(from), i = 0, n = keys.length, key; i < n; i++) {
        key = keys[i];
        if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
          get: ((k) => from[k]).bind(null, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
      }
      return to;
    };
    var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
      value: mod,
      enumerable: true
    }) : target, mod));
    var mdurl = require_index_cjs();
    mdurl = __toESM(mdurl, 1);
    var uc_micro = require_index_cjs2();
    uc_micro = __toESM(uc_micro, 1);
    var entities = require_lib();
    var linkify_it = require_index_cjs3();
    linkify_it = __toESM(linkify_it, 1);
    var punycode_js = require_punycode();
    punycode_js = __toESM(punycode_js, 1);
    var utils_exports = /* @__PURE__ */ __exportAll({
      arrayReplaceAt: () => arrayReplaceAt,
      asciiTrim: () => asciiTrim,
      assign: () => assign,
      escapeHtml: () => escapeHtml,
      escapeRE: () => escapeRE,
      fromCodePoint: () => fromCodePoint,
      has: () => has,
      isMdAsciiPunct: () => isMdAsciiPunct,
      isPunctChar: () => isPunctChar,
      isPunctCharCode: () => isPunctCharCode,
      isSpace: () => isSpace,
      isString: () => isString,
      isValidEntityCode: () => isValidEntityCode,
      isWhiteSpace: () => isWhiteSpace,
      lib: () => lib,
      normalizeReference: () => normalizeReference,
      unescapeAll: () => unescapeAll,
      unescapeMd: () => unescapeMd
    });
    function _class(obj) {
      return Object.prototype.toString.call(obj);
    }
    function isString(obj) {
      return _class(obj) === "[object String]";
    }
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    function has(object, key) {
      return _hasOwnProperty.call(object, key);
    }
    function assign(obj) {
      Array.prototype.slice.call(arguments, 1).forEach(function(source) {
        if (!source) return;
        if (typeof source !== "object") throw new TypeError(source + "must be object");
        Object.keys(source).forEach(function(key) {
          obj[key] = source[key];
        });
      });
      return obj;
    }
    function arrayReplaceAt(src, pos, newElements) {
      return [].concat(src.slice(0, pos), newElements, src.slice(pos + 1));
    }
    function isValidEntityCode(c) {
      if (c >= 55296 && c <= 57343) return false;
      if (c >= 64976 && c <= 65007) return false;
      if ((c & 65535) === 65535 || (c & 65535) === 65534) return false;
      if (c >= 0 && c <= 8) return false;
      if (c === 11) return false;
      if (c >= 14 && c <= 31) return false;
      if (c >= 127 && c <= 159) return false;
      if (c > 1114111) return false;
      return true;
    }
    function fromCodePoint(c) {
      if (c > 65535) {
        c -= 65536;
        const surrogate1 = 55296 + (c >> 10);
        const surrogate2 = 56320 + (c & 1023);
        return String.fromCharCode(surrogate1, surrogate2);
      }
      return String.fromCharCode(c);
    }
    var UNESCAPE_MD_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
    var UNESCAPE_ALL_RE = new RegExp(UNESCAPE_MD_RE.source + "|" + /&([a-z#][a-z0-9]{1,31});/gi.source, "gi");
    var DIGITAL_ENTITY_TEST_RE = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;
    function replaceEntityPattern(match, name) {
      if (name.charCodeAt(0) === 35 && DIGITAL_ENTITY_TEST_RE.test(name)) {
        const code2 = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        if (isValidEntityCode(code2)) return fromCodePoint(code2);
        return match;
      }
      const decoded = (0, entities.decodeHTML)(match);
      if (decoded !== match) return decoded;
      return match;
    }
    function unescapeMd(str) {
      if (str.indexOf("\\") < 0) return str;
      return str.replace(UNESCAPE_MD_RE, "$1");
    }
    function unescapeAll(str) {
      if (str.indexOf("\\") < 0 && str.indexOf("&") < 0) return str;
      return str.replace(UNESCAPE_ALL_RE, function(match, escaped, entity2) {
        if (escaped) return escaped;
        return replaceEntityPattern(match, entity2);
      });
    }
    var HTML_ESCAPE_TEST_RE = /[&<>"]/;
    var HTML_ESCAPE_REPLACE_RE = /[&<>"]/g;
    var HTML_REPLACEMENTS = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;"
    };
    function replaceUnsafeChar(ch) {
      return HTML_REPLACEMENTS[ch];
    }
    function escapeHtml(str) {
      if (HTML_ESCAPE_TEST_RE.test(str)) return str.replace(HTML_ESCAPE_REPLACE_RE, replaceUnsafeChar);
      return str;
    }
    var REGEXP_ESCAPE_RE = /[.?*+^$[\]\\(){}|-]/g;
    function escapeRE(str) {
      return str.replace(REGEXP_ESCAPE_RE, "\\$&");
    }
    function isSpace(code2) {
      switch (code2) {
        case 9:
        case 32:
          return true;
      }
      return false;
    }
    function isWhiteSpace(code2) {
      if (code2 >= 8192 && code2 <= 8202) return true;
      switch (code2) {
        case 9:
        case 10:
        case 11:
        case 12:
        case 13:
        case 32:
        case 160:
        case 5760:
        case 8239:
        case 8287:
        case 12288:
          return true;
      }
      return false;
    }
    function isPunctChar(ch) {
      return uc_micro.P.test(ch) || uc_micro.S.test(ch);
    }
    function isPunctCharCode(code2) {
      return isPunctChar(fromCodePoint(code2));
    }
    function isMdAsciiPunct(ch) {
      switch (ch) {
        case 33:
        case 34:
        case 35:
        case 36:
        case 37:
        case 38:
        case 39:
        case 40:
        case 41:
        case 42:
        case 43:
        case 44:
        case 45:
        case 46:
        case 47:
        case 58:
        case 59:
        case 60:
        case 61:
        case 62:
        case 63:
        case 64:
        case 91:
        case 92:
        case 93:
        case 94:
        case 95:
        case 96:
        case 123:
        case 124:
        case 125:
        case 126:
          return true;
        default:
          return false;
      }
    }
    function normalizeReference(str) {
      str = str.trim().replace(/\s+/g, " ");
      if ("\u1E9E".toLowerCase() === "\u1E7E")
        str = str.replace(/ẞ/g, "\xDF");
      return str.toLowerCase().toUpperCase();
    }
    function isAsciiTrimmable(c) {
      return c === 32 || c === 9 || c === 10 || c === 13;
    }
    function asciiTrim(str) {
      let start = 0;
      for (; start < str.length; start++) if (!isAsciiTrimmable(str.charCodeAt(start))) break;
      let end = str.length - 1;
      for (; end >= start; end--) if (!isAsciiTrimmable(str.charCodeAt(end))) break;
      return str.slice(start, end + 1);
    }
    var lib = {
      mdurl,
      ucmicro: uc_micro
    };
    function parseLinkLabel(state, start, disableNested) {
      let level, found, marker, prevPos;
      const max = state.posMax;
      const oldPos = state.pos;
      state.pos = start + 1;
      level = 1;
      while (state.pos < max) {
        marker = state.src.charCodeAt(state.pos);
        if (marker === 93) {
          level--;
          if (level === 0) {
            found = true;
            break;
          }
        }
        prevPos = state.pos;
        state.md.inline.skipToken(state);
        if (marker === 91) {
          if (prevPos === state.pos - 1) level++;
          else if (disableNested) {
            state.pos = oldPos;
            return -1;
          }
        }
      }
      let labelEnd = -1;
      if (found) labelEnd = state.pos;
      state.pos = oldPos;
      return labelEnd;
    }
    function parseLinkDestination(str, start, max) {
      let code2;
      let pos = start;
      const result = {
        ok: false,
        pos: 0,
        str: ""
      };
      if (str.charCodeAt(pos) === 60) {
        pos++;
        while (pos < max) {
          code2 = str.charCodeAt(pos);
          if (code2 === 10) return result;
          if (code2 === 60) return result;
          if (code2 === 62) {
            result.pos = pos + 1;
            result.str = unescapeAll(str.slice(start + 1, pos));
            result.ok = true;
            return result;
          }
          if (code2 === 92 && pos + 1 < max) {
            pos += 2;
            continue;
          }
          pos++;
        }
        return result;
      }
      let level = 0;
      while (pos < max) {
        code2 = str.charCodeAt(pos);
        if (code2 === 32) break;
        if (code2 < 32 || code2 === 127) break;
        if (code2 === 92 && pos + 1 < max) {
          if (str.charCodeAt(pos + 1) === 32) {
            pos++;
            continue;
          }
          pos += 2;
          continue;
        }
        if (code2 === 40) {
          level++;
          if (level > 32) return result;
        }
        if (code2 === 41) {
          if (level === 0) break;
          level--;
        }
        pos++;
      }
      if (start === pos) return result;
      if (level !== 0) return result;
      result.str = unescapeAll(str.slice(start, pos));
      result.pos = pos;
      result.ok = true;
      return result;
    }
    function parseLinkTitle(str, start, max, prev_state) {
      let code2;
      let pos = start;
      const state = {
        ok: false,
        can_continue: false,
        pos: 0,
        str: "",
        marker: 0
      };
      if (prev_state) {
        state.str = prev_state.str;
        state.marker = prev_state.marker;
      } else {
        if (pos >= max) return state;
        let marker = str.charCodeAt(pos);
        if (marker !== 34 && marker !== 39 && marker !== 40) return state;
        start++;
        pos++;
        if (marker === 40) marker = 41;
        state.marker = marker;
      }
      while (pos < max) {
        code2 = str.charCodeAt(pos);
        if (code2 === state.marker) {
          state.pos = pos + 1;
          state.str += unescapeAll(str.slice(start, pos));
          state.ok = true;
          return state;
        } else if (code2 === 40 && state.marker === 41) return state;
        else if (code2 === 92 && pos + 1 < max) pos++;
        pos++;
      }
      state.can_continue = true;
      state.str += unescapeAll(str.slice(start, pos));
      return state;
    }
    var helpers_exports = /* @__PURE__ */ __exportAll({
      parseLinkDestination: () => parseLinkDestination,
      parseLinkLabel: () => parseLinkLabel,
      parseLinkTitle: () => parseLinkTitle
    });
    var default_rules = {};
    default_rules.code_inline = function(tokens, idx, options, env, slf) {
      const token = tokens[idx];
      return "<code" + slf.renderAttrs(token) + ">" + escapeHtml(token.content) + "</code>";
    };
    default_rules.code_block = function(tokens, idx, options, env, slf) {
      const token = tokens[idx];
      return "<pre" + slf.renderAttrs(token) + "><code>" + escapeHtml(tokens[idx].content) + "</code></pre>\n";
    };
    default_rules.fence = function(tokens, idx, options, env, slf) {
      const token = tokens[idx];
      const info = token.info ? unescapeAll(token.info).trim() : "";
      let langName = "";
      let langAttrs = "";
      if (info) {
        const arr = info.split(/(\s+)/g);
        langName = arr[0];
        langAttrs = arr.slice(2).join("");
      }
      let highlighted;
      if (options.highlight) highlighted = options.highlight(token.content, langName, langAttrs) || escapeHtml(token.content);
      else highlighted = escapeHtml(token.content);
      if (highlighted.indexOf("<pre") === 0) return highlighted + "\n";
      if (info) {
        const i = token.attrIndex("class");
        const tmpAttrs = token.attrs ? token.attrs.slice() : [];
        if (i < 0) tmpAttrs.push(["class", options.langPrefix + langName]);
        else {
          tmpAttrs[i] = tmpAttrs[i].slice();
          tmpAttrs[i][1] += " " + options.langPrefix + langName;
        }
        const tmpToken = { attrs: tmpAttrs };
        return `<pre><code${slf.renderAttrs(tmpToken)}>${highlighted}</code></pre>
`;
      }
      return `<pre><code${slf.renderAttrs(token)}>${highlighted}</code></pre>
`;
    };
    default_rules.image = function(tokens, idx, options, env, slf) {
      const token = tokens[idx];
      token.attrs[token.attrIndex("alt")][1] = slf.renderInlineAsText(token.children, options, env);
      return slf.renderToken(tokens, idx, options);
    };
    default_rules.hardbreak = function(tokens, idx, options) {
      return options.xhtmlOut ? "<br />\n" : "<br>\n";
    };
    default_rules.softbreak = function(tokens, idx, options) {
      return options.breaks ? options.xhtmlOut ? "<br />\n" : "<br>\n" : "\n";
    };
    default_rules.text = function(tokens, idx) {
      return escapeHtml(tokens[idx].content);
    };
    default_rules.html_block = function(tokens, idx) {
      return tokens[idx].content;
    };
    default_rules.html_inline = function(tokens, idx) {
      return tokens[idx].content;
    };
    function Renderer() {
      this.rules = assign({}, default_rules);
    }
    Renderer.prototype.renderAttrs = function renderAttrs(token) {
      let i, l, result;
      if (!token.attrs) return "";
      result = "";
      for (i = 0, l = token.attrs.length; i < l; i++) result += " " + escapeHtml(token.attrs[i][0]) + '="' + escapeHtml(token.attrs[i][1]) + '"';
      return result;
    };
    Renderer.prototype.renderToken = function renderToken(tokens, idx, options) {
      const token = tokens[idx];
      let result = "";
      if (token.hidden) return "";
      if (token.block && token.nesting !== -1 && idx && tokens[idx - 1].hidden) result += "\n";
      result += (token.nesting === -1 ? "</" : "<") + token.tag;
      result += this.renderAttrs(token);
      if (token.nesting === 0 && options.xhtmlOut) result += " /";
      let needLf = false;
      if (token.block) {
        needLf = true;
        if (token.nesting === 1) {
          if (idx + 1 < tokens.length) {
            const nextToken = tokens[idx + 1];
            if (nextToken.type === "inline" || nextToken.hidden) needLf = false;
            else if (nextToken.nesting === -1 && nextToken.tag === token.tag) needLf = false;
          }
        }
      }
      result += needLf ? ">\n" : ">";
      return result;
    };
    Renderer.prototype.renderInline = function(tokens, options, env) {
      let result = "";
      const rules = this.rules;
      for (let i = 0, len = tokens.length; i < len; i++) {
        const type = tokens[i].type;
        if (typeof rules[type] !== "undefined") result += rules[type](tokens, i, options, env, this);
        else result += this.renderToken(tokens, i, options);
      }
      return result;
    };
    Renderer.prototype.renderInlineAsText = function(tokens, options, env) {
      let result = "";
      for (let i = 0, len = tokens.length; i < len; i++) switch (tokens[i].type) {
        case "text":
          result += tokens[i].content;
          break;
        case "image":
          result += this.renderInlineAsText(tokens[i].children, options, env);
          break;
        case "html_inline":
        case "html_block":
          result += tokens[i].content;
          break;
        case "softbreak":
        case "hardbreak":
          result += "\n";
          break;
        default:
      }
      return result;
    };
    Renderer.prototype.render = function(tokens, options, env) {
      let result = "";
      const rules = this.rules;
      for (let i = 0, len = tokens.length; i < len; i++) {
        const type = tokens[i].type;
        if (type === "inline") result += this.renderInline(tokens[i].children, options, env);
        else if (typeof rules[type] !== "undefined") result += rules[type](tokens, i, options, env, this);
        else result += this.renderToken(tokens, i, options, env);
      }
      return result;
    };
    function Ruler() {
      this.__rules__ = [];
      this.__cache__ = null;
    }
    Ruler.prototype.__find__ = function(name) {
      for (let i = 0; i < this.__rules__.length; i++) if (this.__rules__[i].name === name) return i;
      return -1;
    };
    Ruler.prototype.__compile__ = function() {
      const self = this;
      const chains = [""];
      self.__rules__.forEach(function(rule) {
        if (!rule.enabled) return;
        rule.alt.forEach(function(altName) {
          if (chains.indexOf(altName) < 0) chains.push(altName);
        });
      });
      self.__cache__ = {};
      chains.forEach(function(chain) {
        self.__cache__[chain] = [];
        self.__rules__.forEach(function(rule) {
          if (!rule.enabled) return;
          if (chain && rule.alt.indexOf(chain) < 0) return;
          self.__cache__[chain].push(rule.fn);
        });
      });
    };
    Ruler.prototype.at = function(name, fn, options) {
      const index = this.__find__(name);
      const opt = options || {};
      if (index === -1) throw new Error("Parser rule not found: " + name);
      this.__rules__[index].fn = fn;
      this.__rules__[index].alt = opt.alt || [];
      this.__cache__ = null;
    };
    Ruler.prototype.before = function(beforeName, ruleName, fn, options) {
      const index = this.__find__(beforeName);
      const opt = options || {};
      if (index === -1) throw new Error("Parser rule not found: " + beforeName);
      this.__rules__.splice(index, 0, {
        name: ruleName,
        enabled: true,
        fn,
        alt: opt.alt || []
      });
      this.__cache__ = null;
    };
    Ruler.prototype.after = function(afterName, ruleName, fn, options) {
      const index = this.__find__(afterName);
      const opt = options || {};
      if (index === -1) throw new Error("Parser rule not found: " + afterName);
      this.__rules__.splice(index + 1, 0, {
        name: ruleName,
        enabled: true,
        fn,
        alt: opt.alt || []
      });
      this.__cache__ = null;
    };
    Ruler.prototype.push = function(ruleName, fn, options) {
      const opt = options || {};
      this.__rules__.push({
        name: ruleName,
        enabled: true,
        fn,
        alt: opt.alt || []
      });
      this.__cache__ = null;
    };
    Ruler.prototype.enable = function(list2, ignoreInvalid) {
      if (!Array.isArray(list2)) list2 = [list2];
      const result = [];
      list2.forEach(function(name) {
        const idx = this.__find__(name);
        if (idx < 0) {
          if (ignoreInvalid) return;
          throw new Error("Rules manager: invalid rule name " + name);
        }
        this.__rules__[idx].enabled = true;
        result.push(name);
      }, this);
      this.__cache__ = null;
      return result;
    };
    Ruler.prototype.enableOnly = function(list2, ignoreInvalid) {
      if (!Array.isArray(list2)) list2 = [list2];
      this.__rules__.forEach(function(rule) {
        rule.enabled = false;
      });
      this.enable(list2, ignoreInvalid);
    };
    Ruler.prototype.disable = function(list2, ignoreInvalid) {
      if (!Array.isArray(list2)) list2 = [list2];
      const result = [];
      list2.forEach(function(name) {
        const idx = this.__find__(name);
        if (idx < 0) {
          if (ignoreInvalid) return;
          throw new Error("Rules manager: invalid rule name " + name);
        }
        this.__rules__[idx].enabled = false;
        result.push(name);
      }, this);
      this.__cache__ = null;
      return result;
    };
    Ruler.prototype.getRules = function(chainName) {
      if (this.__cache__ === null) this.__compile__();
      return this.__cache__[chainName] || [];
    };
    function Token(type, tag, nesting) {
      this.type = type;
      this.tag = tag;
      this.attrs = null;
      this.map = null;
      this.nesting = nesting;
      this.level = 0;
      this.children = null;
      this.content = "";
      this.markup = "";
      this.info = "";
      this.meta = null;
      this.block = false;
      this.hidden = false;
    }
    Token.prototype.attrIndex = function attrIndex(name) {
      if (!this.attrs) return -1;
      const attrs = this.attrs;
      for (let i = 0, len = attrs.length; i < len; i++) if (attrs[i][0] === name) return i;
      return -1;
    };
    Token.prototype.attrPush = function attrPush(attrData) {
      if (this.attrs) this.attrs.push(attrData);
      else this.attrs = [attrData];
    };
    Token.prototype.attrSet = function attrSet(name, value) {
      const idx = this.attrIndex(name);
      const attrData = [name, value];
      if (idx < 0) this.attrPush(attrData);
      else this.attrs[idx] = attrData;
    };
    Token.prototype.attrGet = function attrGet(name) {
      const idx = this.attrIndex(name);
      let value = null;
      if (idx >= 0) value = this.attrs[idx][1];
      return value;
    };
    Token.prototype.attrJoin = function attrJoin(name, value) {
      const idx = this.attrIndex(name);
      if (idx < 0) this.attrPush([name, value]);
      else this.attrs[idx][1] = this.attrs[idx][1] + " " + value;
    };
    function StateCore(src, md, env) {
      this.src = src;
      this.env = env;
      this.tokens = [];
      this.inlineMode = false;
      this.md = md;
    }
    StateCore.prototype.Token = Token;
    var NEWLINES_RE = /\r\n?|\n/g;
    var NULL_RE = /\0/g;
    function normalize(state) {
      let str;
      str = state.src.replace(NEWLINES_RE, "\n");
      str = str.replace(NULL_RE, "\uFFFD");
      state.src = str;
    }
    function block(state) {
      let token;
      if (state.inlineMode) {
        token = new state.Token("inline", "", 0);
        token.content = state.src;
        token.map = [0, 1];
        token.children = [];
        state.tokens.push(token);
      } else state.md.block.parse(state.src, state.md, state.env, state.tokens);
    }
    function inline(state) {
      const tokens = state.tokens;
      for (let i = 0, l = tokens.length; i < l; i++) {
        const tok = tokens[i];
        if (tok.type === "inline") state.md.inline.parse(tok.content, state.md, state.env, tok.children);
      }
    }
    function isLinkOpen$1(str) {
      return /^<a[>\s]/i.test(str);
    }
    function isLinkClose$1(str) {
      return /^<\/a\s*>/i.test(str);
    }
    function linkify$1(state) {
      const blockTokens = state.tokens;
      if (!state.md.options.linkify) return;
      for (let j = 0, l = blockTokens.length; j < l; j++) {
        if (blockTokens[j].type !== "inline" || !state.md.linkify.pretest(blockTokens[j].content)) continue;
        const tokens = blockTokens[j].children;
        const replacements = [];
        let htmlLinkLevel = 0;
        for (let i = tokens.length - 1; i >= 0; i--) {
          const currentToken = tokens[i];
          if (currentToken.type === "link_close") {
            i--;
            while (tokens[i].level !== currentToken.level && tokens[i].type !== "link_open") i--;
            continue;
          }
          if (currentToken.type === "html_inline") {
            if (isLinkOpen$1(currentToken.content) && htmlLinkLevel > 0) htmlLinkLevel--;
            if (isLinkClose$1(currentToken.content)) htmlLinkLevel++;
          }
          if (htmlLinkLevel > 0) continue;
          if (currentToken.type === "text" && state.md.linkify.test(currentToken.content)) {
            const text2 = currentToken.content;
            let links = state.md.linkify.match(text2);
            const nodes = [];
            let level = currentToken.level;
            let lastPos = 0;
            if (links.length > 0 && links[0].index === 0 && i > 0 && tokens[i - 1].type === "text_special") links = links.slice(1);
            for (let ln = 0; ln < links.length; ln++) {
              const url = links[ln].url;
              const fullUrl = state.md.normalizeLink(url);
              if (!state.md.validateLink(fullUrl)) continue;
              let urlText = links[ln].text;
              if (!links[ln].schema) urlText = state.md.normalizeLinkText("http://" + urlText).replace(/^http:\/\//, "");
              else if (links[ln].schema === "mailto:" && !/^mailto:/i.test(urlText)) urlText = state.md.normalizeLinkText("mailto:" + urlText).replace(/^mailto:/, "");
              else urlText = state.md.normalizeLinkText(urlText);
              const pos = links[ln].index;
              if (pos > lastPos) {
                const token = new state.Token("text", "", 0);
                token.content = text2.slice(lastPos, pos);
                token.level = level;
                nodes.push(token);
              }
              const token_o = new state.Token("link_open", "a", 1);
              token_o.attrs = [["href", fullUrl]];
              token_o.level = level++;
              token_o.markup = "linkify";
              token_o.info = "auto";
              nodes.push(token_o);
              const token_t = new state.Token("text", "", 0);
              token_t.content = urlText;
              token_t.level = level;
              nodes.push(token_t);
              const token_c = new state.Token("link_close", "a", -1);
              token_c.level = --level;
              token_c.markup = "linkify";
              token_c.info = "auto";
              nodes.push(token_c);
              lastPos = links[ln].lastIndex;
            }
            if (lastPos < text2.length) {
              const token = new state.Token("text", "", 0);
              token.content = text2.slice(lastPos);
              token.level = level;
              nodes.push(token);
            }
            replacements.push({
              index: i,
              nodes
            });
          }
        }
        if (replacements.length > 0) {
          let newTokensLength = tokens.length;
          for (const replacement of replacements) newTokensLength += replacement.nodes.length - 1;
          const newTokens = new Array(newTokensLength);
          let replacementIndex = 0;
          let newTokenIndex = 0;
          replacements.reverse();
          for (let i = 0; i < tokens.length; i++) {
            const replacement = replacements[replacementIndex];
            if ((replacement === null || replacement === void 0 ? void 0 : replacement.index) === i) {
              for (const node of replacement.nodes) newTokens[newTokenIndex++] = node;
              replacementIndex++;
            } else newTokens[newTokenIndex++] = tokens[i];
          }
          blockTokens[j].children = newTokens;
        }
      }
    }
    var RARE_RE = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/;
    var SCOPED_ABBR_TEST_RE = /\((c|tm|r)\)/i;
    var SCOPED_ABBR_RE = /\((c|tm|r)\)/gi;
    var SCOPED_ABBR = {
      c: "\xA9",
      r: "\xAE",
      tm: "\u2122"
    };
    function replaceFn(match, name) {
      return SCOPED_ABBR[name.toLowerCase()];
    }
    function replace_scoped(inlineTokens) {
      let inside_autolink = 0;
      for (let i = inlineTokens.length - 1; i >= 0; i--) {
        const token = inlineTokens[i];
        if (token.type === "text" && !inside_autolink) token.content = token.content.replace(SCOPED_ABBR_RE, replaceFn);
        if (token.type === "link_open" && token.info === "auto") inside_autolink--;
        if (token.type === "link_close" && token.info === "auto") inside_autolink++;
      }
    }
    function replace_rare(inlineTokens) {
      let inside_autolink = 0;
      for (let i = inlineTokens.length - 1; i >= 0; i--) {
        const token = inlineTokens[i];
        if (token.type === "text" && !inside_autolink) {
          if (RARE_RE.test(token.content)) token.content = token.content.replace(/\+-/g, "\xB1").replace(/\.{2,}/g, "\u2026").replace(/([?!])…/g, "$1..").replace(/([?!]){4,}/g, "$1$1$1").replace(/,{2,}/g, ",").replace(/(^|[^-])---(?=[^-]|$)/gm, "$1\u2014").replace(/(^|\s)--(?=\s|$)/gm, "$1\u2013").replace(/(^|[^-\s])--(?=[^-\s]|$)/gm, "$1\u2013");
        }
        if (token.type === "link_open" && token.info === "auto") inside_autolink--;
        if (token.type === "link_close" && token.info === "auto") inside_autolink++;
      }
    }
    function replace(state) {
      let blkIdx;
      if (!state.md.options.typographer) return;
      for (blkIdx = state.tokens.length - 1; blkIdx >= 0; blkIdx--) {
        if (state.tokens[blkIdx].type !== "inline") continue;
        if (SCOPED_ABBR_TEST_RE.test(state.tokens[blkIdx].content)) replace_scoped(state.tokens[blkIdx].children);
        if (RARE_RE.test(state.tokens[blkIdx].content)) replace_rare(state.tokens[blkIdx].children);
      }
    }
    var QUOTE_TEST_RE = /['"]/;
    var QUOTE_RE = /['"]/g;
    var APOSTROPHE = "\u2019";
    var MAX_OPENERS = 1e3;
    function truncateStack(stack, heads, length) {
      while (stack.length > length) {
        const item = stack.pop();
        if (item.isSingleQuote) heads.single = item.prevSameQuoteIdx;
        else heads.double = item.prevSameQuoteIdx;
      }
    }
    function addReplacement(replacements, tokenIdx, pos, ch) {
      if (!replacements[tokenIdx]) replacements[tokenIdx] = [];
      replacements[tokenIdx].push({
        pos,
        ch
      });
    }
    function applyReplacements(str, replacements) {
      let result = "";
      let lastPos = 0;
      replacements.sort((a, b) => a.pos - b.pos);
      for (let i = 0; i < replacements.length; i++) {
        const replacement = replacements[i];
        result += str.slice(lastPos, replacement.pos) + replacement.ch;
        lastPos = replacement.pos + 1;
      }
      return result + str.slice(lastPos);
    }
    function process_inlines(tokens, state) {
      let j;
      const stack = [];
      const heads = {
        single: -1,
        double: -1
      };
      const replacements = {};
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const thisLevel = tokens[i].level;
        for (j = stack.length - 1; j >= 0; j--) if (stack[j].level <= thisLevel) break;
        truncateStack(stack, heads, j + 1);
        if (token.type !== "text") continue;
        const text2 = token.content;
        let pos = 0;
        const max = text2.length;
        OUTER: while (pos < max) {
          QUOTE_RE.lastIndex = pos;
          const t = QUOTE_RE.exec(text2);
          if (!t) break;
          let canOpen = true;
          let canClose = true;
          pos = t.index + 1;
          const isSingle = t[0] === "'";
          let lastChar = 32;
          if (t.index - 1 >= 0) lastChar = text2.charCodeAt(t.index - 1);
          else for (j = i - 1; j >= 0; j--) {
            if (tokens[j].type === "softbreak" || tokens[j].type === "hardbreak") break;
            if (!tokens[j].content) continue;
            lastChar = tokens[j].content.charCodeAt(tokens[j].content.length - 1);
            break;
          }
          let nextChar = 32;
          if (pos < max) nextChar = text2.charCodeAt(pos);
          else for (j = i + 1; j < tokens.length; j++) {
            if (tokens[j].type === "softbreak" || tokens[j].type === "hardbreak") break;
            if (!tokens[j].content) continue;
            nextChar = tokens[j].content.charCodeAt(0);
            break;
          }
          const isLastPunctChar = isMdAsciiPunct(lastChar) || isPunctCharCode(lastChar);
          const isNextPunctChar = isMdAsciiPunct(nextChar) || isPunctCharCode(nextChar);
          const isLastWhiteSpace = isWhiteSpace(lastChar);
          const isNextWhiteSpace = isWhiteSpace(nextChar);
          if (isNextWhiteSpace) canOpen = false;
          else if (isNextPunctChar) {
            if (!(isLastWhiteSpace || isLastPunctChar)) canOpen = false;
          }
          if (isLastWhiteSpace) canClose = false;
          else if (isLastPunctChar) {
            if (!(isNextWhiteSpace || isNextPunctChar)) canClose = false;
          }
          if (nextChar === 34 && t[0] === '"') {
            if (lastChar >= 48 && lastChar <= 57) canClose = canOpen = false;
          }
          if (canOpen && canClose) {
            canOpen = isLastPunctChar;
            canClose = isNextPunctChar;
          }
          if (!canOpen && !canClose) {
            if (isSingle) addReplacement(replacements, i, t.index, APOSTROPHE);
            continue;
          }
          if (canClose) {
            j = isSingle ? heads.single : heads.double;
            if (j >= 0 && stack[j].level === thisLevel) {
              const item = stack[j];
              let openQuote;
              let closeQuote;
              if (isSingle) {
                openQuote = state.md.options.quotes[2];
                closeQuote = state.md.options.quotes[3];
              } else {
                openQuote = state.md.options.quotes[0];
                closeQuote = state.md.options.quotes[1];
              }
              addReplacement(replacements, i, t.index, closeQuote);
              addReplacement(replacements, item.tokenIdx, item.contentPos, openQuote);
              truncateStack(stack, heads, j);
              continue OUTER;
            }
          }
          if (canOpen) {
            if (stack.length >= MAX_OPENERS) return;
            stack.push({
              tokenIdx: i,
              contentPos: t.index,
              isSingleQuote: isSingle,
              level: thisLevel,
              prevSameQuoteIdx: isSingle ? heads.single : heads.double
            });
            if (isSingle) heads.single = stack.length - 1;
            else heads.double = stack.length - 1;
          } else if (canClose && isSingle) addReplacement(replacements, i, t.index, APOSTROPHE);
        }
      }
      Object.keys(replacements).forEach(function(tokenIdx) {
        tokens[tokenIdx].content = applyReplacements(tokens[tokenIdx].content, replacements[tokenIdx]);
      });
    }
    function smartquotes(state) {
      if (!state.md.options.typographer) return;
      for (let blkIdx = state.tokens.length - 1; blkIdx >= 0; blkIdx--) {
        if (state.tokens[blkIdx].type !== "inline" || !QUOTE_TEST_RE.test(state.tokens[blkIdx].content)) continue;
        process_inlines(state.tokens[blkIdx].children, state);
      }
    }
    function text_join(state) {
      let curr, last;
      const blockTokens = state.tokens;
      const l = blockTokens.length;
      for (let j = 0; j < l; j++) {
        if (blockTokens[j].type !== "inline") continue;
        const tokens = blockTokens[j].children;
        const max = tokens.length;
        for (curr = 0; curr < max; curr++) if (tokens[curr].type === "text_special") tokens[curr].type = "text";
        for (curr = last = 0; curr < max; curr++) if (tokens[curr].type === "text" && curr + 1 < max && tokens[curr + 1].type === "text") tokens[curr + 1].content = tokens[curr].content + tokens[curr + 1].content;
        else {
          if (curr !== last) tokens[last] = tokens[curr];
          last++;
        }
        if (curr !== last) tokens.length = last;
      }
    }
    var _rules$2 = [
      ["normalize", normalize],
      ["block", block],
      ["inline", inline],
      ["linkify", linkify$1],
      ["replacements", replace],
      ["smartquotes", smartquotes],
      ["text_join", text_join]
    ];
    function Core() {
      this.ruler = new Ruler();
      for (let i = 0; i < _rules$2.length; i++) this.ruler.push(_rules$2[i][0], _rules$2[i][1]);
    }
    Core.prototype.process = function(state) {
      const rules = this.ruler.getRules("");
      for (let i = 0, l = rules.length; i < l; i++) rules[i](state);
    };
    Core.prototype.State = StateCore;
    function StateBlock(src, md, env, tokens) {
      this.src = src;
      this.md = md;
      this.env = env;
      this.tokens = tokens;
      this.bMarks = [];
      this.eMarks = [];
      this.tShift = [];
      this.sCount = [];
      this.bsCount = [];
      this.blkIndent = 0;
      this.line = 0;
      this.lineMax = 0;
      this.tight = false;
      this.ddIndent = -1;
      this.listIndent = -1;
      this.parentType = "root";
      this.level = 0;
      const s = this.src;
      for (let start = 0, pos = 0, indent = 0, offset = 0, len = s.length, indent_found = false; pos < len; pos++) {
        const ch = s.charCodeAt(pos);
        if (!indent_found) if (isSpace(ch)) {
          indent++;
          if (ch === 9) offset += 4 - offset % 4;
          else offset++;
          continue;
        } else indent_found = true;
        if (ch === 10 || pos === len - 1) {
          if (ch !== 10) pos++;
          this.bMarks.push(start);
          this.eMarks.push(pos);
          this.tShift.push(indent);
          this.sCount.push(offset);
          this.bsCount.push(0);
          indent_found = false;
          indent = 0;
          offset = 0;
          start = pos + 1;
        }
      }
      this.bMarks.push(s.length);
      this.eMarks.push(s.length);
      this.tShift.push(0);
      this.sCount.push(0);
      this.bsCount.push(0);
      this.lineMax = this.bMarks.length - 1;
    }
    StateBlock.prototype.push = function(type, tag, nesting) {
      const token = new Token(type, tag, nesting);
      token.block = true;
      if (nesting < 0) this.level--;
      token.level = this.level;
      if (nesting > 0) this.level++;
      this.tokens.push(token);
      return token;
    };
    StateBlock.prototype.isEmpty = function isEmpty(line) {
      return this.bMarks[line] + this.tShift[line] >= this.eMarks[line];
    };
    StateBlock.prototype.skipEmptyLines = function skipEmptyLines(from) {
      for (let max = this.lineMax; from < max; from++) if (this.bMarks[from] + this.tShift[from] < this.eMarks[from]) break;
      return from;
    };
    StateBlock.prototype.skipSpaces = function skipSpaces(pos) {
      for (let max = this.src.length; pos < max; pos++) if (!isSpace(this.src.charCodeAt(pos))) break;
      return pos;
    };
    StateBlock.prototype.skipSpacesBack = function skipSpacesBack(pos, min) {
      if (pos <= min) return pos;
      while (pos > min) if (!isSpace(this.src.charCodeAt(--pos))) return pos + 1;
      return pos;
    };
    StateBlock.prototype.skipChars = function skipChars(pos, code2) {
      for (let max = this.src.length; pos < max; pos++) if (this.src.charCodeAt(pos) !== code2) break;
      return pos;
    };
    StateBlock.prototype.skipCharsBack = function skipCharsBack(pos, code2, min) {
      if (pos <= min) return pos;
      while (pos > min) if (code2 !== this.src.charCodeAt(--pos)) return pos + 1;
      return pos;
    };
    StateBlock.prototype.getLines = function getLines(begin, end, indent, keepLastLF) {
      if (begin >= end) return "";
      const queue = new Array(end - begin);
      for (let i = 0, line = begin; line < end; line++, i++) {
        let lineIndent = 0;
        const lineStart = this.bMarks[line];
        let first = lineStart;
        let last;
        if (line + 1 < end || keepLastLF) last = this.eMarks[line] + 1;
        else last = this.eMarks[line];
        while (first < last && lineIndent < indent) {
          const ch = this.src.charCodeAt(first);
          if (isSpace(ch)) if (ch === 9) lineIndent += 4 - (lineIndent + this.bsCount[line]) % 4;
          else lineIndent++;
          else if (first - lineStart < this.tShift[line]) lineIndent++;
          else break;
          first++;
        }
        if (lineIndent > indent) queue[i] = new Array(lineIndent - indent + 1).join(" ") + this.src.slice(first, last);
        else queue[i] = this.src.slice(first, last);
      }
      return queue.join("");
    };
    StateBlock.prototype.Token = Token;
    var MAX_AUTOCOMPLETED_CELLS = 65536;
    function getLine(state, line) {
      const pos = state.bMarks[line] + state.tShift[line];
      const max = state.eMarks[line];
      return state.src.slice(pos, max);
    }
    function escapedSplit(str) {
      const result = [];
      const max = str.length;
      let pos = 0;
      let ch = str.charCodeAt(pos);
      let isEscaped = false;
      let lastPos = 0;
      let current = "";
      while (pos < max) {
        if (ch === 124) if (!isEscaped) {
          result.push(current + str.substring(lastPos, pos));
          current = "";
          lastPos = pos + 1;
        } else {
          current += str.substring(lastPos, pos - 1);
          lastPos = pos;
        }
        isEscaped = ch === 92;
        pos++;
        ch = str.charCodeAt(pos);
      }
      result.push(current + str.substring(lastPos));
      return result;
    }
    function table(state, startLine, endLine, silent) {
      if (startLine + 2 > endLine) return false;
      let nextLine = startLine + 1;
      if (state.sCount[nextLine] < state.blkIndent) return false;
      if (state.sCount[nextLine] - state.blkIndent >= 4) return false;
      let pos = state.bMarks[nextLine] + state.tShift[nextLine];
      if (pos >= state.eMarks[nextLine]) return false;
      const firstCh = state.src.charCodeAt(pos++);
      if (firstCh !== 124 && firstCh !== 45 && firstCh !== 58) return false;
      if (pos >= state.eMarks[nextLine]) return false;
      const secondCh = state.src.charCodeAt(pos++);
      if (secondCh !== 124 && secondCh !== 45 && secondCh !== 58 && !isSpace(secondCh)) return false;
      if (firstCh === 45 && isSpace(secondCh)) return false;
      while (pos < state.eMarks[nextLine]) {
        const ch = state.src.charCodeAt(pos);
        if (ch !== 124 && ch !== 45 && ch !== 58 && !isSpace(ch)) return false;
        pos++;
      }
      let lineText = getLine(state, startLine + 1);
      let columns = lineText.split("|");
      const aligns = [];
      for (let i = 0; i < columns.length; i++) {
        const t = columns[i].trim();
        if (!t) if (i === 0 || i === columns.length - 1) continue;
        else return false;
        if (!/^:?-+:?$/.test(t)) return false;
        if (t.charCodeAt(t.length - 1) === 58) aligns.push(t.charCodeAt(0) === 58 ? "center" : "right");
        else if (t.charCodeAt(0) === 58) aligns.push("left");
        else aligns.push("");
      }
      lineText = getLine(state, startLine).trim();
      if (lineText.indexOf("|") === -1) return false;
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      columns = escapedSplit(lineText);
      if (columns.length && columns[0] === "") columns.shift();
      if (columns.length && columns[columns.length - 1] === "") columns.pop();
      const columnCount = columns.length;
      if (columnCount === 0 || columnCount !== aligns.length) return false;
      if (silent) return true;
      const oldParentType = state.parentType;
      state.parentType = "table";
      const terminatorRules = state.md.block.ruler.getRules("blockquote");
      const token_to = state.push("table_open", "table", 1);
      const tableLines = [startLine, 0];
      token_to.map = tableLines;
      const token_tho = state.push("thead_open", "thead", 1);
      token_tho.map = [startLine, startLine + 1];
      const token_htro = state.push("tr_open", "tr", 1);
      token_htro.map = [startLine, startLine + 1];
      for (let i = 0; i < columns.length; i++) {
        const token_ho = state.push("th_open", "th", 1);
        if (aligns[i]) token_ho.attrs = [["style", "text-align:" + aligns[i]]];
        const token_il = state.push("inline", "", 0);
        token_il.content = columns[i].trim();
        token_il.children = [];
        state.push("th_close", "th", -1);
      }
      state.push("tr_close", "tr", -1);
      state.push("thead_close", "thead", -1);
      let tbodyLines;
      let autocompletedCells = 0;
      for (nextLine = startLine + 2; nextLine < endLine; nextLine++) {
        if (state.sCount[nextLine] < state.blkIndent) break;
        let terminate = false;
        for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
          terminate = true;
          break;
        }
        if (terminate) break;
        lineText = getLine(state, nextLine).trim();
        if (!lineText) break;
        if (state.sCount[nextLine] - state.blkIndent >= 4) break;
        columns = escapedSplit(lineText);
        if (columns.length && columns[0] === "") columns.shift();
        if (columns.length && columns[columns.length - 1] === "") columns.pop();
        autocompletedCells += columnCount - columns.length;
        if (autocompletedCells > MAX_AUTOCOMPLETED_CELLS) break;
        if (nextLine === startLine + 2) {
          const token_tbo = state.push("tbody_open", "tbody", 1);
          token_tbo.map = tbodyLines = [startLine + 2, 0];
        }
        const token_tro = state.push("tr_open", "tr", 1);
        token_tro.map = [nextLine, nextLine + 1];
        for (let i = 0; i < columnCount; i++) {
          const token_tdo = state.push("td_open", "td", 1);
          if (aligns[i]) token_tdo.attrs = [["style", "text-align:" + aligns[i]]];
          const token_il = state.push("inline", "", 0);
          token_il.content = columns[i] ? columns[i].trim() : "";
          token_il.children = [];
          state.push("td_close", "td", -1);
        }
        state.push("tr_close", "tr", -1);
      }
      if (tbodyLines) {
        state.push("tbody_close", "tbody", -1);
        tbodyLines[1] = nextLine;
      }
      state.push("table_close", "table", -1);
      tableLines[1] = nextLine;
      state.parentType = oldParentType;
      state.line = nextLine;
      return true;
    }
    function code(state, startLine, endLine) {
      if (state.sCount[startLine] - state.blkIndent < 4) return false;
      let nextLine = startLine + 1;
      let last = nextLine;
      while (nextLine < endLine) {
        if (state.isEmpty(nextLine)) {
          nextLine++;
          continue;
        }
        if (state.sCount[nextLine] - state.blkIndent >= 4) {
          nextLine++;
          last = nextLine;
          continue;
        }
        break;
      }
      state.line = last;
      const token = state.push("code_block", "code", 0);
      token.content = state.getLines(startLine, last, 4 + state.blkIndent, false) + "\n";
      token.map = [startLine, state.line];
      return true;
    }
    function fence(state, startLine, endLine, silent) {
      let pos = state.bMarks[startLine] + state.tShift[startLine];
      let max = state.eMarks[startLine];
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      if (pos + 3 > max) return false;
      const marker = state.src.charCodeAt(pos);
      if (marker !== 126 && marker !== 96) return false;
      let mem = pos;
      pos = state.skipChars(pos, marker);
      let len = pos - mem;
      if (len < 3) return false;
      const markup = state.src.slice(mem, pos);
      const params = state.src.slice(pos, max);
      if (marker === 96) {
        if (params.indexOf(String.fromCharCode(marker)) >= 0) return false;
      }
      if (silent) return true;
      let nextLine = startLine;
      let haveEndMarker = false;
      for (; ; ) {
        nextLine++;
        if (nextLine >= endLine) break;
        pos = mem = state.bMarks[nextLine] + state.tShift[nextLine];
        max = state.eMarks[nextLine];
        if (pos < max && state.sCount[nextLine] < state.blkIndent) break;
        if (state.src.charCodeAt(pos) !== marker) continue;
        if (state.sCount[nextLine] - state.blkIndent >= 4) continue;
        pos = state.skipChars(pos, marker);
        if (pos - mem < len) continue;
        pos = state.skipSpaces(pos);
        if (pos < max) continue;
        haveEndMarker = true;
        break;
      }
      len = state.sCount[startLine];
      state.line = nextLine + (haveEndMarker ? 1 : 0);
      const token = state.push("fence", "code", 0);
      token.info = params;
      token.content = state.getLines(startLine + 1, nextLine, len, true);
      token.markup = markup;
      token.map = [startLine, state.line];
      return true;
    }
    function blockquote(state, startLine, endLine, silent) {
      let pos = state.bMarks[startLine] + state.tShift[startLine];
      let max = state.eMarks[startLine];
      const oldLineMax = state.lineMax;
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      if (state.src.charCodeAt(pos) !== 62) return false;
      if (silent) return true;
      const oldBMarks = [];
      const oldBSCount = [];
      const oldSCount = [];
      const oldTShift = [];
      const terminatorRules = state.md.block.ruler.getRules("blockquote");
      const oldParentType = state.parentType;
      state.parentType = "blockquote";
      let lastLineEmpty = false;
      let nextLine;
      for (nextLine = startLine; nextLine < endLine; nextLine++) {
        const isOutdented = state.sCount[nextLine] < state.blkIndent;
        pos = state.bMarks[nextLine] + state.tShift[nextLine];
        max = state.eMarks[nextLine];
        if (pos >= max) break;
        if (state.src.charCodeAt(pos++) === 62 && !isOutdented) {
          let initial = state.sCount[nextLine] + 1;
          let spaceAfterMarker;
          let adjustTab;
          if (state.src.charCodeAt(pos) === 32) {
            pos++;
            initial++;
            adjustTab = false;
            spaceAfterMarker = true;
          } else if (state.src.charCodeAt(pos) === 9) {
            spaceAfterMarker = true;
            if ((state.bsCount[nextLine] + initial) % 4 === 3) {
              pos++;
              initial++;
              adjustTab = false;
            } else adjustTab = true;
          } else spaceAfterMarker = false;
          let offset = initial;
          oldBMarks.push(state.bMarks[nextLine]);
          state.bMarks[nextLine] = pos;
          while (pos < max) {
            const ch = state.src.charCodeAt(pos);
            if (isSpace(ch)) if (ch === 9) offset += 4 - (offset + state.bsCount[nextLine] + (adjustTab ? 1 : 0)) % 4;
            else offset++;
            else break;
            pos++;
          }
          lastLineEmpty = pos >= max;
          oldBSCount.push(state.bsCount[nextLine]);
          state.bsCount[nextLine] = state.sCount[nextLine] + 1 + (spaceAfterMarker ? 1 : 0);
          oldSCount.push(state.sCount[nextLine]);
          state.sCount[nextLine] = offset - initial;
          oldTShift.push(state.tShift[nextLine]);
          state.tShift[nextLine] = pos - state.bMarks[nextLine];
          continue;
        }
        if (lastLineEmpty) break;
        let terminate = false;
        for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
          terminate = true;
          break;
        }
        if (terminate) {
          state.lineMax = nextLine;
          if (state.blkIndent !== 0) {
            oldBMarks.push(state.bMarks[nextLine]);
            oldBSCount.push(state.bsCount[nextLine]);
            oldTShift.push(state.tShift[nextLine]);
            oldSCount.push(state.sCount[nextLine]);
            state.sCount[nextLine] -= state.blkIndent;
          }
          break;
        }
        oldBMarks.push(state.bMarks[nextLine]);
        oldBSCount.push(state.bsCount[nextLine]);
        oldTShift.push(state.tShift[nextLine]);
        oldSCount.push(state.sCount[nextLine]);
        state.sCount[nextLine] = -1;
      }
      const oldIndent = state.blkIndent;
      state.blkIndent = 0;
      const token_o = state.push("blockquote_open", "blockquote", 1);
      token_o.markup = ">";
      const lines = [startLine, 0];
      token_o.map = lines;
      state.md.block.tokenize(state, startLine, nextLine);
      const token_c = state.push("blockquote_close", "blockquote", -1);
      token_c.markup = ">";
      state.lineMax = oldLineMax;
      state.parentType = oldParentType;
      lines[1] = state.line;
      for (let i = 0; i < oldTShift.length; i++) {
        state.bMarks[i + startLine] = oldBMarks[i];
        state.tShift[i + startLine] = oldTShift[i];
        state.sCount[i + startLine] = oldSCount[i];
        state.bsCount[i + startLine] = oldBSCount[i];
      }
      state.blkIndent = oldIndent;
      return true;
    }
    function hr(state, startLine, endLine, silent) {
      const max = state.eMarks[startLine];
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      let pos = state.bMarks[startLine] + state.tShift[startLine];
      const marker = state.src.charCodeAt(pos++);
      if (marker !== 42 && marker !== 45 && marker !== 95) return false;
      let cnt = 1;
      while (pos < max) {
        const ch = state.src.charCodeAt(pos++);
        if (ch !== marker && !isSpace(ch)) return false;
        if (ch === marker) cnt++;
      }
      if (cnt < 3) return false;
      if (silent) return true;
      state.line = startLine + 1;
      const token = state.push("hr", "hr", 0);
      token.map = [startLine, state.line];
      token.markup = Array(cnt + 1).join(String.fromCharCode(marker));
      return true;
    }
    function skipBulletListMarker(state, startLine) {
      const max = state.eMarks[startLine];
      let pos = state.bMarks[startLine] + state.tShift[startLine];
      const marker = state.src.charCodeAt(pos++);
      if (marker !== 42 && marker !== 45 && marker !== 43) return -1;
      if (pos < max) {
        if (!isSpace(state.src.charCodeAt(pos))) return -1;
      }
      return pos;
    }
    function skipOrderedListMarker(state, startLine) {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      let pos = start;
      if (pos + 1 >= max) return -1;
      let ch = state.src.charCodeAt(pos++);
      if (ch < 48 || ch > 57) return -1;
      for (; ; ) {
        if (pos >= max) return -1;
        ch = state.src.charCodeAt(pos++);
        if (ch >= 48 && ch <= 57) {
          if (pos - start >= 10) return -1;
          continue;
        }
        if (ch === 41 || ch === 46) break;
        return -1;
      }
      if (pos < max) {
        ch = state.src.charCodeAt(pos);
        if (!isSpace(ch)) return -1;
      }
      return pos;
    }
    function markTightParagraphs(state, idx) {
      const level = state.level + 2;
      for (let i = idx + 2, l = state.tokens.length - 2; i < l; i++) if (state.tokens[i].level === level && state.tokens[i].type === "paragraph_open") {
        state.tokens[i + 2].hidden = true;
        state.tokens[i].hidden = true;
        i += 2;
      }
    }
    function list(state, startLine, endLine, silent) {
      let max, pos, start, token;
      let nextLine = startLine;
      let tight = true;
      if (state.sCount[nextLine] - state.blkIndent >= 4) return false;
      if (state.listIndent >= 0 && state.sCount[nextLine] - state.listIndent >= 4 && state.sCount[nextLine] < state.blkIndent) return false;
      let isTerminatingParagraph = false;
      if (silent && state.parentType === "paragraph") {
        if (state.sCount[nextLine] >= state.blkIndent) isTerminatingParagraph = true;
      }
      let isOrdered;
      let markerValue;
      let posAfterMarker;
      if ((posAfterMarker = skipOrderedListMarker(state, nextLine)) >= 0) {
        isOrdered = true;
        start = state.bMarks[nextLine] + state.tShift[nextLine];
        markerValue = Number(state.src.slice(start, posAfterMarker - 1));
        if (isTerminatingParagraph && markerValue !== 1) return false;
      } else if ((posAfterMarker = skipBulletListMarker(state, nextLine)) >= 0) isOrdered = false;
      else return false;
      if (isTerminatingParagraph) {
        if (state.skipSpaces(posAfterMarker) >= state.eMarks[nextLine]) return false;
      }
      if (silent) return true;
      const markerCharCode = state.src.charCodeAt(posAfterMarker - 1);
      const listTokIdx = state.tokens.length;
      if (isOrdered) {
        token = state.push("ordered_list_open", "ol", 1);
        if (markerValue !== 1) token.attrs = [["start", markerValue]];
      } else token = state.push("bullet_list_open", "ul", 1);
      const listLines = [nextLine, 0];
      token.map = listLines;
      token.markup = String.fromCharCode(markerCharCode);
      let prevEmptyEnd = false;
      const terminatorRules = state.md.block.ruler.getRules("list");
      const oldParentType = state.parentType;
      state.parentType = "list";
      while (nextLine < endLine) {
        pos = posAfterMarker;
        max = state.eMarks[nextLine];
        const initial = state.sCount[nextLine] + posAfterMarker - (state.bMarks[nextLine] + state.tShift[nextLine]);
        let offset = initial;
        while (pos < max) {
          const ch = state.src.charCodeAt(pos);
          if (ch === 9) offset += 4 - (offset + state.bsCount[nextLine]) % 4;
          else if (ch === 32) offset++;
          else break;
          pos++;
        }
        const contentStart = pos;
        let indentAfterMarker;
        if (contentStart >= max) indentAfterMarker = 1;
        else indentAfterMarker = offset - initial;
        if (indentAfterMarker > 4) indentAfterMarker = 1;
        const indent = initial + indentAfterMarker;
        token = state.push("list_item_open", "li", 1);
        token.markup = String.fromCharCode(markerCharCode);
        const itemLines = [nextLine, 0];
        token.map = itemLines;
        if (isOrdered) token.info = state.src.slice(start, posAfterMarker - 1);
        const oldTight = state.tight;
        const oldTShift = state.tShift[nextLine];
        const oldSCount = state.sCount[nextLine];
        const oldListIndent = state.listIndent;
        state.listIndent = state.blkIndent;
        state.blkIndent = indent;
        state.tight = true;
        state.tShift[nextLine] = contentStart - state.bMarks[nextLine];
        state.sCount[nextLine] = offset;
        if (contentStart >= max && state.isEmpty(nextLine + 1)) state.line = Math.min(state.line + 2, endLine);
        else state.md.block.tokenize(state, nextLine, endLine, true);
        if (!state.tight || prevEmptyEnd) tight = false;
        prevEmptyEnd = state.line - nextLine > 1 && state.isEmpty(state.line - 1);
        state.blkIndent = state.listIndent;
        state.listIndent = oldListIndent;
        state.tShift[nextLine] = oldTShift;
        state.sCount[nextLine] = oldSCount;
        state.tight = oldTight;
        token = state.push("list_item_close", "li", -1);
        token.markup = String.fromCharCode(markerCharCode);
        nextLine = state.line;
        itemLines[1] = nextLine;
        if (nextLine >= endLine) break;
        if (state.sCount[nextLine] < state.blkIndent) break;
        if (state.sCount[nextLine] - state.blkIndent >= 4) break;
        let terminate = false;
        for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
          terminate = true;
          break;
        }
        if (terminate) break;
        if (isOrdered) {
          posAfterMarker = skipOrderedListMarker(state, nextLine);
          if (posAfterMarker < 0) break;
          start = state.bMarks[nextLine] + state.tShift[nextLine];
        } else {
          posAfterMarker = skipBulletListMarker(state, nextLine);
          if (posAfterMarker < 0) break;
        }
        if (markerCharCode !== state.src.charCodeAt(posAfterMarker - 1)) break;
      }
      if (isOrdered) token = state.push("ordered_list_close", "ol", -1);
      else token = state.push("bullet_list_close", "ul", -1);
      token.markup = String.fromCharCode(markerCharCode);
      listLines[1] = nextLine;
      state.line = nextLine;
      state.parentType = oldParentType;
      if (tight) markTightParagraphs(state, listTokIdx);
      return true;
    }
    function reference(state, startLine, _endLine, silent) {
      let pos = state.bMarks[startLine] + state.tShift[startLine];
      let max = state.eMarks[startLine];
      let nextLine = startLine + 1;
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      if (state.src.charCodeAt(pos) !== 91) return false;
      function getNextLine(nextLine2) {
        const endLine = state.lineMax;
        if (nextLine2 >= endLine || state.isEmpty(nextLine2)) return null;
        let isContinuation = false;
        if (state.sCount[nextLine2] - state.blkIndent > 3) isContinuation = true;
        if (state.sCount[nextLine2] < 0) isContinuation = true;
        if (!isContinuation) {
          const terminatorRules = state.md.block.ruler.getRules("reference");
          const oldParentType = state.parentType;
          state.parentType = "reference";
          let terminate = false;
          for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine2, endLine, true)) {
            terminate = true;
            break;
          }
          state.parentType = oldParentType;
          if (terminate) return null;
        }
        const pos2 = state.bMarks[nextLine2] + state.tShift[nextLine2];
        const max2 = state.eMarks[nextLine2];
        return state.src.slice(pos2, max2 + 1);
      }
      let str = state.src.slice(pos, max + 1);
      max = str.length;
      let labelEnd = -1;
      for (pos = 1; pos < max; pos++) {
        const ch = str.charCodeAt(pos);
        if (ch === 91) return false;
        else if (ch === 93) {
          labelEnd = pos;
          break;
        } else if (ch === 10) {
          const lineContent = getNextLine(nextLine);
          if (lineContent !== null) {
            str += lineContent;
            max = str.length;
            nextLine++;
          }
        } else if (ch === 92) {
          pos++;
          if (pos < max && str.charCodeAt(pos) === 10) {
            const lineContent = getNextLine(nextLine);
            if (lineContent !== null) {
              str += lineContent;
              max = str.length;
              nextLine++;
            }
          }
        }
      }
      if (labelEnd < 0 || str.charCodeAt(labelEnd + 1) !== 58) return false;
      for (pos = labelEnd + 2; pos < max; pos++) {
        const ch = str.charCodeAt(pos);
        if (ch === 10) {
          const lineContent = getNextLine(nextLine);
          if (lineContent !== null) {
            str += lineContent;
            max = str.length;
            nextLine++;
          }
        } else if (isSpace(ch)) {
        } else break;
      }
      const destRes = state.md.helpers.parseLinkDestination(str, pos, max);
      if (!destRes.ok) return false;
      const href = state.md.normalizeLink(destRes.str);
      if (!state.md.validateLink(href)) return false;
      pos = destRes.pos;
      const destEndPos = pos;
      const destEndLineNo = nextLine;
      const start = pos;
      for (; pos < max; pos++) {
        const ch = str.charCodeAt(pos);
        if (ch === 10) {
          const lineContent = getNextLine(nextLine);
          if (lineContent !== null) {
            str += lineContent;
            max = str.length;
            nextLine++;
          }
        } else if (isSpace(ch)) {
        } else break;
      }
      let titleRes = state.md.helpers.parseLinkTitle(str, pos, max);
      while (titleRes.can_continue) {
        const lineContent = getNextLine(nextLine);
        if (lineContent === null) break;
        str += lineContent;
        pos = max;
        max = str.length;
        nextLine++;
        titleRes = state.md.helpers.parseLinkTitle(str, pos, max, titleRes);
      }
      let title;
      if (pos < max && start !== pos && titleRes.ok) {
        title = titleRes.str;
        pos = titleRes.pos;
      } else {
        title = "";
        pos = destEndPos;
        nextLine = destEndLineNo;
      }
      while (pos < max) {
        if (!isSpace(str.charCodeAt(pos))) break;
        pos++;
      }
      if (pos < max && str.charCodeAt(pos) !== 10) {
        if (title) {
          title = "";
          pos = destEndPos;
          nextLine = destEndLineNo;
          while (pos < max) {
            if (!isSpace(str.charCodeAt(pos))) break;
            pos++;
          }
        }
      }
      if (pos < max && str.charCodeAt(pos) !== 10) return false;
      const label = normalizeReference(str.slice(1, labelEnd));
      if (!label) return false;
      if (silent) return true;
      if (typeof state.env.references === "undefined") state.env.references = {};
      if (typeof state.env.references[label] === "undefined") state.env.references[label] = {
        title,
        href
      };
      state.line = nextLine;
      return true;
    }
    var html_blocks_default = [
      "address",
      "article",
      "aside",
      "base",
      "basefont",
      "blockquote",
      "body",
      "caption",
      "center",
      "col",
      "colgroup",
      "dd",
      "details",
      "dialog",
      "dir",
      "div",
      "dl",
      "dt",
      "fieldset",
      "figcaption",
      "figure",
      "footer",
      "form",
      "frame",
      "frameset",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "head",
      "header",
      "hr",
      "html",
      "iframe",
      "legend",
      "li",
      "link",
      "main",
      "menu",
      "menuitem",
      "nav",
      "noframes",
      "ol",
      "optgroup",
      "option",
      "p",
      "param",
      "search",
      "section",
      "summary",
      "table",
      "tbody",
      "td",
      "tfoot",
      "th",
      "thead",
      "title",
      "tr",
      "track",
      "ul"
    ];
    var HTML_TAG_RE = /* @__PURE__ */ new RegExp(`^(?:<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)*\\s*\\/?>|<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`);
    var HTML_OPEN_CLOSE_TAG_RE = /* @__PURE__ */ new RegExp(`^(?:<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)*\\s*\\/?>|<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>)`);
    var HTML_SEQUENCES = [
      [
        /^<(script|pre|style|textarea)(?=(\s|>|$))/i,
        /<\/(script|pre|style|textarea)>/i,
        true
      ],
      [
        /^<!--/,
        /-->/,
        true
      ],
      [
        /^<\?/,
        /\?>/,
        true
      ],
      [
        /^<![A-Za-z]/,
        />/,
        true
      ],
      [
        /^<!\[CDATA\[/,
        /\]\]>/,
        true
      ],
      [
        new RegExp("^</?(" + html_blocks_default.join("|") + ")(?=(\\s|/?>|$))", "i"),
        /^$/,
        true
      ],
      [
        new RegExp(HTML_OPEN_CLOSE_TAG_RE.source + "\\s*$"),
        /^$/,
        false
      ]
    ];
    function html_block(state, startLine, endLine, silent) {
      let pos = state.bMarks[startLine] + state.tShift[startLine];
      let max = state.eMarks[startLine];
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      if (!state.md.options.html) return false;
      if (state.src.charCodeAt(pos) !== 60) return false;
      let lineText = state.src.slice(pos, max);
      let i = 0;
      for (; i < HTML_SEQUENCES.length; i++) if (HTML_SEQUENCES[i][0].test(lineText)) break;
      if (i === HTML_SEQUENCES.length) return false;
      if (silent) return HTML_SEQUENCES[i][2];
      let nextLine = startLine + 1;
      const endsOnBlankLine = HTML_SEQUENCES[i][1].test("");
      if (!HTML_SEQUENCES[i][1].test(lineText)) for (; nextLine < endLine; nextLine++) {
        if (state.sCount[nextLine] < state.blkIndent) {
          if (endsOnBlankLine || !state.isEmpty(nextLine)) break;
        }
        pos = state.bMarks[nextLine] + state.tShift[nextLine];
        max = state.eMarks[nextLine];
        lineText = state.src.slice(pos, max);
        if (HTML_SEQUENCES[i][1].test(lineText)) {
          if (lineText.length !== 0) nextLine++;
          break;
        }
      }
      state.line = nextLine;
      const token = state.push("html_block", "", 0);
      token.map = [startLine, nextLine];
      token.content = state.getLines(startLine, nextLine, state.blkIndent, true);
      return true;
    }
    function heading(state, startLine, endLine, silent) {
      let pos = state.bMarks[startLine] + state.tShift[startLine];
      let max = state.eMarks[startLine];
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      let ch = state.src.charCodeAt(pos);
      if (ch !== 35 || pos >= max) return false;
      let level = 1;
      ch = state.src.charCodeAt(++pos);
      while (ch === 35 && pos < max && level <= 6) {
        level++;
        ch = state.src.charCodeAt(++pos);
      }
      if (level > 6 || pos < max && !isSpace(ch)) return false;
      if (silent) return true;
      max = state.skipSpacesBack(max, pos);
      const tmp = state.skipCharsBack(max, 35, pos);
      if (tmp > pos && isSpace(state.src.charCodeAt(tmp - 1))) max = tmp;
      state.line = startLine + 1;
      const token_o = state.push("heading_open", "h" + String(level), 1);
      token_o.markup = "########".slice(0, level);
      token_o.map = [startLine, state.line];
      const token_i = state.push("inline", "", 0);
      token_i.content = asciiTrim(state.src.slice(pos, max));
      token_i.map = [startLine, state.line];
      token_i.children = [];
      const token_c = state.push("heading_close", "h" + String(level), -1);
      token_c.markup = "########".slice(0, level);
      return true;
    }
    function lheading(state, startLine, endLine) {
      const terminatorRules = state.md.block.ruler.getRules("paragraph");
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const oldParentType = state.parentType;
      state.parentType = "paragraph";
      let level = 0;
      let marker;
      let nextLine = startLine + 1;
      for (; nextLine < endLine && !state.isEmpty(nextLine); nextLine++) {
        if (state.sCount[nextLine] - state.blkIndent > 3) continue;
        if (state.sCount[nextLine] >= state.blkIndent) {
          let pos = state.bMarks[nextLine] + state.tShift[nextLine];
          const max = state.eMarks[nextLine];
          if (pos < max) {
            marker = state.src.charCodeAt(pos);
            if (marker === 45 || marker === 61) {
              pos = state.skipChars(pos, marker);
              pos = state.skipSpaces(pos);
              if (pos >= max) {
                level = marker === 61 ? 1 : 2;
                break;
              }
            }
          }
        }
        if (state.sCount[nextLine] < 0) continue;
        let terminate = false;
        for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
          terminate = true;
          break;
        }
        if (terminate) break;
      }
      if (!level) {
        state.parentType = oldParentType;
        return false;
      }
      const content = asciiTrim(state.getLines(startLine, nextLine, state.blkIndent, false));
      state.line = nextLine + 1;
      const token_o = state.push("heading_open", "h" + String(level), 1);
      token_o.markup = String.fromCharCode(marker);
      token_o.map = [startLine, state.line];
      const token_i = state.push("inline", "", 0);
      token_i.content = content;
      token_i.map = [startLine, state.line - 1];
      token_i.children = [];
      const token_c = state.push("heading_close", "h" + String(level), -1);
      token_c.markup = String.fromCharCode(marker);
      state.parentType = oldParentType;
      return true;
    }
    function paragraph(state, startLine, endLine) {
      const terminatorRules = state.md.block.ruler.getRules("paragraph");
      const oldParentType = state.parentType;
      let nextLine = startLine + 1;
      state.parentType = "paragraph";
      for (; nextLine < endLine && !state.isEmpty(nextLine); nextLine++) {
        if (state.sCount[nextLine] - state.blkIndent > 3) continue;
        if (state.sCount[nextLine] < 0) continue;
        let terminate = false;
        for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
          terminate = true;
          break;
        }
        if (terminate) break;
      }
      const content = asciiTrim(state.getLines(startLine, nextLine, state.blkIndent, false));
      state.line = nextLine;
      const token_o = state.push("paragraph_open", "p", 1);
      token_o.map = [startLine, state.line];
      const token_i = state.push("inline", "", 0);
      token_i.content = content;
      token_i.map = [startLine, state.line];
      token_i.children = [];
      state.push("paragraph_close", "p", -1);
      state.parentType = oldParentType;
      return true;
    }
    var _rules$1 = [
      [
        "table",
        table,
        ["paragraph", "reference"]
      ],
      ["code", code],
      [
        "fence",
        fence,
        [
          "paragraph",
          "reference",
          "blockquote",
          "list"
        ]
      ],
      [
        "blockquote",
        blockquote,
        [
          "paragraph",
          "reference",
          "blockquote",
          "list"
        ]
      ],
      [
        "hr",
        hr,
        [
          "paragraph",
          "reference",
          "blockquote",
          "list"
        ]
      ],
      [
        "list",
        list,
        [
          "paragraph",
          "reference",
          "blockquote"
        ]
      ],
      ["reference", reference],
      [
        "html_block",
        html_block,
        [
          "paragraph",
          "reference",
          "blockquote"
        ]
      ],
      [
        "heading",
        heading,
        [
          "paragraph",
          "reference",
          "blockquote"
        ]
      ],
      ["lheading", lheading],
      ["paragraph", paragraph]
    ];
    function ParserBlock() {
      this.ruler = new Ruler();
      for (let i = 0; i < _rules$1.length; i++) this.ruler.push(_rules$1[i][0], _rules$1[i][1], { alt: (_rules$1[i][2] || []).slice() });
    }
    ParserBlock.prototype.tokenize = function(state, startLine, endLine) {
      const rules = this.ruler.getRules("");
      const len = rules.length;
      const maxNesting = state.md.options.maxNesting;
      let line = startLine;
      let hasEmptyLines = false;
      while (line < endLine) {
        state.line = line = state.skipEmptyLines(line);
        if (line >= endLine) break;
        if (state.sCount[line] < state.blkIndent) break;
        if (state.level >= maxNesting) {
          state.line = endLine;
          break;
        }
        const prevLine = state.line;
        let ok = false;
        for (let i = 0; i < len; i++) {
          ok = rules[i](state, line, endLine, false);
          if (ok) {
            if (prevLine >= state.line) throw new Error("block rule didn't increment state.line");
            break;
          }
        }
        if (!ok) throw new Error("none of the block rules matched");
        state.tight = !hasEmptyLines;
        if (state.isEmpty(state.line - 1)) hasEmptyLines = true;
        line = state.line;
        if (line < endLine && state.isEmpty(line)) {
          hasEmptyLines = true;
          line++;
          state.line = line;
        }
      }
    };
    ParserBlock.prototype.parse = function(src, md, env, outTokens) {
      if (!src) return;
      const state = new this.State(src, md, env, outTokens);
      this.tokenize(state, state.line, state.lineMax);
    };
    ParserBlock.prototype.State = StateBlock;
    function StateInline(src, md, env, outTokens) {
      this.src = src;
      this.env = env;
      this.md = md;
      this.tokens = outTokens;
      this.tokens_meta = Array(outTokens.length);
      this.pos = 0;
      this.posMax = this.src.length;
      this.level = 0;
      this.pending = "";
      this.pendingLevel = 0;
      this.cache = {};
      this.delimiters = [];
      this._prev_delimiters = [];
      this.backticks = {};
      this.backticksScanned = false;
      this.linkLevel = 0;
    }
    StateInline.prototype.pushPending = function() {
      const token = new Token("text", "", 0);
      token.content = this.pending;
      token.level = this.pendingLevel;
      this.tokens.push(token);
      this.pending = "";
      return token;
    };
    StateInline.prototype.push = function(type, tag, nesting) {
      if (this.pending) this.pushPending();
      const token = new Token(type, tag, nesting);
      let token_meta = null;
      if (nesting < 0) {
        this.level--;
        this.delimiters = this._prev_delimiters.pop();
      }
      token.level = this.level;
      if (nesting > 0) {
        this.level++;
        this._prev_delimiters.push(this.delimiters);
        this.delimiters = [];
        token_meta = { delimiters: this.delimiters };
      }
      this.pendingLevel = this.level;
      this.tokens.push(token);
      this.tokens_meta.push(token_meta);
      return token;
    };
    StateInline.prototype.scanDelims = function(start, canSplitWord) {
      const max = this.posMax;
      const marker = this.src.charCodeAt(start);
      let lastChar;
      if (start === 0) lastChar = 32;
      else if (start === 1) {
        lastChar = this.src.charCodeAt(0);
        if ((lastChar & 63488) === 55296) lastChar = 65533;
      } else {
        lastChar = this.src.charCodeAt(start - 1);
        if ((lastChar & 64512) === 56320) {
          const highSurr = this.src.charCodeAt(start - 2);
          lastChar = (highSurr & 64512) === 55296 ? 65536 + (highSurr - 55296 << 10) + (lastChar - 56320) : 65533;
        } else if ((lastChar & 64512) === 55296) lastChar = 65533;
      }
      let pos = start;
      while (pos < max && this.src.charCodeAt(pos) === marker) pos++;
      const count = pos - start;
      let nextChar = pos < max ? this.src.charCodeAt(pos) : 32;
      if ((nextChar & 64512) === 55296) {
        const lowSurr = this.src.charCodeAt(pos + 1);
        nextChar = (lowSurr & 64512) === 56320 ? 65536 + (nextChar - 55296 << 10) + (lowSurr - 56320) : 65533;
      } else if ((nextChar & 64512) === 56320) nextChar = 65533;
      const isLastPunctChar = isMdAsciiPunct(lastChar) || isPunctCharCode(lastChar);
      const isNextPunctChar = isMdAsciiPunct(nextChar) || isPunctCharCode(nextChar);
      const isLastWhiteSpace = isWhiteSpace(lastChar);
      const isNextWhiteSpace = isWhiteSpace(nextChar);
      const left_flanking = !isNextWhiteSpace && (!isNextPunctChar || isLastWhiteSpace || isLastPunctChar);
      const right_flanking = !isLastWhiteSpace && (!isLastPunctChar || isNextWhiteSpace || isNextPunctChar);
      return {
        can_open: left_flanking && (canSplitWord || !right_flanking || isLastPunctChar),
        can_close: right_flanking && (canSplitWord || !left_flanking || isNextPunctChar),
        length: count
      };
    };
    StateInline.prototype.Token = Token;
    function isTerminatorChar(ch) {
      switch (ch) {
        case 10:
        case 33:
        case 35:
        case 36:
        case 37:
        case 38:
        case 42:
        case 43:
        case 45:
        case 58:
        case 60:
        case 61:
        case 62:
        case 64:
        case 91:
        case 92:
        case 93:
        case 94:
        case 95:
        case 96:
        case 123:
        case 125:
        case 126:
          return true;
        default:
          return false;
      }
    }
    function text(state, silent) {
      let pos = state.pos;
      while (pos < state.posMax && !isTerminatorChar(state.src.charCodeAt(pos))) pos++;
      if (pos === state.pos) return false;
      if (!silent) state.pending += state.src.slice(state.pos, pos);
      state.pos = pos;
      return true;
    }
    function isAsciiAlpha(code2) {
      return code2 >= 65 && code2 <= 90 || code2 >= 97 && code2 <= 122;
    }
    function isSchemeChar(code2) {
      return code2 >= 65 && code2 <= 90 || code2 >= 97 && code2 <= 122 || code2 >= 48 && code2 <= 57 || code2 === 43 || code2 === 45 || code2 === 46;
    }
    function linkify(state, silent) {
      if (!state.md.options.linkify) return false;
      if (state.linkLevel > 0) return false;
      const pos = state.pos;
      const max = state.posMax;
      if (pos + 3 > max) return false;
      if (state.src.charCodeAt(pos) !== 58) return false;
      if (state.src.charCodeAt(pos + 1) !== 47) return false;
      if (state.src.charCodeAt(pos + 2) !== 47) return false;
      const protoMin = pos - Math.min(10, state.pending.length, pos);
      let protoStart = pos;
      while (protoStart > protoMin && isSchemeChar(state.src.charCodeAt(protoStart - 1))) protoStart--;
      if (protoStart === pos || !isAsciiAlpha(state.src.charCodeAt(protoStart))) return false;
      const protoLength = pos - protoStart;
      const link2 = state.md.linkify.matchAtStart(state.src.slice(protoStart));
      if (!link2) return false;
      let url = link2.url;
      if (url.length <= protoLength) return false;
      let urlEnd = url.length;
      while (urlEnd > 0 && url.charCodeAt(urlEnd - 1) === 42) urlEnd--;
      if (urlEnd !== url.length) url = url.slice(0, urlEnd);
      const fullUrl = state.md.normalizeLink(url);
      if (!state.md.validateLink(fullUrl)) return false;
      if (!silent) {
        state.pending = state.pending.slice(0, -protoLength);
        const token_o = state.push("link_open", "a", 1);
        token_o.attrs = [["href", fullUrl]];
        token_o.markup = "linkify";
        token_o.info = "auto";
        const token_t = state.push("text", "", 0);
        token_t.content = state.md.normalizeLinkText(url);
        const token_c = state.push("link_close", "a", -1);
        token_c.markup = "linkify";
        token_c.info = "auto";
      }
      state.pos += url.length - protoLength;
      return true;
    }
    function newline(state, silent) {
      let pos = state.pos;
      if (state.src.charCodeAt(pos) !== 10) return false;
      const pmax = state.pending.length - 1;
      const max = state.posMax;
      if (!silent) if (pmax >= 0 && state.pending.charCodeAt(pmax) === 32) if (pmax >= 1 && state.pending.charCodeAt(pmax - 1) === 32) {
        let ws = pmax - 1;
        while (ws >= 1 && state.pending.charCodeAt(ws - 1) === 32) ws--;
        state.pending = state.pending.slice(0, ws);
        state.push("hardbreak", "br", 0);
      } else {
        state.pending = state.pending.slice(0, -1);
        state.push("softbreak", "br", 0);
      }
      else state.push("softbreak", "br", 0);
      pos++;
      while (pos < max && isSpace(state.src.charCodeAt(pos))) pos++;
      state.pos = pos;
      return true;
    }
    var ESCAPED = [];
    for (let i = 0; i < 256; i++) ESCAPED.push(0);
    "\\!\"#$%&'()*+,./:;<=>?@[]^_`{|}~-".split("").forEach(function(ch) {
      ESCAPED[ch.charCodeAt(0)] = 1;
    });
    function escape(state, silent) {
      let pos = state.pos;
      const max = state.posMax;
      if (state.src.charCodeAt(pos) !== 92) return false;
      pos++;
      if (pos >= max) return false;
      let ch1 = state.src.charCodeAt(pos);
      if (ch1 === 10) {
        if (!silent) state.push("hardbreak", "br", 0);
        pos++;
        while (pos < max) {
          ch1 = state.src.charCodeAt(pos);
          if (!isSpace(ch1)) break;
          pos++;
        }
        state.pos = pos;
        return true;
      }
      if (ch1 === 32) {
        if (!silent) {
          const token = state.push("text_special", "", 0);
          token.content = "\\";
          token.markup = "\\";
          token.info = "escape";
        }
        state.pos = pos;
        return true;
      }
      let escapedStr = state.src[pos];
      if (ch1 >= 55296 && ch1 <= 56319 && pos + 1 < max) {
        const ch2 = state.src.charCodeAt(pos + 1);
        if (ch2 >= 56320 && ch2 <= 57343) {
          escapedStr += state.src[pos + 1];
          pos++;
        }
      }
      const origStr = "\\" + escapedStr;
      if (!silent) {
        const token = state.push("text_special", "", 0);
        if (ch1 < 256 && ESCAPED[ch1] !== 0) token.content = escapedStr;
        else token.content = origStr;
        token.markup = origStr;
        token.info = "escape";
      }
      state.pos = pos + 1;
      return true;
    }
    function backtick(state, silent) {
      let pos = state.pos;
      if (state.src.charCodeAt(pos) !== 96) return false;
      const start = pos;
      pos++;
      const max = state.posMax;
      while (pos < max && state.src.charCodeAt(pos) === 96) pos++;
      const marker = state.src.slice(start, pos);
      const openerLength = marker.length;
      if (state.backticksScanned && (state.backticks[openerLength] || 0) <= start) {
        if (!silent) state.pending += marker;
        state.pos += openerLength;
        return true;
      }
      let matchEnd = pos;
      let matchStart;
      while ((matchStart = state.src.indexOf("`", matchEnd)) !== -1) {
        matchEnd = matchStart + 1;
        while (matchEnd < max && state.src.charCodeAt(matchEnd) === 96) matchEnd++;
        const closerLength = matchEnd - matchStart;
        if (closerLength === openerLength) {
          if (!silent) {
            const token = state.push("code_inline", "code", 0);
            token.markup = marker;
            token.content = state.src.slice(pos, matchStart).replace(/\n/g, " ").replace(/^ (.+) $/, "$1");
          }
          state.pos = matchEnd;
          return true;
        }
        state.backticks[closerLength] = matchStart;
      }
      state.backticksScanned = true;
      if (!silent) state.pending += marker;
      state.pos += openerLength;
      return true;
    }
    function strikethrough_tokenize(state, silent) {
      const start = state.pos;
      const marker = state.src.charCodeAt(start);
      if (silent) return false;
      if (marker !== 126) return false;
      const scanned = state.scanDelims(state.pos, true);
      let len = scanned.length;
      const ch = String.fromCharCode(marker);
      if (len < 2) return false;
      let token;
      if (len % 2) {
        token = state.push("text", "", 0);
        token.content = ch;
        len--;
      }
      for (let i = 0; i < len; i += 2) {
        token = state.push("text", "", 0);
        token.content = ch + ch;
        state.delimiters.push({
          marker,
          length: 0,
          token: state.tokens.length - 1,
          end: -1,
          open: scanned.can_open,
          close: scanned.can_close
        });
      }
      state.pos += scanned.length;
      return true;
    }
    function postProcess$1(state, delimiters) {
      let token;
      const loneMarkers = [];
      const max = delimiters.length;
      for (let i = 0; i < max; i++) {
        const startDelim = delimiters[i];
        if (startDelim.marker !== 126) continue;
        if (startDelim.end === -1) continue;
        const endDelim = delimiters[startDelim.end];
        token = state.tokens[startDelim.token];
        token.type = "s_open";
        token.tag = "s";
        token.nesting = 1;
        token.markup = "~~";
        token.content = "";
        token = state.tokens[endDelim.token];
        token.type = "s_close";
        token.tag = "s";
        token.nesting = -1;
        token.markup = "~~";
        token.content = "";
        if (state.tokens[endDelim.token - 1].type === "text" && state.tokens[endDelim.token - 1].content === "~") loneMarkers.push(endDelim.token - 1);
      }
      while (loneMarkers.length) {
        const i = loneMarkers.pop();
        let j = i + 1;
        while (j < state.tokens.length && state.tokens[j].type === "s_close") j++;
        j--;
        if (i !== j) {
          token = state.tokens[j];
          state.tokens[j] = state.tokens[i];
          state.tokens[i] = token;
        }
      }
    }
    function strikethrough_postProcess(state) {
      const tokens_meta = state.tokens_meta;
      const max = state.tokens_meta.length;
      postProcess$1(state, state.delimiters);
      for (let curr = 0; curr < max; curr++) if (tokens_meta[curr] && tokens_meta[curr].delimiters) postProcess$1(state, tokens_meta[curr].delimiters);
    }
    var strikethrough_default = {
      tokenize: strikethrough_tokenize,
      postProcess: strikethrough_postProcess
    };
    function emphasis_tokenize(state, silent) {
      const start = state.pos;
      const marker = state.src.charCodeAt(start);
      if (silent) return false;
      if (marker !== 95 && marker !== 42) return false;
      const scanned = state.scanDelims(state.pos, marker === 42);
      for (let i = 0; i < scanned.length; i++) {
        const token = state.push("text", "", 0);
        token.content = String.fromCharCode(marker);
        state.delimiters.push({
          marker,
          length: scanned.length,
          token: state.tokens.length - 1,
          end: -1,
          open: scanned.can_open,
          close: scanned.can_close
        });
      }
      state.pos += scanned.length;
      return true;
    }
    function postProcess(state, delimiters) {
      const max = delimiters.length;
      for (let i = max - 1; i >= 0; i--) {
        const startDelim = delimiters[i];
        if (startDelim.marker !== 95 && startDelim.marker !== 42) continue;
        if (startDelim.end === -1) continue;
        const endDelim = delimiters[startDelim.end];
        const isStrong = i > 0 && delimiters[i - 1].end === startDelim.end + 1 && delimiters[i - 1].marker === startDelim.marker && delimiters[i - 1].token === startDelim.token - 1 && delimiters[startDelim.end + 1].token === endDelim.token + 1;
        const ch = String.fromCharCode(startDelim.marker);
        const token_o = state.tokens[startDelim.token];
        token_o.type = isStrong ? "strong_open" : "em_open";
        token_o.tag = isStrong ? "strong" : "em";
        token_o.nesting = 1;
        token_o.markup = isStrong ? ch + ch : ch;
        token_o.content = "";
        const token_c = state.tokens[endDelim.token];
        token_c.type = isStrong ? "strong_close" : "em_close";
        token_c.tag = isStrong ? "strong" : "em";
        token_c.nesting = -1;
        token_c.markup = isStrong ? ch + ch : ch;
        token_c.content = "";
        if (isStrong) {
          state.tokens[delimiters[i - 1].token].content = "";
          state.tokens[delimiters[startDelim.end + 1].token].content = "";
          i--;
        }
      }
    }
    function emphasis_post_process(state) {
      const tokens_meta = state.tokens_meta;
      const max = state.tokens_meta.length;
      postProcess(state, state.delimiters);
      for (let curr = 0; curr < max; curr++) if (tokens_meta[curr] && tokens_meta[curr].delimiters) postProcess(state, tokens_meta[curr].delimiters);
    }
    var emphasis_default = {
      tokenize: emphasis_tokenize,
      postProcess: emphasis_post_process
    };
    function link(state, silent) {
      let code2, label, res, ref;
      let href = "";
      let title = "";
      let start = state.pos;
      let parseReference = true;
      if (state.src.charCodeAt(state.pos) !== 91) return false;
      const oldPos = state.pos;
      const max = state.posMax;
      const labelStart = state.pos + 1;
      const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos, true);
      if (labelEnd < 0) return false;
      let pos = labelEnd + 1;
      if (pos < max && state.src.charCodeAt(pos) === 40) {
        parseReference = false;
        pos++;
        for (; pos < max; pos++) {
          code2 = state.src.charCodeAt(pos);
          if (!isSpace(code2) && code2 !== 10) break;
        }
        if (pos >= max) return false;
        start = pos;
        res = state.md.helpers.parseLinkDestination(state.src, pos, state.posMax);
        if (res.ok) {
          href = state.md.normalizeLink(res.str);
          if (state.md.validateLink(href)) pos = res.pos;
          else href = "";
          start = pos;
          for (; pos < max; pos++) {
            code2 = state.src.charCodeAt(pos);
            if (!isSpace(code2) && code2 !== 10) break;
          }
          res = state.md.helpers.parseLinkTitle(state.src, pos, state.posMax);
          if (pos < max && start !== pos && res.ok) {
            title = res.str;
            pos = res.pos;
            for (; pos < max; pos++) {
              code2 = state.src.charCodeAt(pos);
              if (!isSpace(code2) && code2 !== 10) break;
            }
          }
        }
        if (pos >= max || state.src.charCodeAt(pos) !== 41) parseReference = true;
        pos++;
      }
      if (parseReference) {
        if (typeof state.env.references === "undefined") return false;
        if (pos < max && state.src.charCodeAt(pos) === 91) {
          start = pos + 1;
          pos = state.md.helpers.parseLinkLabel(state, pos);
          if (pos >= 0) label = state.src.slice(start, pos++);
          else pos = labelEnd + 1;
        } else pos = labelEnd + 1;
        if (!label) label = state.src.slice(labelStart, labelEnd);
        ref = state.env.references[normalizeReference(label)];
        if (!ref) {
          state.pos = oldPos;
          return false;
        }
        href = ref.href;
        title = ref.title;
      }
      if (!silent) {
        state.pos = labelStart;
        state.posMax = labelEnd;
        const token_o = state.push("link_open", "a", 1);
        const attrs = [["href", href]];
        token_o.attrs = attrs;
        if (title) attrs.push(["title", title]);
        state.linkLevel++;
        state.md.inline.tokenize(state);
        state.linkLevel--;
        state.push("link_close", "a", -1);
      }
      state.pos = pos;
      state.posMax = max;
      return true;
    }
    function image(state, silent) {
      let code2, content, label, pos, ref, res, title, start;
      let href = "";
      const oldPos = state.pos;
      const max = state.posMax;
      if (state.src.charCodeAt(state.pos) !== 33) return false;
      if (state.src.charCodeAt(state.pos + 1) !== 91) return false;
      const labelStart = state.pos + 2;
      const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos + 1, false);
      if (labelEnd < 0) return false;
      pos = labelEnd + 1;
      if (pos < max && state.src.charCodeAt(pos) === 40) {
        pos++;
        for (; pos < max; pos++) {
          code2 = state.src.charCodeAt(pos);
          if (!isSpace(code2) && code2 !== 10) break;
        }
        if (pos >= max) return false;
        start = pos;
        res = state.md.helpers.parseLinkDestination(state.src, pos, state.posMax);
        if (res.ok) {
          href = state.md.normalizeLink(res.str);
          if (state.md.validateLink(href)) pos = res.pos;
          else href = "";
        }
        start = pos;
        for (; pos < max; pos++) {
          code2 = state.src.charCodeAt(pos);
          if (!isSpace(code2) && code2 !== 10) break;
        }
        res = state.md.helpers.parseLinkTitle(state.src, pos, state.posMax);
        if (pos < max && start !== pos && res.ok) {
          title = res.str;
          pos = res.pos;
          for (; pos < max; pos++) {
            code2 = state.src.charCodeAt(pos);
            if (!isSpace(code2) && code2 !== 10) break;
          }
        } else title = "";
        if (pos >= max || state.src.charCodeAt(pos) !== 41) {
          state.pos = oldPos;
          return false;
        }
        pos++;
      } else {
        if (typeof state.env.references === "undefined") return false;
        if (pos < max && state.src.charCodeAt(pos) === 91) {
          start = pos + 1;
          pos = state.md.helpers.parseLinkLabel(state, pos);
          if (pos >= 0) label = state.src.slice(start, pos++);
          else pos = labelEnd + 1;
        } else pos = labelEnd + 1;
        if (!label) label = state.src.slice(labelStart, labelEnd);
        ref = state.env.references[normalizeReference(label)];
        if (!ref) {
          state.pos = oldPos;
          return false;
        }
        href = ref.href;
        title = ref.title;
      }
      if (!silent) {
        content = state.src.slice(labelStart, labelEnd);
        const tokens = [];
        state.md.inline.parse(content, state.md, state.env, tokens);
        const token = state.push("image", "img", 0);
        const attrs = [["src", href], ["alt", ""]];
        token.attrs = attrs;
        token.children = tokens;
        token.content = content;
        if (title) attrs.push(["title", title]);
      }
      state.pos = pos;
      state.posMax = max;
      return true;
    }
    var EMAIL_RE = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/;
    var AUTOLINK_RE = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;
    function autolink(state, silent) {
      let pos = state.pos;
      if (state.src.charCodeAt(pos) !== 60) return false;
      const start = state.pos;
      const max = state.posMax;
      for (; ; ) {
        if (++pos >= max) return false;
        const ch = state.src.charCodeAt(pos);
        if (ch === 60) return false;
        if (ch === 62) break;
      }
      const url = state.src.slice(start + 1, pos);
      if (AUTOLINK_RE.test(url)) {
        const fullUrl = state.md.normalizeLink(url);
        if (!state.md.validateLink(fullUrl)) return false;
        if (!silent) {
          const token_o = state.push("link_open", "a", 1);
          token_o.attrs = [["href", fullUrl]];
          token_o.markup = "autolink";
          token_o.info = "auto";
          const token_t = state.push("text", "", 0);
          token_t.content = state.md.normalizeLinkText(url);
          const token_c = state.push("link_close", "a", -1);
          token_c.markup = "autolink";
          token_c.info = "auto";
        }
        state.pos += url.length + 2;
        return true;
      }
      if (EMAIL_RE.test(url)) {
        const fullUrl = state.md.normalizeLink("mailto:" + url);
        if (!state.md.validateLink(fullUrl)) return false;
        if (!silent) {
          const token_o = state.push("link_open", "a", 1);
          token_o.attrs = [["href", fullUrl]];
          token_o.markup = "autolink";
          token_o.info = "auto";
          const token_t = state.push("text", "", 0);
          token_t.content = state.md.normalizeLinkText(url);
          const token_c = state.push("link_close", "a", -1);
          token_c.markup = "autolink";
          token_c.info = "auto";
        }
        state.pos += url.length + 2;
        return true;
      }
      return false;
    }
    function isLinkOpen(str) {
      return /^<a[>\s]/i.test(str);
    }
    function isLinkClose(str) {
      return /^<\/a\s*>/i.test(str);
    }
    function isLetter(ch) {
      const lc = ch | 32;
      return lc >= 97 && lc <= 122;
    }
    function html_inline(state, silent) {
      if (!state.md.options.html) return false;
      const max = state.posMax;
      const pos = state.pos;
      if (state.src.charCodeAt(pos) !== 60 || pos + 2 >= max) return false;
      const ch = state.src.charCodeAt(pos + 1);
      if (ch !== 33 && ch !== 63 && ch !== 47 && !isLetter(ch)) return false;
      const match = state.src.slice(pos).match(HTML_TAG_RE);
      if (!match) return false;
      if (!silent) {
        const token = state.push("html_inline", "", 0);
        token.content = match[0];
        if (isLinkOpen(token.content)) state.linkLevel++;
        if (isLinkClose(token.content)) state.linkLevel--;
      }
      state.pos += match[0].length;
      return true;
    }
    var DIGITAL_RE = /^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i;
    var NAMED_RE = /^&([a-z][a-z0-9]{1,31});/i;
    function entity(state, silent) {
      const pos = state.pos;
      const max = state.posMax;
      if (state.src.charCodeAt(pos) !== 38) return false;
      if (pos + 1 >= max) return false;
      if (state.src.charCodeAt(pos + 1) === 35) {
        const match = state.src.slice(pos).match(DIGITAL_RE);
        if (match) {
          if (!silent) {
            const code2 = match[1][0].toLowerCase() === "x" ? parseInt(match[1].slice(1), 16) : parseInt(match[1], 10);
            const token = state.push("text_special", "", 0);
            token.content = isValidEntityCode(code2) ? fromCodePoint(code2) : fromCodePoint(65533);
            token.markup = match[0];
            token.info = "entity";
          }
          state.pos += match[0].length;
          return true;
        }
      } else {
        const match = state.src.slice(pos).match(NAMED_RE);
        if (match) {
          const decoded = (0, entities.decodeHTMLStrict)(match[0]);
          if (decoded !== match[0]) {
            if (!silent) {
              const token = state.push("text_special", "", 0);
              token.content = decoded;
              token.markup = match[0];
              token.info = "entity";
            }
            state.pos += match[0].length;
            return true;
          }
        }
      }
      return false;
    }
    function processDelimiters(delimiters) {
      const openersBottom = {};
      const max = delimiters.length;
      if (!max) return;
      let headerIdx = 0;
      let lastTokenIdx = -2;
      const jumps = [];
      for (let closerIdx = 0; closerIdx < max; closerIdx++) {
        const closer = delimiters[closerIdx];
        jumps.push(0);
        if (delimiters[headerIdx].marker !== closer.marker || lastTokenIdx !== closer.token - 1) headerIdx = closerIdx;
        lastTokenIdx = closer.token;
        closer.length = closer.length || 0;
        if (!closer.close) continue;
        if (!openersBottom.hasOwnProperty(closer.marker)) openersBottom[closer.marker] = [
          -1,
          -1,
          -1,
          -1,
          -1,
          -1
        ];
        const minOpenerIdx = openersBottom[closer.marker][(closer.open ? 3 : 0) + closer.length % 3];
        let openerIdx = headerIdx - jumps[headerIdx] - 1;
        let newMinOpenerIdx = openerIdx;
        for (; openerIdx > minOpenerIdx; openerIdx -= jumps[openerIdx] + 1) {
          const opener = delimiters[openerIdx];
          if (opener.marker !== closer.marker) continue;
          if (opener.open && opener.end < 0) {
            let isOddMatch = false;
            if (opener.close || closer.open) {
              if ((opener.length + closer.length) % 3 === 0) {
                if (opener.length % 3 !== 0 || closer.length % 3 !== 0) isOddMatch = true;
              }
            }
            if (!isOddMatch) {
              const lastJump = openerIdx > 0 && !delimiters[openerIdx - 1].open ? jumps[openerIdx - 1] + 1 : 0;
              jumps[closerIdx] = closerIdx - openerIdx + lastJump;
              jumps[openerIdx] = lastJump;
              closer.open = false;
              opener.end = closerIdx;
              opener.close = false;
              newMinOpenerIdx = -1;
              lastTokenIdx = -2;
              break;
            }
          }
        }
        if (newMinOpenerIdx !== -1) openersBottom[closer.marker][(closer.open ? 3 : 0) + (closer.length || 0) % 3] = newMinOpenerIdx;
      }
    }
    function link_pairs(state) {
      const tokens_meta = state.tokens_meta;
      const max = state.tokens_meta.length;
      processDelimiters(state.delimiters);
      for (let curr = 0; curr < max; curr++) if (tokens_meta[curr] && tokens_meta[curr].delimiters) processDelimiters(tokens_meta[curr].delimiters);
    }
    function fragments_join(state) {
      let curr, last;
      let level = 0;
      const tokens = state.tokens;
      const max = state.tokens.length;
      for (curr = last = 0; curr < max; curr++) {
        if (tokens[curr].nesting < 0) level--;
        tokens[curr].level = level;
        if (tokens[curr].nesting > 0) level++;
        if (tokens[curr].type === "text" && curr + 1 < max && tokens[curr + 1].type === "text") tokens[curr + 1].content = tokens[curr].content + tokens[curr + 1].content;
        else {
          if (curr !== last) tokens[last] = tokens[curr];
          last++;
        }
      }
      if (curr !== last) tokens.length = last;
    }
    var _rules = [
      ["text", text],
      ["linkify", linkify],
      ["newline", newline],
      ["escape", escape],
      ["backticks", backtick],
      ["strikethrough", strikethrough_default.tokenize],
      ["emphasis", emphasis_default.tokenize],
      ["link", link],
      ["image", image],
      ["autolink", autolink],
      ["html_inline", html_inline],
      ["entity", entity]
    ];
    var _rules2 = [
      ["balance_pairs", link_pairs],
      ["strikethrough", strikethrough_default.postProcess],
      ["emphasis", emphasis_default.postProcess],
      ["fragments_join", fragments_join]
    ];
    function ParserInline() {
      this.ruler = new Ruler();
      for (let i = 0; i < _rules.length; i++) this.ruler.push(_rules[i][0], _rules[i][1]);
      this.ruler2 = new Ruler();
      for (let i = 0; i < _rules2.length; i++) this.ruler2.push(_rules2[i][0], _rules2[i][1]);
    }
    ParserInline.prototype.skipToken = function(state) {
      const pos = state.pos;
      const rules = this.ruler.getRules("");
      const len = rules.length;
      const maxNesting = state.md.options.maxNesting;
      const cache = state.cache;
      if (typeof cache[pos] !== "undefined") {
        state.pos = cache[pos];
        return;
      }
      let ok = false;
      if (state.level < maxNesting) for (let i = 0; i < len; i++) {
        state.level++;
        ok = rules[i](state, true);
        state.level--;
        if (ok) {
          if (pos >= state.pos) throw new Error("inline rule didn't increment state.pos");
          break;
        }
      }
      else state.pos = state.posMax;
      if (!ok) state.pos++;
      cache[pos] = state.pos;
    };
    ParserInline.prototype.tokenize = function(state) {
      const rules = this.ruler.getRules("");
      const len = rules.length;
      const end = state.posMax;
      const maxNesting = state.md.options.maxNesting;
      while (state.pos < end) {
        const prevPos = state.pos;
        let ok = false;
        if (state.level < maxNesting) for (let i = 0; i < len; i++) {
          ok = rules[i](state, false);
          if (ok) {
            if (prevPos >= state.pos) throw new Error("inline rule didn't increment state.pos");
            break;
          }
        }
        if (ok) {
          if (state.pos >= end) break;
          continue;
        }
        state.pending += state.src[state.pos++];
      }
      if (state.pending) state.pushPending();
    };
    ParserInline.prototype.parse = function(str, md, env, outTokens) {
      const state = new this.State(str, md, env, outTokens);
      this.tokenize(state);
      const rules = this.ruler2.getRules("");
      const len = rules.length;
      for (let i = 0; i < len; i++) rules[i](state);
    };
    ParserInline.prototype.State = StateInline;
    var config = {
      default: {
        options: {
          html: false,
          xhtmlOut: false,
          breaks: false,
          langPrefix: "language-",
          linkify: false,
          typographer: false,
          quotes: "\u201C\u201D\u2018\u2019",
          highlight: null,
          maxNesting: 100
        },
        components: {
          core: {},
          block: {},
          inline: {}
        }
      },
      zero: {
        options: {
          html: false,
          xhtmlOut: false,
          breaks: false,
          langPrefix: "language-",
          linkify: false,
          typographer: false,
          quotes: "\u201C\u201D\u2018\u2019",
          highlight: null,
          maxNesting: 20
        },
        components: {
          core: { rules: [
            "normalize",
            "block",
            "inline",
            "text_join"
          ] },
          block: { rules: ["paragraph"] },
          inline: {
            rules: ["text"],
            rules2: ["balance_pairs", "fragments_join"]
          }
        }
      },
      commonmark: {
        options: {
          html: true,
          xhtmlOut: true,
          breaks: false,
          langPrefix: "language-",
          linkify: false,
          typographer: false,
          quotes: "\u201C\u201D\u2018\u2019",
          highlight: null,
          maxNesting: 20
        },
        components: {
          core: { rules: [
            "normalize",
            "block",
            "inline",
            "text_join"
          ] },
          block: { rules: [
            "blockquote",
            "code",
            "fence",
            "heading",
            "hr",
            "html_block",
            "lheading",
            "list",
            "reference",
            "paragraph"
          ] },
          inline: {
            rules: [
              "autolink",
              "backticks",
              "emphasis",
              "entity",
              "escape",
              "html_inline",
              "image",
              "link",
              "newline",
              "text"
            ],
            rules2: [
              "balance_pairs",
              "emphasis",
              "fragments_join"
            ]
          }
        }
      }
    };
    var BAD_PROTO_RE = /^(vbscript|javascript|file|data):/;
    var GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/;
    function validateLink(url) {
      const str = url.trim().toLowerCase();
      return BAD_PROTO_RE.test(str) ? GOOD_DATA_RE.test(str) : true;
    }
    var RECODE_HOSTNAME_FOR = [
      "http:",
      "https:",
      "mailto:"
    ];
    function normalizeLink(url) {
      const parsed = mdurl.parse(url, true);
      if (parsed.hostname) {
        if (!parsed.protocol || RECODE_HOSTNAME_FOR.indexOf(parsed.protocol) >= 0) try {
          parsed.hostname = punycode_js.default.toASCII(parsed.hostname);
        } catch (er) {
        }
      }
      return mdurl.encode(mdurl.format(parsed));
    }
    function normalizeLinkText(url) {
      const parsed = mdurl.parse(url, true);
      if (parsed.hostname) {
        if (!parsed.protocol || RECODE_HOSTNAME_FOR.indexOf(parsed.protocol) >= 0) try {
          parsed.hostname = punycode_js.default.toUnicode(parsed.hostname);
        } catch (er) {
        }
      }
      return mdurl.decode(mdurl.format(parsed), mdurl.decode.defaultChars + "%");
    }
    function MarkdownIt(presetName, options) {
      if (!(this instanceof MarkdownIt)) return new MarkdownIt(presetName, options);
      if (!options) {
        if (!isString(presetName)) {
          options = presetName || {};
          presetName = "default";
        }
      }
      this.inline = new ParserInline();
      this.block = new ParserBlock();
      this.core = new Core();
      this.renderer = new Renderer();
      this.linkify = new linkify_it.default();
      this.validateLink = validateLink;
      this.normalizeLink = normalizeLink;
      this.normalizeLinkText = normalizeLinkText;
      this.utils = utils_exports;
      this.helpers = assign({}, helpers_exports);
      this.options = {};
      this.configure(presetName);
      if (options) this.set(options);
    }
    MarkdownIt.prototype.set = function(options) {
      assign(this.options, options);
      return this;
    };
    MarkdownIt.prototype.configure = function(presets) {
      const self = this;
      if (isString(presets)) {
        const presetName = presets;
        presets = config[presetName];
        if (!presets) throw new Error('Wrong `markdown-it` preset "' + presetName + '", check name');
      }
      if (!presets) throw new Error("Wrong `markdown-it` preset, can't be empty");
      if (presets.options) self.set(presets.options);
      if (presets.components) Object.keys(presets.components).forEach(function(name) {
        if (presets.components[name].rules) self[name].ruler.enableOnly(presets.components[name].rules);
        if (presets.components[name].rules2) self[name].ruler2.enableOnly(presets.components[name].rules2);
      });
      return this;
    };
    MarkdownIt.prototype.enable = function(list2, ignoreInvalid) {
      let result = [];
      if (!Array.isArray(list2)) list2 = [list2];
      [
        "core",
        "block",
        "inline"
      ].forEach(function(chain) {
        result = result.concat(this[chain].ruler.enable(list2, true));
      }, this);
      result = result.concat(this.inline.ruler2.enable(list2, true));
      const missed = list2.filter(function(name) {
        return result.indexOf(name) < 0;
      });
      if (missed.length && !ignoreInvalid) throw new Error("MarkdownIt. Failed to enable unknown rule(s): " + missed);
      return this;
    };
    MarkdownIt.prototype.disable = function(list2, ignoreInvalid) {
      let result = [];
      if (!Array.isArray(list2)) list2 = [list2];
      [
        "core",
        "block",
        "inline"
      ].forEach(function(chain) {
        result = result.concat(this[chain].ruler.disable(list2, true));
      }, this);
      result = result.concat(this.inline.ruler2.disable(list2, true));
      const missed = list2.filter(function(name) {
        return result.indexOf(name) < 0;
      });
      if (missed.length && !ignoreInvalid) throw new Error("MarkdownIt. Failed to disable unknown rule(s): " + missed);
      return this;
    };
    MarkdownIt.prototype.use = function(plugin) {
      const args = [this].concat(Array.prototype.slice.call(arguments, 1));
      plugin.apply(plugin, args);
      return this;
    };
    MarkdownIt.prototype.parse = function(src, env) {
      if (typeof src !== "string") throw new Error("Input data should be a String");
      const state = new this.core.State(src, this, env);
      this.core.process(state);
      return state.tokens;
    };
    MarkdownIt.prototype.render = function(src, env) {
      env = env || {};
      return this.renderer.render(this.parse(src, env), this.options, env);
    };
    MarkdownIt.prototype.parseInline = function(src, env) {
      const state = new this.core.State(src, this, env);
      state.inlineMode = true;
      this.core.process(state);
      return state.tokens;
    };
    MarkdownIt.prototype.renderInline = function(src, env) {
      env = env || {};
      return this.renderer.render(this.parseInline(src, env), this.options, env);
    };
    module2.exports = MarkdownIt;
  }
});

// src/repository-links.js
var require_repository_links = __commonJS({
  "src/repository-links.js"(exports2, module2) {
    var MarkdownIt = require_index_cjs4();
    var markdownParser = new MarkdownIt({ html: true });
    markdownParser.normalizeLink = (value) => value;
    markdownParser.validateLink = () => true;
    for (const name of ["link", "autolink"]) {
      const rule = markdownParser.inline.ruler.__rules__.find((entry) => entry.name === name).fn;
      markdownParser.inline.ruler.at(name, (state, silent) => {
        const start = state.pos;
        const tokenCount = state.tokens.length;
        const matched = rule(state, silent);
        if (matched && !silent) {
          const first = state.tokens[tokenCount];
          const token = first.type === "link_open" ? first : state.tokens[tokenCount + 1];
          token.meta = { start, end: state.pos };
        }
        return matched;
      });
    }
    function f_inlineSourceMap(content, sourceLines, firstLine, tableColumn) {
      let inlineOffset = 0;
      return content.split("\n").map((line, index) => {
        const source = sourceLines[firstLine + index].text.replace(/\0/g, "\uFFFD");
        const removed = [];
        const searchable = tableColumn === null ? source : source.replace(/\\\|/g, (_, offset) => {
          removed.push(offset - removed.length);
          return "|";
        });
        const searchStart = tableColumn ?? 0;
        let sourceColumn = searchable.indexOf(line, searchStart);
        if (sourceColumn < 0) {
          const trimmed = line.trimStart();
          const column = searchable.indexOf(trimmed, searchStart);
          if (column >= 0) sourceColumn = column - (line.length - trimmed.length);
        }
        const range = { inlineOffset, sourceColumn, removed };
        inlineOffset += line.length + 1;
        return range;
      });
    }
    function f_sourcePosition(offset, ranges, sourceLines, firstLine) {
      let index = ranges.length - 1;
      while (ranges[index].inlineOffset > offset) index--;
      const { inlineOffset, sourceColumn, removed } = ranges[index];
      if (sourceColumn < 0) return null;
      const line = firstLine + index;
      const column = sourceColumn + offset - inlineOffset;
      const col = column + removed.filter((escape) => escape <= column).length;
      return { line, col, offset: sourceLines[line].offset + col };
    }
    function f_scanMarkdownLinks2(markdown) {
      const links = [];
      let offset = 0;
      const sourceLines = markdown.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).map((line) => {
        const source = { text: line.replace(/[\r\n]+$/, ""), offset };
        offset += line.length;
        return source;
      });
      const closingLine = /^\uFEFF?---[ \t]*$/.test(sourceLines[0].text) ? sourceLines.findIndex(({ text }, index) => index > 0 && /^---[ \t]*$/.test(text)) : -1;
      const bodyStart = closingLine < 0 ? 0 : sourceLines[closingLine + 1]?.offset ?? markdown.length;
      const body = markdown.slice(0, bodyStart).replace(/[^\r\n]/g, " ") + markdown.slice(bodyStart);
      let tableLine = 0;
      let tableColumn = 0;
      for (const block of markdownParser.parse(body, {})) {
        if (block.type === "tr_open") {
          tableLine = block.map[0];
          tableColumn = 0;
        }
        if (block.type !== "inline") continue;
        const firstLine = block.map ? block.map[0] : tableLine;
        const ranges = f_inlineSourceMap(block.content, sourceLines, firstLine, block.map ? null : tableColumn);
        if (!block.map) tableColumn = ranges[0].sourceColumn + block.content.length;
        for (let index = 0; index < block.children.length; index++) {
          const token = block.children[index];
          if (token.type !== "link_open" || !token.meta) continue;
          const start = f_sourcePosition(token.meta.start, ranges, sourceLines, firstLine);
          const end = f_sourcePosition(token.meta.end, ranges, sourceLines, firstLine);
          if (!start || !end) continue;
          let label = "";
          for (let depth = 1; depth > 0; ) {
            const child = block.children[++index];
            if (child.type === "link_open") depth++;
            if (child.type === "link_close") depth--;
            label += child.type.endsWith("break") ? "\n" : child.content;
          }
          links.push({ destination: token.attrGet("href"), label, position: { start, end } });
        }
      }
      return links;
    }
    function f_originIdentity(origin) {
      const match = origin?.trim().match(/^(?:(?:https?|ssh|git):\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/|[^/@]+@github\.com:|github\.com\/)([\w.-]+)\/([\w.-]+)\/?$/i);
      return match ? (match[1] + "/" + match[2].replace(/\.git$/i, "")).toLowerCase() : null;
    }
    function f_repositoryForPath2(vaultPath, repositories) {
      let closest = null;
      for (const repo of repositories) {
        if (typeof repo.root !== "string") continue;
        if (closest && closest.root.length >= repo.root.length) continue;
        if (!repo.root || vaultPath === repo.root || vaultPath.startsWith(repo.root + "/")) closest = repo;
      }
      return closest;
    }
    function f_repoPath(vaultPath, repo) {
      return repo.root ? vaultPath.slice(repo.root.length + 1) : vaultPath;
    }
    function f_decodePathSegments(path) {
      return path.split("/").map((part) => {
        const decoded = decodeURIComponent(part);
        if (/[\\/\x00-\x1f\x7f]/.test(decoded)) throw new URIError("Invalid character in path");
        return decoded;
      });
    }
    function f_normalizeRepoPath(parts) {
      const clean = [];
      for (const part of parts) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
          if (!clean.length) throw new URIError("Link escapes its repository");
          clean.pop();
        } else {
          clean.push(part);
        }
      }
      return clean.join("/");
    }
    function f_githubRefAndPath(raw, refs, kind) {
      const [first, ...rest] = raw.split("/");
      const ref = decodeURIComponent(first);
      if (!ref || /[\\\x00-\x20\x7f]/.test(ref) || ref.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new URIError("Invalid GitHub ref");
      }
      const parts = f_decodePathSegments(rest.join("/"));
      if (kind === "file" && !parts.some(Boolean)) throw new URIError("GitHub file path is empty");
      if (ref.includes("/")) return { ref, parts };
      const tail = [ref, ...parts].join("/");
      const matches = [...new Set(refs || [])].filter((name) => tail === name || tail.startsWith(name + "/"));
      if (matches.length > 1) return null;
      if (matches.length === 1) {
        return { ref: matches[0], parts: parts.slice(matches[0].split("/").length - 1) };
      }
      const conventionalRef = /^(?:main|master|HEAD|[\da-f]{7,64})$/i.test(ref);
      const pathSegments = parts.filter(Boolean).length;
      const uniqueBoundary = kind === "folder" ? pathSegments === 0 : pathSegments === 1;
      return conventionalRef || uniqueBoundary ? { ref, parts } : null;
    }
    function f_resolveRepositoryLink2(link, { sourcePath, repositories, getTargetType }) {
      const { destination, position } = typeof link === "string" ? { destination: link } : link;
      const result = { destination, ...position && { position } };
      const fail = (status, reason) => ({ ...result, status, reason });
      const hash = destination.indexOf("#");
      result.fragment = hash < 0 ? "" : destination.slice(hash);
      const path = (hash < 0 ? destination : destination.slice(0, hash)).split("?")[0];
      const github = path.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(blob|tree)\/([^]*?)$/i);
      const sourceRepo = f_repositoryForPath2(sourcePath, repositories);
      let repo = sourceRepo;
      let expectedKind = path.endsWith("/") ? "folder" : null;
      let parts;
      try {
        if (github) {
          const identity = github[1].toLowerCase();
          result.repository = identity;
          const canonical = repositories.filter((item) => item.identity === identity);
          const matches = canonical.length ? canonical : repositories.filter((item) => item.aliases?.includes(identity));
          if (!matches.length) return fail("out-of-scope", "GitHub repository is outside the workspace");
          const checkouts = matches.filter((item) => typeof item.root === "string");
          if (checkouts.includes(sourceRepo)) repo = sourceRepo;
          else if (checkouts.length === 1) repo = checkouts[0];
          else if (!checkouts.length) return fail("missing", "Local checkout is unavailable");
          else return fail("ambiguous", "Multiple local checkouts have this GitHub identity");
          expectedKind = github[2].toLowerCase() === "tree" ? "folder" : "file";
          const parsed = f_githubRefAndPath(github[3], repo.refs, expectedKind);
          if (!parsed) return fail("ambiguous", "GitHub ref boundary is ambiguous");
          result.ref = parsed.ref;
          parts = parsed.parts;
          if (expectedKind === "file" && !parts.some(Boolean)) throw new URIError("GitHub file path is empty");
        } else {
          if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path)) return fail("out-of-scope", "External link");
          if (!repo) return fail("missing", "Source repository is unavailable");
          const sourceParts = f_repoPath(sourcePath, repo).split("/");
          if (path) {
            const relative = f_decodePathSegments(path);
            parts = path.startsWith("/") ? relative : sourceParts.slice(0, -1).concat(relative);
          } else {
            parts = sourceParts;
          }
        }
        result.repository = repo.identity || null;
        result.repoPath = f_normalizeRepoPath(parts);
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        return fail("invalid", error.message);
      }
      result.vaultPath = [repo.root, result.repoPath].filter(Boolean).join("/");
      const kind = getTargetType(result.vaultPath);
      if (!kind) return fail("missing", "Local target is unavailable");
      if (expectedKind && expectedKind !== kind) return fail("invalid", "Local target has a different type");
      return { ...result, status: "resolved", kind };
    }
    function f_formatRepositoryLink2(targetPath, sourcePath, repositories, kind) {
      const source = f_repositoryForPath2(sourcePath, repositories);
      const target = f_repositoryForPath2(targetPath, repositories);
      if (!source || !target) throw new Error("Repository map is unavailable for this link");
      const sameCheckout = source.root === target.root;
      if (!sameCheckout && (!target.identity || source.identity === target.identity || repositories.filter((repo) => typeof repo.root === "string" && repo.identity === target.identity).length !== 1)) {
        throw new Error("Target checkout cannot be addressed by a unique GitHub link");
      }
      const relative = f_repoPath(targetPath, target);
      const encoded = relative.split("/").map(
        (part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase())
      ).join("/");
      const directory = kind === "folder";
      const suffix = directory && relative ? "/" : "";
      const destination = sameCheckout ? "/" + encoded + suffix : "https://github.com/" + target.identity + "/" + (directory ? "tree" : "blob") + "/main/" + encoded + suffix;
      const label = (sameCheckout ? relative || "/" : target.identity.split("/")[1] + "/" + relative) + suffix;
      return "[" + label.replace(/([\\\[\]*_`<>&~])/g, "\\$1") + "](" + destination + ")";
    }
    module2.exports = { f_scanMarkdownLinks: f_scanMarkdownLinks2, f_originIdentity, f_repositoryForPath: f_repositoryForPath2, f_resolveRepositoryLink: f_resolveRepositoryLink2, f_formatRepositoryLink: f_formatRepositoryLink2 };
  }
});

// src/native-repository-links.js
var require_native_repository_links = __commonJS({
  "src/native-repository-links.js"(exports2, module2) {
    "use strict";
    function f_installNativeRepositoryLinks2({ metadataCache, vault, scan, resolve }) {
      const methods = ["getCache", "getFirstLinkpathDest", "iterateAllRefs"];
      if (![...methods, "on", "offref", "queueFileForLinkResolution", "resolveLinks"].every((name) => typeof metadataCache?.[name] === "function") || !["on", "offref", "getFileByPath", "getMarkdownFiles", "cachedRead"].every((name) => typeof vault?.[name] === "function")) return null;
      const descriptors = methods.map((name) => Object.getOwnPropertyDescriptor(metadataCache, name));
      if (descriptors.some((descriptor) => descriptor && !descriptor.configurable) || !Object.isExtensible(metadataCache) && descriptors.some((descriptor) => !descriptor)) return null;
      const getCache = metadataCache.getCache;
      const getFirstLinkpathDest = metadataCache.getFirstLinkpathDest;
      const iterateAllRefs = metadataCache.iterateAllRefs;
      const entries = /* @__PURE__ */ new Map();
      let active = true;
      let pendingRefresh;
      let reprojectQueued = false;
      let reprojection;
      let reprojectAgain = false;
      function f_currentEntry(sourcePath) {
        const entry = entries.get(sourcePath);
        return entry && entry.base === getCache.call(metadataCache, sourcePath) ? entry : void 0;
      }
      const patches = [
        function f_getCache(sourcePath) {
          const base = getCache.call(this, sourcePath);
          const entry = entries.get(sourcePath);
          return entry && entry.base === base && entry.overlay ? entry.overlay : base;
        },
        function f_getFirstLinkpathDest(linkPath, sourcePath) {
          const target = typeof linkPath === "string" && linkPath.startsWith("\0atpath:") && f_currentEntry(sourcePath)?.targets.get(linkPath);
          return target ? vault.getFileByPath(target) : getFirstLinkpathDest.call(this, linkPath, sourcePath);
        },
        function f_iterateAllRefs(visit) {
          const stopped = /* @__PURE__ */ new Set();
          const result = iterateAllRefs.call(this, (sourcePath, reference) => {
            const start = reference.position?.start.offset;
            if (entries.get(sourcePath)?.removed.has(start) && f_currentEntry(sourcePath)) return;
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
        }
      ];
      for (const [index, name] of methods.entries()) {
        Object.defineProperty(metadataCache, name, { configurable: true, writable: true, value: patches[index] });
      }
      function f_project(sourcePath, entry) {
        const targets = /* @__PURE__ */ new Map();
        const removed = /* @__PURE__ */ new Set();
        const references = [];
        for (const { destination, label, position, original } of entry.links) {
          const result = resolve(destination, sourcePath);
          if (!result) continue;
          const { offset } = position.start;
          removed.add(offset);
          if (!result.file) continue;
          const link = "\0atpath:" + offset;
          targets.set(link, result.file.path);
          references.push({ link, original, displayText: label, position });
        }
        const changed = removed.size !== entry.removed.size || [...removed].some((offset) => !entry.removed.has(offset)) || targets.size !== entry.targets.size || [...targets].some(([key, path]) => entry.targets.get(key) !== path);
        if (!changed) return false;
        entry.targets = targets;
        entry.removed = removed;
        entry.references = references;
        entry.overlay = removed.size ? {
          ...entry.base,
          links: [...(entry.base.links ?? []).filter((reference) => !removed.has(reference.position?.start.offset)), ...references].sort((left, right) => left.position.start.offset - right.position.start.offset)
        } : null;
        return true;
      }
      function f_index(file, text, base) {
        if (!active || !base || file.extension !== "md" || vault.getFileByPath(file.path) !== file) return;
        const sourcePath = file.path;
        const previous = entries.get(sourcePath);
        const links = scan(text).filter(({ destination }) => destination.startsWith("/") && !destination.startsWith("//") || /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\//i.test(destination)).map((link) => ({
          ...link,
          original: text.slice(link.position.start.offset, link.position.end.offset)
        }));
        const entry = { base, links, targets: /* @__PURE__ */ new Map(), removed: /* @__PURE__ */ new Set(), references: [], overlay: null };
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
        if (file.path === path && file.stat.mtime === mtime && file.stat.size === size && getCache.call(metadataCache, path) === base && entries.get(path)?.base !== base) {
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
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
                batchStart = Date.now();
              }
            }
          } while (reprojectAgain);
        })().finally(() => {
          reprojection = null;
        });
        return reprojection;
      }
      function f_queueReprojection() {
        if (reprojectQueued) return;
        reprojectQueued = true;
        queueMicrotask(() => {
          reprojectQueued = false;
          if (active) void f_reproject().catch((error) => console.warn("AtPath metadata refresh failed", error));
        });
      }
      const metadataEvent = metadataCache.on("changed", f_index);
      const vaultEvents = [
        vault.on("create", f_queueReprojection),
        vault.on("delete", (file) => {
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
              void f_read(file).catch((error) => console.warn("AtPath metadata refresh failed", error));
            }
          }
          f_queueReprojection();
        })
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
                  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
                  batchSize = 0;
                  batchStart = Date.now();
                }
              }
            })().finally(() => {
              pendingRefresh = null;
            });
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
        }
      };
    }
    module2.exports = { f_installNativeRepositoryLinks: f_installNativeRepositoryLinks2 };
  }
});

// src/repository-index.js
var require_repository_index = __commonJS({
  "src/repository-index.js"(exports2, module2) {
    "use strict";
    var { f_originIdentity } = require_repository_links();
    var REPOSITORY_MAP_PATH2 = "repository-map.json";
    var SKIP_DIRECTORIES = /* @__PURE__ */ new Set(["data", "node_modules", "venv", "dist", "build", "__pycache__"]);
    async function f_discoverRepositories2(basePath) {
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
        if (entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
          const [origin, refs] = await Promise.allSettled([
            run("git", ["config", "--local", "--get", "remote.origin.url"], { cwd, timeout: 5e3 }),
            run("git", ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"], { cwd, timeout: 5e3 })
          ]);
          const identity = origin.status === "fulfilled" ? f_originIdentity(origin.value.stdout) : null;
          const names = refs.status === "fulfilled" ? refs.value.stdout.split("\n").filter(Boolean).map(
            (ref) => ref.replace(/^refs\/(?:heads\/|tags\/|remotes\/[^/]+\/)/, "")
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
        if (root !== void 0 && (typeof root !== "string" || root && root.split("/").some((part) => !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))) || identity !== null && !/^[\w.-]+\/[\w.-]+$/.test(identity) || refs !== void 0 && (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) || aliases !== void 0 && (!Array.isArray(aliases) || aliases.some((alias) => !/^[\w.-]+\/[\w.-]+$/.test(alias)))) {
          throw new Error("Invalid repository map entry " + JSON.stringify({ root, identity }));
        }
      }
      return map.repositories;
    }
    async function f_writeRepositoryMap2(adapter, repositories) {
      const text = JSON.stringify({ version: 1, repositories }, null, 2) + "\n";
      if (await adapter.exists(REPOSITORY_MAP_PATH2) && await adapter.read(REPOSITORY_MAP_PATH2) === text) return;
      await adapter.write(REPOSITORY_MAP_PATH2, text);
    }
    async function f_readRepositoryMap2(adapter) {
      return await adapter.exists(REPOSITORY_MAP_PATH2) ? f_parseRepositoryMap(await adapter.read(REPOSITORY_MAP_PATH2)) : [];
    }
    async function f_lookupRenamedRepository2(identity) {
      const { execFile } = require("child_process");
      const { promisify } = require("util");
      const { stdout } = await promisify(execFile)(
        "gh",
        ["api", "repos/" + identity, "--jq", ".full_name"],
        { timeout: 8e3 }
      );
      return f_originIdentity("github.com/" + stdout.trim());
    }
    module2.exports = {
      REPOSITORY_MAP_PATH: REPOSITORY_MAP_PATH2,
      f_discoverRepositories: f_discoverRepositories2,
      f_lookupRenamedRepository: f_lookupRenamedRepository2,
      f_readRepositoryMap: f_readRepositoryMap2,
      f_writeRepositoryMap: f_writeRepositoryMap2
    };
  }
});

// src/site-icon.js
var require_site_icon = __commonJS({
  "src/site-icon.js"(exports2, module2) {
    function escapeHtmlAttr(value) {
      return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function isImageDataUrl(value) {
      return typeof value === "string" && /^data:image\//i.test(value.trim());
    }
    function getImageMimeType(siteIconDataUrl) {
      const match = String(siteIconDataUrl || "").match(/^data:([^;,]+)/i);
      return match ? match[1] : "image/png";
    }
    function buildSiteIconHeadHtml(siteIconDataUrl) {
      if (!isImageDataUrl(siteIconDataUrl)) return "";
      const href = escapeHtmlAttr(siteIconDataUrl.trim());
      const mimeType = escapeHtmlAttr(getImageMimeType(siteIconDataUrl));
      return `<link rel="icon" type="${mimeType}" href="${href}">
<link rel="shortcut icon" type="${mimeType}" href="${href}">`;
    }
    function hasIconLink(html) {
      return /<link\b[^>]*\brel\s*=\s*["'][^"']*\bicon\b[^"']*["'][^>]*>/i.test(String(html || ""));
    }
    function injectSiteIconIntoHtml2(html, siteIconDataUrl) {
      if (typeof html !== "string" || !html) return html;
      const iconHeadHtml = buildSiteIconHeadHtml(siteIconDataUrl);
      if (!iconHeadHtml || hasIconLink(html)) return html;
      if (/<\/head>/i.test(html)) {
        return html.replace(/<\/head>/i, iconHeadHtml + "\n</head>");
      }
      if (/<head\b[^>]*>/i.test(html)) {
        return html.replace(/<head\b[^>]*>/i, (match) => match + "\n" + iconHeadHtml);
      }
      if (/<html\b[^>]*>/i.test(html)) {
        return html.replace(/<html\b[^>]*>/i, (match) => match + "\n<head>\n" + iconHeadHtml + "\n</head>");
      }
      return "<head>\n" + iconHeadHtml + "\n</head>\n" + html;
    }
    function applySiteIconToDeployFiles2(deployFiles, siteIconDataUrl) {
      if (!Array.isArray(deployFiles) || !siteIconDataUrl) return deployFiles;
      return deployFiles.map((file) => {
        const filePath = String(file && (file.path || file.relPath) || "");
        const isHtmlFile = /\.html?$/i.test(filePath);
        if (!isHtmlFile || typeof file.content !== "string") return file;
        const nextContent = injectSiteIconIntoHtml2(file.content, siteIconDataUrl);
        if (nextContent === file.content) return file;
        return { ...file, content: nextContent };
      });
    }
    module2.exports = {
      buildSiteIconHeadHtml,
      injectSiteIconIntoHtml: injectSiteIconIntoHtml2,
      applySiteIconToDeployFiles: applySiteIconToDeployFiles2
    };
  }
});

// src/html-builder.js
var require_html_builder = __commonJS({
  "src/html-builder.js"(exports2, module2) {
    var markdownit = require_index_cjs4();
    var { buildSiteIconHeadHtml } = require_site_icon();
    var HLJS_CSS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/atom-one-dark.min.css";
    var HLJS_JS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js";
    var MERMAID_JS = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    function makeFence2(content) {
      let max = 2;
      const runs = content.match(/`{3,}/g);
      if (runs) for (const r of runs) {
        if (r.length > max) max = r.length;
      }
      return "`".repeat(max + 1);
    }
    var MARKDOWN_EXTENSIONS = /* @__PURE__ */ new Set(["md", "markdown"]);
    var mdi = markdownit({ html: true, linkify: true, typographer: true });
    mdi.core.ruler.after("inline", "repository_links", (state) => {
      const context = state.env.repositoryLinks;
      if (!context) return;
      for (const block of state.tokens) {
        if (block.type !== "inline") continue;
        const tokens = block.children;
        for (let index = 0; index < tokens.length; index++) {
          const open = tokens[index];
          if (open.type !== "link_open") continue;
          const destination = open.attrGet("href");
          if (!destination || destination.startsWith("#")) continue;
          const resolved = context.resolveLink(destination, context.sourcePath);
          if (!resolved || resolved.status === "out-of-scope") continue;
          let closeIndex = index + 1;
          while (tokens[closeIndex]?.type !== "link_close") closeIndex++;
          const slug = !state.env.nestedRepositoryLinks && resolved.status === "resolved" ? context.slugsByPath?.get(resolved.vaultPath) : null;
          if (slug) {
            open.attrSet("href", "atpath/" + slug + ".html" + (resolved.fragment || ""));
            open.attrJoin("class", "atpath-ref");
            if (state.env.compactLinks) {
              const label = new open.constructor("text", "", 0);
              label.content = resolved.vaultPath.split("/").pop();
              tokens.splice(index + 1, closeIndex - index - 1, label);
              closeIndex = index + 2;
            }
          } else {
            open.tag = tokens[closeIndex].tag = "span";
            open.attrs = [["class", "atpath-nested"]];
          }
          index = closeIndex;
        }
      }
    });
    function preprocessObsidianImages(md) {
      return md.replace(
        /!\[([^\]]*?)\|(\d+)\]\(([^)]+)\)/g,
        '<img src="$3" alt="$1" width="$2" style="max-width:100%">'
      );
    }
    function renderMarkdown(md, context) {
      return mdi.render(preprocessObsidianImages(md), context);
    }
    var HEADING_RE = /^<(h[1-4])>(.*?)<\/\1>$/i;
    function slugifyHeading(text) {
      return text.replace(/<[^>]+>/g, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
    }
    function wrapSections(html) {
      const lines = html.split("\n");
      const out = [];
      const stack = [];
      const usedSlugs = /* @__PURE__ */ new Set();
      function uniqueSlug(base) {
        let slug = base;
        let n = 2;
        while (usedSlugs.has(slug)) {
          slug = base + "-" + n++;
        }
        usedSlugs.add(slug);
        return slug;
      }
      for (const line of lines) {
        const m = line.match(HEADING_RE);
        if (!m) {
          out.push(line);
          continue;
        }
        const tag = m[1].toLowerCase();
        const level = parseInt(tag[1], 10);
        const content = m[2];
        const slug = uniqueSlug(slugifyHeading(content));
        if (level === 1) {
          out.push(`<${tag} id="${slug}">${content}</${tag}>`);
          continue;
        }
        while (stack.length > 0 && stack[stack.length - 1] >= level) {
          stack.pop();
          out.push("</details>");
        }
        stack.push(level);
        out.push(`<details id="${slug}">`);
        out.push(`<summary><${tag}>${content}</${tag}></summary>`);
      }
      while (stack.length > 0) {
        stack.pop();
        out.push("</details>");
      }
      return out.join("\n");
    }
    function foldBoldListItems(html) {
      const lines = html.split("\n");
      const out = [];
      let i = 0;
      while (i < lines.length) {
        if (lines[i].trim() === "<li>" && i + 1 < lines.length && /^<p><strong>.*<\/strong><\/p>$/.test(lines[i + 1].trim())) {
          const titleMatch = lines[i + 1].match(/<p><strong>(.*?)<\/strong><\/p>/);
          const title = titleMatch[1];
          let depth = 1;
          let j = i + 2;
          const content = [];
          while (j < lines.length && depth > 0) {
            const opens = (lines[j].match(/<li[\s>]/g) || []).length;
            const closes = (lines[j].match(/<\/li>/g) || []).length;
            depth += opens - closes;
            if (depth <= 0) break;
            content.push(lines[j]);
            j++;
          }
          out.push("<li>");
          out.push(`<details class="principle"><summary><strong>${title}</strong></summary>`);
          out.push(...content);
          out.push("</details>");
          out.push("</li>");
          i = j + 1;
        } else {
          out.push(lines[i]);
          i++;
        }
      }
      return out.join("\n");
    }
    var CSS_TEMPLATE = `
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; padding: 3.5rem 1rem 2rem;
  background: #1e1e1e; color: #dcddde;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
               "Helvetica Neue", Arial, sans-serif;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.container { max-width: 100%; padding: 0 1rem; }
h1 { font-size: 1.8em; text-decoration: underline; margin-top: 0; }
h2 { font-size: 1.554em; }
h3 { font-size: 1.342em; }
h4 { font-size: 1.158em; }
h5, h6 { font-size: 1em; }
p { margin: 0 0 0.9em 0; }
a { color: #a88bfa; text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { padding-left: 1.8em; margin: 0 0 0.9em 0; }
li { margin-bottom: 0.25em; }
li > ul, li > ol { margin-top: 0.25em; margin-bottom: 0; }
img { border-radius: 4px; display: block; margin: 0.9em 0; }
code {
  background: #2d2d2d; padding: 0.15em 0.35em;
  border-radius: 3px; font-size: 0.9em;
}
pre {
  background: #2d2d2d; padding: 1em;
  border-radius: 6px; overflow-x: auto; margin: 0 0 0.9em 0;
}
pre code { background: none; padding: 0; }
strong { color: #e0e0e0; }
details {
  border-left: 2px solid #444;
  margin: 0.4em 0 0.4em 0.2em; padding-left: 0.8em;
}
details > details { border-left-color: #555; }
summary {
  cursor: pointer; list-style: none;
  position: relative; padding-left: 1.2em;
}
summary::-webkit-details-marker { display: none; }
summary::before {
  content: "\\25B6"; position: absolute; left: 0; top: 0.15em;
  font-size: 0.7em; color: #888; transition: transform 0.15s ease;
}
details[open] > summary::before { transform: rotate(90deg); }
summary h2, summary h3, summary h4 { display: inline; margin: 0; }
details.principle { border-left: none; margin: 0.2em 0; padding-left: 0; }
details.principle > summary { padding-left: 1.2em; }
details.principle > summary strong { font-size: 1em; }
.top-btns {
  position: fixed; top: 1rem; right: 1rem;
  display: flex; gap: 0.5rem; z-index: 10;
}
.contact-btn {
  background: #25d366; color: #fff; border: 1px solid #1da851;
  padding: 0.4em 0.8em; border-radius: 6px; font-size: 0.85em;
  text-decoration: none; transition: background 0.15s;
}
.contact-btn:hover { background: #1da851; text-decoration: none; color: #fff; }
.dl-btn {
  background: #2d2d2d; color: #a88bfa; border: 1px solid #444;
  padding: 0.4em 0.8em; border-radius: 6px; font-size: 0.85em;
  text-decoration: none; transition: background 0.15s;
}
.dl-btn:hover { background: #3a3a3a; text-decoration: none; }
hr { border: none; border-top: 1px solid #444; margin: 1.5em 0; }
.atpath-ref {
  color: #a88bfa; text-decoration: underline dotted;
  cursor: pointer;
}
.atpath-ref:hover { text-decoration: underline solid; }
.atpath-nested {
  color: #a88bfa; opacity: 0.6;
  font-style: italic;
}
.back-nav {
  margin-bottom: 1.5em; padding-bottom: 0.8em;
  border-bottom: 1px solid #444;
}
.back-nav a { font-size: 0.95em; }
pre code.hljs { background: transparent; padding: 0; }
.mermaid { text-align: center; margin: 1em 0; }
.mermaid svg { max-width: 100%; }
`;
    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function topButtons(downloadBase64, downloadFilename, contactUrl, contactLabel) {
      let btns = "";
      if (contactUrl) {
        btns += `  <a class="contact-btn" href="${escapeHtml(contactUrl)}" target="_blank" rel="noopener">${escapeHtml(contactLabel || "Contact")}</a>
`;
      }
      const ext = (downloadFilename.match(/\.(\w+)$/) || [])[1] || "md";
      const mime = ext === "md" ? "text/markdown" : "text/plain";
      btns += `  <a class="dl-btn" href="data:${mime};base64,${downloadBase64}" download="${escapeHtml(downloadFilename)}">Baixar .${ext}</a>
`;
      return `<div class="top-btns">
${btns}</div>`;
    }
    function htmlPage(title, bodyContent, extraHead, siteIconDataUrl) {
      const siteIconHead = buildSiteIconHeadHtml(siteIconDataUrl);
      const headParts = [];
      if (siteIconHead) headParts.push(siteIconHead);
      if (extraHead) headParts.push(extraHead);
      return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS_TEMPLATE}</style>
<link rel="stylesheet" href="${HLJS_CSS}">
${headParts.length > 0 ? headParts.join("\n") : ""}
</head>
<body>
${bodyContent}
<script src="${HLJS_JS}"></script>
<script src="${MERMAID_JS}"></script>
<script>
(function() {
  try {
    document.querySelectorAll('pre code').forEach(function(el) {
      if (!el.classList.contains('language-mermaid')) hljs.highlightElement(el);
    });
  } catch(e) {}
  try {
    document.querySelectorAll('pre code.language-mermaid').forEach(function(el) {
      var div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = el.textContent;
      el.closest('pre').replaceWith(div);
    });
    mermaid.initialize({ startOnLoad: false, theme: 'dark' });
    mermaid.run();
  } catch(e) {}
  // Anchor navigation for collapsed <details> sections
  (function() {
    function openTarget(hash) {
      if (!hash) return;
      var el = document.getElementById(hash.replace(/^#/, ''));
      if (!el) return;
      var node = el;
      while (node) {
        if (node.tagName === 'DETAILS') node.open = true;
        node = node.parentElement;
      }
      if (el.tagName === 'DETAILS') el.open = true;
      el.scrollIntoView({ behavior: 'smooth' });
    }
    if (location.hash) openTarget(location.hash);
    document.addEventListener('click', function(e) {
      var a = e.target.closest('a[href^="#"]');
      if (!a) return;
      e.preventDefault();
      var href = a.getAttribute('href');
      history.pushState(null, '', href);
      openTarget(href);
    });
    window.addEventListener('hashchange', function() { openTarget(location.hash); });
  })();
})();
</script>
</body>
</html>`;
    }
    function slugifyPath2(filePath) {
      return filePath.replace(/[\/\\.]/g, "-").replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").toLowerCase();
    }
    var AT_PATH_RE2 = /(?<=^|[\s(])@([\w\p{L}\p{M}./_-]+\.[\w]+|[\w\p{L}\p{M}./_-][\w\p{L}\p{M}./ _()&-]+?\.[\w]+)/gu;
    var WIKILINK_ATPATH_RE2 = /\[\[([^\]|]+)\|@([^\]]+)\]\]/g;
    function replaceAtPathsWithLinks(md, atPathSlugs, compactLinks) {
      let result = md.replace(new RegExp(WIKILINK_ATPATH_RE2.source, WIKILINK_ATPATH_RE2.flags), (match, _target, display) => {
        const slug = atPathSlugs.get(display);
        if (slug) {
          const linkText = compactLinks ? display.split("/").pop() : "@" + display;
          return `<a href="atpath/${slug}.html" class="atpath-ref">${linkText}</a>`;
        }
        return "@" + display;
      });
      const regex = new RegExp(AT_PATH_RE2.source, AT_PATH_RE2.flags);
      result = result.replace(regex, (match, relPath) => {
        const slug = atPathSlugs.get(relPath);
        if (slug) {
          const linkText = compactLinks ? relPath.split("/").pop() : "@" + relPath;
          return `<a href="atpath/${slug}.html" class="atpath-ref">${linkText}</a>`;
        }
        return match;
      });
      return result;
    }
    function replaceNestedAtPaths(md) {
      let result = md.replace(new RegExp(WIKILINK_ATPATH_RE2.source, WIKILINK_ATPATH_RE2.flags), (_, _target, display) => {
        return `<span class="atpath-nested">@${escapeHtml(display)}</span>`;
      });
      const regex = new RegExp(AT_PATH_RE2.source, AT_PATH_RE2.flags);
      result = result.replace(regex, (match, relPath) => {
        return `<span class="atpath-nested">@${escapeHtml(relPath)}</span>`;
      });
      return result;
    }
    function processMarkdown(md, context) {
      let html = renderMarkdown(md, context);
      html = wrapSections(html);
      html = foldBoldListItems(html);
      return html;
    }
    function toBase64(str) {
      if (typeof Buffer !== "undefined") return Buffer.from(str).toString("base64");
      return btoa(unescape(encodeURIComponent(str)));
    }
    function buildMainPage2(title, markdown, atPathSlugs, contactUrl, contactLabel, compactLinks, siteIconDataUrl, repositoryLinks) {
      const mdBase64 = toBase64(markdown);
      const downloadFilename = title + ".md";
      let md = replaceAtPathsWithLinks(markdown, atPathSlugs, compactLinks);
      const bodyHtml = processMarkdown(md, { repositoryLinks, compactLinks });
      const buttons = topButtons(mdBase64, downloadFilename, contactUrl, contactLabel);
      return htmlPage(title, `${buttons}
<div class="container">
${bodyHtml}
</div>`, "", siteIconDataUrl);
    }
    function buildAtPathPage2(title, markdown, mainPageTitle, contactUrl, contactLabel, siteIconDataUrl, repositoryLinks) {
      const mdBase64 = toBase64(markdown);
      const downloadFilename = title.replace(/\//g, "-");
      const ext = ((repositoryLinks?.sourcePath || title).match(/\.(\w+)$/) || [])[1]?.toLowerCase();
      let md = markdown;
      if (ext && !MARKDOWN_EXTENSIONS.has(ext)) {
        const fence = makeFence2(md);
        md = fence + ext + "\n" + md + "\n" + fence;
      }
      md = replaceNestedAtPaths(md);
      const bodyHtml = processMarkdown(md, { repositoryLinks, nestedRepositoryLinks: true });
      const buttons = topButtons(mdBase64, downloadFilename, contactUrl, contactLabel);
      const backNav = `<div class="back-nav"><a href="../index.html">&larr; Back to ${escapeHtml(mainPageTitle)}</a></div>`;
      return htmlPage(title, `${buttons}
<div class="container">
${backNav}
${bodyHtml}
</div>`, "", siteIconDataUrl);
    }
    function buildUnpublishedPage2(noteTitle, siteIconDataUrl) {
      const bodyContent = `<div class="container" style="display:flex;justify-content:center;align-items:center;min-height:80vh">
<div style="text-align:center">
<h1>${escapeHtml(noteTitle)}</h1>
<p style="color:#888;font-size:1.1em">Content unpublished by owner.</p>
</div>
</div>`;
      return htmlPage(noteTitle, bodyContent, "", siteIconDataUrl);
    }
    module2.exports = { buildMainPage: buildMainPage2, buildAtPathPage: buildAtPathPage2, buildUnpublishedPage: buildUnpublishedPage2, slugifyPath: slugifyPath2, slugifyHeading, AT_PATH_RE: AT_PATH_RE2, CSS_TEMPLATE };
  }
});

// src/vercel-api.js
var require_vercel_api = __commonJS({
  "src/vercel-api.js"(exports2, module2) {
    var { requestUrl: requestUrl2 } = require("obsidian");
    var VERCEL_API = "https://api.vercel.com";
    function slugify2(title) {
      return title.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
    }
    function buildRequestError(service, method, path, status, detail) {
      let message = service + " " + method + " " + path + " failed";
      if (status != null) message += ", status " + status;
      if (detail) message += ": " + detail;
      const err = new Error(message);
      if (status != null) err.status = status;
      return err;
    }
    function extractErrorDetail(data, text) {
      if (data && typeof data === "object") {
        if (typeof data.error === "string") return data.error;
        if (data.error && typeof data.error.message === "string") return data.error.message;
        if (typeof data.message === "string") return data.message;
      }
      if (typeof text === "string" && text.trim()) return text.trim();
      return "";
    }
    async function apiCall(token, method, path, body) {
      const options = {
        url: VERCEL_API + path,
        method,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        }
      };
      if (body) options.body = JSON.stringify(body);
      let resp;
      try {
        resp = await requestUrl2(options);
      } catch (e) {
        const status = typeof e.status === "number" ? e.status : null;
        throw buildRequestError("Vercel API", method, path, status, e.message || "");
      }
      if (resp.status >= 400) {
        throw buildRequestError("Vercel API", method, path, resp.status, extractErrorDetail(resp.json, resp.text));
      }
      return { status: resp.status, data: resp.json };
    }
    async function checkProjectAvailability2(token, slug) {
      try {
        const { status, data } = await apiCall(token, "GET", `/v9/projects/${slug}`);
        if (status === 200 && data && data.id) return "ours";
      } catch (e) {
        if (e.status === 404) return "available";
        throw e;
      }
      return "available";
    }
    async function ensureProject2(token, slug) {
      try {
        const { status, data } = await apiCall(token, "GET", `/v9/projects/${slug}`);
        if (status === 200 && data && data.id) {
          await apiCall(token, "PATCH", `/v9/projects/${slug}`, {
            buildCommand: "",
            outputDirectory: "",
            framework: null
          });
          return slug;
        }
      } catch (e) {
        if (e.status && e.status !== 404) throw new Error("Vercel API error: " + (e.message || e.status));
      }
      try {
        await apiCall(token, "POST", "/v10/projects", {
          name: slug,
          framework: null
        });
        return slug;
      } catch (e) {
        if (e.status === 409 || e.message && e.message.includes("already")) {
          throw new Error('The project name "' + slug + '" is already taken on Vercel. Please choose a different name.');
        }
        throw new Error("Failed to create Vercel project: " + (e.message || e.status));
      }
    }
    async function setEnvVars(token, projectSlug, vars) {
      const { data: existing } = await apiCall(token, "GET", `/v9/projects/${projectSlug}/env`);
      const envList = existing && existing.envs || [];
      const envMap = {};
      for (const e of envList) {
        envMap[e.key] = e.id;
      }
      for (const [key, value] of Object.entries(vars)) {
        if (envMap[key]) {
          await apiCall(token, "PATCH", `/v9/projects/${projectSlug}/env/${envMap[key]}`, {
            value,
            type: "encrypted",
            target: ["production"]
          });
        } else {
          await apiCall(token, "POST", `/v10/projects/${projectSlug}/env`, {
            key,
            value,
            type: "encrypted",
            target: ["production"]
          });
        }
      }
    }
    async function waitForDeployment(token, deploymentId, onProgress, timeoutMs) {
      if (!timeoutMs) timeoutMs = 6e4;
      const interval = 3e3;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const { data } = await apiCall(token, "GET", `/v13/deployments/${deploymentId}`);
        const state = data && data.readyState;
        if (state === "READY") return { ready: true, url: data.url, state };
        if (state === "ERROR" || state === "CANCELED") {
          const detail = data.errorMessage || state;
          return { ready: false, url: data.url, state, error: detail };
        }
        if (onProgress) {
          const label = state === "BUILDING" ? "Building..." : "Deploying...";
          onProgress(label);
        }
        await new Promise((r) => setTimeout(r, interval));
      }
      return { ready: false, state: "TIMEOUT", error: "Deployment timed out after " + timeoutMs / 1e3 + "s" };
    }
    async function healthCheck(url) {
      await new Promise((r) => setTimeout(r, 2e3));
      try {
        const resp = await requestUrl2({ url, method: "GET" });
        const text = typeof resp.text === "string" ? resp.text : "";
        if (text.includes("NOT_FOUND") || text.includes("DEPLOYMENT_NOT_FOUND")) {
          return { ok: false, status: resp.status, detail: "Vercel returned NOT_FOUND at deployed URL" };
        }
        if (resp.status >= 400) {
          return { ok: false, status: resp.status, detail: "HTTP " + resp.status };
        }
        return { ok: true, status: resp.status };
      } catch (e) {
        return { ok: false, status: null, detail: e.message || String(e) };
      }
    }
    async function resolveReachableUrl(preferredUrl, fallbackUrl) {
      const preferredHealth = await healthCheck(preferredUrl);
      if (preferredHealth.ok || !fallbackUrl || fallbackUrl === preferredUrl) {
        return { url: preferredUrl, healthCheck: preferredHealth };
      }
      const fallbackHealth = await healthCheck(fallbackUrl);
      if (fallbackHealth.ok) {
        return { url: fallbackUrl, healthCheck: fallbackHealth };
      }
      return { url: preferredUrl, healthCheck: preferredHealth };
    }
    async function deployToVercel2(token, noteTitle, files, opts) {
      const projectName = opts && opts.projectName || await ensureProject2(token, slugify2(noteTitle));
      const onProgress = opts && opts.onProgress;
      if (opts && opts.isPrivate && opts.envVars) {
        await setEnvVars(token, projectName, opts.envVars);
      }
      const fileEntries = files.map((f) => ({
        file: f.path,
        data: f.content,
        encoding: f.encoding || "utf-8"
      }));
      const { data } = await apiCall(token, "POST", "/v13/deployments", {
        name: projectName,
        target: "production",
        projectSettings: { framework: null },
        files: fileEntries
      });
      const deploymentId = data && data.id;
      const projectUrl = "https://" + projectName + ".vercel.app";
      let deploymentUrl = data && data.url ? "https://" + data.url : "";
      const result = { url: deploymentUrl || projectUrl, projectName, deploymentState: "UNKNOWN" };
      if (!deploymentId) return result;
      const readyState = data.readyState;
      if (readyState === "READY") {
        result.deploymentState = "READY";
      } else if (readyState === "ERROR" || readyState === "CANCELED") {
        result.deploymentState = readyState;
        result.deploymentError = data.errorMessage || readyState;
      } else {
        if (onProgress) onProgress("Building...");
        const poll = await waitForDeployment(token, deploymentId, onProgress);
        result.deploymentState = poll.state || "UNKNOWN";
        if (poll.error) result.deploymentError = poll.error;
        if (!deploymentUrl && poll.url) {
          deploymentUrl = "https://" + poll.url;
          result.url = deploymentUrl;
        }
      }
      if (result.deploymentState === "READY") {
        try {
          const { data: projData } = await apiCall(token, "GET", `/v9/projects/${projectName}`);
          const aliases = projData && projData.targets && projData.targets.production && projData.targets.production.alias;
          const expectedAlias = projectName + ".vercel.app";
          const vercelAlias = aliases && aliases.find((a) => a.endsWith(".vercel.app"));
          if (vercelAlias && vercelAlias !== expectedAlias) {
            result.deploymentState = "NAME_TRUNCATED";
            result.deploymentError = 'The project name "' + projectName + '" is too long for a .vercel.app URL. Vercel shortened it to "' + vercelAlias.replace(".vercel.app", "") + '". Please shorten the note title and try again.';
            const resolved = await resolveReachableUrl("https://" + vercelAlias, deploymentUrl);
            result.url = resolved.url;
            result.healthCheck = resolved.healthCheck;
          } else {
            const preferredUrl = vercelAlias ? "https://" + vercelAlias : deploymentUrl || projectUrl;
            const resolved = await resolveReachableUrl(preferredUrl, deploymentUrl);
            result.url = resolved.url;
            result.healthCheck = resolved.healthCheck;
          }
        } catch (_) {
          const resolved = await resolveReachableUrl(result.url, deploymentUrl);
          result.url = resolved.url;
          result.healthCheck = resolved.healthCheck;
        }
      }
      return result;
    }
    module2.exports = { slugify: slugify2, ensureProject: ensureProject2, checkProjectAvailability: checkProjectAvailability2, deployToVercel: deployToVercel2, setEnvVars };
  }
});

// src/auth-shell-builder.js
var require_auth_shell_builder = __commonJS({
  "src/auth-shell-builder.js"(exports2, module2) {
    var { CSS_TEMPLATE } = require_html_builder();
    var { buildSiteIconHeadHtml } = require_site_icon();
    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function buildAuthShell2(noteTitle, clerkPublishableKey, publisherEmail, publisherWhatsapp, siteIconDataUrl) {
      const title = escapeHtml(noteTitle);
      const pubKeyJSON = JSON.stringify(clerkPublishableKey);
      const publisherEmailJSON = JSON.stringify(publisherEmail || "");
      const publisherWhatsappJSON = JSON.stringify(publisherWhatsapp || "");
      const siteIconHead = buildSiteIconHeadHtml(siteIconDataUrl);
      return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${CSS_TEMPLATE}</style>
${siteIconHead}
</head>
<body>
<div class="container">
  <h1>${title}</h1>
  <div id="auth-ui">
    <p id="auth-msg" style="text-align:center;color:#888">Carregando...</p>
  </div>
</div>

<script>
(async function() {
  var authUI  = document.getElementById('auth-ui');
  var authMsg = document.getElementById('auth-msg');
  var publishableKey = ${pubKeyJSON};
  var publisherEmail = ${publisherEmailJSON};
  var publisherWhatsapp = ${publisherWhatsappJSON};
  var pollTimer = null;

  // Derive pageKey from URL
  var path = window.location.pathname.replace(/^\\//, '').replace(/\\.html?$/, '');
  var pageKey = path || 'main';
  if (pageKey === 'index') pageKey = 'main';

  // Load Clerk JS SDK \u2014 data-clerk-publishable-key triggers auto-init of window.Clerk
  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
  script.crossOrigin = 'anonymous';
  script.setAttribute('data-clerk-publishable-key', publishableKey);
  script.onload = function() {
    initClerk().catch(function(e) {
      authMsg.style.display = '';
      authMsg.textContent = 'Erro de autentica\\u00e7\\u00e3o: ' + (e.message || e);
    });
  };
  script.onerror = function() { authMsg.textContent = 'Falha ao carregar autentica\\u00e7\\u00e3o.'; };
  document.head.appendChild(script);

  function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); btn.textContent = 'Copiado!'; } catch(e) { btn.textContent = 'Falha ao copiar'; }
    document.body.removeChild(ta);
  }

  function showContent(html) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    document.open();
    document.write(html);
    document.close();
  }

  function startApprovalPoll(clerk) {
    if (pollTimer) return;
    pollTimer = setInterval(async function() {
      try {
        var session = clerk.session;
        if (!session) return;
        var t = await session.getToken();
        var r = await fetch('/api/auth?page=' + encodeURIComponent(pageKey), {
          headers: { 'Authorization': 'Bearer ' + t }
        });
        if (r.status === 200) {
          var html = await r.text();
          showContent(html);
        }
      } catch(e) {}
    }, 15000);
  }

  async function fetchContent(clerk) {
    authMsg.textContent = 'Verificando acesso...';
    authMsg.style.display = '';

    var session = clerk.session;
    if (!session) {
      authMsg.textContent = 'Sess\\u00e3o inativa. Atualize a p\\u00e1gina e entre novamente.';
      return;
    }

    var token;
    try {
      token = await session.getToken();
    } catch(e) {
      authMsg.textContent = 'Falha ao obter token de sess\\u00e3o.';
      return;
    }

    var resp;
    try {
      resp = await fetch('/api/auth?page=' + encodeURIComponent(pageKey), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
    } catch(e) {
      authMsg.textContent = 'Erro de rede. Tente novamente.';
      return;
    }

    if (resp.status === 200) {
      var html = await resp.text();
      showContent(html);
    } else if (resp.status === 403) {
      var body;
      try { body = await resp.json(); } catch(e) { body = {}; }
      var approvalUrl = body.approvalUrl || '';
      var siteUrl = approvalUrl ? new URL(approvalUrl).origin : '';
      var email = (clerk.user.primaryEmailAddress && clerk.user.primaryEmailAddress.emailAddress) || '';
      var subject = encodeURIComponent('Solicita\\u00e7\\u00e3o de acesso');
      var mailBody = encodeURIComponent('Ol\\u00e1, gostaria de ter acesso a ' + siteUrl + '\\n\\nMeu email: ' + email + (approvalUrl ? '\\n\\nAprovar: ' + approvalUrl : ''));
      authMsg.textContent = 'Voc\\u00ea n\\u00e3o tem acesso a esta p\\u00e1gina.';

      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'text-align:center;margin-top:1em;';

      // Primary: WhatsApp button (when publisherWhatsapp + approvalUrl available)
      if (publisherWhatsapp && approvalUrl) {
        var waText = encodeURIComponent('Ol\\u00e1, gostaria de ter acesso a ' + siteUrl + '\\n\\nMeu email: ' + email + '\\n\\nAprovar: ' + approvalUrl);
        var waBtn = document.createElement('a');
        waBtn.href = 'https://wa.me/' + publisherWhatsapp + '?text=' + waText;
        waBtn.target = '_blank';
        waBtn.rel = 'noopener';
        waBtn.textContent = 'Solicitar acesso via WhatsApp';
        waBtn.style.cssText = 'display:inline-block;padding:0.6em 1.4em;background:#25D366;color:#fff;border-radius:6px;font-weight:600;text-decoration:none;font-size:1em;';
        wrapper.appendChild(waBtn);
      }

      // Fallback: copy + mailto (when publisherEmail available)
      if (publisherEmail) {
        var emailLabel = document.createElement('p');
        emailLabel.style.cssText = 'color:#888;font-size:0.9em;margin-top:1em;margin-bottom:0.5em;';
        emailLabel.textContent = 'Entre em contato: ' + publisherEmail;
        wrapper.appendChild(emailLabel);

        var copyText = 'Ol\\u00e1, gostaria de ter acesso a ' + siteUrl + '\\n\\nMeu email: ' + email + (approvalUrl ? '\\n\\nAprovar: ' + approvalUrl : '');
        var copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copiar solicita\\u00e7\\u00e3o';
        copyBtn.style.cssText = 'display:inline-block;padding:0.6em 1.4em;background:#a88bfa;color:#1e1e1e;border-radius:6px;font-weight:600;border:none;cursor:pointer;font-size:1em;';
        copyBtn.addEventListener('click', function() {
          try {
            navigator.clipboard.writeText(copyText).then(function() {
              copyBtn.textContent = 'Copiado!';
            }, function() {
              fallbackCopy(copyText, copyBtn);
            });
          } catch(e) {
            fallbackCopy(copyText, copyBtn);
          }
        });
        wrapper.appendChild(copyBtn);

        var mailLink = document.createElement('a');
        mailLink.href = 'mailto:' + publisherEmail + '?subject=' + subject + '&body=' + mailBody;
        mailLink.textContent = 'Abrir cliente de email';
        mailLink.style.cssText = 'display:block;margin-top:0.75em;font-size:0.85em;color:#888;text-decoration:underline;';
        wrapper.appendChild(mailLink);
      }

      if (wrapper.children.length > 0) {
        authUI.appendChild(wrapper);
      }

      // Auto-poll: check every 15s if user has been approved
      var pollStatus = document.createElement('p');
      pollStatus.style.cssText = 'text-align:center;color:#888;font-size:0.8em;margin-top:1.2em;';
      pollStatus.textContent = 'Aguardando aprova\\u00e7\\u00e3o...';
      authUI.appendChild(pollStatus);
      startApprovalPoll(clerk);
    } else {
      authMsg.textContent = 'Autentica\\u00e7\\u00e3o falhou. Atualize a p\\u00e1gina e tente novamente.';
    }
  }

  async function initClerk() {
    var clerk = window.Clerk;
    if (!clerk) { authMsg.textContent = 'Falha ao inicializar autentica\\u00e7\\u00e3o.'; return; }
    await clerk.load({
      localization: {
        socialButtonsBlockButton: 'Continuar com {{provider|titleize}}',
        dividerText: 'ou',
        formButtonPrimary: 'Continuar',
        formFieldLabel__emailAddress: 'Endere\\u00e7o de e-mail',
        formFieldLabel__firstName: 'Primeiro nome',
        formFieldLabel__lastName: 'Sobrenome',
        formFieldLabel__password: 'Senha',
        formFieldInputPlaceholder__emailAddress: 'Digite seu e-mail',
        formFieldInputPlaceholder__firstName: 'Primeiro nome',
        formFieldInputPlaceholder__lastName: 'Sobrenome',
        formFieldInputPlaceholder__password: 'Digite sua senha',
        signUp: {
          start: {
            title: 'Criar sua conta',
            subtitle: 'Bem-vindo! Preencha os dados para continuar.',
            actionText: 'J\\u00e1 possui uma conta?',
            actionLink: 'Entrar',
          },
          emailCode: {
            title: 'Verifique seu e-mail',
            subtitle: 'para continuar',
            formTitle: 'C\\u00f3digo de verifica\\u00e7\\u00e3o',
            formSubtitle: 'Insira o c\\u00f3digo enviado para seu e-mail',
            resendButton: 'N\\u00e3o recebeu? Reenviar c\\u00f3digo',
          },
        },
        signIn: {
          start: {
            title: 'Entrar',
            subtitle: 'Bem-vindo de volta!',
            actionText: 'N\\u00e3o possui uma conta?',
            actionLink: 'Cadastrar-se',
          },
        },
      }
    });

    if (clerk.user) {
      // Already signed in \u2014 fetch content directly
      await fetchContent(clerk);
    } else {
      // Mount sign-in component inline (no redirect loop)
      authMsg.style.display = 'none';
      var signInDiv = document.createElement('div');
      signInDiv.id = 'clerk-sign-in';
      authUI.appendChild(signInDiv);
      clerk.mountSignUp(signInDiv, { fallbackRedirectUrl: window.location.href });

      // Wait for sign-in to complete via listener
      await new Promise(function(resolve) {
        clerk.addListener(function(res) {
          if (res.user) resolve();
        });
      });

      // Clean up sign-in UI and fetch content
      signInDiv.remove();
      await fetchContent(clerk);
    }
  }
})();
</script>
</body>
</html>`;
    }
    module2.exports = { buildAuthShell: buildAuthShell2 };
  }
});

// src/auth-function-template.js
var require_auth_function_template = __commonJS({
  "src/auth-function-template.js"(exports2, module2) {
    function buildAuthFunction2(config) {
      const approvedEmailsJSON = JSON.stringify(config.approvedEmails);
      const pagesJSON = JSON.stringify(config.pages);
      const projectNameJSON = JSON.stringify(config.projectName);
      return `import { createHmac } from "crypto";
import { verifyToken, createClerkClient } from "@clerk/backend";

// --- Embedded config (generated at build time) ---
const APPROVED_EMAILS = ${approvedEmailsJSON};
const PAGES = ${pagesJSON};
const PROJECT_NAME = ${projectNameJSON};

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

function signToken(payload) {
  var data = JSON.stringify(payload);
  var sig = createHmac("sha256", process.env.CLERK_SECRET_KEY).update(data).digest("hex");
  return Buffer.from(data).toString("base64url") + "." + sig;
}

function getRequestOrigin(req) {
  var proto = ((req.headers["x-forwarded-proto"] || "").split(",")[0] || "").trim();
  var host = ((req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0] || "").trim();
  if (!host) return "https://" + PROJECT_NAME + ".vercel.app";
  return (proto || "https") + "://" + host;
}

export default async function handler(req, res) {
  const auth = (req.headers.authorization || "").replace(/^Bearer\\s+/, "");
  if (!auth) return res.status(401).json({ error: "Not authenticated" });

  let claims;
  try {
    claims = await verifyToken(auth, { secretKey: process.env.CLERK_SECRET_KEY });
  } catch {
    return res.status(401).json({ error: "Invalid session" });
  }

  // Fetch user to get email (not in default JWT claims)
  let email, user;
  try {
    user = await clerkClient.users.getUser(claims.sub);
    const primary = user.emailAddresses.find(function(e) { return e.id === user.primaryEmailAddressId; });
    email = (primary && primary.emailAddress || "").toLowerCase();
  } catch {
    return res.status(500).json({ error: "Failed to resolve user" });
  }

  // Check approved emails list
  var isApproved = APPROVED_EMAILS.includes(email);

  // Check privateMetadata approval
  if (!isApproved) {
    var meta = user.privateMetadata || {};
    if (meta["approved:" + PROJECT_NAME] === true) {
      isApproved = true;
    }
  }

  if (!isApproved) {
    var token = signToken({ email: email, site: PROJECT_NAME, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    var approvalUrl = getRequestOrigin(req) + "/api/approve?token=" + encodeURIComponent(token);
    return res.status(403).json({ error: "Access denied", approvalUrl: approvalUrl });
  }

  const pageKey = (req.query && req.query.page) || "main";
  const html = PAGES[pageKey];
  if (!html) return res.status(404).json({ error: "Page not found" });

  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
};
`;
    }
    function buildApproveFunction2(config) {
      const projectNameJSON = JSON.stringify(config.projectName);
      const publishableKeyJSON = JSON.stringify(config.clerkPublishableKey);
      const publisherEmailJSON = JSON.stringify((config.publisherEmail || "").toLowerCase().trim());
      return `import { createHmac, timingSafeEqual } from "crypto";
import { verifyToken, createClerkClient } from "@clerk/backend";

const PROJECT_NAME = ${projectNameJSON};
const CLERK_PUBLISHABLE_KEY = ${publishableKeyJSON};
const PUBLISHER_EMAIL = ${publisherEmailJSON};
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

function verifySignedToken(raw) {
  var parts = raw.split(".");
  if (parts.length !== 2) return null;
  var data = Buffer.from(parts[0], "base64url");
  var expected = createHmac("sha256", process.env.CLERK_SECRET_KEY).update(data).digest("hex");
  if (!timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
  var payload = JSON.parse(data.toString());
  if (payload.site !== PROJECT_NAME) return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function htmlPage(title, message, ok) {
  return \`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>\${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:\${ok?"#f0fdf4":"#fef2f2"};color:#1e1e1e}
.card{background:#fff;border-radius:12px;padding:2em 2.5em;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:1.3em;margin:0 0 .5em}p{color:#555;margin:0}</style></head>
<body><div class="card"><h1>\${title}</h1><p>\${message}</p></div></body></html>\`;
}

function approvalPage(email, token) {
  var safeEmail = escapeHtml(email);
  return \`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aprovar acesso</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#1e1e1e}
.card{background:#fff;border-radius:12px;padding:2em 2.5em;max-width:480px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:1.3em;margin:0 0 .5em}p{color:#555;margin:.5em 0}
#clerk-auth{margin:1.5em 0}
#status{color:#888;font-style:italic}
.ok{color:#16a34a}.err{color:#dc2626}</style></head>
<body><div class="card">
<h1>Aprovar acesso</h1>
<p>Aprovar acesso para <strong>\${safeEmail}</strong>?</p>
<div id="clerk-auth"></div>
<p id="status">Carregando...</p>
</div>
<script>
var hmacToken = \${JSON.stringify(token)};
var publisherEmail = \${JSON.stringify(PUBLISHER_EMAIL)};

function setStatus(msg, cls) {
  var el = document.getElementById("status");
  el.textContent = msg;
  el.className = cls || "";
}

function doApprove(sessionToken) {
  setStatus("Aprovando...");
  fetch("/api/approve", {
    method: "POST",
    headers: { "Authorization": "Bearer " + sessionToken, "Content-Type": "application/json" },
    body: JSON.stringify({ token: hmacToken })
  }).then(function(r) { return r.json().then(function(b) { return { ok: r.ok, body: b }; }); })
    .then(function(res) {
      if (res.ok) {
        setStatus("Acesso aprovado \\u2705", "ok");
        document.querySelector("h1").textContent = "Acesso aprovado \\u2705";
      } else {
        setStatus(res.body.error || "Erro ao aprovar", "err");
      }
    })
    .catch(function() { setStatus("Erro de rede", "err"); });
}

function checkAndApprove() {
  if (!window.Clerk) return;
  var user = window.Clerk.user;
  if (!user) {
    setStatus("Fa\\u00e7a login para continuar");
    var el = document.getElementById("clerk-auth");
    if (el && window.Clerk.mountSignIn) window.Clerk.mountSignIn(el);
    window.Clerk.addListener(function() {
      if (window.Clerk.user) checkAndApprove();
    });
    return;
  }
  var email = (user.primaryEmailAddress && user.primaryEmailAddress.emailAddress || "").toLowerCase();
  if (email !== publisherEmail) {
    setStatus("Apenas o propriet\\u00e1rio do site pode aprovar acessos.", "err");
    return;
  }
  window.Clerk.session.getToken().then(doApprove);
}

(function() {
  var s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.min.js";
  s.setAttribute("data-clerk-publishable-key", \${JSON.stringify(CLERK_PUBLISHABLE_KEY)});
  s.addEventListener("load", function() {
    window.Clerk.load().then(checkAndApprove);
  });
  document.head.appendChild(s);
})();
</script></body></html>\`;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    var raw = req.query && req.query.token;
    if (!raw) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(400).send(htmlPage("Link inv\\u00e1lido", "Token ausente.", false));
    }

    var payload = verifySignedToken(raw);
    if (!payload) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(400).send(htmlPage("Link inv\\u00e1lido", "Token expirado ou inv\\u00e1lido.", false));
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(approvalPage(payload.email, raw));
  }

  if (req.method === "POST") {
    var auth = (req.headers.authorization || "").replace(/^Bearer\\s+/, "");
    if (!auth) return res.status(401).json({ error: "Not authenticated" });

    var claims;
    try {
      claims = await verifyToken(auth, { secretKey: process.env.CLERK_SECRET_KEY });
    } catch {
      return res.status(401).json({ error: "Invalid session" });
    }

    var callerUser;
    try {
      callerUser = await clerkClient.users.getUser(claims.sub);
    } catch {
      return res.status(500).json({ error: "Failed to resolve user" });
    }
    var primary = callerUser.emailAddresses.find(function(e) { return e.id === callerUser.primaryEmailAddressId; });
    var callerEmail = (primary && primary.emailAddress || "").toLowerCase();

    if (callerEmail !== PUBLISHER_EMAIL) {
      return res.status(403).json({ error: "Only the site owner can approve access" });
    }

    var tokenStr = req.body && req.body.token;
    if (!tokenStr) return res.status(400).json({ error: "Token missing" });

    var tokenPayload = verifySignedToken(tokenStr);
    if (!tokenPayload) return res.status(400).json({ error: "Token expired or invalid" });

    try {
      var result = await clerkClient.users.getUserList({ emailAddress: [tokenPayload.email] });
      var user = result.data && result.data[0];
      if (!user) return res.status(404).json({ error: "User not found" });

      await clerkClient.users.updateUserMetadata(user.id, {
        privateMetadata: { ["approved:" + PROJECT_NAME]: true }
      });

      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: "Failed to approve user" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
`;
    }
    module2.exports = { buildAuthFunction: buildAuthFunction2, buildApproveFunction: buildApproveFunction2 };
  }
});

// src/atpath-core.js
var require_atpath_core = __commonJS({
  "src/atpath-core.js"(exports2, module2) {
    "use strict";
    var { TFile: TFile2, TFolder: TFolder2 } = require("obsidian");
    var REPOS_SEGMENT = "_repos/";
    function getRepoRoot2(filePath) {
      if (!filePath) return "";
      const idx = filePath.indexOf(REPOS_SEGMENT);
      if (idx === -1) return "";
      const afterRepos = filePath.substring(idx + REPOS_SEGMENT.length);
      const slash = afterRepos.indexOf("/");
      if (slash === -1) return "";
      return filePath.substring(0, idx + REPOS_SEGMENT.length + slash);
    }
    function toRepoRelative2(filePath, repoRoot) {
      if (!repoRoot) return filePath;
      return filePath.substring(repoRoot.length + 1);
    }
    function discoverRepoRoots2(plugin) {
      const now = Date.now();
      if (plugin._repoRootsCache && now - plugin._repoRootsCacheTime < 5e3) {
        return plugin._repoRootsCache;
      }
      const roots = /* @__PURE__ */ new Map();
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
    function resolveAtPathFromSource2(relPath, sourceFilePath, plugin) {
      const sourceRepoRoot = getRepoRoot2(sourceFilePath);
      if (sourceRepoRoot) {
        const candidate = sourceRepoRoot + "/" + relPath;
        if (plugin.app.vault.getAbstractFileByPath(candidate)) return candidate;
      }
      const slashIdx = relPath.indexOf("/");
      if (slashIdx !== -1) {
        const firstSegment = relPath.substring(0, slashIdx);
        const rest = relPath.substring(slashIdx + 1);
        const repoRoots = discoverRepoRoots2(plugin);
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
      const sourceRepoRoot = getRepoRoot2(sourceFilePath);
      if (sourceRepoRoot) {
        const candidate = sourceRepoRoot + "/" + trimmed;
        const f = plugin.app.vault.getAbstractFileByPath(candidate);
        if (f instanceof TFolder2) return candidate;
      }
      const slashIdx = trimmed.indexOf("/");
      if (slashIdx !== -1) {
        const firstSegment = trimmed.substring(0, slashIdx);
        const rest = trimmed.substring(slashIdx + 1);
        const repoRoots = discoverRepoRoots2(plugin);
        const repoRoot = repoRoots.get(firstSegment);
        if (repoRoot) {
          const candidate = repoRoot + "/" + rest;
          const f = plugin.app.vault.getAbstractFileByPath(candidate);
          if (f instanceof TFolder2) return candidate;
        }
      }
      const direct = plugin.app.vault.getAbstractFileByPath(trimmed);
      if (direct instanceof TFolder2) return trimmed;
      return sourceRepoRoot ? sourceRepoRoot + "/" + trimmed : trimmed;
    }
    function computeDisplayPath(targetPath, sourcePath) {
      const sourceRepoRoot = getRepoRoot2(sourcePath);
      if (sourceRepoRoot && targetPath.startsWith(sourceRepoRoot + "/")) {
        return toRepoRelative2(targetPath, sourceRepoRoot);
      }
      const targetRepoRoot = getRepoRoot2(targetPath);
      if (targetRepoRoot) {
        const repoName = targetRepoRoot.substring(targetRepoRoot.lastIndexOf("/") + 1);
        return repoName + "/" + toRepoRelative2(targetPath, targetRepoRoot);
      }
      return targetPath;
    }
    function isSubsequenceCI2(query, text) {
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
    function looksBinary2(content) {
      const sample = content.slice(0, 4096);
      let suspicious = 0;
      for (let i = 0; i < sample.length; i++) {
        const c = sample.charCodeAt(i);
        if (c === 0) return true;
        if (c === 65533) suspicious++;
        else if (c < 9 || c > 13 && c < 32) suspicious++;
      }
      return sample.length > 0 && suspicious / sample.length > 0.1;
    }
    function fuzzyScore(query, candidate) {
      if (!query) return 1;
      const q = query.toLowerCase();
      const c = candidate.toLowerCase();
      if (c.includes(q)) return 1 + q.length / Math.max(c.length, 1);
      let qi = 0;
      for (let i = 0; i < c.length && qi < q.length; i++) {
        if (c[i] === q[qi]) qi++;
      }
      return qi === q.length ? 0.5 : 0;
    }
    function createAtPathCore2(plugin) {
      const { app } = plugin;
      const folderTokenMemo = /* @__PURE__ */ new Map();
      const folderTokenInflight = /* @__PURE__ */ new Map();
      let folderTokenEpoch = 0;
      function getPerf() {
        if (typeof window !== "undefined" && window.__atpath_perf) return window.__atpath_perf;
        return { inc: () => {
        }, record: () => {
        }, time: (_l, fn) => fn(), timeAsync: async (_l, fn) => fn(), enabled: false };
      }
      function resolveAtPathTarget(ref, sourcePath) {
        if (ref && ref.kind === "folder") {
          const rel2 = ref.vaultPath || (ref.displayPath || "").replace(/\/+$/, "");
          const path2 = resolveAtPathFolderFromSource(rel2, sourcePath || "", plugin);
          const folder = app.vault.getAbstractFileByPath(path2);
          if (folder instanceof TFolder2) {
            return { kind: "folder", target: folder, normalizedPath: folder.path };
          }
          return { kind: "missing", target: null, normalizedPath: path2 };
        }
        const rel = ref && (ref.displayPath || ref.vaultPath) || "";
        if (!rel) return { kind: "missing", target: null, normalizedPath: "" };
        const path = resolveAtPathFromSource2(rel, sourcePath || "", plugin);
        const file = app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile2) {
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
        const perf = getPerf();
        perf.inc("getFolderTokens.calls");
        const folder = app.vault.getAbstractFileByPath(folderPath);
        if (!(folder instanceof TFolder2)) return 0;
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
              if (c instanceof TFolder2) {
                walk(c);
              } else if (c instanceof TFile2 && !isIgnored(c.path)) {
                perf.inc("getFolderTokens.walkedFiles");
                if (c.stat.size > sizeCapBytes) {
                  perf.inc("getFolderTokens.skippedTooLarge");
                  continue;
                }
                paths.push(c.path);
                if (paths.length > maxFiles) {
                  overCap = true;
                  return;
                }
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
                  const bucket = sz < 1024 ? "lt1k" : sz < 5 * 1024 ? "1-5k" : sz < 20 * 1024 ? "5-20k" : sz < 100 * 1024 ? "20-100k" : "100k+";
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
        try {
          return await promise;
        } finally {
          folderTokenInflight.delete(folderPath);
        }
      }
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
          if (c instanceof TFolder2) {
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
        const sourceRepoRoot = getRepoRoot2(sp);
        const trimmed = (query || "").replace(/^@/, "");
        if (trimmed.endsWith("/")) {
          const prefix = trimmed.replace(/\/+$/, "");
          if (sourceRepoRoot) {
            const sameRepoCandidate = sourceRepoRoot + "/" + prefix;
            const same = app.vault.getAbstractFileByPath(sameRepoCandidate);
            if (same instanceof TFolder2) {
              return immediateChildren(same, sp, "same-repo");
            }
          }
          const direct = app.vault.getAbstractFileByPath(prefix);
          if (direct instanceof TFolder2) {
            return immediateChildren(direct, sp, "vault-abs");
          }
          return prefixMatch(prefix, sp);
        }
        return fuzzyAll(trimmed, sp);
      }
      function immediateChildren(folder, sourcePath, mode) {
        const out = [];
        for (const c of folder.children) {
          const isFolder = c instanceof TFolder2;
          const isFile = c instanceof TFile2;
          if (!isFolder && !isFile) continue;
          out.push({
            kind: isFolder ? "folder" : "file",
            target: c,
            display: computeDisplayPath(c.path, sourcePath) + (isFolder ? "/" : ""),
            repoMode: mode,
            score: 1
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
              score: 1.3
            });
          }
        }
        for (const f of files) {
          if (f.path.toLowerCase().startsWith(lower)) {
            matches.push({
              kind: "file",
              target: f,
              display: computeDisplayPath(f.path, sourcePath),
              score: 1
            });
          }
        }
        matches.sort((a, b) => b.score - a.score || a.display.localeCompare(b.display));
        return matches.slice(0, 50);
      }
      function fuzzyAll(query, sourcePath) {
        const folders = listAllFolders();
        const files = app.vault.getFiles();
        const sourceRepoRoot = getRepoRoot2(sourcePath);
        const sameRepo = [];
        const crossRepo = [];
        const loose = [];
        function place(entry) {
          const targetRepoRoot = getRepoRoot2(entry.target.path);
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
              score: base * 1.3
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
              score: base
            });
          }
        }
        const all = [...sameRepo, ...crossRepo, ...loose];
        if (query) all.sort((a, b) => b.score - a.score);
        return all.slice(0, 50);
      }
      function formatAtPathInsertion(target, sourcePath, mode) {
        const isFolder = target instanceof TFolder2;
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
        computeDisplayPath: (t, s) => computeDisplayPath(t, s)
      };
    }
    function extractDraggedVaultPaths2(dataTransfer, app, sourcePath, currentDragRefs) {
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      const addPath = (rawPath) => {
        if (!rawPath || typeof rawPath !== "string") return;
        const path = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
        if (!path || seen.has(path)) return;
        const target = app.vault.getAbstractFileByPath(path);
        if (!target) return;
        if (sourcePath && target.path === sourcePath) return;
        seen.add(path);
        if (target instanceof TFile2) {
          out.push({ kind: "file", vaultPath: target.path, target });
        } else if (target instanceof TFolder2) {
          out.push({ kind: "folder", vaultPath: target.path, target });
        }
      };
      if (Array.isArray(currentDragRefs) && currentDragRefs.length > 0) {
        for (const r of currentDragRefs) addPath(r && r.vaultPath);
        if (out.length > 0) return out;
      }
      if (!dataTransfer) return out;
      const tryJsonMime = (mime) => {
        let raw;
        try {
          raw = dataTransfer.getData(mime);
        } catch (_) {
          return false;
        }
        if (!raw) return false;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (_) {
          return false;
        }
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
      if (tryJsonMime("application/obsidian-files")) return out;
      if (tryJsonMime("application/obsidian-file")) return out;
      if (tryJsonMime("application/x-obsidian-files")) return out;
      let uriList;
      try {
        uriList = dataTransfer.getData("text/uri-list");
      } catch (_) {
        uriList = "";
      }
      if (uriList) {
        const basePath = app.vault.adapter && typeof app.vault.adapter.getBasePath === "function" ? app.vault.adapter.getBasePath() : "";
        for (const line of uriList.split(/\r?\n/)) {
          const url = line.trim();
          if (!url || url.startsWith("#")) continue;
          if (url.startsWith("obsidian://")) {
            try {
              const u = new URL(url);
              const fileParam = u.searchParams.get("file");
              if (fileParam) addPath(decodeURIComponent(fileParam));
            } catch (_) {
            }
          } else if (url.startsWith("file://")) {
            let abs;
            try {
              abs = decodeURIComponent(url.replace(/^file:\/\//, ""));
            } catch (_) {
              continue;
            }
            if (basePath && abs.startsWith(basePath + "/")) {
              addPath(abs.substring(basePath.length + 1));
            }
          }
        }
        if (out.length > 0) return out;
      }
      let plain;
      try {
        plain = dataTransfer.getData("text/plain");
      } catch (_) {
        plain = "";
      }
      if (plain) {
        for (const line of plain.split(/\r?\n/)) {
          const path = line.trim();
          if (path) addPath(path);
        }
      }
      return out;
    }
    module2.exports = {
      createAtPathCore: createAtPathCore2,
      REPOS_SEGMENT,
      getRepoRoot: getRepoRoot2,
      toRepoRelative: toRepoRelative2,
      discoverRepoRoots: discoverRepoRoots2,
      resolveAtPathFromSource: resolveAtPathFromSource2,
      resolveAtPathFolderFromSource,
      computeDisplayPath,
      isSubsequenceCI: isSubsequenceCI2,
      extractDraggedVaultPaths: extractDraggedVaultPaths2,
      looksBinary: looksBinary2
    };
  }
});

// src/html-app-publish.js
var require_html_app_publish = __commonJS({
  "src/html-app-publish.js"(exports2, module2) {
    var HTML_APP_SCOPE_SINGLE_FILE2 = "single-file";
    var HTML_APP_SCOPE_FOLDER2 = "folder";
    var DIRECTORY_BINARY_EXTENSIONS = /* @__PURE__ */ new Set([
      "png",
      "jpg",
      "jpeg",
      "gif",
      "bmp",
      "svg",
      "ico",
      "webp",
      "avif",
      "pdf",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "ppt",
      "pptx",
      "zip",
      "gz",
      "tar",
      "rar",
      "7z",
      "bz2",
      "mp3",
      "wav",
      "ogg",
      "flac",
      "aac",
      "m4a",
      "mp4",
      "avi",
      "mkv",
      "mov",
      "webm",
      "wmv",
      "woff",
      "woff2",
      "ttf",
      "otf",
      "eot",
      "exe",
      "dll",
      "so",
      "dylib",
      "bin",
      "sqlite",
      "db"
    ]);
    function isHtmlExtension2(ext) {
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
      return String(title || "").toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
    }
    function humanizeName(value) {
      return String(value || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    }
    function decodeBasicEntities(value) {
      return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    }
    function extractHtmlTitle(html) {
      if (typeof html !== "string" || !html) return "";
      const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (!match) return "";
      return decodeBasicEntities(match[1]).replace(/\s+/g, " ").trim();
    }
    function getDefaultHtmlAppProjectName(filePath, scope) {
      const fileName = getFileName(filePath);
      const fallback = scope === HTML_APP_SCOPE_FOLDER2 ? getParentFolderName(filePath) || stripHtmlExtension(fileName) : stripHtmlExtension(fileName);
      return slugifyProjectName(fallback);
    }
    function getDefaultHtmlAppTitle(filePath, scope, entryHtml) {
      const extractedTitle = extractHtmlTitle(entryHtml);
      if (extractedTitle) return extractedTitle;
      const fileName = getFileName(filePath);
      const fallback = scope === HTML_APP_SCOPE_FOLDER2 ? getParentFolderName(filePath) || stripHtmlExtension(fileName) : stripHtmlExtension(fileName);
      return humanizeName(fallback) || "HTML app";
    }
    function buildHtmlAppDefaults2({ filePath, scope, entryHtml, existingState }) {
      const defaultProjectName = getDefaultHtmlAppProjectName(filePath, scope);
      const projectName = existingState && existingState.projectName ? existingState.projectName : defaultProjectName;
      const siteTitle = existingState && existingState.siteTitle ? existingState.siteTitle : getDefaultHtmlAppTitle(filePath, scope, entryHtml);
      return {
        defaultProjectName,
        projectName,
        siteTitle,
        domain: projectName + ".vercel.app"
      };
    }
    function normalizeDeployPath(relPath) {
      return String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    }
    function getHtmlAppPageKey(deployPath) {
      const normalized = normalizeDeployPath(deployPath).replace(/\.html?$/i, "");
      if (!normalized || normalized === "index") return "main";
      return normalized;
    }
    function buildHtmlAppDeployFiles2({ scope, entryFilePath, entryHtml, folderFiles }) {
      if (scope === HTML_APP_SCOPE_SINGLE_FILE2) {
        return [{ path: "index.html", content: entryHtml, encoding: "utf-8" }];
      }
      const entryRelPath = normalizeDeployPath(getFileName(entryFilePath) || entryFilePath);
      const deployFiles = [];
      const seenPaths = /* @__PURE__ */ new Set();
      for (const file of folderFiles || []) {
        const deployPath = normalizeDeployPath(file.relPath);
        if (!deployPath) continue;
        if (deployPath === "index.html" && entryRelPath !== "index.html") continue;
        if (seenPaths.has(deployPath)) continue;
        seenPaths.add(deployPath);
        deployFiles.push({
          path: deployPath,
          content: file.content,
          encoding: file.encoding || "utf-8"
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
    function partitionHtmlAppDeployFiles2(deployFiles) {
      const htmlPages = {};
      const staticFiles = [];
      for (const file of deployFiles || []) {
        const deployPath = normalizeDeployPath(file.path || file.relPath);
        if (!deployPath) continue;
        const ext = (deployPath.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || "";
        if (isHtmlExtension2(ext)) {
          htmlPages[getHtmlAppPageKey(deployPath)] = file.content;
          continue;
        }
        staticFiles.push({
          path: deployPath,
          content: file.content,
          encoding: file.encoding || "utf-8"
        });
      }
      return { htmlPages, staticFiles };
    }
    function getPublishedHtmlAppState2(settings, filePath) {
      return settings && settings.publishedHtmlApps ? settings.publishedHtmlApps[filePath] : void 0;
    }
    function setPublishedHtmlAppState2(settings, filePath, state) {
      if (!settings.publishedHtmlApps || typeof settings.publishedHtmlApps !== "object") {
        settings.publishedHtmlApps = {};
      }
      settings.publishedHtmlApps[filePath] = state;
      return state;
    }
    function renamePublishedHtmlAppState2(settings, oldPath, newPath) {
      if (!settings || !settings.publishedHtmlApps || !settings.publishedHtmlApps[oldPath]) {
        return false;
      }
      settings.publishedHtmlApps[newPath] = settings.publishedHtmlApps[oldPath];
      delete settings.publishedHtmlApps[oldPath];
      return true;
    }
    async function collectDirectoryFiles2(dirPath, opts) {
      let fs;
      let pathMod;
      try {
        fs = require("fs").promises;
        pathMod = require("path");
      } catch (_) {
        return [];
      }
      const files = [];
      const maxFiles = opts && opts.maxFiles || 500;
      const maxTotalBytes = opts && opts.maxTotalBytes || 50 * 1024 * 1024;
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
    module2.exports = {
      HTML_APP_SCOPE_SINGLE_FILE: HTML_APP_SCOPE_SINGLE_FILE2,
      HTML_APP_SCOPE_FOLDER: HTML_APP_SCOPE_FOLDER2,
      isHtmlExtension: isHtmlExtension2,
      extractHtmlTitle,
      getDefaultHtmlAppProjectName,
      buildHtmlAppDefaults: buildHtmlAppDefaults2,
      buildHtmlAppDeployFiles: buildHtmlAppDeployFiles2,
      partitionHtmlAppDeployFiles: partitionHtmlAppDeployFiles2,
      getPublishedHtmlAppState: getPublishedHtmlAppState2,
      setPublishedHtmlAppState: setPublishedHtmlAppState2,
      renamePublishedHtmlAppState: renamePublishedHtmlAppState2,
      collectDirectoryFiles: collectDirectoryFiles2
    };
  }
});

// src/main.js
var { Plugin, EditorSuggest, MarkdownRenderChild, MarkdownView, TFile, TFolder, Menu, PluginSettingTab, Setting, Notice, Modal, Platform, setIcon, prepareFuzzySearch, renderResults, requestUrl } = require("obsidian");
var { ViewPlugin, Decoration, MatchDecorator, EditorView, WidgetType } = require("@codemirror/view");
var { Compartment, Prec } = require("@codemirror/state");
var { f_createTokenIndex, f_estimateTokens } = require_token_index();
var { f_installExplorerTokenBadges } = require_explorer_token_badges();
var { f_loadTokenCache, f_saveTokenCache } = require_token_cache_storage();
var { f_scanMarkdownLinks, f_repositoryForPath, f_resolveRepositoryLink, f_formatRepositoryLink } = require_repository_links();
var { f_installNativeRepositoryLinks } = require_native_repository_links();
var {
  REPOSITORY_MAP_PATH,
  f_discoverRepositories,
  f_lookupRenamedRepository,
  f_readRepositoryMap,
  f_writeRepositoryMap
} = require_repository_index();
var ATPATH_PERF = (() => {
  let enabled = false;
  try {
    enabled = typeof window !== "undefined" && !!window.localStorage && window.localStorage.getItem("atpath-perf") === "1";
  } catch (_) {
  }
  const counts = /* @__PURE__ */ new Map();
  const times = /* @__PURE__ */ new Map();
  const bump = (label, dt) => {
    counts.set(label, (counts.get(label) || 0) + 1);
    if (dt != null) times.set(label, (times.get(label) || 0) + dt);
  };
  const api = {
    enabled,
    inc(label) {
      if (enabled) bump(label, null);
    },
    record(label, dt) {
      if (enabled) bump(label, dt);
    },
    time(label, fn) {
      if (!enabled) return fn();
      const t0 = performance.now();
      try {
        return fn();
      } finally {
        bump(label, performance.now() - t0);
      }
    },
    async timeAsync(label, fn) {
      if (!enabled) return fn();
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        bump(label, performance.now() - t0);
      }
    },
    dump() {
      const rows = [];
      for (const [k, n] of counts) {
        const ms = times.get(k);
        rows.push({
          label: k,
          count: n,
          totalMs: ms != null ? Number(ms.toFixed(1)) : null,
          avgMs: ms != null && n > 0 ? Number((ms / n).toFixed(2)) : null
        });
      }
      rows.sort((a, b) => (b.totalMs || 0) - (a.totalMs || 0));
      console.warn("[atpath-perf] dump (sorted by totalMs)", rows);
      counts.clear();
      times.clear();
      return rows;
    }
  };
  if (enabled && typeof window !== "undefined") {
    try {
      window.__atpath_perf = api;
      window.__atpath_perf_dump = () => api.dump();
      console.warn("[atpath-perf] enabled. Call window.__atpath_perf_dump() to print + reset.");
    } catch (_) {
    }
  }
  return api;
})();
var AtPathWidget = class extends WidgetType {
  constructor(fullMatch, path, tokenCount) {
    super();
    this.fullMatch = fullMatch;
    this.path = path;
    this.tokenCount = tokenCount;
  }
  eq(other) {
    return this.fullMatch === other.fullMatch && this.tokenCount === other.tokenCount;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "atpath-link";
    span.textContent = this.fullMatch;
    span.dataset.atpath = this.path;
    if (this.tokenCount) span.dataset.tokens = this.tokenCount;
    return span;
  }
  ignoreEvent(event) {
    return event.type !== "mousedown";
  }
};
var WikilinkAtPathWidget = class extends WidgetType {
  constructor(displayPath, vaultPath, tokenCount) {
    super();
    this.displayPath = displayPath;
    this.vaultPath = vaultPath;
    this.tokenCount = tokenCount;
  }
  eq(other) {
    return this.displayPath === other.displayPath && this.vaultPath === other.vaultPath && this.tokenCount === other.tokenCount;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "atpath-link";
    span.textContent = "@" + this.displayPath;
    span.dataset.atpath = this.vaultPath;
    if (this.tokenCount) span.dataset.tokens = this.tokenCount;
    return span;
  }
  ignoreEvent(event) {
    return event.type !== "mousedown";
  }
};
var AtFolderWidget = class extends WidgetType {
  constructor(fullMatch, relPath, tokenCount) {
    super();
    this.fullMatch = fullMatch;
    this.relPath = relPath;
    this.tokenCount = tokenCount;
  }
  eq(other) {
    return this.fullMatch === other.fullMatch && this.tokenCount === other.tokenCount;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "atpath-link atpath-folder-link";
    span.textContent = this.fullMatch;
    span.dataset.atpath = this.relPath;
    span.dataset.atpathKind = "folder";
    if (this.tokenCount) span.dataset.tokens = this.tokenCount;
    return span;
  }
  ignoreEvent(event) {
    return event.type !== "mousedown";
  }
};
var BINARY_EXTENSIONS = /* @__PURE__ */ new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "svg",
  "ico",
  "webp",
  "avif",
  "heic",
  "heif",
  "tiff",
  "tif",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "zip",
  "gz",
  "tar",
  "rar",
  "7z",
  "bz2",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "aac",
  "m4a",
  "mp4",
  "avi",
  "mkv",
  "mov",
  "webm",
  "wmv",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "sqlite",
  "db"
]);
function makeFence(content) {
  let max = 2;
  const runs = content.match(/`{3,}/g);
  if (runs) for (const r of runs) {
    if (r.length > max) max = r.length;
  }
  return "`".repeat(max + 1);
}
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (_) {
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.className = "atpath-clipboard-fallback";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}
function formatTokens(n) {
  if (n < 1e3) return "~" + n;
  if (n < 1e4) return "~" + (n / 1e3).toFixed(1) + "k";
  return "~" + Math.round(n / 1e3) + "k";
}
function formatLinkedTargetCount(t) {
  if (!t) return "0";
  if (t.kind === "missing") return "Unavailable";
  if (t.pending) return (t.tokens ? formatTokens(t.tokens) + "+" : "\u2026") + (t.skipped ? " *" : "");
  if (t.overCap) return "> " + t.overCap.fileCount + " files";
  return formatTokens(t.tokens || 0) + (t.skipped ? " *" : "");
}
function f_formatFolderTokenCount(value) {
  return value?.overCap ? formatLinkedTargetCount({ overCap: value }) : formatLinkedTargetCount({ tokens: value?.tokens ?? value, pending: value?.partial, skipped: value?.skipped });
}
function f_bindReadingFolderCount(plugin, context, badge, path) {
  const paint = () => {
    const count = plugin.f_folderTokenCount(path);
    const text = " (" + f_formatFolderTokenCount(count) + ")";
    if (badge.textContent !== text) badge.textContent = text;
    if (count?.skipped) badge.title = count.skipped + " files skipped. Token estimate from readable text.";
  };
  paint();
  if (typeof context.addChild !== "function" || typeof MarkdownRenderChild !== "function") return;
  const child = new MarkdownRenderChild(badge);
  child.register(plugin._tokenIndex.subscribe(paint));
  context.addChild(child);
}
function f_uniqueLinkedTokenTotal(targets) {
  const folders = targets.filter((target) => target.kind === "folder" && !target.overCap);
  return targets.reduce((total, target) => {
    if (folders.some((folder) => folder !== target && (folder.path === "/" || target.path.startsWith(folder.path + "/")))) return total;
    return total + (target.tokens || 0);
  }, 0);
}
var { buildMainPage, buildAtPathPage, buildUnpublishedPage, slugifyPath } = require_html_builder();
var { deployToVercel, ensureProject, checkProjectAvailability, slugify } = require_vercel_api();
var { buildAuthShell } = require_auth_shell_builder();
var { buildAuthFunction, buildApproveFunction } = require_auth_function_template();
var { applySiteIconToDeployFiles, injectSiteIconIntoHtml } = require_site_icon();
var {
  createAtPathCore,
  getRepoRoot: coreGetRepoRoot,
  toRepoRelative: coreToRepoRelative,
  discoverRepoRoots: coreDiscoverRepoRoots,
  resolveAtPathFromSource: coreResolveAtPathFromSource,
  resolveAtPathFolderFromSource: coreResolveAtPathFolderFromSource,
  computeDisplayPath: coreComputeDisplayPath,
  isSubsequenceCI,
  extractDraggedVaultPaths: coreExtractDraggedVaultPaths,
  looksBinary
} = require_atpath_core();
var {
  HTML_APP_SCOPE_SINGLE_FILE,
  HTML_APP_SCOPE_FOLDER,
  isHtmlExtension,
  buildHtmlAppDefaults,
  buildHtmlAppDeployFiles,
  partitionHtmlAppDeployFiles,
  getPublishedHtmlAppState,
  setPublishedHtmlAppState,
  renamePublishedHtmlAppState,
  collectDirectoryFiles
} = require_html_app_publish();
var DEFAULT_SETTINGS = {
  showTokenCounts: true,
  maxFileSizeMB: 5,
  maxFolderFiles: 500,
  statusBarShowSelection: true,
  suggestFolders: true,
  enableDragDropAtPath: true,
  vercelToken: "",
  contactUrl: "",
  contactLabel: "Entre em contato",
  clerkPublishableKey: "",
  clerkSecretKey: "",
  publisherEmail: "",
  siteIconDataUrl: "",
  siteIconFileName: "",
  publishedPages: {},
  publishedHtmlApps: {}
};
function getPublishState(plugin, publishData) {
  if (publishData.publishKind === "html-app") {
    return getPublishedHtmlAppState(plugin.settings, publishData.sourcePath);
  }
  return plugin.settings.publishedPages[publishData.notePath];
}
function setPublishState(plugin, publishData, nextState) {
  if (publishData.publishKind === "html-app") {
    return setPublishedHtmlAppState(plugin.settings, publishData.sourcePath, nextState);
  }
  plugin.settings.publishedPages[publishData.notePath] = nextState;
  return nextState;
}
var SITE_ICON_MAX_BYTES = 1024 * 1024;
var SITE_ICON_ACCEPT = ".png,.jpg,.jpeg,.svg,.ico,.webp,.gif,image/*";
function describeSiteIcon(settings) {
  if (settings.siteIconFileName) {
    return "Saved globally as " + settings.siteIconFileName + ".";
  }
  if (settings.siteIconDataUrl) {
    return "Saved globally for future publishes.";
  }
  return "No image saved yet.";
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}
async function saveSiteIconFile(plugin, file) {
  if (!file) throw new Error("Choose an image file first.");
  if (file.size > SITE_ICON_MAX_BYTES) {
    throw new Error("Site icon must be 1 MB or smaller.");
  }
  const type = String(file.type || "");
  const fileName = String(file.name || "").toLowerCase();
  const looksLikeImage = type.startsWith("image/") || /\.(png|jpe?g|svg|ico|webp|gif)$/i.test(fileName);
  if (!looksLikeImage) {
    throw new Error("Choose a PNG, JPG, SVG, ICO, WebP, or GIF image.");
  }
  const dataUrl = await readFileAsDataUrl(file);
  if (!/^data:image\//i.test(dataUrl)) {
    throw new Error("The selected file could not be stored as an image.");
  }
  plugin.settings.siteIconDataUrl = dataUrl;
  plugin.settings.siteIconFileName = file.name || "";
  await plugin.saveSettings();
}
function clearSiteIcon(plugin) {
  plugin.settings.siteIconDataUrl = "";
  plugin.settings.siteIconFileName = "";
  return plugin.saveSettings();
}
function addSiteIconPicker(setting, plugin, baseDescription, opts = {}) {
  const allowClear = opts.allowClear !== false;
  const chooseSavedLabel = opts.chooseSavedLabel || "Replace image";
  const chooseEmptyLabel = opts.chooseEmptyLabel || "Choose image";
  const notices = opts.notices !== false;
  let pending = Promise.resolve();
  let chooseBtn = null;
  let clearBtn = null;
  const inputEl = setting.controlEl.createEl("input", {
    attr: {
      type: "file",
      accept: SITE_ICON_ACCEPT
    }
  });
  inputEl.addClass("atpath-hidden");
  const refresh = () => {
    setting.setDesc(baseDescription + " " + describeSiteIcon(plugin.settings));
    if (chooseBtn) {
      chooseBtn.setButtonText(plugin.settings.siteIconDataUrl ? chooseSavedLabel : chooseEmptyLabel);
    }
    if (clearBtn) {
      clearBtn.setDisabled(!plugin.settings.siteIconDataUrl);
    }
  };
  inputEl.addEventListener("change", () => {
    const file = inputEl.files && inputEl.files[0];
    if (!file) return;
    pending = (async () => {
      try {
        await saveSiteIconFile(plugin, file);
        refresh();
        if (notices) new Notice("Site icon saved for future publishes.");
      } catch (error) {
        new Notice(error.message || String(error));
      } finally {
        inputEl.value = "";
      }
    })();
    void pending;
  });
  setting.addButton((btn) => {
    chooseBtn = btn;
    btn.onClick(() => inputEl.click());
  });
  if (allowClear) {
    setting.addButton((btn) => {
      clearBtn = btn;
      btn.setButtonText("Clear").onClick(() => {
        void (async () => {
          try {
            await clearSiteIcon(plugin);
            refresh();
            if (notices) new Notice("Site icon cleared.");
          } catch (error) {
            new Notice(error.message || String(error));
          }
        })();
      });
    });
  }
  refresh();
  return {
    waitForPending: async () => {
      await pending;
    }
  };
}
function openInDefaultApp(plugin, vaultPath) {
  const adapter = plugin.app.vault.adapter;
  if (!adapter || typeof adapter.getBasePath !== "function") {
    new Notice("Opening in the default app is only available on desktop.");
    return;
  }
  const basePath = adapter.getBasePath();
  const absolutePath = require("path").join(basePath, vaultPath);
  require("electron").shell.openPath(absolutePath);
}
function showAtPathMenu(plugin, event, vaultPath) {
  if (Platform.isMobile) return;
  const menu = new Menu();
  menu.addItem(
    (item) => item.setTitle("Open in default app").setIcon("arrow-up-right").onClick(() => openInDefaultApp(plugin, vaultPath))
  );
  menu.showAtMouseEvent(event);
}
function revealFolderInExplorer(app, folder) {
  const leaves = app.workspace.getLeavesOfType("file-explorer");
  let revealed = false;
  for (const leaf of leaves) {
    const view = leaf.view;
    try {
      if (typeof view?.revealInFolder === "function") {
        view.revealInFolder(folder);
        revealed = true;
      }
    } catch (err) {
      console.warn("[atpath] revealInFolder failed", err);
    }
  }
  if (!revealed) new Notice("Could not reveal folder in file explorer: " + folder.path);
}
function showAtPathFolderMenu(plugin, event, folder) {
  const menu = new Menu();
  menu.addItem(
    (item) => item.setTitle("Reveal in file explorer").setIcon("folder").onClick(() => revealFolderInExplorer(plugin.app, folder))
  );
  if (!Platform.isMobile) {
    menu.addItem(
      (item) => item.setTitle("Open folder in default app").setIcon("arrow-up-right").onClick(() => openInDefaultApp(plugin, folder.path))
    );
  }
  menu.showAtMouseEvent(event);
}
async function openFileByViewState(plugin, resolved) {
  const ext = resolved.extension;
  const viewType = typeof plugin.app.viewRegistry.getTypeByExtension === "function" ? plugin.app.viewRegistry.getTypeByExtension(ext) : plugin.app.viewRegistry.typeByExtension[ext];
  const leaf = plugin.app.workspace.getLeaf(false);
  await leaf.setViewState({
    type: viewType || "markdown",
    active: true,
    state: { file: resolved.path }
  });
}
var getRepoRoot = coreGetRepoRoot;
var toRepoRelative = coreToRepoRelative;
var discoverRepoRoots = coreDiscoverRepoRoots;
var resolveAtPathFromSource = coreResolveAtPathFromSource;
function resolveAtPath(relPath, plugin) {
  const activeFile = plugin.app.workspace.getActiveFile();
  if (!activeFile) return relPath;
  return resolveAtPathFromSource(relPath, activeFile.path, plugin);
}
var AtPathSuggest = class extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }
  onTrigger(cursor, editor, file) {
    if (!file || !f_repositoryForPath(file.path, this.plugin.repositories)) return null;
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const start = before.lastIndexOf("[[");
    if (start < 0 || /[\[\]]/.test(before.slice(start + 2)) || before[start - 1] === "!" || /(^|[^\\])(?:\\\\)*\\$/.test(before.slice(0, start))) return null;
    if (isInExcludedRange(editor.posToOffset(cursor), buildExcludedRanges(editor.getValue()))) return null;
    return { start: { line: cursor.line, ch: start }, end: cursor, query: before.slice(start + 2) };
  }
  getSuggestions(context) {
    if (this._suggestDebounceTimer) clearTimeout(this._suggestDebounceTimer);
    return new Promise((resolve) => {
      this._suggestDebounceTimer = setTimeout(() => {
        this._suggestDebounceTimer = null;
        resolve(this._computeSuggestions(context));
      }, 100);
    });
  }
  _computeSuggestions(context) {
    const file = context.file;
    if (!file) return [];
    const sourcePath = file.path;
    const query = context.query || "";
    const showFolders = this.plugin.settings.suggestFolders !== false;
    const core = this.plugin.core;
    const sourceRepo = f_repositoryForPath(sourcePath, this.plugin.repositories);
    const tierOf = (path) => f_repositoryForPath(path, this.plugin.repositories) === sourceRepo ? 0 : 1;
    const vaultGen = this.plugin._suggestVaultGen || 0;
    const cache = this._suggestCache;
    let base;
    if (cache && cache.sourcePath === sourcePath && cache.showFolders === showFolders && cache.vaultGen === vaultGen && query.startsWith(cache.query)) {
      base = cache.items;
    } else {
      base = this._buildSuggestCandidates(sourcePath, showFolders, tierOf);
    }
    const survivors = query ? base.filter((c) => isSubsequenceCI(query, c.display)) : base;
    this._suggestCache = { sourcePath, showFolders, vaultGen, query, items: survivors };
    const fuzzy = query ? prepareFuzzySearch(query) : null;
    const tiers = [[], [], []];
    for (const c of survivors) {
      let fuzzyResult = null;
      let score = c.kind === "folder" ? 1.3 : 1;
      if (fuzzy) {
        fuzzyResult = fuzzy(c.display);
        if (!fuzzyResult) continue;
        score = c.kind === "folder" ? fuzzyResult.score * 1.3 : fuzzyResult.score;
      }
      tiers[c.tier].push({
        kind: c.kind,
        target: c.target,
        display: c.display,
        fuzzyResult,
        score
      });
    }
    if (fuzzy) {
      for (const t of tiers) t.sort((a, b) => b.score - a.score);
    } else {
      for (const t of tiers) {
        t.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
          return a.display.localeCompare(b.display);
        });
      }
    }
    return [...tiers[0], ...tiers[1], ...tiers[2]].slice(0, 50);
  }
  // Build the full {kind, target, display, tier} candidate list for a source
  // file: every vault file plus (optionally) every folder, display strings
  // precomputed once. Feeds the narrowing cache in getSuggestions so the
  // per-keystroke work is just subsequence filtering + scoring the survivors.
  _buildSuggestCandidates(sourcePath, showFolders, tierOf) {
    const core = this.plugin.core;
    const out = [];
    for (const f of this.app.vault.getFiles()) {
      out.push({
        kind: "file",
        target: f,
        display: this.plugin.f_displayLinkedPath(f.path, sourcePath),
        tier: tierOf(f.path)
      });
    }
    if (showFolders) {
      for (const folder of core.listAllFolders()) {
        out.push({
          kind: "folder",
          target: folder,
          display: this.plugin.f_displayLinkedPath(folder.path, sourcePath) + "/",
          tier: tierOf(folder.path)
        });
      }
    }
    return out;
  }
  renderSuggestion(value, el) {
    const row = el.createDiv({ cls: "atpath-suggest-row" });
    if (value.kind === "folder") {
      const iconEl = row.createSpan({ cls: "atpath-suggest-icon" });
      setIcon(iconEl, "folder");
    }
    const titleEl = row.createDiv({ cls: "atpath-suggest-title" });
    if (value.fuzzyResult) {
      renderResults(titleEl, value.display, value.fuzzyResult);
    } else {
      titleEl.setText(value.display);
    }
  }
  selectSuggestion(value) {
    const { editor, start, end, file } = this.context;
    try {
      const insertion = this.plugin.f_formatLinkedTarget(value.target, file.path);
      const tail = editor.getLine(end.line).slice(end.ch);
      const replaceEnd = tail.startsWith("]]") ? { ...end, ch: end.ch + 2 } : end;
      editor.replaceRange(insertion + " ", start, replaceEnd);
    } catch (error) {
      new Notice(error.message);
    }
  }
};
function f_prioritizeRepositorySuggest(plugin, suggest) {
  const suggests = plugin.app.workspace.editorSuggest?.suggests;
  if (!Array.isArray(suggests)) return false;
  const index = suggests.indexOf(suggest);
  if (index < 0) return false;
  suggests.splice(index, 1);
  suggests.unshift(suggest);
  return true;
}
var AT_PATH_RE = /(?<=^|[\s(])@([\w\p{L}\p{M}./_-]+\.[\w]+|[\w\p{L}\p{M}./_-][\w\p{L}\p{M}./ _()&-]+?\.[\w]+)/gu;
var AT_PATH_FOLDER_RE = /(^|[\s(])@([\w\p{L}\p{M}._-][\w\p{L}\p{M}./ _()&-]*?)\/(?=$|[\s)>,;:!?])/gu;
var WIKILINK_ATPATH_RE = /\[\[([^\]|]+)\|@([^\]]+)\]\]/g;
function buildExcludedRanges(content) {
  const ranges = [];
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx !== -1) ranges.push([0, endIdx + 4]);
  }
  const fenceRe = /^(`{3,}|~{3,}).*$/gm;
  let fence;
  let openFence = null;
  while ((fence = fenceRe.exec(content)) !== null) {
    if (!openFence) {
      openFence = { start: fence.index, marker: fence[1][0], len: fence[1].length };
    } else if (fence[1][0] === openFence.marker && fence[1].length >= openFence.len) {
      ranges.push([openFence.start, fence.index + fence[0].length]);
      openFence = null;
    }
  }
  if (openFence) ranges.push([openFence.start, content.length]);
  const inlineRe = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
  let inl;
  while ((inl = inlineRe.exec(content)) !== null) {
    ranges.push([inl.index, inl.index + inl[0].length]);
  }
  return ranges;
}
function isInExcludedRange(pos, ranges) {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) return true;
    if (start > pos) break;
  }
  return false;
}
function scanAtPathRefs(content, app, sourcePath) {
  const results = [];
  const excluded = buildExcludedRanges(content);
  const wlRe = new RegExp(WIKILINK_ATPATH_RE.source, WIKILINK_ATPATH_RE.flags);
  let m;
  while ((m = wlRe.exec(content)) !== null) {
    if (isInExcludedRange(m.index, excluded)) continue;
    let vaultPath = m[1];
    if (app) {
      const resolved = app.metadataCache.getFirstLinkpathDest(vaultPath, sourcePath || "");
      if (resolved) vaultPath = resolved.path;
    }
    results.push({
      kind: "file",
      vaultPath,
      displayPath: m[2],
      format: "wikilink",
      fullMatch: m[0],
      start: m.index,
      end: m.index + m[0].length
    });
  }
  const folderRe = new RegExp(AT_PATH_FOLDER_RE.source, AT_PATH_FOLDER_RE.flags);
  while ((m = folderRe.exec(content)) !== null) {
    const lead = m[1] || "";
    const relPath = m[2];
    const start = m.index + lead.length;
    const end = m.index + m[0].length;
    if (isInExcludedRange(start, excluded)) continue;
    const overlaps = results.some((r) => start < r.end && end > r.start);
    if (overlaps) continue;
    results.push({
      kind: "folder",
      vaultPath: relPath,
      displayPath: relPath + "/",
      format: "legacy",
      fullMatch: "@" + relPath + "/",
      start,
      end
    });
  }
  const legacyRe = new RegExp(AT_PATH_RE.source, AT_PATH_RE.flags);
  while ((m = legacyRe.exec(content)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (isInExcludedRange(start, excluded)) continue;
    if (content.charAt(end) === "/") continue;
    const overlaps = results.some((r) => start < r.end && end > r.start);
    if (overlaps) continue;
    results.push({
      kind: "file",
      vaultPath: null,
      // caller resolves via resolveAtPathFromSource
      displayPath: m[1],
      format: "legacy",
      fullMatch: m[0],
      start,
      end
    });
  }
  results.sort((a, b) => a.start - b.start);
  return results;
}
function buildAtPathViewPlugin(plugin) {
  function buildDecorations(view) {
    const builder = [];
    const selRanges = view.state.selection.ranges;
    const selectionOverlaps = (from, to) => selRanges.some((r) => r.from >= from && r.to <= to);
    for (const { from, to } of view.visibleRanges) {
      let overlapsFolder2 = function(absStart, absEnd) {
        for (const [fs, fe] of folderRanges) {
          if (absStart < fe && absEnd > fs) return true;
        }
        return false;
      };
      var overlapsFolder = overlapsFolder2;
      const text = view.state.sliceDoc(from, to);
      const folderRanges = [];
      const fre = new RegExp(AT_PATH_FOLDER_RE.source, AT_PATH_FOLDER_RE.flags);
      let m;
      while ((m = fre.exec(text)) !== null) {
        const lead = m[1] || "";
        const relPath = m[2];
        const absStart = from + m.index + lead.length;
        const absEnd = from + m.index + m[0].length;
        folderRanges.push([absStart, absEnd]);
        const fullMatch = "@" + relPath + "/";
        let tokenStr = null;
        if (plugin.settings.showTokenCounts) {
          const sourcePath = plugin.app.workspace.getActiveFile()?.path || "";
          const resolved = plugin.core.resolveAtPathTarget(
            { kind: "folder", vaultPath: relPath },
            sourcePath
          );
          if (resolved.kind === "folder") {
            tokenStr = f_formatFolderTokenCount(plugin.f_folderTokenCount(resolved.normalizedPath));
          }
        }
        if (selectionOverlaps(absStart, absEnd)) {
          const attrs = { "data-atpath": relPath, "data-atpath-kind": "folder" };
          if (tokenStr) attrs["data-tokens"] = tokenStr;
          builder.push({
            from: absStart,
            to: absEnd,
            deco: Decoration.mark({ class: "atpath-link atpath-folder-link", attributes: attrs })
          });
        } else {
          builder.push({
            from: absStart,
            to: absEnd,
            deco: Decoration.replace({
              widget: new AtFolderWidget(fullMatch, relPath, tokenStr)
            })
          });
        }
      }
      const fileRe = new RegExp(AT_PATH_RE.source, AT_PATH_RE.flags);
      while ((m = fileRe.exec(text)) !== null) {
        const absStart = from + m.index;
        const absEnd = from + m.index + m[0].length;
        if (overlapsFolder2(absStart, absEnd)) continue;
        if (absEnd < to && text[m.index + m[0].length] === "/") continue;
        const relPath = m[1];
        const attrs = { "data-atpath": relPath };
        let tokenStr = null;
        if (plugin.settings.showTokenCounts) {
          const vaultPath = resolveAtPath(relPath, plugin);
          const cached = plugin.tokenCache.get(vaultPath);
          if (cached) tokenStr = formatTokens(cached.tokens);
          else plugin.scheduleTokenFetch(vaultPath, view);
        }
        if (selectionOverlaps(absStart, absEnd)) {
          if (tokenStr) attrs["data-tokens"] = tokenStr;
          builder.push({
            from: absStart,
            to: absEnd,
            deco: Decoration.mark({ class: "atpath-link", attributes: attrs })
          });
        } else {
          builder.push({
            from: absStart,
            to: absEnd,
            deco: Decoration.replace({
              widget: new AtPathWidget(m[0], relPath, tokenStr)
            })
          });
        }
      }
    }
    builder.sort((a, b) => a.from - b.from || a.to - b.to);
    return Decoration.set(builder.map((b) => b.deco.range(b.from, b.to)));
  }
  return ViewPlugin.define(
    (view) => ({
      decorations: ATPATH_PERF.time("vp.atpath.buildDecorations.init", () => buildDecorations(view)),
      update(update) {
        ATPATH_PERF.inc("vp.atpath.update.calls");
        const triggers = [];
        if (update.docChanged) triggers.push("doc");
        if (update.viewportChanged) triggers.push("vp");
        if (update.selectionSet) triggers.push("sel");
        if (plugin.tokenCacheDirty) triggers.push("dirty");
        if (triggers.length > 0) {
          for (const t of triggers) ATPATH_PERF.inc("vp.atpath.update.trigger." + t);
          ATPATH_PERF.inc("vp.atpath.rebuild");
          this.decorations = ATPATH_PERF.time("vp.atpath.buildDecorations", () => buildDecorations(update.view));
          plugin.tokenCacheDirty = false;
        }
      }
    }),
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const target = event.target;
          if (!target.classList.contains("atpath-link")) return false;
          const relPath = target.dataset.atpath;
          if (!relPath) return false;
          event.preventDefault();
          const activeFile = plugin.app.workspace.getActiveFile();
          if (!activeFile) return false;
          const sourcePath = activeFile.path;
          if (target.dataset.atpathKind === "folder") {
            const resolved2 = plugin.core.resolveAtPathTarget(
              { kind: "folder", vaultPath: relPath },
              sourcePath
            );
            if (resolved2.kind === "folder") {
              revealFolderInExplorer(plugin.app, resolved2.target);
            }
            return true;
          }
          const vaultPath = resolveAtPathFromSource(relPath, sourcePath, plugin);
          const resolved = plugin.app.vault.getAbstractFileByPath(vaultPath);
          if (resolved instanceof TFile) {
            openFileByViewState(plugin, resolved);
          }
          return true;
        },
        contextmenu(event, view) {
          const target = event.target;
          if (!target.classList.contains("atpath-link")) return false;
          const relPath = target.dataset.atpath;
          if (!relPath) return false;
          event.preventDefault();
          const activeFile = plugin.app.workspace.getActiveFile();
          if (!activeFile) return false;
          if (target.dataset.atpathKind === "folder") {
            const resolved = plugin.core.resolveAtPathTarget(
              { kind: "folder", vaultPath: relPath },
              activeFile.path
            );
            if (resolved.kind === "folder") {
              showAtPathFolderMenu(plugin, event, resolved.target);
            }
            return true;
          }
          const vaultPath = resolveAtPathFromSource(relPath, activeFile.path, plugin);
          showAtPathMenu(plugin, event, vaultPath);
          return true;
        }
      }
    }
  );
}
function resolveWikilinkHref(plugin, href, sourcePath) {
  const direct = plugin.app.vault.getAbstractFileByPath(href);
  if (direct instanceof TFile) return direct.path;
  const resolved = plugin.app.metadataCache.getFirstLinkpathDest(href, sourcePath || "");
  if (resolved instanceof TFile) return resolved.path;
  return href;
}
function buildWikilinkViewPlugin(plugin) {
  const decorator = new MatchDecorator({
    regexp: WIKILINK_ATPATH_RE,
    decoration: (match, view, pos) => {
      const end = pos + match[0].length;
      const cursorInside = view.state.selection.ranges.some(
        (r) => r.from >= pos && r.to <= end
      );
      const linkTarget = match[1];
      const displayPath = match[2];
      const activeFile = plugin.app.workspace.getActiveFile();
      const sourcePath = activeFile?.path || "";
      const resolved = plugin.app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
      const vaultPath = resolved?.path || linkTarget;
      let tokenStr = null;
      if (plugin.settings.showTokenCounts) {
        const cached = plugin.tokenCache.get(vaultPath);
        if (cached) tokenStr = formatTokens(cached.tokens);
        else plugin.scheduleTokenFetch(vaultPath, view);
      }
      if (!cursorInside) {
        return Decoration.replace({
          widget: new WikilinkAtPathWidget(displayPath, vaultPath, tokenStr)
        });
      }
      return null;
    }
  });
  return ViewPlugin.define(
    (view) => ({
      decorations: ATPATH_PERF.time("vp.wikilink.createDeco.init", () => decorator.createDeco(view)),
      update(update) {
        ATPATH_PERF.inc("vp.wikilink.update.calls");
        if (update.docChanged) ATPATH_PERF.inc("vp.wikilink.update.trigger.doc");
        if (update.selectionSet) ATPATH_PERF.inc("vp.wikilink.update.trigger.sel");
        if (plugin.tokenCacheDirty) ATPATH_PERF.inc("vp.wikilink.update.trigger.dirty");
        if (plugin.tokenCacheDirty || update.selectionSet) {
          ATPATH_PERF.inc("vp.wikilink.createDeco");
          this.decorations = ATPATH_PERF.time("vp.wikilink.createDeco.full", () => decorator.createDeco(update.view));
          plugin.tokenCacheDirty = false;
        } else {
          ATPATH_PERF.inc("vp.wikilink.updateDeco");
          this.decorations = ATPATH_PERF.time("vp.wikilink.updateDeco.incremental", () => decorator.updateDeco(update, this.decorations));
        }
      }
    }),
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const target = event.target;
          if (!target.classList.contains("atpath-link")) return false;
          const vaultPath = target.dataset.atpath;
          if (!vaultPath) return false;
          event.preventDefault();
          const resolved = plugin.app.vault.getAbstractFileByPath(vaultPath);
          if (resolved instanceof TFile) openFileByViewState(plugin, resolved);
          return true;
        },
        contextmenu(event, view) {
          const target = event.target;
          if (!target.classList.contains("atpath-link")) return false;
          const vaultPath = target.dataset.atpath;
          if (!vaultPath) return false;
          event.preventDefault();
          showAtPathMenu(plugin, event, vaultPath);
          return true;
        }
      }
    }
  );
}
function buildBufferCountListener(plugin) {
  let pendingTimer = null;
  let lastDoc = null;
  function scheduleDocRetoken(view) {
    if (pendingTimer) return;
    ATPATH_PERF.inc("buffer.scheduleDocRetoken.scheduled");
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      try {
        const text = view.state.doc.toString();
        const kb = text.length / 1024;
        const bucket = kb < 1 ? "lt1k" : kb < 5 ? "1-5k" : kb < 20 ? "5-20k" : kb < 100 ? "20-100k" : "100k+";
        ATPATH_PERF.inc("buffer.encode.docSize." + bucket);
        plugin._noteBufferTokens = ATPATH_PERF.time("buffer.encode.doc", () => f_estimateTokens(text));
      } catch (err) {
        console.warn("[atpath] buffer token count failed", err);
      }
      plugin._repaintStatusBarFromBuffer();
    }, 80);
  }
  function recomputeSelection(state) {
    ATPATH_PERF.inc("buffer.recomputeSelection.calls");
    let total = 0;
    let nonEmpty = 0;
    for (const r of state.selection.ranges) {
      if (r.empty) continue;
      nonEmpty++;
      try {
        total += ATPATH_PERF.time("buffer.encode.selection", () => f_estimateTokens(state.sliceDoc(r.from, r.to)));
      } catch (err) {
        console.warn("[atpath] selection token count failed", err);
        return;
      }
    }
    if (nonEmpty > 0) ATPATH_PERF.inc("buffer.recomputeSelection.nonEmpty");
    plugin._selectionTokens = total;
    plugin._repaintStatusBarFromBuffer();
  }
  return EditorView.updateListener.of((update) => {
    ATPATH_PERF.inc("buffer.updateListener.calls");
    if (update.docChanged) {
      ATPATH_PERF.inc("buffer.updateListener.docChanged");
      if (lastDoc !== update.state.doc) {
        lastDoc = update.state.doc;
        scheduleDocRetoken(update.view);
      }
    }
    if (update.selectionSet) {
      ATPATH_PERF.inc("buffer.updateListener.selectionSet");
      recomputeSelection(update.state);
    }
  });
}
function extractDraggedVaultPaths(dataTransfer, plugin, sourcePath) {
  return coreExtractDraggedVaultPaths(dataTransfer, plugin.app, sourcePath, plugin._currentDragRefs);
}
function captureDragRefsFromExplorerDom(plugin, evt) {
  const app = plugin.app;
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const target = evt.target instanceof Element ? evt.target : null;
  if (!target) return out;
  const item = target.closest("[data-path]");
  if (!item) return out;
  const explorer = item.closest(".workspace-leaf-content[data-type='file-explorer']") || item.closest(".nav-files-container") || null;
  let candidates;
  if (explorer && item.classList.contains("is-selected")) {
    const selected = explorer.querySelectorAll(".is-selected[data-path]");
    candidates = selected.length > 0 ? Array.from(selected) : [item];
  } else {
    candidates = [item];
  }
  for (const el of candidates) {
    const path = el.getAttribute("data-path");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const af = app.vault.getAbstractFileByPath(path);
    if (!af) continue;
    if (af instanceof TFile) {
      out.push({ kind: "file", vaultPath: af.path, target: af });
    } else if (af instanceof TFolder) {
      out.push({ kind: "folder", vaultPath: af.path, target: af });
    }
  }
  return out;
}
function insertAtPathRefs(view, pos, refs, plugin) {
  const sourcePath = plugin.app.workspace.getActiveFile()?.path || "";
  const parts = [];
  for (const ref of refs) {
    if (!ref?.target) continue;
    try {
      parts.push(plugin.f_formatLinkedTarget(ref.target, sourcePath));
    } catch (error) {
      new Notice(error.message);
    }
  }
  if (parts.length === 0) return;
  const text = parts.join(" ") + " ";
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: "input.drop"
  });
}
function buildDragDropExtension(plugin) {
  return EditorView.domEventHandlers({
    dragover(evt, _view) {
      const refs = extractDraggedVaultPaths(
        evt.dataTransfer,
        plugin,
        plugin.app.workspace.getActiveFile()?.path || ""
      );
      if (!refs.length) return false;
      evt.preventDefault();
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = "link";
      return true;
    },
    drop(evt, view) {
      const sourcePath = plugin.app.workspace.getActiveFile()?.path || "";
      let refs = extractDraggedVaultPaths(evt.dataTransfer, plugin, sourcePath);
      if (!refs.length) return false;
      if (refs.length > 50) {
        new Notice("Drop limited to 50 paths");
        refs = refs.slice(0, 50);
      }
      evt.preventDefault();
      evt.stopPropagation();
      const dropPos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
      insertAtPathRefs(view, dropPos != null ? dropPos : view.state.selection.main.head, refs, plugin);
      plugin._currentDragRefs = null;
      return true;
    }
  });
}
function f_editorSourcePath(view, plugin) {
  const source = plugin.app.workspace.getLeavesOfType("markdown").find((leaf) => leaf.view.editor?.cm === view);
  return source?.view.file?.path || plugin.app.workspace.getActiveFile()?.path;
}
var RepositoryTokenWidget = class extends WidgetType {
  constructor(count, skipped) {
    super();
    this.count = count;
    this.skipped = skipped;
  }
  eq(other) {
    return this.count === other.count && this.skipped === other.skipped;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "atpath-token-count";
    span.textContent = " (" + this.count + ")";
    span.title = "Approximate tokens from character count" + (this.skipped ? ". " + this.skipped + " files skipped." : "");
    return span;
  }
};
function f_buildRepositoryLinkView(plugin) {
  function f_decorate(view, refs, sourcePath) {
    if (!sourcePath) return Decoration.none;
    const ranges = [];
    for (const ref of refs) {
      if (!view.visibleRanges.some((range) => ref.start >= range.from && ref.end <= range.to)) continue;
      const result = plugin.f_resolveLinkTarget(ref, sourcePath);
      if (result.kind === "ignored") continue;
      ranges.push(Decoration.mark({
        attributes: {
          "data-atpath-destination": ref.destination,
          "data-atpath-source": sourcePath,
          title: result.reason || result.normalizedPath
        }
      }).range(ref.start, ref.end));
      if (!plugin.settings.showTokenCounts) continue;
      let text;
      let skipped;
      if (result.kind === "missing") text = "unavailable";
      else if (result.kind === "folder") {
        const count = plugin.f_folderTokenCount(result.normalizedPath);
        skipped = count?.skipped;
        text = f_formatFolderTokenCount(count);
      } else {
        plugin.f_watchLinkedCount(result.normalizedPath, false);
        const cached = plugin.tokenCache.get(result.normalizedPath);
        if (!cached) plugin.scheduleTokenFetch(result.normalizedPath, view);
        if (cached) text = formatTokens(cached.tokens);
      }
      if (text) ranges.push(Decoration.widget({ widget: new RepositoryTokenWidget(text, skipped), side: 1 }).range(ref.end));
    }
    return Decoration.set(ranges, true);
  }
  return ViewPlugin.define((view) => {
    const refs = plugin.f_scanMarkdownRefs(view.state.doc.toString());
    const sourcePath = f_editorSourcePath(view, plugin);
    return {
      refs,
      sourcePath,
      generation: plugin._repositoryDecorationGeneration,
      decorations: f_decorate(view, refs, sourcePath),
      update(update) {
        const path = f_editorSourcePath(update.view, plugin);
        if (update.docChanged) this.refs = plugin.f_scanMarkdownRefs(update.state.doc.toString());
        if (update.docChanged || update.viewportChanged || path !== this.sourcePath || this.generation !== plugin._repositoryDecorationGeneration) {
          this.sourcePath = path;
          this.generation = plugin._repositoryDecorationGeneration;
          this.decorations = f_decorate(update.view, this.refs, path);
        }
      }
    };
  }, {
    decorations: (value) => value.decorations
  });
}
function f_captureEditorRepositoryLinks(plugin) {
  const handle = (event) => {
    const link = event.target.closest?.("[data-atpath-destination][data-atpath-source]");
    if (!link || !link.closest(".cm-content")) return;
    if (event.type !== "contextmenu") {
      if (event.type === "mousedown" && !(event.button === 1 || Platform.isAndroidApp)) return;
      if (event.type === "click" && (event.button !== 0 || Platform.isAndroidApp)) return;
      if (!event.ctrlKey && !event.metaKey && event.button !== 1 && !Platform.isMobile) {
        if (event.altKey || event.shiftKey || !link.closest(".is-live-preview") || !event.target.closest(".cm-underline, .external-link")) return;
        if (!link.ownerDocument.getSelection()?.isCollapsed) return;
      }
    }
    f_interceptRepositoryLink(plugin, event, link.dataset.atpathDestination, link.dataset.atpathSource);
  };
  for (const type of ["click", "mousedown", "contextmenu"]) plugin.registerDomEvent(document, type, handle, { capture: true });
}
function f_isCanonicalRepositoryDestination(destination) {
  return destination.startsWith("/") && !destination.startsWith("//") || /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\//i.test(destination);
}
function f_interceptRepositoryLink(plugin, event, destination, sourcePath) {
  const resolved = plugin.f_resolveLinkTarget({ destination }, sourcePath);
  if (resolved.kind === "ignored") return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === "contextmenu") {
    if (resolved.kind === "folder") showAtPathFolderMenu(plugin, event, resolved.target);
    if (resolved.kind === "file") showAtPathMenu(plugin, event, resolved.normalizedPath);
  } else {
    void plugin.f_resolveLinkTargetAsync({ destination }, sourcePath).then((result) => plugin.f_openRepositoryTarget(result, event.ctrlKey || event.metaKey || event.button === 1)).catch((error) => new Notice("Could not open repository link: " + error.message));
  }
  return true;
}
function registerPostProcessor(plugin) {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    for (const link of el.querySelectorAll("a[href]")) {
      const destination = link.dataset.href || link.getAttribute("href");
      if (!destination || !f_isCanonicalRepositoryDestination(destination) && !/^\.\.?\//.test(destination)) continue;
      const result = plugin.f_resolveLinkTarget({ destination }, ctx.sourcePath);
      if (!f_isCanonicalRepositoryDestination(destination) && result.kind === "missing") continue;
      if (result.kind === "ignored" && !result.repository) continue;
      link.addEventListener("click", (event) => f_interceptRepositoryLink(plugin, event, destination, ctx.sourcePath), true);
      link.addEventListener("contextmenu", (event) => f_interceptRepositoryLink(plugin, event, destination, ctx.sourcePath), true);
      if (result.kind === "ignored") continue;
      link.classList.add("atpath-link");
      link.title = result.reason || result.normalizedPath;
      if (!plugin.settings.showTokenCounts) continue;
      const badge = link.createSpan({ cls: "atpath-token-count" });
      badge.title = "Approximate tokens from character count";
      if (result.kind === "folder") f_bindReadingFolderCount(plugin, ctx, badge, result.normalizedPath);
      else {
        if (result.kind === "missing") badge.textContent = " (unavailable)";
        void plugin.f_resolveLinkTargetAsync({ destination }, ctx.sourcePath).then(async (resolved) => {
          if (resolved.kind !== "file") return;
          const count = await plugin.getTokenCount(resolved.normalizedPath);
          badge.textContent = count == null ? "" : " (" + formatTokens(count) + ")";
          link.title = resolved.normalizedPath;
        }).catch((error) => console.warn("AtPath could not count linked target", destination, error));
      }
    }
    const internalLinks = el.querySelectorAll("a.internal-link");
    for (const link of internalLinks) {
      if (link.classList.contains("atpath-link") || !link.textContent.startsWith("@")) continue;
      link.classList.add("atpath-link");
      const rawHref = link.dataset.href || link.getAttribute("href") || "";
      const vaultPath = resolveWikilinkHref(plugin, rawHref, ctx.sourcePath);
      link.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showAtPathMenu(plugin, e, vaultPath);
      });
      if (plugin.settings.showTokenCounts) {
        const tokenSpan = document.createElement("span");
        tokenSpan.className = "atpath-token-count";
        const cached = plugin.tokenCache.get(vaultPath);
        if (cached) {
          tokenSpan.textContent = " (" + formatTokens(cached.tokens) + ")";
        } else {
          plugin.getTokenCount(vaultPath).then(
            (tokens) => {
              if (tokens != null) {
                tokenSpan.textContent = " (" + formatTokens(tokens) + ")";
              }
            },
            (err) => console.warn("[atpath] token count failed", err)
          );
        }
        link.after(tokenSpan);
      }
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const fileRe = /(?:^|(?<=[\s(]))@([\w\p{L}\p{M}./_-]+\.[\w]+|[\w\p{L}\p{M}./_-][\w\p{L}\p{M}./ _()&-]+?\.[\w]+)/gu;
    const replacements = [];
    let node;
    while (node = walker.nextNode()) {
      const text = node.textContent;
      const folderRanges = [];
      const folderRe = new RegExp(AT_PATH_FOLDER_RE.source, AT_PATH_FOLDER_RE.flags);
      let fMatch;
      while ((fMatch = folderRe.exec(text)) !== null) {
        const lead = fMatch[1] || "";
        const capture = fMatch[2];
        const startIdx = fMatch.index + lead.length;
        const endIdx = fMatch.index + fMatch[0].length;
        folderRanges.push([startIdx, endIdx]);
        replacements.push({
          node,
          kind: "folder",
          match: "@" + capture + "/",
          capture,
          index: startIdx,
          length: endIdx - startIdx
        });
      }
      fileRe.lastIndex = 0;
      let match;
      while ((match = fileRe.exec(text)) !== null) {
        const startIdx = match.index;
        const endIdx = match.index + match[0].length;
        let overlaps = false;
        for (const [fs, fe] of folderRanges) {
          if (startIdx < fe && endIdx > fs) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;
        if (text[endIdx] === "/") continue;
        replacements.push({
          node,
          kind: "file",
          match: match[0],
          capture: match[1],
          index: startIdx,
          length: match[0].length
        });
      }
    }
    const byNode = /* @__PURE__ */ new Map();
    for (const r of replacements) {
      if (!byNode.has(r.node)) byNode.set(r.node, []);
      byNode.get(r.node).push(r);
    }
    for (const [textNode, items] of byNode) {
      items.sort((a, b) => b.index - a.index);
      for (const item of items) {
        const { kind, match, capture, index, length } = item;
        const before = textNode.textContent.substring(0, index);
        const after = textNode.textContent.substring(index + length);
        const parent = textNode.parentNode;
        if (!parent) continue;
        const link = document.createElement("a");
        link.className = kind === "folder" ? "atpath-link atpath-folder-link" : "atpath-link";
        link.textContent = match;
        if (kind === "folder") {
          link.addEventListener("click", (e) => {
            e.preventDefault();
            const resolved = plugin.core.resolveAtPathTarget(
              { kind: "folder", vaultPath: capture },
              ctx.sourcePath
            );
            if (resolved.kind === "folder") {
              revealFolderInExplorer(plugin.app, resolved.target);
            }
          });
          link.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const resolved = plugin.core.resolveAtPathTarget(
              { kind: "folder", vaultPath: capture },
              ctx.sourcePath
            );
            if (resolved.kind === "folder") {
              showAtPathFolderMenu(plugin, e, resolved.target);
            }
          });
        } else {
          link.addEventListener("click", (e) => {
            e.preventDefault();
            const vaultPath = resolveAtPathFromSource(capture, ctx.sourcePath, plugin);
            const resolved = plugin.app.vault.getAbstractFileByPath(vaultPath);
            if (resolved instanceof TFile) {
              openFileByViewState(plugin, resolved);
            }
          });
          link.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const vaultPath = resolveAtPathFromSource(capture, ctx.sourcePath, plugin);
            showAtPathMenu(plugin, e, vaultPath);
          });
        }
        if (after) parent.insertBefore(document.createTextNode(after), textNode.nextSibling);
        if (plugin.settings.showTokenCounts) {
          const tokenSpan = document.createElement("span");
          tokenSpan.className = "atpath-token-count";
          if (kind === "folder") {
            const resolved = plugin.core.resolveAtPathTarget(
              { kind: "folder", vaultPath: capture },
              ctx.sourcePath
            );
            if (resolved.kind === "folder") {
              f_bindReadingFolderCount(plugin, ctx, tokenSpan, resolved.normalizedPath);
            }
          } else {
            const vaultPath = resolveAtPathFromSource(capture, ctx.sourcePath, plugin);
            const cached = plugin.tokenCache.get(vaultPath);
            if (cached) {
              tokenSpan.textContent = " (" + formatTokens(cached.tokens) + ")";
            } else {
              plugin.getTokenCount(vaultPath).then(
                (tokens) => {
                  if (tokens != null) {
                    tokenSpan.textContent = " (" + formatTokens(tokens) + ")";
                  }
                },
                (err) => console.warn("[atpath] token count failed", err)
              );
            }
          }
          parent.insertBefore(tokenSpan, textNode.nextSibling);
        }
        parent.insertBefore(link, textNode.nextSibling);
        textNode.textContent = before;
      }
    }
  });
}
var AtPathSettingTab = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Show token counts").setDesc("Display approximate token counts next to linked targets and in the status bar. Counts use four characters per token.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.showTokenCounts).onChange(async (value) => {
        this.plugin.settings.showTokenCounts = value;
        await this.plugin.saveSettings();
        this.plugin.onTokenSettingsChanged();
      })
    );
    new Setting(containerEl).setName("Max file size (MB)").setDesc("Skip token counting for files larger than this.").addText(
      (text) => text.setValue(String(this.plugin.settings.maxFileSizeMB)).onChange(async (value) => {
        const num = parseFloat(value);
        if (!isNaN(num) && num > 0) {
          this.plugin.settings.maxFileSizeMB = num;
          await this.plugin.saveSettings();
          this.plugin.onTokenSettingsChanged();
        }
      })
    );
    new Setting(containerEl).setName("Max files per folder reference").setDesc("Folder references above this limit show a file count and are skipped when copying linked content.").addText(
      (text) => text.setValue(String(this.plugin.settings.maxFolderFiles)).onChange(async (value) => {
        const num = parseInt(value, 10);
        if (!isNaN(num) && num > 0) {
          this.plugin.settings.maxFolderFiles = num;
          await this.plugin.saveSettings();
          this.plugin.onTokenSettingsChanged();
        }
      })
    );
    new Setting(containerEl).setName("Show selection tokens in status bar").setDesc("When you select text, the note segment shows `Sel: <selected> / <total>`. Disable to always show the note total only.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.statusBarShowSelection !== false).onChange(async (value) => {
        this.plugin.settings.statusBarShowSelection = value;
        await this.plugin.saveSettings();
        this.plugin.updateStatusBar();
      })
    );
    new Setting(containerEl).setName("Suggest folders in autocomplete").setDesc("Include folder candidates when you type [[. A folder inserts an ordinary Markdown link.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.suggestFolders !== false).onChange(async (value) => {
        this.plugin.settings.suggestFolders = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Drag-and-drop repository links").setDesc("Dragging a file or folder into the editor inserts a Markdown repository link. Disable to restore Obsidian\u2019s default drag behavior.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enableDragDropAtPath !== false).onChange(async (value) => {
        this.plugin.settings.enableDragDropAtPath = value;
        await this.plugin.saveSettings();
        this.plugin.reconfigureDragDrop();
      })
    );
    new Setting(containerEl).setHeading().setName("Publishing");
    new Setting(containerEl).setName("Vercel API token").setDesc("Personal access token for deploying notes to Vercel.").addText(
      (text) => text.setPlaceholder("Enter token...").setValue(this.plugin.settings.vercelToken).then((t) => {
        t.inputEl.type = "password";
      }).onChange(async (value) => {
        this.plugin.settings.vercelToken = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Contact URL").setDesc("Link for the contact button on published pages (e.g. WhatsApp link).").addText(
      (text) => text.setPlaceholder("https://wa.me/...").setValue(this.plugin.settings.contactUrl).onChange(async (value) => {
        this.plugin.settings.contactUrl = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Contact button label").setDesc("Text shown on the contact button.").addText(
      (text) => text.setValue(this.plugin.settings.contactLabel).onChange(async (value) => {
        this.plugin.settings.contactLabel = value;
        await this.plugin.saveSettings();
      })
    );
    const siteIconSetting = new Setting(containerEl).setName("Site icon");
    addSiteIconPicker(
      siteIconSetting,
      this.plugin,
      "Shown in browser tabs for published sites. Choose it once and reuse it everywhere."
    );
    new Setting(containerEl).setHeading().setName("Private publishing");
    new Setting(containerEl).setName("Clerk publishable key").setDesc("From your Clerk dashboard (clerk.com). Free tier: 50k users/month.").addText(
      (text) => text.setPlaceholder("pk_live_...").setValue(this.plugin.settings.clerkPublishableKey).onChange(async (value) => {
        this.plugin.settings.clerkPublishableKey = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Clerk secret key").setDesc("Keep this secret. Used server-side to verify session tokens.").addText(
      (text) => text.setPlaceholder("sk_live_...").setValue(this.plugin.settings.clerkSecretKey).then((t) => {
        t.inputEl.type = "password";
      }).onChange(async (value) => {
        this.plugin.settings.clerkSecretKey = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Publisher email").setDesc("Viewers can request access via email to this address.").addText(
      (text) => text.setPlaceholder("you@example.com").setValue(this.plugin.settings.publisherEmail).onChange(async (value) => {
        this.plugin.settings.publisherEmail = value.trim();
        await this.plugin.saveSettings();
      })
    );
  }
};
var PublishConfirmModal = class extends Modal {
  constructor(app, publishData, onConfirm, onUnpublish) {
    super(app);
    this.publishData = publishData;
    this.onConfirm = onConfirm;
    this.onUnpublish = onUnpublish;
  }
  onOpen() {
    const { contentEl } = this;
    const { domain, plugin } = this.publishData;
    const atPathFiles = this.publishData.atPathFiles || [];
    const pageState = getPublishState(plugin, this.publishData);
    const isHtmlAppPublish = this.publishData.publishKind === "html-app";
    contentEl.createEl("h2", { text: "Publish to Vercel" });
    const statusEl = contentEl.createDiv({ cls: "atpath-publish-status" });
    if (pageState && pageState.url && !pageState.isUnpublished) {
      statusEl.createSpan({ cls: "atpath-status-dot atpath-status-dot--live" });
      statusEl.appendText("Live at " + pageState.url);
      if (pageState.isPrivate && pageState.approvedEmails) {
        statusEl.appendText(" \u2014 Private (" + pageState.approvedEmails.length + " users)");
      }
    } else if (pageState && pageState.isUnpublished) {
      statusEl.createSpan({ cls: "atpath-status-dot atpath-status-dot--unpublished" });
      statusEl.appendText("Unpublished \u2014 " + pageState.url);
    } else {
      statusEl.appendText("Not published");
      statusEl.createEl("br");
      statusEl.createEl("small", { text: "Will publish to " + domain });
    }
    if (isHtmlAppPublish) {
      const modeLabel = this.publishData.publishScope === HTML_APP_SCOPE_FOLDER ? "Folder mode" : "Single-file mode";
      contentEl.createEl("p", { text: modeLabel + " \u2014 " + this.publishData.sourcePath });
      if (this.publishData.publishScope === HTML_APP_SCOPE_FOLDER) {
        const sourceFolder = this.publishData.sourcePath.split("/").slice(0, -1).join("/") || "/";
        contentEl.createEl("small", { text: "Will deploy the parent folder recursively from " + sourceFolder });
      } else {
        contentEl.createEl("small", { text: "Will deploy only this HTML file as /index.html" });
      }
    } else if (atPathFiles.length > 0) {
      const heading = "Linked files (" + atPathFiles.length + ")";
      if (atPathFiles.length > 5) {
        const details = contentEl.createEl("details");
        details.createEl("summary", { text: heading });
        const list = details.createEl("ul");
        for (const f of atPathFiles) list.createEl("li", { text: "@" + f.relPath });
      } else {
        contentEl.createEl("p", { text: heading });
        const list = contentEl.createEl("ul");
        for (const f of atPathFiles) list.createEl("li", { text: "@" + f.relPath });
      }
    }
    let tokenValue = plugin.settings.vercelToken;
    if (!tokenValue) {
      new Setting(contentEl).setName("Vercel API token").addText(
        (text) => text.setPlaceholder("Enter token...").then((t) => {
          t.inputEl.type = "password";
        }).onChange((value) => {
          tokenValue = value.trim();
        })
      );
    }
    let siteTitleValue = pageState && pageState.siteTitle ? pageState.siteTitle : this.publishData.noteTitle;
    if (isHtmlAppPublish) {
      new Setting(contentEl).setName("Website title").setDesc("Used as the publish label and unpublished placeholder title.").addText(
        (text) => text.setValue(siteTitleValue).onChange((value) => {
          siteTitleValue = value.trim();
        })
      );
    }
    let siteIconPicker = null;
    if (!plugin.settings.siteIconDataUrl) {
      const siteIconSetting = new Setting(contentEl).setName("Site icon");
      siteIconPicker = addSiteIconPicker(
        siteIconSetting,
        plugin,
        "Optional. Shown in browser tabs and saved globally for future publishes.",
        { notices: false }
      );
    }
    const isExistingProject = pageState && pageState.projectName;
    let projectNameValue = isExistingProject ? pageState.projectName : this.publishData.defaultProjectName || slugify(this.publishData.noteTitle);
    const projectNameSetting = new Setting(contentEl).setName("Project name").setDesc(isExistingProject ? projectNameValue + ".vercel.app" : "");
    if (isExistingProject) {
      projectNameSetting.setDesc(projectNameValue + ".vercel.app (already deployed)");
    } else {
      projectNameSetting.addText((text) => {
        const validateProjectName = (val) => {
          const invalid = val.length > 100 || /[^a-z0-9._-]/.test(val) || val.includes("---") || !val;
          const tooLong = val.length > 40;
          text.inputEl.toggleClass("atpath-input-error", invalid);
          return { valid: !invalid, tooLong };
        };
        text.setValue(projectNameValue).onChange((value) => {
          projectNameValue = value.trim();
          const result = validateProjectName(projectNameValue);
          if (!result.valid) {
            projectNameSetting.setDesc("Invalid: use a-z, 0-9, ., _, - (max 100 chars, no ---)");
          } else if (result.tooLong) {
            projectNameSetting.setDesc(projectNameValue + ".vercel.app \u2014 Warning: long names may be shortened by Vercel");
          } else {
            projectNameSetting.setDesc(projectNameValue + ".vercel.app");
          }
        });
        const initResult = validateProjectName(projectNameValue);
        projectNameSetting.setDesc(
          initResult.tooLong ? projectNameValue + ".vercel.app \u2014 Warning: long names may be shortened by Vercel" : projectNameValue + ".vercel.app"
        );
      });
    }
    let compactLinks = true;
    if (!isHtmlAppPublish) {
      new Setting(contentEl).setName("Use file names for published links?").setDesc("Show just the filename (e.g. helpers.py) instead of the full path").addToggle(
        (toggle) => toggle.setValue(true).onChange((value) => {
          compactLinks = value;
        })
      );
    }
    let isPrivate = pageState && pageState.isPrivate || false;
    let clerkPubKey = plugin.settings.clerkPublishableKey;
    let clerkSecKey = plugin.settings.clerkSecretKey;
    let approvedEmailsText = (pageState && pageState.approvedEmails || []).join("\n");
    const privateToggleContainer = contentEl.createDiv();
    const authSectionEl = contentEl.createDiv({ cls: "atpath-auth-section" + (isPrivate ? "" : " atpath-hidden") });
    new Setting(privateToggleContainer).setName("Require login to view").addToggle(
      (toggle) => toggle.setValue(isPrivate).onChange((value) => {
        isPrivate = value;
        if (value) {
          authSectionEl.removeClass("atpath-hidden");
        } else {
          authSectionEl.addClass("atpath-hidden");
        }
      })
    );
    if (!clerkPubKey) {
      new Setting(authSectionEl).setName("Clerk publishable key").addText(
        (text) => text.setPlaceholder("pk_live_...").onChange((value) => {
          clerkPubKey = value.trim();
        })
      );
    }
    if (!clerkSecKey) {
      new Setting(authSectionEl).setName("Clerk secret key").addText(
        (text) => text.setPlaceholder("sk_live_...").then((t) => {
          t.inputEl.type = "password";
        }).onChange((value) => {
          clerkSecKey = value.trim();
        })
      );
    }
    const emailsSetting = new Setting(authSectionEl).setName("Approved emails").setDesc("One email per line");
    emailsSetting.controlEl.addClass("atpath-approved-emails");
    const textarea = emailsSetting.controlEl.createEl("textarea", {
      attr: { placeholder: "alice@example.com\nbob@example.com", rows: "4" }
    });
    textarea.value = approvedEmailsText;
    textarea.addEventListener("input", () => {
      approvedEmailsText = textarea.value;
    });
    const buttonSetting = new Setting(contentEl);
    if (pageState && pageState.url && !pageState.isUnpublished) {
      buttonSetting.addButton(
        (btn) => btn.setButtonText("Unpublish").setWarning().onClick(() => {
          this.close();
          new UnpublishConfirmModal(this.app, this.publishData, this.onUnpublish).open();
        })
      );
    }
    buttonSetting.addButton(
      (btn) => btn.setButtonText("Cancel").onClick(() => this.close())
    );
    const publishLabel = pageState && pageState.url ? "Republish" : "Publish";
    buttonSetting.addButton(
      (btn) => btn.setButtonText(publishLabel).setCta().onClick(() => {
        void (async () => {
          try {
            if (siteIconPicker) {
              await siteIconPicker.waitForPending();
            }
            if (!tokenValue) {
              new Notice("Please enter a Vercel API token.");
              return;
            }
            if (isHtmlAppPublish && !siteTitleValue) {
              new Notice("Please enter a website title.");
              return;
            }
            if (!projectNameValue || projectNameValue.length > 100 || /[^a-z0-9._-]/.test(projectNameValue) || projectNameValue.includes("---")) {
              new Notice("Invalid project name. Use a-z, 0-9, ., _, - (max 100 chars, no ---).");
              return;
            }
            if (isPrivate) {
              const emails = approvedEmailsText.split("\n").map((e) => e.trim().toLowerCase()).filter(Boolean);
              if (emails.length === 0) {
                new Notice("Add at least one approved email.");
                return;
              }
              if (!clerkPubKey) {
                new Notice("Please enter a Clerk publishable key.");
                return;
              }
              if (!clerkSecKey) {
                new Notice("Please enter a Clerk secret key.");
                return;
              }
              if (clerkPubKey.startsWith("pk_test_") || clerkSecKey.startsWith("sk_test_")) {
                new Notice("Warning: test keys may not work on production. Consider live keys.", 8e3);
              }
              this.close();
              this.onConfirm({
                token: tokenValue,
                compactLinks,
                siteTitle: siteTitleValue || this.publishData.noteTitle,
                isPrivate: true,
                approvedEmails: emails,
                clerkPublishableKey: clerkPubKey,
                clerkSecretKey: clerkSecKey,
                projectName: projectNameValue
              });
            } else {
              if (pageState && pageState.isPrivate) {
                const confirmed = confirm("This will make the page publicly accessible. Continue?");
                if (!confirmed) return;
              }
              this.close();
              this.onConfirm({
                token: tokenValue,
                compactLinks,
                siteTitle: siteTitleValue || this.publishData.noteTitle,
                isPrivate: false,
                projectName: projectNameValue
              });
            }
          } catch (error) {
            new Notice(error.message || String(error));
          }
        })();
      })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
};
var UnpublishConfirmModal = class extends Modal {
  constructor(app, publishData, onUnpublish) {
    super(app);
    this.publishData = publishData;
    this.onUnpublish = onUnpublish;
  }
  onOpen() {
    const { contentEl } = this;
    const { plugin } = this.publishData;
    const pageState = getPublishState(plugin, this.publishData);
    const url = pageState ? pageState.url : "";
    contentEl.createEl("h2", { text: "Unpublish" });
    contentEl.createEl("p", { text: url });
    contentEl.createEl("p", {
      text: "This will replace the content with a placeholder page. The URL will remain active. You can republish at any time."
    });
    new Setting(contentEl).addButton(
      (btn) => btn.setButtonText("Go back").onClick(() => {
        this.close();
        new PublishConfirmModal(
          this.app,
          this.publishData,
          this.publishData._onConfirm,
          this.publishData._onUnpublish
        ).open();
      })
    ).addButton(
      (btn) => btn.setButtonText("Unpublish").setWarning().onClick(() => {
        this.close();
        this.onUnpublish();
      })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
};
var PublishResultModal = class extends Modal {
  constructor(app, result) {
    super(app);
    this.result = result;
  }
  onOpen() {
    const { contentEl } = this;
    const { success, url, summary, error, warning } = this.result;
    if (success) {
      contentEl.createEl("h2", { text: warning ? "Published with warnings" : "Published successfully" });
      contentEl.createEl("p", { text: summary });
      if (warning) {
        const warnDiv = contentEl.createDiv({ cls: "atpath-deploy-warning" });
        warnDiv.createEl("p", { text: warning });
      }
      contentEl.createEl("p", { text: url, cls: "atpath-publish-url" });
      new Setting(contentEl).addButton(
        (btn) => btn.setButtonText("Copy URL").setCta().onClick(async () => {
          await copyToClipboard(url);
          btn.setButtonText("Copied!");
          setTimeout(() => btn.setButtonText("Copy URL"), 2e3);
        })
      ).addButton(
        (btn) => btn.setButtonText("Open in browser").onClick(() => {
          window.open(url, "_blank");
        })
      );
    } else {
      contentEl.createEl("h2", { text: "Publish failed" });
      const pre = contentEl.createEl("pre", { cls: "atpath-error-pre" });
      pre.textContent = error;
    }
    new Setting(contentEl).addButton(
      (btn) => btn.setButtonText("Close").onClick(() => this.close())
    );
  }
  onClose() {
    this.contentEl.empty();
  }
};
var MigrationPreviewModal = class extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Review legacy links for migration" });
    const statusEl = contentEl.createEl("p", { text: "Scanning files...", cls: "atpath-migration-status" });
    const plan = await this.plugin.f_planRepositoryMigration();
    const resolved = plan.reduce((total, file) => total + file.edits.length, 0);
    const unresolved = plan.reduce((total, file) => total + file.skipped.length, 0);
    statusEl.setText(resolved + " proposed replacements and " + unresolved + " unresolved references in " + plan.length + " files.");
    for (const file of plan) {
      const details = contentEl.createEl("details");
      details.createEl("summary", { text: file.file.path });
      const lines = [];
      for (const edit of file.edits) lines.push("- " + edit.original, "+ " + edit.replacement);
      for (const skipped of file.skipped) lines.push("Unresolved: " + skipped);
      details.createEl("pre", { text: lines.join("\n") });
    }
    new Setting(contentEl).addButton((button) => button.setButtonText("Close").onClick(() => this.close())).addButton((button) => button.setButtonText("Apply reviewed replacements").setDisabled(!resolved).setCta().onClick(async () => {
      this.close();
      await this.plugin.f_applyRepositoryMigration(plan);
    }));
  }
  onClose() {
    this.contentEl.empty();
  }
};
var HtmlAppScopeModal = class extends Modal {
  constructor(app, plugin, htmlFile) {
    super(app);
    this.plugin = plugin;
    this.htmlFile = htmlFile;
  }
  onOpen() {
    const { contentEl } = this;
    const pageState = getPublishedHtmlAppState(this.plugin.settings, this.htmlFile.path);
    const previousScope = pageState && pageState.scope;
    contentEl.createEl("h2", { text: "@Path: publish HTML app" });
    contentEl.createEl("p", { text: this.htmlFile.path });
    if (pageState && pageState.url && !pageState.isUnpublished) {
      contentEl.createEl("p", { text: "Current publish: " + pageState.url });
    } else if (pageState && pageState.isUnpublished) {
      contentEl.createEl("p", { text: "Current publish: unpublished at " + pageState.url });
    }
    contentEl.createEl("p", {
      text: "Choose whether to deploy just this HTML file or its whole folder."
    });
    contentEl.createEl("small", {
      text: "Single file deploys only this file as /index.html. Folder deploys the parent folder recursively and uses this file as the site entry point."
    });
    new Setting(contentEl).addButton(
      (btn) => btn.setButtonText("Publish single file").setCta(previousScope !== HTML_APP_SCOPE_FOLDER).onClick(async () => {
        this.close();
        await this.plugin.publishHtmlApp(this.htmlFile, HTML_APP_SCOPE_SINGLE_FILE);
      })
    ).addButton(
      (btn) => btn.setButtonText("Publish folder").setCta(previousScope === HTML_APP_SCOPE_FOLDER).onClick(async () => {
        this.close();
        await this.plugin.publishHtmlApp(this.htmlFile, HTML_APP_SCOPE_FOLDER);
      })
    ).addButton(
      (btn) => btn.setButtonText("Cancel").onClick(() => this.close())
    );
  }
  onClose() {
    this.contentEl.empty();
  }
};
var AtPathPlugin = class extends Plugin {
  async onload() {
    await this.loadSettings();
    this.tokenCache = /* @__PURE__ */ new Map();
    this.tokenCacheDirty = false;
    this._refreshTimer = null;
    this._lastEditorView = null;
    this._statusBarGen = 0;
    this.core = createAtPathCore(this);
    this._unindexedTargets = /* @__PURE__ */ new Map();
    this._unindexedProbes = /* @__PURE__ */ new Map();
    this._linkedCountWatches = /* @__PURE__ */ new Map();
    const vault = this.app.vault;
    const vaultKey = this.app.appId || vault.adapter.getBasePath?.() || vault.getName();
    this._tokenIndex = f_createTokenIndex({
      getFiles: () => [...vault.getFiles(), ...this._unindexedTargets.values()],
      read: (file) => this.f_readLinkedFile(file),
      isEligible: (file) => this.f_eligibleLinkedFile(file),
      looksBinary,
      load: () => f_loadTokenCache(vaultKey),
      save: (cache) => f_saveTokenCache(vaultKey, cache),
      tokenCache: this.tokenCache,
      onError: (error) => console.warn("AtPath count cache", error)
    });
    this.register(this._tokenIndex.subscribe(() => {
      let changed = false;
      for (const [key, watch] of this._linkedCountWatches) {
        const next = this.f_linkedCountSignature(watch.path, watch.folder);
        if (watch.signature === next) continue;
        this._linkedCountWatches.set(key, { ...watch, signature: next });
        changed = true;
      }
      if (!changed) return;
      this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
      this.tokenCacheDirty = true;
      this._scheduleRefresh();
    }));
    this.app.workspace.onLayoutReady(() => {
      if (this._repositoryIndexClosed) return;
      this._explorerTokenBadges = f_installExplorerTokenBadges({
        workspace: this.app.workspace,
        index: this._tokenIndex,
        formatTokens: (tokens) => formatTokens(tokens).slice(1),
        isEnabled: () => this.settings.showTokenCounts
      });
      void this._tokenIndex.start().catch((error) => console.warn("AtPath could not start token counting", error));
    });
    this.register(() => {
      this._explorerTokenBadges?.dispose();
      void this._tokenIndex.dispose();
      clearTimeout(this._refreshTimer);
      clearTimeout(this._statusBarTimeout);
    });
    this.repositories = [];
    this._repositoryAliasAttempts = /* @__PURE__ */ new Map();
    const suggest = new AtPathSuggest(this);
    this.registerEditorSuggest(suggest);
    if (!f_prioritizeRepositorySuggest(this, suggest)) console.warn("AtPath could not prioritize repository link suggestions");
    this.register(() => clearTimeout(suggest._suggestDebounceTimer));
    this.registerEditorExtension(f_buildRepositoryLinkView(this));
    f_captureEditorRepositoryLinks(this);
    this.register(() => {
      this._repositoryIndexClosed = true;
      clearTimeout(this._repositoryRefreshTimer);
      clearTimeout(this._repositoryMoveTimer);
      this._nativeRepositoryLinks?.unload();
    });
    this.app.workspace.onLayoutReady(() => this.f_refreshRepositoryIndex());
    this.registerEvent(this.app.vault.on("raw", (path) => {
      if (this._unindexedProbes.delete(path) && this._unindexedTargets.delete(path)) {
        this._tokenIndex.remove(path);
        this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
        this._scheduleRefresh();
      }
      if (path === REPOSITORY_MAP_PATH && Platform.isMobile) this.f_queueRepositoryRefresh();
      else if (!Platform.isMobile && /(?:^|\/)\.git(?:$|\/(?:config|HEAD|packed-refs|refs\/))/.test(path)) this.f_queueRepositoryRefresh();
    }));
    this.addCommand({
      id: "refresh-repositories",
      name: "Refresh repository map",
      callback: () => {
        this._repositoryAliasAttempts.clear();
        return this.f_refreshRepositoryIndex();
      }
    });
    this.registerEditorExtension(buildAtPathViewPlugin(this));
    this.registerEditorExtension(buildWikilinkViewPlugin(this));
    if (!Platform.isMobile) {
      this.registerEditorExtension(buildBufferCountListener(this));
    }
    this.dragDropCompartment = new Compartment();
    this.registerEditorExtension(
      this.dragDropCompartment.of(
        this.settings.enableDragDropAtPath !== false ? Prec.highest(buildDragDropExtension(this)) : []
      )
    );
    this._currentDragRefs = null;
    this.registerDomEvent(document, "dragstart", (evt) => {
      this._currentDragRefs = null;
      if (this.settings.enableDragDropAtPath === false) return;
      const refs = captureDragRefsFromExplorerDom(this, evt);
      if (refs.length > 0) this._currentDragRefs = refs;
    }, { capture: true });
    this.registerDomEvent(document, "dragend", () => {
      this._currentDragRefs = null;
    }, { capture: true });
    registerPostProcessor(this);
    if (!Platform.isMobile) {
      this.noteBarEl = this.addStatusBarItem();
      this.noteBarEl.addClass("mod-clickable", "atpath-status-note");
      this.registerDomEvent(this.noteBarEl, "click", () => this.copyNoteWithAtPaths());
      this.linkedBarEl = this.addStatusBarItem();
      this.linkedBarEl.addClass("mod-clickable", "atpath-status-linked");
      this.linkedBarEl.setAttribute("aria-haspopup", "true");
      this._linkedLabelEl = this.linkedBarEl.createSpan({ cls: "atpath-label", text: "Links" });
      this._linkedValueEl = this.linkedBarEl.createSpan({ cls: "atpath-value", text: "" });
      this._linkedCountEl = this.linkedBarEl.createSpan({ cls: "atpath-count", text: "" });
      this._popoverEl = this.linkedBarEl.createDiv({ cls: "atpath-linked-popover" });
      this._popoverEl.setAttribute("role", "dialog");
      this._popoverEl.setAttribute("hidden", "");
      this._popoverPinned = false;
      this._popoverHideTimer = null;
      this._popoverCheckedPaths = /* @__PURE__ */ new Set();
      this._popoverCheckedSig = null;
      this.registerHoverLinkSource("atpath-status", {
        display: "AtPath status bar",
        defaultMod: true
      });
      this._wireLinkedPopoverEvents();
      this._noteBufferTokens = 0;
      this._selectionTokens = 0;
      this.updateStatusBar();
    }
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this._tokenIndex.upsert(file);
        }
        this._debouncedUpdateStatusBar();
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this._tokenIndex.upsert(file);
        if (file instanceof TFolder) this.f_queueRepositoryRefresh();
        this._suggestVaultGen = (this._suggestVaultGen || 0) + 1;
        if (this.core) {
          if (file instanceof TFolder) this.core.clearFoldersCache();
          this.core.clearFolderTokenMemo();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this._suggestVaultGen = (this._suggestVaultGen || 0) + 1;
        this._tokenIndex.remove(file.path);
        if (file instanceof TFolder && this.repositories.some((repo) => repo.root === file.path || repo.root?.startsWith(file.path + "/"))) {
          this.f_queueRepositoryRefresh();
        }
        if (this.core) {
          if (file instanceof TFolder) this.core.clearFoldersCache();
          this.core.clearFolderTokenMemo();
        }
        this._debouncedUpdateStatusBar();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this._suggestVaultGen = (this._suggestVaultGen || 0) + 1;
        this._tokenIndex.rename(file, oldPath);
        if (this.core) {
          if (file instanceof TFolder) this.core.clearFoldersCache();
          this.core.clearFolderTokenMemo();
        }
        this.f_queueRepositoryMove(file, oldPath);
        let movedPublishedState = false;
        if (this.settings.publishedPages[oldPath]) {
          this.settings.publishedPages[file.path] = this.settings.publishedPages[oldPath];
          delete this.settings.publishedPages[oldPath];
          movedPublishedState = true;
        }
        if (renamePublishedHtmlAppState(this.settings, oldPath, file.path)) {
          movedPublishedState = true;
        }
        if (movedPublishedState) {
          void this.saveSettings();
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !isHtmlExtension(file.extension)) return;
        menu.addItem(
          (item) => item.setTitle("@Path: publish this HTML app...").setIcon("upload").onClick(() => new HtmlAppScopeModal(this.app, this, file).open())
        );
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this._linkedCountWatches.clear();
        this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
        this._noteBufferTokens = 0;
        this._selectionTokens = 0;
        this.updateStatusBar();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this._noteBufferTokens = 0;
        this._selectionTokens = 0;
        if (this.core) this.core.clearFolderTokenMemo();
        this.updateStatusBar();
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this._debouncedUpdateStatusBar();
      })
    );
    this.addSettingTab(new AtPathSettingTab(this.app, this));
    this.addCommand({
      id: "copy-note-with-atpaths",
      name: "Copy note with linked files to clipboard",
      editorCallback: () => this.copyNoteWithAtPaths()
    });
    this.addCommand({
      id: "publish-to-vercel",
      name: "Publish current note to Vercel",
      callback: () => this.publishToVercel()
    });
    this.addCommand({
      id: "dry-run-migration",
      name: "Preview legacy links for migration",
      callback: () => this.dryRunMigration()
    });
    if (!Platform.isMobile) {
      this.trayBarEl = this.addStatusBarItem();
      this.trayBarEl.addClass("mod-clickable", "atpath-tray-btn");
      this.trayBarEl.setText("@Path");
      this.registerDomEvent(this.trayBarEl, "click", (event) => this.showTrayMenu(event));
    }
  }
  showTrayMenu(event) {
    const menu = new Menu();
    menu.addItem(
      (item) => item.setTitle("Review legacy links for migration").setIcon("replace-all").onClick(() => new MigrationPreviewModal(this.app, this).open())
    );
    menu.addItem(
      (item) => item.setTitle("Publish to Vercel").setIcon("upload").onClick(() => this.publishToVercel())
    );
    menu.addItem(
      (item) => item.setTitle("Copy with linked files").setIcon("clipboard-copy").onClick(() => this.copyNoteWithAtPaths())
    );
    menu.addItem(
      (item) => item.setTitle("Settings").setIcon("settings").onClick(() => {
        this.app.setting.open();
        this.app.setting.openTabById(this.manifest.id);
      })
    );
    menu.showAtMouseEvent(event);
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  reconfigureDragDrop() {
    if (!this.dragDropCompartment) return;
    const ext = this.settings.enableDragDropAtPath !== false ? Prec.highest(buildDragDropExtension(this)) : [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const cm = leaf.view && leaf.view.editor && leaf.view.editor.cm;
      if (!cm) continue;
      try {
        cm.dispatch({ effects: this.dragDropCompartment.reconfigure(ext) });
      } catch (err) {
        console.warn("[atpath] drag-drop reconfigure failed for one leaf", err);
      }
    }
  }
  f_linkedCountSignature(path, folder) {
    const count = this._tokenIndex.get(path, folder);
    return count ? [count.tokens, count.pending, count.skipped, count.counted].join(":") : "";
  }
  f_watchLinkedCount(path, folder) {
    const key = (folder ? "folder:" : "file:") + path;
    if (this._linkedCountWatches.has(key)) return;
    if (this._linkedCountWatches.size >= 500) this._linkedCountWatches.delete(this._linkedCountWatches.keys().next().value);
    this._linkedCountWatches.set(key, { path, folder, signature: this.f_linkedCountSignature(path, folder) });
  }
  async getTokenCount(vaultPath) {
    this.f_watchLinkedCount(vaultPath, false);
    const file = this.app.vault.getAbstractFileByPath(vaultPath) || this._unindexedTargets.get(vaultPath);
    return file && (file instanceof TFile || file.localOnly) ? this._tokenIndex.request(file) : null;
  }
  f_folderTokenCount(path) {
    this.f_watchLinkedCount(path, true);
    const total = this._tokenIndex.get(path, true);
    const limit = this.settings.maxFolderFiles || 500;
    if (total.counted + total.pending > limit) return { overCap: true, fileCount: total.counted + total.pending };
    if (total.pending || total.skipped) return { partial: Boolean(total.pending), skipped: total.skipped, tokens: total.tokens };
    return total.tokens;
  }
  scheduleTokenFetch(vaultPath, view) {
    if (!this.settings.showTokenCounts) return;
    if (view) this._lastEditorView = view;
    void this.getTokenCount(vaultPath).catch((error) => console.warn("AtPath could not count", vaultPath, error));
  }
  scheduleFolderTokenFetch(_folderPath, view) {
    if (view) this._lastEditorView = view;
  }
  _scheduleRefresh() {
    ATPATH_PERF.inc("scheduleRefresh.calls");
    if (this._refreshTimer) {
      ATPATH_PERF.inc("scheduleRefresh.coalesced");
      return;
    }
    ATPATH_PERF.inc("scheduleRefresh.scheduled");
    this._refreshTimer = window.setTimeout(() => {
      this._refreshTimer = null;
      ATPATH_PERF.inc("scheduleRefresh.fired");
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) leaf.view.editor?.cm?.dispatch();
      this.updateStatusBar();
    }, 150);
  }
  _debouncedUpdateStatusBar() {
    if (this._statusBarTimeout) clearTimeout(this._statusBarTimeout);
    this._statusBarTimeout = setTimeout(() => this.updateStatusBar(), 300);
  }
  async updateStatusBar() {
    ATPATH_PERF.inc("updateStatusBar.calls");
    const _usbT0 = ATPATH_PERF.enabled ? performance.now() : 0;
    if (!this.noteBarEl || !this.linkedBarEl) return;
    const clearBars = () => {
      this.noteBarEl.empty();
      this.noteBarEl.removeAttribute("aria-label");
      this._hideLinkedSegment();
      this._linkedTargets = [];
      this._lastLinkedTotal = 0;
      this._linkedPartial = false;
      this._linkedSig = "";
      this._renderLinkedPopover();
    };
    if (!this.settings.showTokenCounts) {
      clearBars();
      return;
    }
    const gen = ++this._statusBarGen;
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) {
      clearBars();
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      clearBars();
      return;
    }
    const content = mdView.editor.getValue();
    let noteTokens = this._noteBufferTokens;
    if (!noteTokens) {
      ATPATH_PERF.inc("updateStatusBar.encodeFallback");
      noteTokens = ATPATH_PERF.time("updateStatusBar.encodeFallback.encode", () => f_estimateTokens(content));
      this._noteBufferTokens = noteTokens;
    }
    const refs = ATPATH_PERF.time("updateStatusBar.scanAtPathRefs", () => this.f_scanLinkedRefs(content, activeFile.path));
    ATPATH_PERF.inc("updateStatusBar.refs." + (refs.length < 5 ? "lt5" : refs.length < 15 ? "5-15" : refs.length < 30 ? "15-30" : "30+"));
    const seen = /* @__PURE__ */ new Set();
    const linkedTargets = [];
    let linkedTotal = 0;
    let pendingOrOverCap = false;
    for (const ref of refs) {
      const resolved = this.f_resolveLinkTarget(ref, activeFile.path);
      if (resolved.kind === "missing") {
        if (resolved.vaultPath && ref.destination) void this.f_probeUnindexedTarget(resolved.vaultPath, resolved.repository);
        const key = "missing:" + (ref.destination || ref.displayPath);
        if (!seen.has(key)) {
          seen.add(key);
          linkedTargets.push({ kind: "missing", path: key, label: ref.displayPath, reason: resolved.reason, tokens: 0 });
          pendingOrOverCap = true;
        }
        continue;
      }
      const normalizedPath = resolved.normalizedPath;
      if (seen.has(normalizedPath)) continue;
      seen.add(normalizedPath);
      if (resolved.kind === "folder") {
        const cached = this.f_folderTokenCount(normalizedPath);
        if (cached == null) {
          const cm = mdView.editor && mdView.editor.cm ? mdView.editor.cm : this._lastEditorView;
          this.scheduleFolderTokenFetch(normalizedPath, cm);
          linkedTargets.push({ kind: "folder", path: normalizedPath, tokens: 0, pending: true });
          pendingOrOverCap = true;
          continue;
        }
        if (cached && typeof cached === "object" && cached.overCap) {
          linkedTargets.push({ kind: "folder", path: normalizedPath, tokens: 0, overCap: cached });
          pendingOrOverCap = true;
          continue;
        }
        const pending = Boolean(cached?.partial);
        const skipped = cached?.skipped;
        pendingOrOverCap ||= pending || Boolean(skipped);
        linkedTargets.push({ kind: "folder", path: normalizedPath, tokens: cached?.tokens ?? cached, pending, skipped });
        continue;
      }
      const tokens = await this.getTokenCount(normalizedPath);
      if (gen !== this._statusBarGen) return;
      if (tokens != null) {
        linkedTargets.push({ kind: resolved.kind, path: normalizedPath, tokens });
      }
    }
    linkedTotal = f_uniqueLinkedTokenTotal(linkedTargets);
    this._linkedTargets = linkedTargets;
    this._lastLinkedTotal = linkedTotal;
    this._linkedPartial = pendingOrOverCap;
    this._linkedSig = linkedTargets.map((t) => t.kind + ":" + t.path).sort().join("|");
    this._renderStatusBarSegments(noteTokens, linkedTotal, linkedTargets.length, pendingOrOverCap);
    this._renderLinkedPopover();
    if (ATPATH_PERF.enabled) {
      ATPATH_PERF.record("updateStatusBar.totalMs", performance.now() - _usbT0);
    }
  }
  _repaintStatusBarFromBuffer() {
    if (!this.noteBarEl || !this.linkedBarEl) return;
    if (!this.settings.showTokenCounts) return;
    const linkedCount = (this._linkedTargets || []).length;
    this._renderStatusBarSegments(
      this._noteBufferTokens || 0,
      this._lastLinkedTotal || 0,
      linkedCount,
      !!this._linkedPartial
    );
  }
  _renderStatusBarSegments(noteTokens, linkedTotal, linkedCount, partial) {
    if (!this.noteBarEl || !this.linkedBarEl) return;
    this.noteBarEl.empty();
    const noteLabel = this.noteBarEl.createSpan({ cls: "atpath-label" });
    const noteValue = this.noteBarEl.createSpan({ cls: "atpath-value" });
    const sel = this._selectionTokens || 0;
    if (sel > 0 && this.settings.statusBarShowSelection !== false) {
      this.noteBarEl.addClass("atpath-status-has-selection");
      noteLabel.setText("Sel");
      noteValue.setText(formatTokens(sel) + " / " + formatTokens(noteTokens));
      this.noteBarEl.setAttribute(
        "aria-label",
        "Selection: " + formatTokens(sel) + "\nNote: " + formatTokens(noteTokens)
      );
    } else {
      this.noteBarEl.removeClass("atpath-status-has-selection");
      noteLabel.setText("Note");
      noteValue.setText(formatTokens(noteTokens));
      this.noteBarEl.setAttribute("aria-label", "Note: " + formatTokens(noteTokens));
    }
    if (linkedCount === 0) {
      this._hideLinkedSegment();
      return;
    }
    this._linkedLabelEl.removeClass("atpath-hidden");
    this._linkedValueEl.removeClass("atpath-hidden");
    this._linkedCountEl.removeClass("atpath-hidden");
    const suffix = partial ? "+" : "";
    this._linkedValueEl.setText(formatTokens(linkedTotal) + suffix);
    this._linkedCountEl.setText("(" + linkedCount + ")");
    this.linkedBarEl.setAttribute(
      "aria-label",
      "Links (" + linkedCount + "): " + formatTokens(linkedTotal) + suffix + (partial ? " \u2014 some targets still counting or skipped" : "")
    );
  }
  _hideLinkedSegment() {
    if (!this.linkedBarEl) return;
    this.linkedBarEl.removeAttribute("aria-label");
    if (this._linkedLabelEl) this._linkedLabelEl.addClass("atpath-hidden");
    if (this._linkedValueEl) this._linkedValueEl.addClass("atpath-hidden");
    if (this._linkedCountEl) this._linkedCountEl.addClass("atpath-hidden");
    this._hidePopoverImmediate();
  }
  _wireLinkedPopoverEvents() {
    if (!this.linkedBarEl || !this._popoverEl) return;
    this.registerDomEvent(this.linkedBarEl, "mouseenter", () => this._showPopover());
    this.registerDomEvent(this.linkedBarEl, "mouseleave", () => this._scheduleHidePopover());
    this.registerDomEvent(this._popoverEl, "mouseenter", () => this._showPopover());
    this.registerDomEvent(this._popoverEl, "mouseleave", () => this._scheduleHidePopover());
    this.registerDomEvent(this.linkedBarEl, "click", (evt) => {
      if (this._popoverEl && this._popoverEl.contains(evt.target)) return;
      this._popoverPinned = !this._popoverPinned;
      if (this._popoverPinned) {
        this.linkedBarEl.addClass("is-pinned");
        this._showPopover();
      } else {
        this.linkedBarEl.removeClass("is-pinned");
        this._scheduleHidePopover();
      }
    });
    this.registerDomEvent(document, "click", (evt) => {
      if (!this._popoverPinned) return;
      if (!this._popoverEl || this._popoverEl.hasAttribute("hidden")) return;
      const t = evt.target;
      if (this.linkedBarEl.contains(t)) return;
      if (this._popoverEl.contains(t)) return;
      this._hidePopoverImmediate();
    });
  }
  _showPopover() {
    if (!this._popoverEl) return;
    if ((this._linkedTargets || []).length === 0) return;
    if (this._popoverHideTimer) {
      window.clearTimeout(this._popoverHideTimer);
      this._popoverHideTimer = null;
    }
    this._popoverEl.removeAttribute("hidden");
  }
  _scheduleHidePopover() {
    if (!this._popoverEl) return;
    if (this._popoverPinned) return;
    if (this._popoverHideTimer) window.clearTimeout(this._popoverHideTimer);
    this._popoverHideTimer = window.setTimeout(() => {
      if (this._popoverEl) this._popoverEl.setAttribute("hidden", "");
      this._popoverHideTimer = null;
    }, 150);
  }
  _hidePopoverImmediate() {
    if (!this._popoverEl) return;
    if (this._popoverHideTimer) {
      window.clearTimeout(this._popoverHideTimer);
      this._popoverHideTimer = null;
    }
    this._popoverEl.setAttribute("hidden", "");
    this._popoverPinned = false;
    if (this.linkedBarEl) this.linkedBarEl.removeClass("is-pinned");
  }
  _renderLinkedPopover() {
    ATPATH_PERF.inc("popover.render.calls");
    if (!this._popoverEl) return;
    const targets = this._linkedTargets || [];
    if (targets.length === 0) {
      this._popoverEl.empty();
      this._popoverBuiltSig = "";
      this._popoverRowMap = null;
      this._popoverHeaderEl = null;
      this._popoverSelectedEl = null;
      this._hidePopoverImmediate();
      return;
    }
    const isSelectable = (t) => t.kind !== "missing" && !t.pending && !t.overCap;
    if (this._popoverCheckedSig !== this._linkedSig) {
      this._popoverCheckedPaths = new Set(targets.filter(isSelectable).map((t) => t.path));
      this._popoverCheckedSig = this._linkedSig;
    } else {
      const liveSet = new Set(targets.map((t) => t.path));
      const selectableSet = new Set(targets.filter(isSelectable).map((t) => t.path));
      for (const p of [...this._popoverCheckedPaths]) {
        if (!liveSet.has(p) || !selectableSet.has(p)) this._popoverCheckedPaths.delete(p);
      }
    }
    const activeFile = this.app.workspace.getActiveFile();
    const sourcePath = activeFile ? activeFile.path : "";
    const renderSig = sourcePath + "\n" + targets.map(
      (t) => t.kind + ":" + t.path + (t.pending ? ":p" : "") + (t.overCap ? ":o" : "")
    ).join("|");
    const partial = !!this._linkedPartial;
    const totalSuffix = partial ? "+" : "";
    if (this._popoverBuiltSig === renderSig && this._popoverRowMap) {
      ATPATH_PERF.inc("popover.render.fastPath");
      if (this._popoverHeaderEl) {
        const w = targets.length === 1 ? "target" : "targets";
        this._popoverHeaderEl.setText(
          "Linked references \xB7 " + formatTokens(this._lastLinkedTotal || 0) + totalSuffix + " tokens \xB7 " + targets.length + " " + w
        );
      }
      for (const t of targets) {
        const refs = this._popoverRowMap.get(t.path);
        if (!refs) continue;
        if (refs.countEl) refs.countEl.setText(formatLinkedTargetCount(t));
        if (refs.cb) {
          const selectable = isSelectable(t);
          refs.cb.disabled = !selectable;
          if (!selectable) refs.cb.checked = false;
          else refs.cb.checked = this._popoverCheckedPaths.has(t.path);
        }
        if (refs.row) {
          const title = t.pending ? "Still counting\u2026" : t.overCap ? "Skipped: over the configured max-files limit" : t.kind === "folder" ? t.path + "/" : t.path;
          refs.row.setAttribute("title", title);
          if (t.pending) refs.row.addClass("atpath-linked-popover-row--pending");
          else refs.row.removeClass("atpath-linked-popover-row--pending");
          if (t.overCap) refs.row.addClass("atpath-linked-popover-row--overcap");
          else refs.row.removeClass("atpath-linked-popover-row--overcap");
        }
      }
      this._refreshPopoverSelectedTotal();
      return;
    }
    ATPATH_PERF.inc("popover.render.slowPath");
    ATPATH_PERF.inc("popover.render.slowPath.targets." + (targets.length < 5 ? "lt5" : targets.length < 15 ? "5-15" : targets.length < 30 ? "15-30" : "30+"));
    this._popoverEl.empty();
    this._popoverRowMap = /* @__PURE__ */ new Map();
    const header = this._popoverEl.createDiv({ cls: "atpath-linked-popover-header" });
    this._popoverHeaderEl = header;
    const targetWord = targets.length === 1 ? "target" : "targets";
    header.setText(
      "Linked references \xB7 " + formatTokens(this._lastLinkedTotal || 0) + totalSuffix + " tokens \xB7 " + targets.length + " " + targetWord
    );
    const rowsEl = this._popoverEl.createDiv({ cls: "atpath-linked-popover-rows" });
    for (const t of targets) {
      const row = rowsEl.createEl("label", { cls: "atpath-linked-popover-row" });
      if (t.kind === "folder") row.addClass("atpath-linked-popover-row--folder");
      if (t.pending) row.addClass("atpath-linked-popover-row--pending");
      if (t.overCap) row.addClass("atpath-linked-popover-row--overcap");
      const selectable = isSelectable(t);
      const cb = row.createEl("input", { type: "checkbox", cls: "atpath-linked-popover-check" });
      cb.checked = selectable && this._popoverCheckedPaths.has(t.path);
      cb.disabled = !selectable;
      cb.addEventListener("change", () => {
        if (!selectable) {
          cb.checked = false;
          return;
        }
        if (cb.checked) this._popoverCheckedPaths.add(t.path);
        else this._popoverCheckedPaths.delete(t.path);
        this._refreshPopoverSelectedTotal();
      });
      const iconEl = row.createSpan({ cls: "atpath-linked-popover-icon" });
      setIcon(iconEl, t.kind === "folder" ? "folder" : "file-text");
      const displayLabel = (t.label || this.f_displayLinkedPath(t.path, sourcePath)) + (t.kind === "folder" ? "/" : "");
      const pathSpan = row.createSpan({ cls: "atpath-linked-popover-path" });
      pathSpan.createEl("bdi", { text: displayLabel });
      const fullPath = t.kind === "folder" ? t.path + "/" : t.path;
      const rowTitle = t.reason || (t.pending ? "Still counting\u2026" : t.overCap ? "Skipped: over the configured max-files limit" : t.skipped ? fullPath + " \xB7 " + t.skipped + " files skipped" : fullPath);
      pathSpan.setAttribute("title", rowTitle);
      row.setAttribute("title", rowTitle);
      const countEl = row.createSpan({
        cls: "atpath-linked-popover-count",
        text: formatLinkedTargetCount(t)
      });
      if (t.kind === "file") {
        row.addEventListener("mouseenter", (evt) => {
          this.app.workspace.trigger("hover-link", {
            event: evt,
            source: "atpath-status",
            hoverParent: this,
            targetEl: row,
            linktext: t.path,
            sourcePath
          });
        });
      }
      this._popoverRowMap.set(t.path, { row, cb, countEl });
    }
    const footer = this._popoverEl.createDiv({ cls: "atpath-linked-popover-footer" });
    this._popoverSelectedEl = footer.createDiv({ cls: "atpath-linked-popover-selected" });
    const actions = footer.createDiv({ cls: "atpath-linked-popover-actions" });
    const allBtn = actions.createEl("button", {
      text: "All",
      cls: "atpath-linked-popover-btn"
    });
    allBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      this._popoverCheckedPaths = new Set(targets.filter(isSelectable).map((t) => t.path));
      this._renderLinkedPopover();
      this._showPopover();
    });
    const noneBtn = actions.createEl("button", {
      text: "None",
      cls: "atpath-linked-popover-btn"
    });
    noneBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      this._popoverCheckedPaths.clear();
      this._renderLinkedPopover();
      this._showPopover();
    });
    const copySelectedBtn = actions.createEl("button", {
      text: "Copy selected",
      cls: "atpath-linked-popover-btn"
    });
    copySelectedBtn.setAttribute("title", "Copy the contents of selected links");
    copySelectedBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      const selected = new Set(this._popoverCheckedPaths);
      void this.copySelectedAtPathsOnly({ paths: selected });
    });
    const copyWithNoteBtn = actions.createEl("button", {
      text: "Copy selected + note",
      cls: "atpath-linked-popover-btn atpath-linked-popover-btn--primary"
    });
    copyWithNoteBtn.setAttribute("title", "Copy the note and the contents of selected links");
    copyWithNoteBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      const selected = new Set(this._popoverCheckedPaths);
      void this.copyNoteWithAtPaths({ paths: selected });
    });
    this._popoverBuiltSig = renderSig;
    this._refreshPopoverSelectedTotal();
  }
  _refreshPopoverSelectedTotal() {
    if (!this._popoverSelectedEl) return;
    const targets = this._linkedTargets || [];
    const selected = targets.filter((target) => !target.pending && !target.overCap && this._popoverCheckedPaths.has(target.path));
    const total = f_uniqueLinkedTokenTotal(selected);
    const count = selected.length;
    const selectableCount = targets.filter((t) => t.kind !== "missing" && !t.pending && !t.overCap).length;
    this._popoverSelectedEl.setText(
      "Selected: " + formatTokens(total) + " tokens (" + count + "/" + selectableCount + ")"
    );
  }
  async copySelectedAtPathsOnly(opts) {
    const paths = opts?.paths;
    if (!(paths instanceof Set) || !paths.size) {
      new Notice("No linked targets selected.");
      return;
    }
    await this.f_copyLinkedContent(false, paths);
  }
  async copyNoteWithAtPaths(opts) {
    await this.f_copyLinkedContent(true, opts?.paths);
  }
  async f_copyLinkedContent(includeNote, selectedPaths) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const sourcePath = view?.file?.path ?? this.app.workspace.getActiveFile()?.path;
    if (!view || !sourcePath) {
      new Notice("No active note.");
      return;
    }
    const content = view.editor.getValue();
    const refs = this.f_scanLinkedRefs(content, sourcePath);
    const seenTargets = /* @__PURE__ */ new Set();
    const includedFiles = /* @__PURE__ */ new Set();
    const blocks = [];
    const skipped = [];
    const maxFiles = this.settings.maxFolderFiles || 500;
    const f_add = async (file) => {
      if (includedFiles.has(file.path)) return null;
      if (!this.f_eligibleLinkedFile(file)) {
        skipped.push(this.f_displayLinkedPath(file.path, sourcePath) + " (excluded or too large)");
        return null;
      }
      try {
        const text = await this.f_readLinkedFile(file);
        if (looksBinary(text)) {
          skipped.push(this.f_displayLinkedPath(file.path, sourcePath) + " (binary)");
          return null;
        }
        includedFiles.add(file.path);
        return { path: this.f_displayLinkedPath(file.path, sourcePath), text };
      } catch {
        skipped.push(this.f_displayLinkedPath(file.path, sourcePath) + " (unreadable)");
        return null;
      }
    };
    for (const ref of refs) {
      const result = await this.f_resolveLinkTargetAsync(ref, sourcePath);
      const path = result.normalizedPath;
      if (selectedPaths && !selectedPaths.has(path)) continue;
      const key = path ?? ref.destination ?? ref.displayPath;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      if (result.kind === "missing") {
        skipped.push((ref.destination || ref.displayPath) + " (" + (result.reason || "unavailable") + ")");
      } else if (result.kind === "file") {
        const block = await f_add(result.target);
        if (block) blocks.push(block);
      } else if (result.kind === "folder") {
        const files = [];
        let excluded = 0;
        const pending = [result.target];
        while (pending.length && files.length <= maxFiles) {
          const item = pending.pop();
          if (item instanceof TFolder) {
            for (let index = item.children.length - 1; index >= 0; index--) pending.push(item.children[index]);
          } else if (item instanceof TFile && !includedFiles.has(item.path)) {
            if (this.f_eligibleLinkedFile(item)) files.push(item);
            else excluded++;
          }
        }
        const label = this.f_displayLinkedPath(path, sourcePath);
        if (files.length > maxFiles) {
          skipped.push(label + " (over the " + maxFiles + "-file limit)");
          continue;
        }
        if (excluded) skipped.push(label + " (" + excluded + " excluded or oversized files)");
        const folderBlocks = [];
        for (const file of files) {
          const block = await f_add(file);
          if (block) folderBlocks.push(block);
        }
        if (folderBlocks.length) {
          const total = folderBlocks.reduce((sum, block) => sum + f_estimateTokens(block.text), 0);
          blocks.push({ heading: "--- " + label + " (" + folderBlocks.length + " files, " + formatTokens(total) + " tokens) ---" });
          blocks.push(...folderBlocks);
        }
      }
    }
    const added = includedFiles.size;
    if (!includeNote && !added) {
      new Notice("Nothing to copy." + (skipped.length ? "\n" + skipped.join("\n") : ""), 0);
      return;
    }
    let output = includeNote ? content : "";
    for (const block of blocks) {
      if (output) output += "\n\n";
      if (block.heading) output += block.heading;
      else {
        const fence = makeFence(block.text);
        output += "## " + block.path + "\n\n" + fence + "\n" + block.text + "\n" + fence + "\n\n---";
      }
    }
    try {
      await copyToClipboard(output);
    } catch (error) {
      new Notice("Failed to copy to clipboard: " + error.message, 0);
      return;
    }
    new Notice("Copied " + (includeNote ? "note" + (added ? " and " : "") : "") + (added ? added + " linked file(s)" : "") + "." + (skipped.length ? "\nSkipped " + skipped.length + " target(s):\n" + skipped.join("\n") : ""), skipped.length ? 0 : 5e3);
  }
  f_eligibleLinkedFile(file) {
    return !BINARY_EXTENSIONS.has(file.extension.toLowerCase()) && file.stat.size <= this.settings.maxFileSizeMB * 1024 * 1024 && !this.core.isIgnored(file.path) && !file.path.split("/").some((part) => part === this.app.vault.configDir || part === ".git" || part === "node_modules");
  }
  f_readLinkedFile(file) {
    return file.localOnly ? this.app.vault.adapter.read(file.path) : this.app.vault.cachedRead(file);
  }
  async resolveLocalImages(md, activeFile) {
    const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let result = md;
    const replacements = [];
    let match;
    while ((match = imgRegex.exec(md)) !== null) {
      const src = match[2];
      if (/^https?:\/\//.test(src) || src.startsWith("data:")) continue;
      const resolved = this.app.metadataCache.getFirstLinkpathDest(src, activeFile.path);
      if (!resolved || !(resolved instanceof TFile)) continue;
      try {
        const binary = await this.app.vault.readBinary(resolved);
        const bytes = new Uint8Array(binary);
        let b64 = "";
        for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
        b64 = btoa(b64);
        const ext = resolved.extension.toLowerCase();
        const mime = ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
        replacements.push({ original: match[2], dataUri: `data:${mime};base64,${b64}` });
      } catch (_) {
      }
    }
    for (const r of replacements) {
      result = result.split(r.original).join(r.dataUri);
    }
    return result;
  }
  f_queueRepositoryRefresh() {
    clearTimeout(this._repositoryRefreshTimer);
    this._repositoryRefreshTimer = setTimeout(() => this.f_refreshRepositoryIndex(), 300);
  }
  f_repositoryIndexChanged() {
    this._suggestVaultGen = (this._suggestVaultGen || 0) + 1;
    this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
    this.tokenCacheDirty = true;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) leaf.view.editor?.cm?.dispatch();
    this._debouncedUpdateStatusBar();
    if (this._nativeRepositoryLinks) void this._nativeRepositoryLinks.refresh().catch((error) => console.warn("AtPath could not refresh repository backlinks", error));
  }
  async f_refreshRepositoryIndex() {
    if (this._repositoryIndexClosed) return;
    if (this._repositoryRefresh) {
      this._repositoryRefreshAgain = true;
      return;
    }
    const adapter = this.app.vault.adapter;
    this._repositoryRefresh = (async () => {
      const cached = await f_readRepositoryMap(adapter).catch((error) => {
        console.warn("AtPath could not read the repository map", error);
        return [];
      });
      if (this._repositoryIndexClosed) return;
      if (Platform.isMobile || !this.repositories.length) {
        this.repositories = cached;
        this._unindexedProbes.clear();
        this.f_repositoryIndexChanged();
      }
      if (!Platform.isMobile && typeof adapter.getBasePath === "function") {
        const discovered = await f_discoverRepositories(adapter.getBasePath());
        if (this._repositoryIndexClosed) return;
        const prior = [...cached, ...this.repositories];
        for (const repo of discovered) {
          const aliases = prior.filter((item) => item.identity && item.identity === repo.identity).flatMap((item) => item.aliases || []);
          if (aliases.length) repo.aliases = [...new Set(aliases)].sort();
        }
        for (const repo of prior) {
          if (repo.identity && !discovered.some((item) => item.identity === repo.identity)) {
            discovered.push({ identity: repo.identity, aliases: repo.aliases });
          }
        }
        this.repositories = discovered;
        this.f_repositoryIndexChanged();
        await this.f_persistRepositoryMap();
      }
      if (this._repositoryIndexClosed || !this.repositories.length || this._nativeRepositoryLinks) return;
      this._nativeRepositoryLinks = f_installNativeRepositoryLinks({
        metadataCache: this.app.metadataCache,
        vault: this.app.vault,
        scan: f_scanMarkdownLinks,
        resolve: (destination, sourcePath) => {
          if (!f_repositoryForPath(sourcePath, this.repositories)) return null;
          const result = this.f_resolveLinkTarget({ destination }, sourcePath, false);
          if (result.kind === "ignored") return null;
          return { file: result.target instanceof TFile ? result.target : null };
        }
      });
      if (!this._nativeRepositoryLinks) console.warn("AtPath repository backlinks are unavailable in this Obsidian version");
      else await this._nativeRepositoryLinks.refresh();
    })().catch((error) => console.warn("AtPath could not refresh the repository map", error));
    try {
      await this._repositoryRefresh;
    } finally {
      this._repositoryRefresh = null;
      if (this._repositoryRefreshAgain) {
        this._repositoryRefreshAgain = false;
        this.f_queueRepositoryRefresh();
      }
    }
  }
  f_persistRepositoryMap() {
    this._repositoryMapWrite = (this._repositoryMapWrite ?? Promise.resolve()).catch(() => {
    }).then(() => {
      if (!this._repositoryIndexClosed) return f_writeRepositoryMap(this.app.vault.adapter, this.repositories);
    });
    return this._repositoryMapWrite;
  }
  f_requestRepositoryAlias(identity) {
    if (Platform.isMobile || this._repositoryIndexClosed) return;
    const owner = identity.split("/")[0] + "/";
    if (!this.repositories.some((repo) => repo.identity?.startsWith(owner) || repo.aliases?.some((alias) => alias.startsWith(owner)))) return;
    const lastAttempt = this._repositoryAliasAttempts.get(identity);
    if (lastAttempt && Date.now() - lastAttempt < 5 * 60 * 1e3) return;
    this._repositoryAliasAttempts.set(identity, Date.now());
    this._repositoryAliasQueue = (this._repositoryAliasQueue ?? Promise.resolve()).then(async () => {
      if (this._repositoryIndexClosed) return;
      const canonical = await f_lookupRenamedRepository(identity);
      if (this._repositoryIndexClosed || !canonical || canonical === identity) return;
      const repositories = this.repositories;
      const matches = repositories.filter((repo) => repo.identity === canonical);
      if (!matches.length) return;
      const oldAliases = repositories.filter((repo) => repo.root === void 0 && repo.identity === identity).flatMap((repo) => repo.aliases || []);
      for (const repo of matches) repo.aliases = [.../* @__PURE__ */ new Set([...repo.aliases || [], ...oldAliases, identity])].sort();
      this.repositories = repositories.filter((repo) => repo.root !== void 0 || repo.identity !== identity);
      this.f_repositoryIndexChanged();
      await this.f_persistRepositoryMap();
    }).catch(() => {
    });
  }
  f_displayLinkedPath(path, sourcePath) {
    const repo = f_repositoryForPath(path, this.repositories);
    if (!repo) return path;
    const relative = repo.root ? path.slice(repo.root.length + 1) : path;
    const sourceRepo = f_repositoryForPath(sourcePath, this.repositories);
    return sourceRepo === repo ? relative || "/" : (repo.identity?.split("/")[1] ?? repo.root.split("/").pop()) + "/" + relative;
  }
  f_formatLinkedTarget(target, sourcePath) {
    return f_formatRepositoryLink(
      target.path === "/" ? "" : target.path,
      sourcePath,
      this.repositories,
      target instanceof TFolder ? "folder" : "file"
    );
  }
  f_scanMarkdownRefs(content) {
    return f_scanMarkdownLinks(content).filter((link) => link.destination && !link.destination.startsWith("#")).map((link) => ({
      ...link,
      format: "markdown",
      displayPath: link.label || link.destination,
      start: link.position.start.offset,
      end: link.position.end.offset
    }));
  }
  f_scanLinkedRefs(content, sourcePath) {
    const markdown = this.f_scanMarkdownRefs(content);
    const managed = markdown.filter((ref) => this.f_resolveLinkTarget(ref, sourcePath).kind !== "ignored");
    const legacy = scanAtPathRefs(content, this.app, sourcePath).filter((ref) => !markdown.some((link) => ref.start < link.end && ref.end > link.start));
    return [...managed, ...legacy].sort((left, right) => left.start - right.start);
  }
  f_resolveLinkTarget(ref, sourcePath, lookupAlias = true) {
    if (!ref.destination) {
      const result2 = this.core.resolveAtPathTarget(ref, sourcePath);
      if (result2.kind !== "missing" || ref.format !== "legacy") return result2;
      const legacy = ref.displayPath?.replace(/\/+$/, "") || "";
      const sourceRepo = f_repositoryForPath(sourcePath, this.repositories);
      const [first, ...rest] = legacy.split("/");
      const matches = this.repositories.filter((repo) => typeof repo.root === "string" && (repo.identity?.split("/")[1] === first || repo.root.split("/").pop() === first));
      const candidates = [
        sourceRepo && [sourceRepo.root, legacy].filter(Boolean).join("/"),
        matches.length === 1 && rest.length && [matches[0].root, ...rest].filter(Boolean).join("/")
      ];
      for (const path of candidates) {
        if (!path) continue;
        const target2 = this.app.vault.getAbstractFileByPath(path);
        if (ref.kind === "folder" ? target2 instanceof TFolder : target2 instanceof TFile) {
          return { kind: ref.kind, target: target2, normalizedPath: path };
        }
      }
      return result2;
    }
    if (ref.destination.startsWith("#")) return { kind: "ignored" };
    const vault = this.app.vault;
    let target;
    const result = f_resolveRepositoryLink(ref, {
      sourcePath,
      repositories: this.repositories,
      getTargetType: (path) => {
        target = path ? vault.getAbstractFileByPath(path) || this._unindexedTargets.get(path) : vault.getRoot();
        return target instanceof TFolder ? "folder" : target instanceof TFile || target?.localOnly ? "file" : null;
      }
    });
    if (lookupAlias && result.repository && (result.status === "out-of-scope" || result.status === "missing" && result.vaultPath === void 0)) this.f_requestRepositoryAlias(result.repository);
    if (result.status === "out-of-scope") {
      return { ...result, kind: "ignored" };
    }
    if (result.status !== "resolved" && !f_isCanonicalRepositoryDestination(ref.destination)) {
      const pathname = ref.destination.split(/[?#]/)[0];
      if (!pathname.includes("/") && !pathname.includes(".")) return { ...result, status: "out-of-scope", kind: "ignored" };
      if (!f_repositoryForPath(sourcePath, this.repositories)) return { ...result, kind: "ignored" };
    }
    return {
      ...result,
      kind: result.status === "resolved" ? result.kind : "missing",
      target,
      normalizedPath: target?.path ?? result.vaultPath
    };
  }
  async f_resolveLinkTargetAsync(ref, sourcePath) {
    const result = this.f_resolveLinkTarget(ref, sourcePath);
    if (ref.destination && result.status === "missing" && result.vaultPath) {
      await this.f_probeUnindexedTarget(result.vaultPath, result.repository);
      return this.f_resolveLinkTarget(ref, sourcePath);
    }
    return result;
  }
  f_probeUnindexedTarget(path, identity) {
    if (this._unindexedProbes.has(path)) return this._unindexedProbes.get(path);
    if (this._unindexedProbes.size >= 500) this._unindexedProbes.delete(this._unindexedProbes.keys().next().value);
    const adapter = this.app.vault.adapter;
    const probe = (async () => {
      const stat = await adapter.stat(path);
      if (stat?.type !== "file" || this._repositoryIndexClosed || this.app.vault.getAbstractFileByPath(path)) return;
      if (!Platform.isMobile && typeof adapter.getBasePath === "function") {
        const { resolve, relative, sep, isAbsolute } = require("path");
        const { realpath } = require("fs").promises;
        const repo = f_repositoryForPath(path, this.repositories);
        if (!repo || repo.identity !== identity) return;
        const base = adapter.getBasePath();
        const [root, target] = await Promise.all([realpath(resolve(base, repo.root)), realpath(resolve(base, path))]);
        const relativePath = relative(root, target);
        if (relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath)) return;
      }
      if (this._repositoryIndexClosed) return;
      const file = { path, extension: path.includes(".") ? path.split(".").pop() : "", stat, localOnly: true };
      this._unindexedTargets.set(path, file);
      this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
      this._scheduleRefresh();
    })().catch((error) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") console.warn("AtPath could not inspect linked file", path, error);
    });
    this._unindexedProbes.set(path, probe);
    return probe;
  }
  async f_openRepositoryTarget(result, newLeaf) {
    if (result.kind === "folder") {
      revealFolderInExplorer(this.app, result.target);
    } else if (result.kind === "file") {
      if (result.target.localOnly) {
        if (Platform.isMobile) new Notice("File is available for copy but is outside the Obsidian index: " + result.normalizedPath);
        else openInDefaultApp(this, result.normalizedPath);
        return;
      }
      const leaf = this.app.workspace.getLeaf(newLeaf);
      const fragment = result.fragment;
      await leaf.openFile(result.target, fragment ? { eState: { subpath: fragment } } : {});
    } else {
      new Notice(result.reason || "Repository link target is unavailable");
    }
  }
  f_queueRepositoryMove(file, oldPath) {
    this._pendingRepositoryMoves ??= [];
    const moves = this._pendingRepositoryMoves;
    const newPath = file.path;
    if (moves.some((move) => oldPath.startsWith(move.oldPath + "/") && newPath === move.newPath + oldPath.slice(move.oldPath.length))) return;
    const prior = moves.find((move) => move.newPath === oldPath);
    if (prior) prior.newPath = newPath;
    else moves.push({ file, oldPath, newPath });
    clearTimeout(this._repositoryMoveTimer);
    this._repositoryMoveTimer = setTimeout(() => {
      this._pendingRepositoryMoves = [];
      this._repositoryRename = (this._repositoryRename ?? Promise.resolve()).then(async () => {
        for (const move of moves) {
          if (this._repositoryIndexClosed) return;
          if (this.repositories.some((repo) => repo.root === move.oldPath || repo.root?.startsWith(move.oldPath + "/"))) {
            await this.f_refreshRepositoryIndex();
          } else {
            await this.f_rewriteRepositoryReferences(move.newPath, move.oldPath);
            await this.updateAtPathReferences(move.file, move.oldPath);
          }
        }
      }).catch((error) => console.warn("AtPath could not update links after a rename", error));
    }, 100);
  }
  async f_rewriteRepositoryReferences(newPath, oldPath) {
    if (this._repositoryIndexClosed || !this.repositories.length) return;
    for (const mdFile of this.app.vault.getMarkdownFiles()) {
      if (this._repositoryIndexClosed) break;
      const sourceAfter = mdFile.path;
      const sourceBefore = sourceAfter === newPath || sourceAfter.startsWith(newPath + "/") ? oldPath + sourceAfter.slice(newPath.length) : sourceAfter;
      const sourceMovedRepo = f_repositoryForPath(sourceAfter, this.repositories) !== f_repositoryForPath(sourceBefore, this.repositories);
      const rewrite = (content2) => {
        let output = content2;
        for (const ref of this.f_scanMarkdownRefs(content2).reverse()) {
          if (!f_isCanonicalRepositoryDestination(ref.destination)) continue;
          const result = f_resolveRepositoryLink(ref, {
            sourcePath: sourceBefore,
            repositories: this.repositories,
            getTargetType: (path) => {
              const targetPath2 = path === oldPath || path.startsWith(oldPath + "/") ? newPath + path.slice(oldPath.length) : path;
              const target = this.app.vault.getAbstractFileByPath(targetPath2);
              return target instanceof TFolder ? "folder" : target instanceof TFile ? "file" : null;
            }
          });
          if (result.status !== "resolved" || /^[\da-f]{7,64}$/i.test(result.ref || "")) continue;
          const moved = result.vaultPath === oldPath || result.vaultPath.startsWith(oldPath + "/");
          if (!moved && !sourceMovedRepo) continue;
          const targetPath = moved ? newPath + result.vaultPath.slice(oldPath.length) : result.vaultPath;
          let replacement;
          try {
            replacement = f_formatRepositoryLink(targetPath, sourceAfter, this.repositories, result.kind);
          } catch (error) {
            console.warn("AtPath could not update repository link", mdFile.path, ref.destination, error);
            continue;
          }
          const suffix = ref.destination.match(/\?[^#]*|#.*$/)?.[0] || "";
          if (suffix) replacement = replacement.slice(0, -1) + suffix + ")";
          output = output.slice(0, ref.start) + replacement + output.slice(ref.end);
        }
        return output;
      };
      const content = await this.app.vault.cachedRead(mdFile);
      if (rewrite(content) !== content) await this.app.vault.process(mdFile, rewrite);
    }
  }
  getRepoRoots() {
    return discoverRepoRoots(this);
  }
  async collectAtPathFiles(content, activeFile) {
    const seen = /* @__PURE__ */ new Set();
    const atPathFiles = [];
    for (const ref of this.f_scanLinkedRefs(content, activeFile.path)) {
      const result = await this.f_resolveLinkTargetAsync(ref, activeFile.path);
      if (result.kind !== "file" || seen.has(result.normalizedPath) || !this.f_eligibleLinkedFile(result.target)) continue;
      seen.add(result.normalizedPath);
      try {
        const text = await this.f_readLinkedFile(result.target);
        if (!looksBinary(text)) atPathFiles.push({
          relPath: this.f_displayLinkedPath(result.normalizedPath, activeFile.path),
          legacyLabel: ref.format === "markdown" ? null : ref.displayPath,
          vaultPath: result.normalizedPath,
          content: text
        });
      } catch (error) {
        console.warn("AtPath could not read linked file for publishing", result.normalizedPath, error);
      }
    }
    return atPathFiles;
  }
  async collectFileProtocolHtmlFiles(content) {
    const FILE_PROTO_RE = /\[([^\]]*)\]\((file:\/\/\/[^)]+\.html?)\)/gi;
    const bundles = [];
    const seen = /* @__PURE__ */ new Set();
    let m;
    let pathMod;
    let fileURLToPath;
    try {
      pathMod = require("path");
      fileURLToPath = require("url").fileURLToPath;
    } catch (_) {
      return bundles;
    }
    while ((m = FILE_PROTO_RE.exec(content)) !== null) {
      const url = m[2];
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const absPath = fileURLToPath(url);
        const dirPath = pathMod.dirname(absPath);
        const entryFilename = pathMod.basename(absPath);
        const dirName = pathMod.basename(dirPath);
        const files = await collectDirectoryFiles(dirPath);
        bundles.push({ url, entryFilename, dirName, files });
      } catch (_) {
      }
    }
    return bundles;
  }
  async collectHtmlAppFolderFiles(htmlFile) {
    let pathMod;
    try {
      require("fs");
      pathMod = require("path");
    } catch (_) {
      throw new Error("Folder publishing is not available in this environment.");
    }
    const adapter = this.app.vault.adapter;
    if (!adapter || typeof adapter.getBasePath !== "function") {
      throw new Error("Folder publishing is only available on desktop.");
    }
    const basePath = adapter.getBasePath();
    const absoluteFilePath = pathMod.join(basePath, htmlFile.path);
    const absoluteFolderPath = pathMod.dirname(absoluteFilePath);
    return collectDirectoryFiles(absoluteFolderPath);
  }
  async publishToVercel() {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) {
      new Notice("No active note to publish.");
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file.");
      return;
    }
    const noteTitle = activeFile.basename;
    const notePath = activeFile.path;
    const content = mdView.editor.getValue();
    const atPathFiles = await this.collectAtPathFiles(content, activeFile);
    const fileProtoFiles = await this.collectFileProtocolHtmlFiles(content);
    const existingPageState = this.settings.publishedPages[notePath];
    const domain = (existingPageState && existingPageState.projectName || slugify(noteTitle)) + ".vercel.app";
    const publishData = {
      publishKind: "note",
      noteTitle,
      notePath,
      content,
      activeFile,
      atPathFiles,
      fileProtoFiles,
      domain,
      defaultProjectName: slugify(noteTitle),
      plugin: this
    };
    const onConfirm = (modalOpts) => {
      this._executePublish(publishData, modalOpts);
    };
    const onUnpublish = () => {
      this._executeUnpublish(publishData);
    };
    publishData._onConfirm = onConfirm;
    publishData._onUnpublish = onUnpublish;
    new PublishConfirmModal(this.app, publishData, onConfirm, onUnpublish).open();
  }
  async publishHtmlApp(htmlFile, scope) {
    if (!(htmlFile instanceof TFile) || !isHtmlExtension(htmlFile.extension)) {
      new Notice("Choose an HTML file to publish.");
      return;
    }
    let entryHtml;
    try {
      entryHtml = await this.app.vault.cachedRead(htmlFile);
    } catch (_) {
      new Notice("Could not read the selected HTML file.");
      return;
    }
    const existingAppState = getPublishedHtmlAppState(this.settings, htmlFile.path);
    const defaults = buildHtmlAppDefaults({
      filePath: htmlFile.path,
      scope,
      entryHtml,
      existingState: existingAppState
    });
    const publishData = {
      publishKind: "html-app",
      noteTitle: defaults.siteTitle,
      sourcePath: htmlFile.path,
      htmlFile,
      publishScope: scope,
      domain: defaults.domain,
      defaultProjectName: defaults.defaultProjectName,
      plugin: this
    };
    const onConfirm = (modalOpts) => {
      this._executeHtmlAppPublish(publishData, modalOpts);
    };
    const onUnpublish = () => {
      this._executeUnpublish(publishData);
    };
    publishData._onConfirm = onConfirm;
    publishData._onUnpublish = onUnpublish;
    new PublishConfirmModal(this.app, publishData, onConfirm, onUnpublish).open();
  }
  async _executePublish(publishData, opts) {
    const { noteTitle, notePath, content, activeFile, atPathFiles, fileProtoFiles } = publishData;
    const { token, compactLinks, isPrivate, approvedEmails, clerkPublishableKey, clerkSecretKey, projectName: chosenProjectName } = opts;
    const { contactUrl, contactLabel, siteIconDataUrl } = this.settings;
    if (token !== this.settings.vercelToken) {
      this.settings.vercelToken = token;
      await this.saveSettings();
    }
    this.trayBarEl.setText("...");
    try {
      const atPathSlugs = /* @__PURE__ */ new Map();
      const slugsByPath = /* @__PURE__ */ new Map();
      const usedSlugs = /* @__PURE__ */ new Set();
      for (const file of atPathFiles) {
        const base = slugifyPath(file.relPath) || "linked-file";
        let slug = base;
        for (let index = 2; usedSlugs.has(slug); index++) slug = base + "-" + index;
        usedSlugs.add(slug);
        slugsByPath.set(file.vaultPath, slug);
        if (file.legacyLabel) atPathSlugs.set(file.legacyLabel, slug);
      }
      const repositoryLinks = {
        sourcePath: notePath,
        resolveLink: (destination, sourcePath) => this.f_resolveLinkTarget({ destination }, sourcePath, false),
        slugsByPath
      };
      let resolvedContent = await this.resolveLocalImages(content, activeFile);
      const fileProtoSlugs = /* @__PURE__ */ new Map();
      for (const bundle of fileProtoFiles) {
        let slug = slugifyPath(bundle.dirName);
        if (usedSlugs.has(slug)) slug += "-project";
        usedSlugs.add(slug);
        fileProtoSlugs.set(bundle.url, { slug, entryFilename: bundle.entryFilename });
      }
      resolvedContent = resolvedContent.replace(
        /\[([^\]]*)\]\((file:\/\/\/[^)]+\.html?)\)/gi,
        (match, text, url) => {
          const info = fileProtoSlugs.get(url);
          return info ? `[${text}](atpath/${info.slug}/${info.entryFilename})` : match;
        }
      );
      const mainHtml = buildMainPage(noteTitle, resolvedContent, atPathSlugs, contactUrl, contactLabel, compactLinks, siteIconDataUrl, repositoryLinks);
      const subPages = {};
      const deployFiles = [];
      for (const f of atPathFiles) {
        const slug = slugsByPath.get(f.vaultPath);
        const ext = f.vaultPath.split(".").pop().toLowerCase();
        const isHtmlFile = ext === "html" || ext === "htm";
        if (isHtmlFile) {
          const pageHtml = injectSiteIconIntoHtml(f.content, siteIconDataUrl);
          if (isPrivate) {
            subPages["atpath/" + slug] = pageHtml;
          } else {
            deployFiles.push({ path: "atpath/" + slug + ".html", content: pageHtml });
          }
        } else {
          const childFile = this.app.vault.getFileByPath(f.vaultPath);
          const atContent = childFile ? await this.resolveLocalImages(f.content, childFile) : f.content;
          const pageTitle = f.relPath.split("/").pop();
          const pageHtml = buildAtPathPage(pageTitle, atContent, noteTitle, contactUrl, contactLabel, siteIconDataUrl, { ...repositoryLinks, sourcePath: f.vaultPath });
          if (isPrivate) {
            subPages["atpath/" + slug] = pageHtml;
          } else {
            deployFiles.push({ path: "atpath/" + slug + ".html", content: pageHtml });
          }
        }
      }
      const bundleStaticFiles = [];
      for (const bundle of fileProtoFiles) {
        const info = fileProtoSlugs.get(bundle.url);
        for (const f of bundle.files) {
          const deployPath = "atpath/" + info.slug + "/" + f.relPath;
          const ext = (f.relPath.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || "";
          const isHtmlFile = ext === "html" || ext === "htm";
          if (isPrivate && isHtmlFile) {
            subPages[deployPath.replace(/\.html?$/, "")] = injectSiteIconIntoHtml(f.content, siteIconDataUrl);
          } else if (isPrivate) {
            bundleStaticFiles.push({ path: deployPath, content: f.content, encoding: f.encoding });
          } else {
            deployFiles.push({
              path: deployPath,
              content: isHtmlFile ? injectSiteIconIntoHtml(f.content, siteIconDataUrl) : f.content,
              encoding: f.encoding
            });
          }
        }
      }
      let result;
      const pageState = this.settings.publishedPages[notePath] || {};
      const projectSlug = pageState.projectName || chosenProjectName || slugify(noteTitle);
      const projectName = await ensureProject(token, projectSlug);
      if (isPrivate) {
        if (clerkPublishableKey) {
          this.settings.clerkPublishableKey = clerkPublishableKey;
        }
        if (clerkSecretKey) {
          this.settings.clerkSecretKey = clerkSecretKey;
        }
        await this.saveSettings();
        const pages = { main: mainHtml, ...subPages };
        const allApproved = [...approvedEmails];
        const pubEmail = (this.settings.publisherEmail || "").toLowerCase().trim();
        if (pubEmail && !allApproved.includes(pubEmail)) {
          allApproved.push(pubEmail);
        }
        const waMatch = contactUrl.match(/wa\.me\/(\d+)/);
        const publisherWhatsapp = waMatch ? waMatch[1] : "";
        const authShellHtml = buildAuthShell(noteTitle, this.settings.clerkPublishableKey, this.settings.publisherEmail, publisherWhatsapp, siteIconDataUrl);
        const authFunctionSrc = buildAuthFunction({
          approvedEmails: allApproved,
          pages,
          projectName
        });
        const approveFunctionSrc = buildApproveFunction({
          projectName,
          clerkPublishableKey: this.settings.clerkPublishableKey,
          publisherEmail: pubEmail
        });
        const packageJson = JSON.stringify({
          type: "module",
          dependencies: { "@clerk/backend": "^2" }
        });
        const vercelJson = JSON.stringify({
          rewrites: [
            { source: "/((?!api/).*)", destination: "/index.html" }
          ]
        });
        const privateFiles = [
          { path: "index.html", content: authShellHtml },
          { path: "api/auth.js", content: authFunctionSrc },
          { path: "api/approve.js", content: approveFunctionSrc },
          { path: "package.json", content: packageJson },
          { path: "vercel.json", content: vercelJson },
          ...bundleStaticFiles
        ];
        const envVars = {
          CLERK_SECRET_KEY: this.settings.clerkSecretKey
        };
        result = await deployToVercel(token, noteTitle, privateFiles, {
          isPrivate: true,
          envVars,
          projectName,
          onProgress: (msg) => this.trayBarEl.setText(msg)
        });
        this.settings.publishedPages[notePath] = {
          ...pageState,
          url: result.url,
          projectName: result.projectName,
          publishedAt: (/* @__PURE__ */ new Date()).toISOString(),
          isPrivate: true,
          isUnpublished: false,
          approvedEmails
        };
        await this.saveSettings();
      } else {
        deployFiles.unshift({ path: "index.html", content: mainHtml });
        result = await deployToVercel(token, noteTitle, deployFiles, {
          projectName,
          onProgress: (msg) => this.trayBarEl.setText(msg)
        });
        this.settings.publishedPages[notePath] = {
          ...pageState,
          url: result.url,
          projectName: result.projectName,
          publishedAt: (/* @__PURE__ */ new Date()).toISOString(),
          isPrivate: false,
          isUnpublished: false,
          approvedEmails: []
        };
        await this.saveSettings();
      }
      this.trayBarEl.setText("@Path");
      const linkedCount = atPathFiles.length + fileProtoFiles.length;
      const summary = 'Deployed "' + noteTitle + '"' + (linkedCount > 0 ? " with " + linkedCount + " linked page" + (linkedCount > 1 ? "s" : "") : "") + (isPrivate ? " (private)" : "");
      let warning = "";
      if (result.deploymentState && result.deploymentState !== "READY") {
        warning += "Deployment did not succeed (state: " + result.deploymentState + ").";
        if (result.deploymentError) warning += " " + result.deploymentError;
      } else if (result.healthCheck && !result.healthCheck.ok) {
        warning += "Deployment is live but the health check failed.";
        if (result.healthCheck.detail) warning += " " + result.healthCheck.detail;
      }
      new PublishResultModal(this.app, { success: true, url: result.url, summary, warning }).open();
    } catch (e) {
      this.trayBarEl.setText("@Path");
      new PublishResultModal(this.app, { success: false, error: e.message || String(e) }).open();
    }
  }
  async _executeHtmlAppPublish(publishData, opts) {
    const { htmlFile, sourcePath, publishScope } = publishData;
    const {
      token,
      projectName: chosenProjectName,
      siteTitle,
      isPrivate,
      approvedEmails = [],
      clerkPublishableKey,
      clerkSecretKey
    } = opts;
    if (token !== this.settings.vercelToken) {
      this.settings.vercelToken = token;
      await this.saveSettings();
    }
    this.trayBarEl.setText("...");
    try {
      const entryHtml = await this.app.vault.cachedRead(htmlFile);
      const folderFiles = publishScope === HTML_APP_SCOPE_FOLDER ? await this.collectHtmlAppFolderFiles(htmlFile) : [];
      let deployFiles = buildHtmlAppDeployFiles({
        scope: publishScope,
        entryFilePath: htmlFile.path,
        entryHtml,
        folderFiles
      });
      deployFiles = applySiteIconToDeployFiles(deployFiles, this.settings.siteIconDataUrl);
      const pageState = getPublishedHtmlAppState(this.settings, sourcePath) || {};
      const projectSlug = pageState.projectName || chosenProjectName || publishData.defaultProjectName;
      const projectName = await ensureProject(token, projectSlug);
      let result;
      if (isPrivate) {
        if (clerkPublishableKey) {
          this.settings.clerkPublishableKey = clerkPublishableKey;
        }
        if (clerkSecretKey) {
          this.settings.clerkSecretKey = clerkSecretKey;
        }
        await this.saveSettings();
        const { htmlPages, staticFiles } = partitionHtmlAppDeployFiles(deployFiles);
        const allApproved = [...approvedEmails];
        const pubEmail = (this.settings.publisherEmail || "").toLowerCase().trim();
        if (pubEmail && !allApproved.includes(pubEmail)) {
          allApproved.push(pubEmail);
        }
        const waMatch = this.settings.contactUrl.match(/wa\.me\/(\d+)/);
        const publisherWhatsapp = waMatch ? waMatch[1] : "";
        const authShellHtml = buildAuthShell(siteTitle, this.settings.clerkPublishableKey, this.settings.publisherEmail, publisherWhatsapp, this.settings.siteIconDataUrl);
        const authFunctionSrc = buildAuthFunction({
          approvedEmails: allApproved,
          pages: htmlPages,
          projectName
        });
        const approveFunctionSrc = buildApproveFunction({
          projectName,
          clerkPublishableKey: this.settings.clerkPublishableKey,
          publisherEmail: pubEmail
        });
        const packageJson = JSON.stringify({
          type: "module",
          dependencies: { "@clerk/backend": "^2" }
        });
        const vercelJson = JSON.stringify({
          rewrites: [
            { source: "/((?!api/).*)", destination: "/index.html" }
          ]
        });
        const privateFiles = [
          { path: "index.html", content: authShellHtml },
          { path: "api/auth.js", content: authFunctionSrc },
          { path: "api/approve.js", content: approveFunctionSrc },
          { path: "package.json", content: packageJson },
          { path: "vercel.json", content: vercelJson },
          ...staticFiles
        ];
        result = await deployToVercel(token, siteTitle, privateFiles, {
          isPrivate: true,
          envVars: { CLERK_SECRET_KEY: this.settings.clerkSecretKey },
          projectName,
          onProgress: (msg) => this.trayBarEl.setText(msg)
        });
      } else {
        result = await deployToVercel(token, siteTitle, deployFiles, {
          projectName,
          onProgress: (msg) => this.trayBarEl.setText(msg)
        });
      }
      setPublishedHtmlAppState(this.settings, sourcePath, {
        ...pageState,
        url: result.url,
        projectName: result.projectName,
        publishedAt: (/* @__PURE__ */ new Date()).toISOString(),
        isPrivate: !!isPrivate,
        isUnpublished: false,
        approvedEmails: isPrivate ? approvedEmails : [],
        scope: publishScope,
        siteTitle
      });
      await this.saveSettings();
      this.trayBarEl.setText("@Path");
      const modeLabel = publishScope === HTML_APP_SCOPE_FOLDER ? "folder app" : "single HTML file";
      const summary = 'Deployed "' + siteTitle + '" as a ' + modeLabel + " (" + deployFiles.length + " file" + (deployFiles.length === 1 ? "" : "s") + ")" + (isPrivate ? " (private)." : ".");
      let warning = "";
      if (result.deploymentState && result.deploymentState !== "READY") {
        warning += "Deployment did not succeed (state: " + result.deploymentState + ").";
        if (result.deploymentError) warning += " " + result.deploymentError;
      } else if (result.healthCheck && !result.healthCheck.ok) {
        warning += "Deployment is live but the health check failed.";
        if (result.healthCheck.detail) warning += " " + result.healthCheck.detail;
      }
      new PublishResultModal(this.app, { success: true, url: result.url, summary, warning }).open();
    } catch (e) {
      this.trayBarEl.setText("@Path");
      new PublishResultModal(this.app, { success: false, error: e.message || String(e) }).open();
    }
  }
  async _executeUnpublish(publishData) {
    const plugin = this;
    const token = plugin.settings.vercelToken;
    const pageState = getPublishState(plugin, publishData) || {};
    const title = pageState.siteTitle || publishData.noteTitle;
    if (!token) {
      new Notice("No Vercel token configured.");
      return;
    }
    plugin.trayBarEl.setText("...");
    try {
      const placeholderHtml = buildUnpublishedPage(title, plugin.settings.siteIconDataUrl);
      const files = [{ path: "index.html", content: placeholderHtml }];
      const deployName = pageState.projectName || title;
      await deployToVercel(token, title, files, { projectName: deployName });
      setPublishState(plugin, publishData, {
        ...pageState,
        isUnpublished: true
      });
      await plugin.saveSettings();
      plugin.trayBarEl.setText("@Path");
      new Notice('Unpublished "' + title + '". You can republish at any time.');
    } catch (e) {
      plugin.trayBarEl.setText("@Path");
      new PublishResultModal(plugin.app, { success: false, error: e.message || String(e) }).open();
    }
  }
  dryRunMigration() {
    new MigrationPreviewModal(this.app, this).open();
  }
  async f_planRepositoryMigration() {
    const plan = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path.split("/").some((part) => part === "90_archive" || part === "prompts")) continue;
      const content = await this.app.vault.cachedRead(file);
      const refs = this.f_scanLinkedRefs(content, file.path).filter((ref) => ref.format !== "markdown");
      const edits = [];
      const skipped = [];
      for (const ref of refs) {
        const result = this.f_resolveLinkTarget(ref, file.path);
        if (result.kind === "missing") {
          skipped.push(ref.fullMatch);
          continue;
        }
        try {
          edits.push({
            start: ref.start,
            end: ref.end,
            original: ref.fullMatch,
            replacement: this.f_formatLinkedTarget(result.target, file.path)
          });
        } catch {
          skipped.push(ref.fullMatch);
        }
      }
      if (edits.length || skipped.length) plan.push({ file, path: file.path, content, edits, skipped });
    }
    return plan;
  }
  async f_applyRepositoryMigration(plan) {
    let replaced = 0;
    const stale = [];
    for (const { file, path, content, edits } of plan) {
      if (!edits.length) continue;
      if (file.path !== path) {
        stale.push(path);
        continue;
      }
      await this.app.vault.process(file, (current) => {
        if (current !== content) {
          stale.push(path);
          return current;
        }
        let updated = current;
        for (const edit of edits.slice().reverse()) {
          updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
        }
        replaced += edits.length;
        return updated;
      });
    }
    new Notice("Migrated " + replaced + " legacy links." + (stale.length ? "\nSkipped files changed since preview:\n" + stale.join("\n") : ""), stale.length ? 0 : 5e3);
  }
  onTokenSettingsChanged() {
    void this._tokenIndex.sync();
    this._explorerTokenBadges?.refresh();
    this._repositoryDecorationGeneration = (this._repositoryDecorationGeneration || 0) + 1;
    this.tokenCacheDirty = true;
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mdView && mdView.editor && mdView.editor.cm) {
      try {
        mdView.editor.cm.dispatch();
      } catch (e) {
      }
    }
    this.updateStatusBar();
  }
  async updateAtPathReferences(file, oldPath) {
    const oldRepoRoot = getRepoRoot(oldPath);
    const newRepoRoot = getRepoRoot(file.path);
    const oldRel = oldRepoRoot ? toRepoRelative(oldPath, oldRepoRoot) : oldPath;
    const newRel = newRepoRoot ? toRepoRelative(file.path, newRepoRoot) : file.path;
    const isFolder = !file.path.includes(".") || file.children !== void 0;
    const mdFiles = this.app.vault.getMarkdownFiles();
    if (!isFolder) {
      for (const mdFile of mdFiles) {
        const content = await this.app.vault.read(mdFile);
        const wlRe = new RegExp(WIKILINK_ATPATH_RE.source, WIKILINK_ATPATH_RE.flags);
        let match;
        let updated = content;
        let offset = 0;
        while ((match = wlRe.exec(content)) !== null) {
          const linkTarget = match[1];
          const resolved = this.app.metadataCache.getFirstLinkpathDest(linkTarget, mdFile.path);
          if (!resolved || resolved.path !== file.path) continue;
          const refRepoRoot = getRepoRoot(mdFile.path);
          let correctDisplay;
          if (newRepoRoot && refRepoRoot === newRepoRoot) {
            correctDisplay = toRepoRelative(file.path, newRepoRoot);
          } else if (newRepoRoot) {
            const repoName = newRepoRoot.substring(newRepoRoot.lastIndexOf("/") + 1);
            correctDisplay = repoName + "/" + toRepoRelative(file.path, newRepoRoot);
          } else {
            correctDisplay = file.path;
          }
          const replacement = "[[" + linkTarget + "|@" + correctDisplay + "]]";
          const start = match.index + offset;
          const end = start + match[0].length;
          updated = updated.substring(0, start) + replacement + updated.substring(end);
          offset += replacement.length - match[0].length;
        }
        if (updated !== content) {
          await this.app.vault.modify(mdFile, updated);
        }
      }
    }
    if (oldRel !== newRel) {
      const escaped = oldRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = isFolder ? `(?<=(?:^|[\\s(]))@${escaped}/` : `(?<=(?:^|[\\s(]))@${escaped}(?=$|[\\s)\\]},;:!?])`;
      const re = new RegExp(pattern, "gm");
      const replacement = isFolder ? "@" + newRel + "/" : "@" + newRel;
      const scope = oldRepoRoot || "";
      for (const mdFile of mdFiles) {
        if (scope && !mdFile.path.startsWith(scope + "/")) continue;
        if (!scope && getRepoRoot(mdFile.path)) continue;
        const content = await this.app.vault.read(mdFile);
        if (!re.test(content)) continue;
        re.lastIndex = 0;
        const updated = content.replace(re, replacement);
        if (updated !== content) {
          await this.app.vault.modify(mdFile, updated);
        }
      }
    }
    if (oldRepoRoot && oldPath !== file.path) {
      const escaped = oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = isFolder ? `(?<=(?:^|[\\s(]))@${escaped}/` : `(?<=(?:^|[\\s(]))@${escaped}(?=$|[\\s)\\]},;:!?])`;
      const re = new RegExp(pattern, "gm");
      const replacement = isFolder ? "@" + file.path + "/" : "@" + file.path;
      for (const mdFile of mdFiles) {
        if (getRepoRoot(mdFile.path) === oldRepoRoot) continue;
        const content = await this.app.vault.read(mdFile);
        if (!re.test(content)) continue;
        re.lastIndex = 0;
        const updated = content.replace(re, replacement);
        if (updated !== content) {
          await this.app.vault.modify(mdFile, updated);
        }
      }
    }
    if (oldRepoRoot && oldRel !== newRel) {
      const oldRepoName = oldRepoRoot.substring(oldRepoRoot.lastIndexOf("/") + 1);
      const newRepoName = newRepoRoot ? newRepoRoot.substring(newRepoRoot.lastIndexOf("/") + 1) : "";
      const oldCrossRef = oldRepoName + "/" + oldRel;
      const newCrossRef = newRepoName ? newRepoName + "/" + newRel : file.path;
      const escaped3 = oldCrossRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern3 = isFolder ? `(?<=(?:^|[\\s(]))@${escaped3}/` : `(?<=(?:^|[\\s(]))@${escaped3}(?=$|[\\s)\\]},;:!?])`;
      const re3 = new RegExp(pattern3, "gm");
      const replacement3 = isFolder ? "@" + newCrossRef + "/" : "@" + newCrossRef;
      for (const mdFile of mdFiles) {
        if (getRepoRoot(mdFile.path) === oldRepoRoot) continue;
        const content = await this.app.vault.read(mdFile);
        if (!re3.test(content)) continue;
        re3.lastIndex = 0;
        const updated = content.replace(re3, replacement3);
        if (updated !== content) {
          await this.app.vault.modify(mdFile, updated);
        }
      }
    }
  }
};
module.exports = AtPathPlugin;
