#!/usr/bin/env node
// Tests for standalone HTML app publish helpers.
//
// Run: node tests/html-app-publish.spec.cjs

const assert = require("node:assert");

const {
  HTML_APP_SCOPE_SINGLE_FILE,
  HTML_APP_SCOPE_FOLDER,
  buildHtmlAppDefaults,
  buildHtmlAppDeployFiles,
  partitionHtmlAppDeployFiles,
  getPublishedHtmlAppState,
  setPublishedHtmlAppState,
  renamePublishedHtmlAppState,
} = require("../src/html-app-publish.js");

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

console.log("\nHTML App Publish Helper Tests\n");

// ── Test 1: Single-file publish deploys only root index.html ──────────
try {
  const deployFiles = buildHtmlAppDeployFiles({
    scope: HTML_APP_SCOPE_SINGLE_FILE,
    entryFilePath: "apps/calculator.html",
    entryHtml: "<!doctype html><html><body>Calculator</body></html>",
    folderFiles: [
      { relPath: "calculator.html", content: "ignored", encoding: "utf-8" },
      { relPath: "style.css", content: "body {}", encoding: "utf-8" },
    ],
  });

  assert.deepStrictEqual(deployFiles, [
    {
      path: "index.html",
      content: "<!doctype html><html><body>Calculator</body></html>",
      encoding: "utf-8",
    },
  ]);

  log("PASS", "Single-file publish deploys only root index.html");
} catch (e) {
  log("FAIL", "Single-file publish deploys only root index.html", e.message);
}

// ── Test 2: Folder publish keeps folder assets and adds root entry ────
try {
  const deployFiles = buildHtmlAppDeployFiles({
    scope: HTML_APP_SCOPE_FOLDER,
    entryFilePath: "apps/charts/app.html",
    entryHtml: "<!doctype html><html><body>Charts</body></html>",
    folderFiles: [
      { relPath: "app.html", content: "<!doctype html><html><body>Charts</body></html>", encoding: "utf-8" },
      { relPath: "style.css", content: "body { margin: 0; }", encoding: "utf-8" },
      { relPath: "assets/logo.png", content: "iVBORw0KGgo=", encoding: "base64" },
    ],
  });

  const paths = deployFiles.map((file) => file.path);
  assert.ok(paths.includes("index.html"), "root index added");
  assert.ok(paths.includes("app.html"), "entry file preserved at original path");
  assert.ok(paths.includes("style.css"), "root asset preserved");
  assert.ok(paths.includes("assets/logo.png"), "nested asset preserved");

  const rootIndex = deployFiles.find((file) => file.path === "index.html");
  assert.strictEqual(rootIndex.content, "<!doctype html><html><body>Charts</body></html>", "root index uses entry HTML");

  log("PASS", "Folder publish keeps folder assets and adds root entry");
} catch (e) {
  log("FAIL", "Folder publish keeps folder assets and adds root entry", e.message);
}

// ── Test 3: Folder publish with index.html entry does not duplicate ───
try {
  const deployFiles = buildHtmlAppDeployFiles({
    scope: HTML_APP_SCOPE_FOLDER,
    entryFilePath: "apps/site/index.html",
    entryHtml: "<!doctype html><html><body>Site</body></html>",
    folderFiles: [
      { relPath: "index.html", content: "<!doctype html><html><body>Site</body></html>", encoding: "utf-8" },
      { relPath: "app.js", content: "console.debug('ok');", encoding: "utf-8" },
    ],
  });

  assert.strictEqual(
    deployFiles.filter((file) => file.path === "index.html").length,
    1,
    "index.html appears only once"
  );

  log("PASS", "Folder publish with index.html entry does not duplicate");
} catch (e) {
  log("FAIL", "Folder publish with index.html entry does not duplicate", e.message);
}

