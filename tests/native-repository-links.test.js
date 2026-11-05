"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { f_installNativeRepositoryLinks } = require("../src/native-repository-links");

function f_events() {
  const listeners = new Map();
  return {
    on(name, callback) {
      const ref = { name, callback };
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(ref);
      return ref;
    },
    offref(ref) { listeners.get(ref.name).delete(ref); },
    trigger(name, ...args) {
      for (const ref of listeners.get(name) ?? []) ref.callback(...args);
    },
  };
}

function f_scan(text) {
  return Array.from(text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g), match => ({
    label: match[1],
    destination: match[2],
    position: {
      start: { line: 0, col: match.index, offset: match.index },
      end: { line: 0, col: match.index + match[0].length, offset: match.index + match[0].length },
    },
  }));
}

function f_fixture() {
  const root = { path: "AGENTS.md", extension: "md" };
  const project = { path: "project/AGENTS.md", extension: "md" };
  const nested = { path: "project/nested/AGENTS.md", extension: "md" };
  const source = { path: "project/note.md", extension: "md", stat: { mtime: 1, size: 1 } };
  const twin = { path: "project/nested/note.md", extension: "md", stat: { mtime: 1, size: 1 } };
  const files = new Map([root, project, nested, source, twin].map(file => [file.path, file]));
  let text = "[same](/AGENTS.md) [cross](https://github.com/company/nested/blob/main/AGENTS.md) [standard](AGENTS.md)";
  const base = { links: f_scan(text).filter(link => !link.destination.startsWith("https:")).map(link => ({
    link: link.destination,
    position: link.position,
  })) };
  const caches = new Map([[source.path, base], [twin.path, base]]);
  const vault = {
    ...f_events(),
    getFileByPath: path => files.get(path) ?? null,
    getMarkdownFiles: () => [source, twin],
    cachedRead: async () => text,
  };
  const metadataCache = {
    ...f_events(),
    resolvedLinks: {},
    getCache(path) { return caches.get(path) ?? null; },
    getFirstLinkpathDest(link) { return this.getLinkpathDest(link)[0] ?? null; },
    getLinkpathDest(link) { return link.endsWith("AGENTS.md") && !link.startsWith("\0") ? [root] : []; },
    iterateAllRefs(visit) {
      for (const [path, cache] of caches) {
        for (const reference of cache.links) {
          if (visit(path, reference) === true) break;
        }
      }
    },
    resolveLinks(path) {
      const counts = {};
      for (const { link } of this.getCache(path)?.links ?? []) {
        const file = this.getFirstLinkpathDest(link.split("#")[0], path);
        if (file) counts[file.path] = (counts[file.path] ?? 0) + 1;
      }
      this.resolvedLinks[path] = counts;
    },
    queueFileForLinkResolution(file) { this.resolveLinks(file.path); },
  };
  const resolve = (destination, sourcePath) => {
    if (destination.startsWith("https://github.com/company/nested/blob/")) {
      return { file: vault.getFileByPath("project/nested/AGENTS.md") };
    }
    if (destination.startsWith("/")) {
      return { file: vault.getFileByPath(sourcePath.replace(/\/[^/]+$/, destination)) };
    }
    return null;
  };
  return {
    base, caches, files, metadataCache, nested, project, root, source, twin, vault,
    scan: f_scan, resolve, setText: value => { text = value; },
  };
}

test("projects source-specific graph edges and positioned backlinks without modifying shared metadata", async () => {
  const fixture = f_fixture();
  const { base, metadataCache, nested, project, root, source, twin } = fixture;
  const original = metadataCache.getCache;
  const bridge = f_installNativeRepositoryLinks(fixture);
  await bridge.refresh();

  assert.deepEqual(metadataCache.resolvedLinks[source.path], { [project.path]: 1, [nested.path]: 1, [root.path]: 1 });
  assert.deepEqual(metadataCache.resolvedLinks[twin.path], { [nested.path]: 2, [root.path]: 1 });
  assert.deepEqual(base.links.map(({ link }) => link), ["/AGENTS.md", "AGENTS.md"]);
  assert.deepEqual(metadataCache.getCache(source.path).links.map(({ link }) => link), [
    "/AGENTS.md", "https://github.com/company/nested/blob/main/AGENTS.md", "AGENTS.md",
  ]);
  const refs = [];
  metadataCache.iterateAllRefs((path, reference) => {
    if (metadataCache.getFirstLinkpathDest(reference.link, path) === nested) refs.push([path, reference]);
  });
  const cross = refs.find(([path]) => path === source.path)[1];
  assert.equal(cross.original, "[cross](https://github.com/company/nested/blob/main/AGENTS.md)");
  assert.equal(cross.position.start.offset, 19);
  assert.deepEqual(metadataCache.getLinkpathDest(cross.link, source.path), []);

  bridge.unload();
  assert.equal(metadataCache.getCache, original);
  assert.equal(metadataCache.getCache(source.path), base);
  assert.deepEqual(metadataCache.resolvedLinks[source.path], { [root.path]: 2 });
});

