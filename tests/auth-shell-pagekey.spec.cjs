#!/usr/bin/env node
// Tests for auth shell pageKey derivation — verifies .html and .htm stripping.
//
// Run: node tests/auth-shell-pagekey.spec.cjs

const assert = require("node:assert");
const { buildAuthShell } = require("../src/auth-shell-builder.js");

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

const DUMMY_PK = "pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXY$";
const html = buildAuthShell("Test Page", DUMMY_PK, "test@example.com");

console.log("\nAuth Shell PageKey Tests\n");

// ── Test 1: Script strips .html extension ─────────────────────────────
try {
  // The regex in the built HTML should strip .html
  assert.ok(
    html.includes(".html?"),
    "Auth shell script contains .html? regex (strips both .html and .htm)"
  );
  log("PASS", "Script contains .html? regex for extension stripping");
} catch (e) {
  log("FAIL", "Script contains .html? regex for extension stripping", e.message);
}

// ── Test 2: Regex strips .html correctly ──────────────────────────────
try {
  // Replicate the pageKey logic from the auth shell
  const stripRe = /\.html?$/;

  assert.strictEqual("page.html".replace(stripRe, ""), "page", ".html stripped");
  assert.strictEqual("page.htm".replace(stripRe, ""), "page", ".htm stripped");
  assert.strictEqual("page".replace(stripRe, ""), "page", "No extension unchanged");
  assert.strictEqual("deep/path/page.html".replace(stripRe, ""), "deep/path/page", "Nested .html stripped");
  assert.strictEqual("deep/path/page.htm".replace(stripRe, ""), "deep/path/page", "Nested .htm stripped");

  log("PASS", "Regex strips both .html and .htm extensions");
} catch (e) {
  log("FAIL", "Regex strips both .html and .htm extensions", e.message);
}

// ── Test 3: Regex does NOT strip unrelated extensions ─────────────────
try {
  const stripRe = /\.html?$/;

  assert.strictEqual("style.css".replace(stripRe, ""), "style.css", ".css not stripped");
  assert.strictEqual("app.js".replace(stripRe, ""), "app.js", ".js not stripped");
  assert.strictEqual("data.json".replace(stripRe, ""), "data.json", ".json not stripped");
  assert.strictEqual("file.htmlx".replace(stripRe, ""), "file.htmlx", ".htmlx not stripped");

  log("PASS", "Regex does not strip unrelated extensions");
} catch (e) {
  log("FAIL", "Regex does not strip unrelated extensions", e.message);
}

// ── Test 4: Source file has the correct regex ─────────────────────────
try {
  const fs = require("node:fs");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "auth-shell-builder.js"), "utf-8");

  assert.ok(
    src.includes(".html?$/"),
    "auth-shell-builder.js uses .html?$ regex (not just .html$)"
  );
  assert.ok(
    !src.match(/\.html\$\//),
    "auth-shell-builder.js does NOT have old .html$ regex (without ?)"
  );

  log("PASS", "Source file uses correct .html?$ regex");
} catch (e) {
  log("FAIL", "Source file uses correct .html?$ regex", e.message);
}

// ── Summary ───────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("\n" + results.length + " tests, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
