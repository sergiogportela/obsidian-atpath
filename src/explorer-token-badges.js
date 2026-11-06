"use strict";

const { TOKEN_COUNT_DISCLOSURE } = require("./token-contract");

const ROW = ".nav-file-title[data-path], .nav-folder-title[data-path]";
const BADGE = "atpath-explorer-token-badge";

function f_describeTokenBadge(snapshot, formatTokens) {
  if (!snapshot) {
    return { text: "…", title: "Token count pending" };
  }
  const { tokens, counted, pending, skipped, failed = 0 } = snapshot;
  const notes = [];
  if (counted || (!skipped && !pending && !failed)) notes.push(tokens.toLocaleString() + " o200k_base text tokens");
  if (counted) notes.push(TOKEN_COUNT_DISCLOSURE.replace(/\.$/, ""));
  if (pending) notes.push(counted ? "Some files are still pending" : "Token count pending");
  if (skipped) notes.push(skipped + (skipped === 1 ? " file skipped" : " files skipped"));
  if (failed) notes.push(failed + (failed === 1 ? " file failed to count" : " files failed to count") + "; total is incomplete");
  return {
    text: (!counted && pending ? "…" : !counted && failed ? "" : !counted && skipped ? "—"
      : formatTokens(tokens) + (pending ? " …" : skipped ? " *" : "")) + (failed ? (counted || pending || skipped ? " !" : "!") : ""),
    title: notes.join(". "),
  };
}

function f_installExplorerTokenBadges({ workspace, index, formatTokens, isEnabled = () => true }) {
  if (!["getLeavesOfType", "on", "offref"].every(name => typeof workspace?.[name] === "function")) return null;
  const watched = new Map();
  const badges = new Map();
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
    const containers = new Set();
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

    const visible = new Map();
    for (const container of containers) {
      if (!watched.has(container)) {
        const observer = new container.ownerDocument.defaultView.MutationObserver(mutations => {
          if (mutations.some(mutation => {
            if (mutation.target.closest?.("." + BADGE)) return false;
            if (mutation.type === "attributes") return true;
            return [...mutation.addedNodes, ...mutation.removedNodes]
              .some(node => !node.classList?.contains(BADGE));
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
        const badge = f_describeTokenBadge(snapshot, formatTokens);
        if (folder) badge.title += ". Configured folder exclusions apply to descendants";
        visible.set(row, badge);
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
    },
  };
}

module.exports = { f_installExplorerTokenBadges, f_describeTokenBadge };
