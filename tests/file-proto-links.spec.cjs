#!/usr/bin/env node
// Tests for file:/// HTML link rewriting in published pages.
//
// Run: node tests/file-proto-links.spec.cjs

const assert = require("node:assert");
const { buildMainPage, slugifyPath } = require("../src/html-builder.js");

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

// Helper: simulate the new bundle-based rewrite from _executePublish
function rewriteFileProtoLinks(markdown, bundles) {
  const fileProtoSlugs = new Map();
  const usedSlugs = new Set();
  for (const bundle of bundles) {
    let slug = slugifyPath(bundle.dirName);
    if (usedSlugs.has(slug)) slug += "-project";
    usedSlugs.add(slug);
    fileProtoSlugs.set(bundle.url, { slug, entryFilename: bundle.entryFilename });
  }

  return markdown.replace(
    /\[([^\]]*)\]\((file:\/\/\/[^)]+\.html?)\)/gi,
    (match, text, url) => {
      const info = fileProtoSlugs.get(url);
      return info ? `[${text}](atpath/${info.slug}/${info.entryFilename})` : match;
    }
  );
}

console.log("\nfile:/// Link Rewriting Tests\n");

// ── Test 1: file:/// links are rewritten with directory slug + entry filename ──
try {
  const markdown = `# Report

See the chart: [Revenue Chart](file:///Users/sergio/charts/revenue.html)

And another: [Costs](file:///Users/sergio/costs-app/costs.htm)`;

  const bundles = [
    { url: "file:///Users/sergio/charts/revenue.html", entryFilename: "revenue.html", dirName: "charts" },
    { url: "file:///Users/sergio/costs-app/costs.htm", entryFilename: "costs.htm", dirName: "costs-app" },
  ];

  const resolved = rewriteFileProtoLinks(markdown, bundles);

  assert.ok(resolved.includes("[Revenue Chart](atpath/charts/revenue.html)"), "Revenue link rewritten with dir slug");
  assert.ok(resolved.includes("[Costs](atpath/costs-app/costs.htm)"), "Costs link rewritten with dir slug");
  assert.ok(!resolved.includes("file:///"), "No file:/// URLs remain");

  log("PASS", "file:/// links rewritten to atpath/{dirSlug}/{entryFilename}");
} catch (e) {
  log("FAIL", "file:/// links rewritten to atpath/{dirSlug}/{entryFilename}", e.message);
}

// ── Test 2: Unmatched file:/// links are left unchanged ──────────
try {
  const markdown = `[Doc](file:///Users/sergio/docs/report.pdf)

[Chart](file:///Users/sergio/charts/revenue.html)`;

  const bundles = [
    { url: "file:///Users/sergio/charts/revenue.html", entryFilename: "revenue.html", dirName: "charts" },
  ];

  const resolved = rewriteFileProtoLinks(markdown, bundles);

  // PDF link stays as-is (regex only matches .html/.htm)
  assert.ok(resolved.includes("file:///Users/sergio/docs/report.pdf"), "PDF link unchanged");
  // HTML link rewritten
  assert.ok(resolved.includes("[Chart](atpath/charts/revenue.html)"), "HTML link rewritten");

  log("PASS", "Non-HTML file:/// links left unchanged");
} catch (e) {
  log("FAIL", "Non-HTML file:/// links left unchanged", e.message);
}

// ── Test 3: Code blocks are NOT corrupted by regex replacement ───
try {
  const markdown = "# Notes\n\nSee: [Chart](file:///Users/sergio/myapp/chart.html)\n\n```js\nconst url = 'file:///Users/sergio/myapp/chart.html';\nconsole.log(url);\n```";

  const bundles = [
    { url: "file:///Users/sergio/myapp/chart.html", entryFilename: "chart.html", dirName: "myapp" },
  ];

  const resolved = rewriteFileProtoLinks(markdown, bundles);

  // The markdown link should be rewritten
  assert.ok(resolved.includes("[Chart](atpath/myapp/chart.html)"), "Markdown link rewritten");
  // The code block reference (bare URL, not in [text](url) syntax) should NOT be touched
  assert.ok(resolved.includes("const url = 'file:///Users/sergio/myapp/chart.html'"), "Code block URL untouched");

  log("PASS", "Code blocks not corrupted by regex replacement");
} catch (e) {
  log("FAIL", "Code blocks not corrupted by regex replacement", e.message);
}

