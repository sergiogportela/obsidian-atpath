#!/usr/bin/env node
// Playwright browser test: heading anchor navigation opens collapsed <details>.
//
// Run: node tests/heading-anchors-browser.spec.cjs

const assert = require("node:assert");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const { buildMainPage } = require("../src/html-builder.js");

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

async function main() {
  console.log("\nPlaywright: Heading Anchor Navigation\n");

  let chromium;
  try {
    chromium = require("playwright").chromium;
  } catch (e) {
    console.log("  (skipping — playwright not available)");
    process.exit(0);
  }

  // Build a test page with multiple headings (some collapsed)
  const markdown = `# Main Title

Some intro text.

## Resultados do Polling

Polling results content here.

### Sub Results

Nested content.

## Conclusão

Final thoughts.

## Resultados do Polling

Duplicate heading content.`;

  const html = buildMainPage("Test Page", markdown, new Map(), "", "", false);

  // Write to temp file
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atpath-anchor-"));
  const tmpFile = path.join(tmpDir, "test.html");
  await fs.writeFile(tmpFile, html);

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto("file://" + tmpFile);

    // ── Test 1: Headings have id attributes ───────────────────────
    try {
      const h1Id = await page.getAttribute("h1", "id");
      assert.ok(h1Id, "h1 has an id attribute");
      assert.strictEqual(h1Id, "main-title", "h1 id is slugified");

      const detailsIds = await page.$$eval("details[id]", els => els.map(e => e.id));
      assert.ok(detailsIds.includes("resultados-do-polling"), "First polling heading has id");
      assert.ok(detailsIds.includes("conclusao"), "Conclusão heading has id");
      assert.ok(detailsIds.includes("resultados-do-polling-2"), "Duplicate heading has -2 suffix");
      assert.ok(detailsIds.includes("sub-results"), "Sub results heading has id");

      log("PASS", "All headings have correct id attributes");
    } catch (e) {
      log("FAIL", "All headings have correct id attributes", e.message);
    }

    // ── Test 2: Details sections start collapsed ──────────────────
    try {
      const allOpen = await page.$$eval("details", els => els.map(e => e.open));
      assert.ok(allOpen.every(o => o === false), "All details start collapsed");

      log("PASS", "Details sections start collapsed");
    } catch (e) {
      log("FAIL", "Details sections start collapsed", e.message);
    }

    // ── Test 3: Navigate to hash → details opens ──────────────────
    try {
      await page.goto("file://" + tmpFile + "#resultados-do-polling");

      // Wait for the anchor JS to run
      await page.waitForTimeout(500);

      const isOpen = await page.$eval("#resultados-do-polling", el => el.open);
      assert.ok(isOpen, "Target details section is open after hash navigation");

      log("PASS", "Hash navigation opens target <details> section");
    } catch (e) {
      log("FAIL", "Hash navigation opens target <details> section", e.message);
    }

    // ── Test 4: Click internal anchor link → details opens ────────
    try {
      // Start fresh (all collapsed)
      await page.goto("file://" + tmpFile);
      await page.waitForTimeout(200);

      // Inject a test link that points to a heading
      await page.evaluate(() => {
        const link = document.createElement("a");
        link.href = "#conclusao";
        link.id = "test-link";
        link.textContent = "Go to Conclusão";
        document.querySelector(".container").prepend(link);
      });

      // Click the link
      await page.click("#test-link");
      await page.waitForTimeout(500);

      const isOpen = await page.$eval("#conclusao", el => el.open);
      assert.ok(isOpen, "Conclusão details opened after click");

      // Verify URL hash was updated
      const hash = await page.evaluate(() => location.hash);
      assert.strictEqual(hash, "#conclusao", "URL hash updated to #conclusao");

      log("PASS", "Click on anchor link opens <details> and updates URL hash");
    } catch (e) {
      log("FAIL", "Click on anchor link opens <details> and updates URL hash", e.message);
    }

    // ── Test 5: Nested details opens parent chain ─────────────────
    try {
      // Start fresh
      await page.goto("file://" + tmpFile);
      await page.waitForTimeout(200);

      // Navigate to the nested heading
      await page.evaluate(() => {
        history.pushState(null, "", "#sub-results");
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      await page.waitForTimeout(500);

      const subOpen = await page.$eval("#sub-results", el => el.open);
      assert.ok(subOpen, "Nested sub-results details is open");

      // Check that parent details is also open
      const parentOpen = await page.$eval("#resultados-do-polling", el => el.open);
      assert.ok(parentOpen, "Parent details (resultados-do-polling) also opened");

      log("PASS", "Nested anchor opens entire parent details chain");
    } catch (e) {
      log("FAIL", "Nested anchor opens entire parent details chain", e.message);
    }

    // ── Test 6: Duplicate heading anchor navigates correctly ──────
    try {
      // Navigate away first to ensure a full page reload
      await page.goto("about:blank");
      await page.goto("file://" + tmpFile + "#resultados-do-polling-2");
      await page.waitForTimeout(500);

      const isOpen = await page.$eval("#resultados-do-polling-2", el => el.open);
      assert.ok(isOpen, "Duplicate heading (with -2 suffix) opens correctly");

      // First one should NOT be open (different section)
      const firstOpen = await page.$eval("#resultados-do-polling", el => el.open);
      assert.ok(!firstOpen, "First instance stays closed when navigating to -2");

      log("PASS", "Duplicate heading with -2 suffix navigates correctly");
    } catch (e) {
      log("FAIL", "Duplicate heading with -2 suffix navigates correctly", e.message);
    }

    // ── Test 7: scrollIntoView is triggered ───────────────────────
    try {
      await page.goto("file://" + tmpFile);
      await page.waitForTimeout(200);

      // Monitor scrollIntoView calls
      const scrolled = await page.evaluate(() => {
        return new Promise((resolve) => {
          const target = document.getElementById("conclusao");
          if (!target) return resolve(false);
          const original = target.scrollIntoView;
          target.scrollIntoView = function() {
            resolve(true);
            target.scrollIntoView = original;
          };
          // Trigger navigation
          history.pushState(null, "", "#conclusao");
          window.dispatchEvent(new HashChangeEvent("hashchange"));
          // Timeout fallback
          setTimeout(() => resolve(false), 2000);
        });
      });

      assert.ok(scrolled, "scrollIntoView was called on target element");

      log("PASS", "scrollIntoView is triggered on anchor navigation");
    } catch (e) {
      log("FAIL", "scrollIntoView is triggered on anchor navigation", e.message);
    }

  } finally {
    await browser.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // ── Summary ──────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log("\n" + results.length + " tests, " + failed + " failed\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();
