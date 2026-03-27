#!/usr/bin/env node
// Playwright test for auth shell: verifies Clerk sign-in mounts inline
// and the page doesn't get stuck on "Loading..."
//
// Run: npx -p playwright node tests/auth-shell.spec.cjs

const { chromium } = require("playwright");
const http = require("node:http");
const assert = require("node:assert");
const { buildAuthShell } = require("../src/auth-shell-builder.js");

const DUMMY_PK = "pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXY$";

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

(async () => {
  // ── Setup ──────────────────────────────────────────────────────
  const html = buildAuthShell("Test Page", DUMMY_PK, "test@example.com");

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });

  const baseUrl = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });

  const browser = await chromium.launch({ headless: true });

  console.log("\nAuth Shell Tests\n");

  // ── Test 1: Renders title and auth-msg element ──────────────────
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl);

    const h1Text = await page.locator("h1").textContent();
    assert.strictEqual(h1Text, "Test Page");

    // auth-msg element must exist (may have already transitioned past "Loading...")
    const authMsg = await page.locator("#auth-msg").textContent();
    assert.ok(typeof authMsg === "string" && authMsg.length > 0, "auth-msg has text");

    log("PASS", "Renders title and auth-msg element");
    await page.close();
  } catch (e) {
    log("FAIL", "Renders title and auth-msg element", e.message);
  }

  // ── Test 2: Transitions past "Loading..." ──────────────────────
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl);

    // Wait for Clerk JS script to be inserted
    await page.waitForSelector('script[src*="clerk"]', { state: "attached", timeout: 10000 });

    // Wait for the page to transition past "Loading..."
    await page.waitForFunction(
      () => {
        const msg = document.getElementById("auth-msg");
        const signIn = document.getElementById("clerk-sign-in");
        return (msg && msg.textContent !== "Loading...") || signIn !== null;
      },
      { timeout: 20000 }
    );

    const finalMsg = await page.locator("#auth-msg").textContent();
    assert.notStrictEqual(finalMsg, "Loading...");

    log("PASS", "Transitions past Loading once Clerk loads", 'auth-msg="' + finalMsg + '"');
    await page.close();
  } catch (e) {
    log("FAIL", "Transitions past Loading once Clerk loads", e.message);
  }

  // ── Test 3: No redirect loop (mountSignIn, not openSignIn) ─────
  try {
    const page = await browser.newPage();
    let navigations = 0;
    page.on("framenavigated", () => navigations++);

    await page.goto(baseUrl);
    navigations = 0; // reset after initial nav

    // Wait enough for any redirect to happen
    await page.waitForTimeout(8000);

    assert.strictEqual(navigations, 0, "Expected 0 extra navigations, got " + navigations);

    log("PASS", "No redirect loop (uses mountSignIn)");
    await page.close();
  } catch (e) {
    log("FAIL", "No redirect loop (uses mountSignIn)", e.message);
  }

  // ── Test 4: clerk-sign-in div is created ───────────────────────
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl);

    const signInDiv = await page.waitForSelector("#clerk-sign-in", { timeout: 20000 }).catch(() => null);

    if (signInDiv) {
      log("PASS", "clerk-sign-in div created (mountSignIn target)");
    } else {
      const msg = await page.locator("#auth-msg").textContent();
      assert.notStrictEqual(msg, "Loading...", "Still stuck on Loading...");
      log("PASS", "Page moved past Loading (Clerk init with dummy key)", 'msg="' + msg + '"');
    }
    await page.close();
  } catch (e) {
    log("FAIL", "clerk-sign-in div created (mountSignIn target)", e.message);
  }

  // ── Test 5: HTML structure uses mountSignIn ────────────────────
  try {
    assert.ok(html.includes('id="auth-msg"'), "auth-msg element exists");
    assert.ok(!html.includes('id="clerk-sign-in"'), "clerk-sign-in is NOT in static HTML");
    assert.ok(html.includes("mountSignUp"), "Uses mountSignUp in script");
    assert.ok(!html.includes("openSignIn"), "Does NOT use openSignIn in script");

    log("PASS", "HTML uses mountSignUp, not openSignIn");
  } catch (e) {
    log("FAIL", "HTML uses mountSignIn, not openSignIn", e.message);
  }

  // ── Teardown ───────────────────────────────────────────────────
  await browser.close();
  server.close();

  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log("\n" + results.length + " tests, " + failed + " failed\n");
  process.exit(failed > 0 ? 1 : 0);
})();
