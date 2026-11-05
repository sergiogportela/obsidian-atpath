"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMainPage, buildAtPathPage } = require("../src/html-builder");
const { f_resolveRepositoryLink } = require("../src/repository-links");

const repositories = [{ root: "a", identity: "org/a" }, { root: "b", identity: "org/b" }];
const files = new Set(["a/source.md", "a/same.md", "b/same.md", "a/code.js"]);
function f_context(sourcePath = "a/source.md") {
  return {
    sourcePath,
    slugsByPath: new Map([["a/same.md", "a-same"], ["b/same.md", "b-same"]]),
    resolveLink: (destination, sourcePath) => f_resolveRepositoryLink(destination, {
      sourcePath, repositories, getTargetType: path => files.has(path) ? "file" : null,
    }),
  };
}

test("publishing resolves destinations despite identical labels, preserving source download", () => {
  const source = "[same](/same.md#heading) and [same](https://github.com/org/b/blob/main/same.md).";
  const html = buildMainPage("Source", source, new Map(), "", "", false, "", f_context());
  assert.match(html, /href="atpath\/a-same.html#heading" class="atpath-ref">same<\/a>/);
  assert.match(html, /href="atpath\/b-same.html" class="atpath-ref">same<\/a>/);
  assert.ok(html.includes(Buffer.from(source).toString("base64")));
});

test("publication rewrites reference-style links but leaves code, external citations and headings", () => {
  const source = "[target][id]\n\n[id]: /same.md\n\n`[code](/same.md)`\n\n```md\n[example](/same.md)\n```\n\n[web](https://example.com) [section](#heading) [missing](/missing.md)";
  const html = buildMainPage("Source", source, new Map(), "", "", false, "", f_context());
  assert.match(html, /href="atpath\/a-same.html" class="atpath-ref">target<\/a>/);
  assert.match(html, /<code>\[code\]\(\/same.md\)<\/code>/);
  assert.match(html, /\[example\]\(\/same.md\)/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /href="#heading"/);
  assert.match(html, /<span class="atpath-nested">missing<\/span>/);
});

test("child pages keep nested repository references inert and infer code extension from resolved path", () => {
  const source = "[child](/same.md) [web](https://example.com)";
  const html = buildAtPathPage("Renamed label", source, "Source", "", "", "", f_context("b/same.md"));
  assert.match(html, /<span class="atpath-nested">child<\/span>/);
  assert.match(html, /href="https:\/\/example.com"/);
  const code = buildAtPathPage("Misleading.md", source, "Source", "", "", "", f_context("a/code.js"));
  assert.match(code, /<code class="language-js">\[child\]\(\/same.md\)/);
});
