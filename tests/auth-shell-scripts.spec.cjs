#!/usr/bin/env node
// Source-level checks: auth shell uses document.write for content delivery.
//
// Run: node tests/auth-shell-scripts.spec.cjs

const assert = require("node:assert");
const { buildAuthShell } = require("../src/auth-shell-builder.js");

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

const html = buildAuthShell("Test", "pk_test_abc", "a@b.com");

console.log("\nAuth Shell: document.write Content Delivery\n");

// ── Test 1: showContent uses document.write ─────────────────────────
try {
  assert.ok(
    html.includes("document.write(html)"),
    "showContent must use document.write"
  );
  log("PASS", "showContent uses document.write");
} catch (e) {
  log("FAIL", "showContent uses document.write", e.message);
}

// ── Test 2: document.open() called before write ─────────────────────
try {
  const openIdx = html.indexOf("document.open()");
  const writeIdx = html.indexOf("document.write(html)");
  assert.ok(openIdx !== -1, "document.open() must be present");
  assert.ok(openIdx < writeIdx, "document.open() must come before document.write()");
  log("PASS", "document.open() called before write");
} catch (e) {
  log("FAIL", "document.open() called before write", e.message);
}

// ── Test 3: document.close() called after write ─────────────────────
try {
  const writeIdx = html.indexOf("document.write(html)");
  const closeIdx = html.indexOf("document.close()");
  assert.ok(closeIdx !== -1, "document.close() must be present");
  assert.ok(closeIdx > writeIdx, "document.close() must come after document.write()");
  log("PASS", "document.close() called after write");
} catch (e) {
  log("FAIL", "document.close() called after write", e.message);
}

// ── Test 4: poll timer is cleared ───────────────────────────────────
try {
  // showContent should clear pollTimer before document.write
  const showContentMatch = html.match(/function showContent\(html\)\s*\{[^}]*\}/);
  assert.ok(showContentMatch, "showContent function found");
  assert.ok(showContentMatch[0].includes("clearInterval(pollTimer)"), "clears pollTimer");
  log("PASS", "Poll timer is cleared in showContent");
} catch (e) {
  log("FAIL", "Poll timer is cleared in showContent", e.message);
}

// ── Test 5: no content.innerHTML in showContent ─────────────────────
try {
  const showContentMatch = html.match(/function showContent\(html\)\s*\{[^}]*\}/);
  assert.ok(showContentMatch, "showContent function found");
  assert.ok(
    !showContentMatch[0].includes("content.innerHTML"),
    "showContent must not use content.innerHTML"
  );
  log("PASS", "No content.innerHTML assignment in showContent");
} catch (e) {
  log("FAIL", "No content.innerHTML assignment in showContent", e.message);
}

// ── Test 6: showContent is not async ────────────────────────────────
try {
  assert.ok(
    !html.includes("async function showContent"),
    "showContent must not be async"
  );
  assert.ok(
    html.includes("function showContent(html)"),
    "showContent must be a plain function"
  );
  log("PASS", "showContent is not async");
} catch (e) {
  log("FAIL", "showContent is not async", e.message);
}

// ── Summary ───────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("\n" + results.length + " tests, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