test("keeps a native wikilink with the same destination text authoritative", async () => {
  const fixture = f_fixture();
  const { base, metadataCache, nested, project, root, source } = fixture;
  const original = base.links[0];
  base.links.push({ ...original, position: { start: { offset: 100 }, end: { offset: 112 } } });
  const bridge = f_installNativeRepositoryLinks(fixture);
  try {
    await bridge.refresh();
    assert.equal(metadataCache.getFirstLinkpathDest("/AGENTS.md", source.path), root);
    assert.deepEqual(metadataCache.resolvedLinks[source.path], { [project.path]: 1, [nested.path]: 1, [root.path]: 2 });
    const refs = metadataCache.getCache(source.path).links;
    assert.match(refs[0].link, /atpath:/);
    assert.equal(refs.at(-1).link, "/AGENTS.md");
  } finally {
    bridge.unload();
  }
});

test("reprojects when a target goes missing, the source moves, or the note is edited", async () => {
  const fixture = f_fixture();
  const { caches, files, metadataCache, nested, project, root, source, vault } = fixture;
  const bridge = f_installNativeRepositoryLinks(fixture);
  await bridge.refresh();

  files.delete(nested.path);
  vault.trigger("delete", nested);
  await Promise.resolve();
  assert.deepEqual(metadataCache.resolvedLinks[source.path], { [project.path]: 1, [root.path]: 1 });
  assert.equal(metadataCache.getFirstLinkpathDest("/AGENTS.md", fixture.twin.path), null);

  const oldPath = source.path;
  source.path = "project/nested/moved.md";
  files.delete(oldPath);
  files.set(source.path, source);
  caches.set(source.path, caches.get(oldPath));
  caches.delete(oldPath);
  vault.trigger("rename", source, oldPath);
  assert.deepEqual(metadataCache.resolvedLinks[source.path], { [root.path]: 1 });

  const edited = "[standard](AGENTS.md)";
  fixture.setText(edited);
  const updated = { links: f_scan(edited).map(({ destination, position }) => ({ link: destination, position })) };
  caches.set(source.path, updated);
  metadataCache.trigger("changed", source, edited, updated);
  assert.equal(metadataCache.getCache(source.path), updated);
  assert.deepEqual(metadataCache.resolvedLinks[source.path], { [root.path]: 1 });
  bridge.unload();
});

test("leaves unsupported metadata caches untouched", () => {
  const fixture = f_fixture();
  const original = fixture.metadataCache.getCache;
  delete fixture.metadataCache.iterateAllRefs;
  assert.equal(f_installNativeRepositoryLinks(fixture), null);
  assert.equal(fixture.metadataCache.getCache, original);
});

test("cold projection yields between batches even when Markdown reads already resolved", async () => {
  const fixture = f_fixture();
  const { base, caches, files, source, vault } = fixture;
  const sources = Array.from({ length: 40 }, (_, index) => ({ ...source, path: "project/note-" + index + ".md" }));
  for (const note of sources) {
    files.set(note.path, note);
    caches.set(note.path, base);
  }
  vault.getMarkdownFiles = () => sources;
  let reads = 0;
  const read = vault.cachedRead;
  vault.cachedRead = file => {
    reads++;
    return read(file);
  };
  const bridge = f_installNativeRepositoryLinks(fixture);
  try {
    const projection = bridge.refresh();
    const readsBeforeTimer = await new Promise(resolve => setTimeout(() => resolve(reads), 0));
    assert.ok(readsBeforeTimer > 0 && readsBeforeTimer <= 16, "initial UI turn read " + readsBeforeTimer + " notes");
    await projection;
    assert.equal(reads, sources.length);
  } finally {
    bridge.unload();
  }
});