// ── Test 4: Defaults use HTML title plus filename or folder naming ────
try {
  const singleDefaults = buildHtmlAppDefaults({
    filePath: "apps/calculator.html",
    scope: HTML_APP_SCOPE_SINGLE_FILE,
    entryHtml: "<html><head><title>Calculator Pro</title></head></html>",
  });
  const folderDefaults = buildHtmlAppDefaults({
    filePath: "apps/dashboard/main.html",
    scope: HTML_APP_SCOPE_FOLDER,
    entryHtml: "<html><head><title>Revenue Dashboard</title></head></html>",
  });

  assert.strictEqual(singleDefaults.defaultProjectName, "calculator", "single-file project name comes from filename");
  assert.strictEqual(folderDefaults.defaultProjectName, "dashboard", "folder project name comes from parent folder");
  assert.strictEqual(singleDefaults.siteTitle, "Calculator Pro", "single-file title comes from HTML title");
  assert.strictEqual(folderDefaults.siteTitle, "Revenue Dashboard", "folder title comes from entry HTML title");

  log("PASS", "Defaults use HTML title plus filename or folder naming");
} catch (e) {
  log("FAIL", "Defaults use HTML title plus filename or folder naming", e.message);
}

// ── Test 5: Private auth split keeps HTML pages protected ─────────────
try {
  const deployFiles = buildHtmlAppDeployFiles({
    scope: HTML_APP_SCOPE_FOLDER,
    entryFilePath: "apps/docs/app.html",
    entryHtml: "<!doctype html><html><body>App</body></html>",
    folderFiles: [
      { relPath: "app.html", content: "<!doctype html><html><body>App</body></html>", encoding: "utf-8" },
      { relPath: "docs/help.htm", content: "<!doctype html><html><body>Help</body></html>", encoding: "utf-8" },
      { relPath: "assets/logo.png", content: "iVBORw0KGgo=", encoding: "base64" },
      { relPath: "style.css", content: "body{margin:0}", encoding: "utf-8" },
    ],
  });
  const { htmlPages, staticFiles } = partitionHtmlAppDeployFiles(deployFiles);

  assert.deepStrictEqual(
    htmlPages,
    {
      main: "<!doctype html><html><body>App</body></html>",
      app: "<!doctype html><html><body>App</body></html>",
      "docs/help": "<!doctype html><html><body>Help</body></html>",
    },
    "HTML files are mapped to auth page keys"
  );
  assert.deepStrictEqual(
    staticFiles,
    [
      { path: "assets/logo.png", content: "iVBORw0KGgo=", encoding: "base64" },
      { path: "style.css", content: "body{margin:0}", encoding: "utf-8" },
    ],
    "Non-HTML assets stay public/static"
  );

  log("PASS", "Private auth split keeps HTML pages protected");
} catch (e) {
  log("FAIL", "Private auth split keeps HTML pages protected", e.message);
}

// ── Test 6: Republish state stays keyed by HTML file path ─────────────
try {
  const settings = {
    publishedPages: {
      "Notes/demo.md": { projectName: "note-project", url: "https://note-project.vercel.app" },
    },
    publishedHtmlApps: {},
  };

  setPublishedHtmlAppState(settings, "apps/demo/app.html", {
    projectName: "demo-site",
    url: "https://demo-site.vercel.app",
    scope: HTML_APP_SCOPE_FOLDER,
    siteTitle: "Demo app",
  });

  const republishDefaults = buildHtmlAppDefaults({
    filePath: "apps/demo/app.html",
    scope: HTML_APP_SCOPE_SINGLE_FILE,
    entryHtml: "<html><head><title>Ignored new title</title></head></html>",
    existingState: getPublishedHtmlAppState(settings, "apps/demo/app.html"),
  });

  assert.strictEqual(republishDefaults.projectName, "demo-site", "republish keeps existing Vercel project");
  assert.strictEqual(republishDefaults.domain, "demo-site.vercel.app", "republish domain uses existing project");
  assert.strictEqual(republishDefaults.siteTitle, "Demo app", "republish keeps stored site title");
  assert.strictEqual(settings.publishedPages["Notes/demo.md"].projectName, "note-project", "note publish state is untouched");

  const renamed = renamePublishedHtmlAppState(settings, "apps/demo/app.html", "apps/demo/index.html");
  assert.strictEqual(renamed, true, "rename helper moves existing HTML app state");
  assert.strictEqual(getPublishedHtmlAppState(settings, "apps/demo/app.html"), undefined, "old HTML path removed");
  assert.strictEqual(getPublishedHtmlAppState(settings, "apps/demo/index.html").projectName, "demo-site", "new HTML path keeps state");

  log("PASS", "Republish state stays keyed by HTML file path");
} catch (e) {
  log("FAIL", "Republish state stays keyed by HTML file path", e.message);
}

// ── Summary ────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("\n" + results.length + " tests, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