// ── Test 4: URL-encoded paths handled via regex match ────────────
try {
  const markdown = "[My Chart](file:///Users/sergio/My%20Charts/revenue.html)";

  const bundles = [
    { url: "file:///Users/sergio/My%20Charts/revenue.html", entryFilename: "revenue.html", dirName: "My Charts" },
  ];

  const resolved = rewriteFileProtoLinks(markdown, bundles);

  assert.ok(resolved.includes("[My Chart](atpath/my-charts/revenue.html)"), "URL-encoded path rewritten with dir slug");
  assert.ok(!resolved.includes("file:///"), "No file:/// remaining");

  log("PASS", "URL-encoded file:/// paths handled correctly");
} catch (e) {
  log("FAIL", "URL-encoded file:/// paths handled correctly", e.message);
}

// ── Test 5: Rendered HTML contains proper <a> tags ───────────────
try {
  const markdown = "See: [Revenue](file:///Users/sergio/dashboard/revenue.html)";

  const bundles = [
    { url: "file:///Users/sergio/dashboard/revenue.html", entryFilename: "revenue.html", dirName: "dashboard" },
  ];

  const resolved = rewriteFileProtoLinks(markdown, bundles);

  const atPathSlugs = new Map();
  const html = buildMainPage("Test", resolved, atPathSlugs, "", "", false);

  // The rendered HTML should have a proper <a> tag, not raw markdown
  assert.ok(html.includes('href="atpath/dashboard/revenue.html"'), "HTML contains proper href");
  assert.ok(html.includes(">Revenue</a>"), "HTML contains link text");
  assert.ok(!html.includes("[Revenue](file:///"), "No raw markdown link in output");

  log("PASS", "Rendered HTML contains clickable <a> tags");
} catch (e) {
  log("FAIL", "Rendered HTML contains clickable <a> tags", e.message);
}

// ── Test 6: slugifyPath produces clean slugs from directory names ─
try {
  const slug = slugifyPath("charts");
  assert.strictEqual(slug, "charts");

  const slug2 = slugifyPath("My Dashboard App");
  assert.strictEqual(slug2, "my-dashboard-app");

  log("PASS", "slugifyPath produces clean slugs from directory names");
} catch (e) {
  log("FAIL", "slugifyPath produces clean slugs from directory names", e.message);
}

// ── Test 7: Duplicate dirName gets -project suffix ───────────────
try {
  const markdown = "[A](file:///a/charts/index.html) [B](file:///b/charts/main.html)";

  const bundles = [
    { url: "file:///a/charts/index.html", entryFilename: "index.html", dirName: "charts" },
    { url: "file:///b/charts/main.html", entryFilename: "main.html", dirName: "charts" },
  ];

  const resolved = rewriteFileProtoLinks(markdown, bundles);

  assert.ok(resolved.includes("atpath/charts/index.html"), "First bundle uses base slug");
  assert.ok(resolved.includes("atpath/charts-project/main.html"), "Second bundle gets -project suffix");

  log("PASS", "Duplicate directory names get -project suffix");
} catch (e) {
  log("FAIL", "Duplicate directory names get -project suffix", e.message);
}

// ── Test 8: Deploy file generation for bundles ───────────────────
try {
  const bundle = {
    url: "file:///Users/sergio/myapp/index.html",
    entryFilename: "index.html",
    dirName: "myapp",
    files: [
      { relPath: "index.html", content: "<html>hello</html>", encoding: "utf-8" },
      { relPath: "style.css", content: "body{}", encoding: "utf-8" },
      { relPath: "logo.png", content: "iVBORw0KGgo=", encoding: "base64" },
    ],
  };

  const slug = slugifyPath(bundle.dirName);
  const deployFiles = [];
  for (const f of bundle.files) {
    deployFiles.push({ path: "atpath/" + slug + "/" + f.relPath, content: f.content, encoding: f.encoding });
  }

  assert.strictEqual(deployFiles.length, 3, "All bundle files included");
  assert.strictEqual(deployFiles[0].path, "atpath/myapp/index.html");
  assert.strictEqual(deployFiles[1].path, "atpath/myapp/style.css");
  assert.strictEqual(deployFiles[2].path, "atpath/myapp/logo.png");
  assert.strictEqual(deployFiles[2].encoding, "base64", "Binary file uses base64 encoding");

  log("PASS", "Deploy files generated with correct paths and encoding");
} catch (e) {
  log("FAIL", "Deploy files generated with correct paths and encoding", e.message);
}

// ── Summary ──────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("\n" + results.length + " tests, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
