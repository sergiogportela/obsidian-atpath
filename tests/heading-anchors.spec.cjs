#!/usr/bin/env node
// Tests for heading anchor IDs and slugifyHeading.
//
// Run: node tests/heading-anchors.spec.cjs

const assert = require("node:assert");
const { buildMainPage, slugifyHeading } = require("../src/html-builder.js");

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

console.log("\nHeading Anchor Tests\n");

// ── Test 1: slugifyHeading handles Portuguese text ───────────────
try {
  assert.strictEqual(slugifyHeading("Resultados do Polling"), "resultados-do-polling");
  assert.strictEqual(slugifyHeading("Introdução"), "introducao");
  assert.strictEqual(slugifyHeading("Análise & Conclusão"), "analise-conclusao");
  assert.strictEqual(slugifyHeading("São Paulo"), "sao-paulo");

  log("PASS", "slugifyHeading handles Portuguese text with accents");
} catch (e) {
  log("FAIL", "slugifyHeading handles Portuguese text with accents", e.message);
}

// ── Test 2: slugifyHeading strips HTML tags ──────────────────────
try {
  assert.strictEqual(slugifyHeading("<em>Important</em> Section"), "important-section");
  assert.strictEqual(slugifyHeading('<a href="#">Link</a> Title'), "link-title");
  assert.strictEqual(slugifyHeading("<strong>Bold</strong>"), "bold");

  log("PASS", "slugifyHeading strips HTML tags");
} catch (e) {
  log("FAIL", "slugifyHeading strips HTML tags", e.message);
}

// ── Test 3: slugifyHeading handles edge cases ────────────────────
try {
  assert.strictEqual(slugifyHeading("  Spaced  Out  "), "spaced-out");
  assert.strictEqual(slugifyHeading("ALL CAPS HEADING"), "all-caps-heading");
  assert.strictEqual(slugifyHeading("kebab-case-already"), "kebab-case-already");

  log("PASS", "slugifyHeading handles edge cases");
} catch (e) {
  log("FAIL", "slugifyHeading handles edge cases", e.message);
}

// ── Test 4: wrapSections produces id on <h1> ─────────────────────
try {
  const html = buildMainPage("Test", "# My Title\n\nSome content", new Map(), "", "", false);

  assert.ok(html.includes('id="my-title"'), "h1 has id attribute");

  log("PASS", "wrapSections produces id on h1");
} catch (e) {
  log("FAIL", "wrapSections produces id on h1", e.message);
}

// ── Test 5: wrapSections produces id on <details> for h2-h4 ─────
try {
  const md = "# Title\n\n## Section One\n\nContent\n\n### Sub Section\n\nMore content";
  const html = buildMainPage("Test", md, new Map(), "", "", false);

  assert.ok(html.includes('<details id="section-one">'), "h2 details has id");
  assert.ok(html.includes('<details id="sub-section">'), "h3 details has id");

  log("PASS", "wrapSections produces id on details for h2-h4");
} catch (e) {
  log("FAIL", "wrapSections produces id on details for h2-h4", e.message);
}

// ── Test 6: Duplicate headings get unique slugs ──────────────────
try {
  const md = "## Results\n\nFirst\n\n## Results\n\nSecond\n\n## Results\n\nThird";
  const html = buildMainPage("Test", md, new Map(), "", "", false);

  assert.ok(html.includes('id="results"'), "First gets base slug");
  assert.ok(html.includes('id="results-2"'), "Second gets -2 suffix");
  assert.ok(html.includes('id="results-3"'), "Third gets -3 suffix");

  log("PASS", "Duplicate headings get unique slugs");
} catch (e) {
  log("FAIL", "Duplicate headings get unique slugs", e.message);
}

// ── Test 7: Anchor JS is included in rendered HTML ───────────────
try {
  const html = buildMainPage("Test", "# Title\n\n## Section", new Map(), "", "", false);

  assert.ok(html.includes("openTarget"), "Anchor JS function is present");
  assert.ok(html.includes("scrollIntoView"), "scrollIntoView call is present");
  assert.ok(html.includes("hashchange"), "hashchange listener is present");

  log("PASS", "Anchor JS is included in rendered HTML");
} catch (e) {
  log("FAIL", "Anchor JS is included in rendered HTML", e.message);
}

// ── Summary ──────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("\n" + results.length + " tests, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
