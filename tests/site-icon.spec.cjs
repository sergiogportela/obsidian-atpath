#!/usr/bin/env node
// Tests for persistent site icon helpers.
//
// Run: node tests/site-icon.spec.cjs

const assert = require("node:assert");

const { buildMainPage, buildUnpublishedPage } = require("../src/html-builder.js");
const { buildAuthShell } = require("../src/auth-shell-builder.js");
const { injectSiteIconIntoHtml, applySiteIconToDeployFiles } = require("../src/site-icon.js");

const SITE_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOZ9er8AAAAASUVORK5CYII=";

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

console.log("\nSite Icon Helper Tests\n");

// ── Test 1: Builder pages include configured site icon ───────────────
try {
  const mainHtml = buildMainPage("Demo", "# Hello", new Map(), "", "", false, SITE_ICON_DATA_URL);
  const authHtml = buildAuthShell("Demo", "pk_test_123", "demo@example.com", "", SITE_ICON_DATA_URL);
  const unpublishedHtml = buildUnpublishedPage("Demo", SITE_ICON_DATA_URL);

  assert.ok(mainHtml.includes(SITE_ICON_DATA_URL), "main page includes icon data URL");
  assert.ok(authHtml.includes(SITE_ICON_DATA_URL), "auth shell includes icon data URL");
  assert.ok(unpublishedHtml.includes(SITE_ICON_DATA_URL), "unpublished page includes icon data URL");
  assert.ok(mainHtml.includes('rel="icon"'), "main page includes favicon link");
  assert.ok(authHtml.includes('rel="shortcut icon"'), "auth shell includes shortcut icon link");

  log("PASS", "Builder pages include configured site icon");
} catch (e) {
  log("FAIL", "Builder pages include configured site icon", e.message);
}

// ── Test 2: Raw HTML gets icon injected before </head> ───────────────
try {
  const html = "<!doctype html><html><head><title>Demo</title></head><body>Hi</body></html>";
  const nextHtml = injectSiteIconIntoHtml(html, SITE_ICON_DATA_URL);

  assert.ok(nextHtml.includes(SITE_ICON_DATA_URL), "data URL injected");
  assert.ok(nextHtml.indexOf('rel="icon"') < nextHtml.indexOf("</head>"), "icon link stays inside head");

  log("PASS", "Raw HTML gets icon injected before </head>");
} catch (e) {
  log("FAIL", "Raw HTML gets icon injected before </head>", e.message);
}

// ── Test 3: Existing app favicon is preserved ────────────────────────
try {
  const html = '<html><head><link rel="icon" href="/custom.ico"></head><body>Hi</body></html>';
  const nextHtml = injectSiteIconIntoHtml(html, SITE_ICON_DATA_URL);

  assert.strictEqual(nextHtml, html, "existing favicon remains untouched");

  log("PASS", "Existing app favicon is preserved");
} catch (e) {
  log("FAIL", "Existing app favicon is preserved", e.message);
}

// ── Test 4: Deploy file helper injects only HTML files ───────────────
try {
  const deployFiles = [
    {
      path: "index.html",
      content: "<html><head><title>Root</title></head><body>Home</body></html>",
      encoding: "utf-8",
    },
    {
      path: "docs/help.html",
      content: '<html><head><link rel="icon" href="/custom.ico"></head><body>Help</body></html>',
      encoding: "utf-8",
    },
    {
      path: "style.css",
      content: "body { color: red; }",
      encoding: "utf-8",
    },
  ];

  const nextFiles = applySiteIconToDeployFiles(deployFiles, SITE_ICON_DATA_URL);

  assert.ok(nextFiles[0].content.includes(SITE_ICON_DATA_URL), "HTML root file gets injected icon");
  assert.strictEqual(nextFiles[1].content, deployFiles[1].content, "existing app icon is preserved");
  assert.strictEqual(nextFiles[2].content, deployFiles[2].content, "non-HTML asset is unchanged");

  log("PASS", "Deploy file helper injects only HTML files");
} catch (e) {
  log("FAIL", "Deploy file helper injects only HTML files", e.message);
}

// ── Summary ───────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("\n" + results.length + " tests, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
