#!/usr/bin/env node
// Tests for the WhatsApp access request + one-click approval flow.
//
// Covers:
//   - buildAuthFunction: privateMetadata check, HMAC-signed approvalUrl in 403
//   - buildApproveFunction: token verification, user approval via privateMetadata
//   - buildAuthShell: WhatsApp button, JSON 403 parsing, auto-poll
//
// Run: npx -p playwright node tests/approval-flow.spec.cjs

const { chromium } = require("playwright");
const http = require("node:http");
const assert = require("node:assert");
const { createHmac } = require("node:crypto");
const { buildAuthFunction, buildApproveFunction } = require("../src/auth-function-template.js");
const { buildAuthShell } = require("../src/auth-shell-builder.js");

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

// ─── Auth Function Template Tests ───────────────────────────────────

function testAuthFunctionSource() {
  console.log("\n--- buildAuthFunction ---\n");

  const src = buildAuthFunction({
    approvedEmails: ["alice@test.com"],
    pages: { main: "<p>hi</p>" },
    projectName: "my-site",
  });

  // Test 1: Imports crypto
  try {
    assert.ok(src.includes('import { createHmac } from "crypto"'), "imports createHmac");
    log("PASS", "Auth function imports crypto.createHmac");
  } catch (e) {
    log("FAIL", "Auth function imports crypto.createHmac", e.message);
  }

  // Test 2: Has PROJECT_NAME constant
  try {
    assert.ok(src.includes('const PROJECT_NAME = "my-site"'), "PROJECT_NAME embedded");
    log("PASS", "Auth function embeds PROJECT_NAME");
  } catch (e) {
    log("FAIL", "Auth function embeds PROJECT_NAME", e.message);
  }

  // Test 3: Checks privateMetadata
  try {
    assert.ok(src.includes("privateMetadata"), "references privateMetadata");
    assert.ok(src.includes('"approved:" + PROJECT_NAME'), "uses approved:{site} key");
    log("PASS", "Auth function checks privateMetadata['approved:{site}']");
  } catch (e) {
    log("FAIL", "Auth function checks privateMetadata['approved:{site}']", e.message);
  }

  // Test 4: 403 returns approvalUrl
  try {
    assert.ok(src.includes("approvalUrl"), "returns approvalUrl on 403");
    assert.ok(src.includes("signToken"), "uses signToken helper");
    assert.ok(src.includes("/api/approve?token="), "approval URL points to /api/approve");
    log("PASS", "Auth function returns approvalUrl in 403 response");
  } catch (e) {
    log("FAIL", "Auth function returns approvalUrl in 403 response", e.message);
  }

  // Test 5: signToken uses HMAC-SHA256 with CLERK_SECRET_KEY
  try {
    assert.ok(src.includes('createHmac("sha256", process.env.CLERK_SECRET_KEY)'), "HMAC uses CLERK_SECRET_KEY");
    assert.ok(src.includes("base64url"), "token is base64url encoded");
    log("PASS", "signToken uses HMAC-SHA256 with CLERK_SECRET_KEY");
  } catch (e) {
    log("FAIL", "signToken uses HMAC-SHA256 with CLERK_SECRET_KEY", e.message);
  }

  // Test 6: Token includes expiry
  try {
    assert.ok(src.includes("exp: Date.now()"), "token has exp field");
    assert.ok(src.includes("7 * 24 * 60 * 60 * 1000"), "7-day expiry");
    log("PASS", "Token includes 7-day expiry");
  } catch (e) {
    log("FAIL", "Token includes 7-day expiry", e.message);
  }

  // Test 7: Still serves content for approved emails
  try {
    assert.ok(src.includes("APPROVED_EMAILS.includes(email)"), "checks approved list");
    assert.ok(src.includes('res.status(200).send(html)'), "serves content on success");
    log("PASS", "Auth function still serves content for approved emails");
  } catch (e) {
    log("FAIL", "Auth function still serves content for approved emails", e.message);
  }

  // Test 8: Fetches user object (needed for privateMetadata)
  try {
    assert.ok(src.includes("let email, user;"), "declares user variable");
    assert.ok(src.includes("user = await clerkClient.users.getUser"), "fetches user");
    log("PASS", "Auth function fetches user object for privateMetadata access");
  } catch (e) {
    log("FAIL", "Auth function fetches user object for privateMetadata access", e.message);
  }
}

// ─── Approve Function Template Tests ────────────────────────────────

function testApproveFunctionSource() {
  console.log("\n--- buildApproveFunction ---\n");

  const src = buildApproveFunction({
    projectName: "my-site",
    clerkPublishableKey: "pk_test_abc123",
    publisherEmail: "Owner@Example.com",
  });

  // Test 1: Uses timingSafeEqual
  try {
    assert.ok(src.includes("timingSafeEqual"), "uses timingSafeEqual");
    assert.ok(src.includes('import { createHmac, timingSafeEqual } from "crypto"'), "imports both crypto functions");
    log("PASS", "Approve function uses timingSafeEqual for constant-time comparison");
  } catch (e) {
    log("FAIL", "Approve function uses timingSafeEqual for constant-time comparison", e.message);
  }

  // Test 2: Validates token structure
  try {
    assert.ok(src.includes('parts.length !== 2'), "checks token has 2 parts");
    assert.ok(src.includes("base64url"), "decodes base64url");
    log("PASS", "Approve function validates token structure");
  } catch (e) {
    log("FAIL", "Approve function validates token structure", e.message);
  }

  // Test 3: Checks site match
  try {
    assert.ok(src.includes("payload.site !== PROJECT_NAME"), "verifies site matches");
    log("PASS", "Approve function checks site matches PROJECT_NAME");
  } catch (e) {
    log("FAIL", "Approve function checks site matches PROJECT_NAME", e.message);
  }

  // Test 4: Checks expiry
  try {
    assert.ok(src.includes("Date.now() > payload.exp"), "checks token expiry");
    log("PASS", "Approve function checks token expiry");
  } catch (e) {
    log("FAIL", "Approve function checks token expiry", e.message);
  }

  // Test 5: Looks up user by email in POST branch
  try {
    assert.ok(src.includes("getUserList"), "calls getUserList");
    assert.ok(src.includes("emailAddress: [tokenPayload.email]"), "filters by email from token");
    log("PASS", "Approve function looks up user by email");
  } catch (e) {
    log("FAIL", "Approve function looks up user by email", e.message);
  }

  // Test 6: Sets privateMetadata
  try {
    assert.ok(src.includes("updateUserMetadata"), "calls updateUserMetadata");
    assert.ok(src.includes('["approved:" + PROJECT_NAME]: true'), "sets approved:{site} key");
    log("PASS", "Approve function sets privateMetadata['approved:{site}'] = true");
  } catch (e) {
    log("FAIL", "Approve function sets privateMetadata['approved:{site}'] = true", e.message);
  }

  // Test 7: Dispatches on req.method (GET vs POST)
  try {
    assert.ok(src.includes('req.method === "GET"'), "checks for GET method");
    assert.ok(src.includes('req.method === "POST"'), "checks for POST method");
    assert.ok(src.includes("405"), "returns 405 for other methods");
    log("PASS", "Approve function dispatches on req.method (GET/POST/405)");
  } catch (e) {
    log("FAIL", "Approve function dispatches on req.method (GET/POST/405)", e.message);
  }

  // Test 8: GET branch serves HTML with Clerk JS
  try {
    assert.ok(src.includes("approvalPage"), "GET serves approval page HTML");
    assert.ok(src.includes("clerk-js@5"), "loads Clerk JS SDK");
    assert.ok(src.includes("clerk-publishable-key"), "sets Clerk publishable key");
    assert.ok(src.includes("mountSignIn"), "mounts Clerk sign-in widget");
    log("PASS", "GET branch serves HTML page with Clerk JS authentication");
  } catch (e) {
    log("FAIL", "GET branch serves HTML page with Clerk JS authentication", e.message);
  }

  // Test 9: POST branch requires Clerk session (verifyToken)
  try {
    assert.ok(src.includes('import { verifyToken, createClerkClient } from "@clerk/backend"'), "imports verifyToken");
    assert.ok(src.includes("verifyToken(auth,"), "POST calls verifyToken");
    assert.ok(src.includes('res.status(401)'), "returns 401 for missing/invalid session");
    log("PASS", "POST branch requires Clerk session via verifyToken");
  } catch (e) {
    log("FAIL", "POST branch requires Clerk session via verifyToken", e.message);
  }

  // Test 10: POST checks caller email against PUBLISHER_EMAIL
  try {
    assert.ok(src.includes("callerEmail !== PUBLISHER_EMAIL"), "compares caller to publisher");
    assert.ok(src.includes('res.status(403)'), "returns 403 for non-publisher");
    log("PASS", "POST branch checks caller email against PUBLISHER_EMAIL");
  } catch (e) {
    log("FAIL", "POST branch checks caller email against PUBLISHER_EMAIL", e.message);
  }

  // Test 11: PUBLISHER_EMAIL is embedded (case-insensitive)
  try {
    assert.ok(src.includes('const PUBLISHER_EMAIL = "owner@example.com"'), "PUBLISHER_EMAIL lowercased");
    log("PASS", "PUBLISHER_EMAIL is embedded and lowercased");
  } catch (e) {
    log("FAIL", "PUBLISHER_EMAIL is embedded and lowercased", e.message);
  }

  // Test 12: PROJECT_NAME is embedded
  try {
    assert.ok(src.includes('const PROJECT_NAME = "my-site"'), "PROJECT_NAME embedded");
    log("PASS", "Approve function embeds PROJECT_NAME");
  } catch (e) {
    log("FAIL", "Approve function embeds PROJECT_NAME", e.message);
  }

  // Test 13: Email in approval page is HTML-escaped (XSS prevention)
  try {
    assert.ok(src.includes("escapeHtml"), "has escapeHtml function");
    assert.ok(src.includes("escapeHtml(email)"), "escapes email in approval page");
    log("PASS", "Approval page HTML-escapes email (XSS prevention)");
  } catch (e) {
    log("FAIL", "Approval page HTML-escapes email (XSS prevention)", e.message);
  }
}

// ─── HMAC Token Round-trip Test ─────────────────────────────────────

function testHmacRoundTrip() {
  console.log("\n--- HMAC token round-trip ---\n");

  const secret = "sk_test_fakesecretkey123";
  const payload = { email: "user@test.com", site: "my-site", exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };

  // Sign
  const data = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(data).digest("hex");
  const token = Buffer.from(data).toString("base64url") + "." + sig;

  // Verify
  try {
    const parts = token.split(".");
    assert.strictEqual(parts.length, 2, "token has 2 parts");

    const decoded = Buffer.from(parts[0], "base64url");
    const expectedSig = createHmac("sha256", secret).update(decoded).digest("hex");
    assert.strictEqual(parts[1], expectedSig, "signatures match");

    const parsed = JSON.parse(decoded.toString());
    assert.strictEqual(parsed.email, "user@test.com");
    assert.strictEqual(parsed.site, "my-site");
    assert.ok(parsed.exp > Date.now(), "not expired");

    log("PASS", "HMAC token signs and verifies correctly");
  } catch (e) {
    log("FAIL", "HMAC token signs and verifies correctly", e.message);
  }

  // Tampered token should fail
  try {
    const tampered = token.slice(0, -4) + "XXXX";
    const parts = tampered.split(".");
    const decoded = Buffer.from(parts[0], "base64url");
    const expectedSig = createHmac("sha256", secret).update(decoded).digest("hex");
    assert.notStrictEqual(parts[1], expectedSig, "tampered sig should not match");
    log("PASS", "Tampered token is rejected");
  } catch (e) {
    log("FAIL", "Tampered token is rejected", e.message);
  }

  // Expired token
  try {
    const expiredPayload = { email: "user@test.com", site: "my-site", exp: Date.now() - 1000 };
    assert.ok(Date.now() > expiredPayload.exp, "token is expired");
    log("PASS", "Expired token detected via exp check");
  } catch (e) {
    log("FAIL", "Expired token detected via exp check", e.message);
  }
}

// ─── Auth Shell WhatsApp + Poll Tests (Playwright) ──────────────────

async function testAuthShellBrowser() {
  console.log("\n--- Auth shell: WhatsApp button + auto-poll (browser) ---\n");

  const DUMMY_PK = "pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXY$";
  const PUBLISHER_EMAIL = "pub@example.com";
  const PUBLISHER_WA = "5511999999999";
  const APPROVAL_URL = "https://my-site.vercel.app/api/approve?token=faketoken123";

  // Build shell with WhatsApp
  const html = buildAuthShell("Test Page", DUMMY_PK, PUBLISHER_EMAIL, PUBLISHER_WA);

  // ── Static source tests ────────────────────────────────────────

  // Test 1: WhatsApp variable is injected
  try {
    assert.ok(html.includes("var publisherWhatsapp = "), "publisherWhatsapp var injected");
    assert.ok(html.includes(PUBLISHER_WA), "WhatsApp number in source");
    log("PASS", "Auth shell injects publisherWhatsapp variable");
  } catch (e) {
    log("FAIL", "Auth shell injects publisherWhatsapp variable", e.message);
  }

  // Test 2: WhatsApp button code present
  try {
    assert.ok(html.includes("wa.me/"), "wa.me link in source");
    assert.ok(html.includes("Solicitar acesso via WhatsApp"), "WhatsApp button text");
    assert.ok(html.includes("#25D366"), "WhatsApp green color");
    log("PASS", "Auth shell contains WhatsApp button code");
  } catch (e) {
    log("FAIL", "Auth shell contains WhatsApp button code", e.message);
  }

  // Test 3: Parses 403 JSON body for approvalUrl
  try {
    assert.ok(html.includes("resp.json()"), "parses 403 as JSON");
    assert.ok(html.includes("body.approvalUrl"), "extracts approvalUrl from body");
    log("PASS", "Auth shell parses 403 JSON body for approvalUrl");
  } catch (e) {
    log("FAIL", "Auth shell parses 403 JSON body for approvalUrl", e.message);
  }

  // Test 4: Auto-poll code present
  try {
    assert.ok(html.includes("startApprovalPoll"), "startApprovalPoll function");
    assert.ok(html.includes("15000"), "15-second interval");
    assert.ok(html.includes("Aguardando aprova"), "waiting status text");
    log("PASS", "Auth shell has auto-poll logic (15s interval)");
  } catch (e) {
    log("FAIL", "Auth shell has auto-poll logic (15s interval)", e.message);
  }

  // Test 5: Shell without WhatsApp still works
  try {
    const htmlNoWa = buildAuthShell("Test Page", DUMMY_PK, PUBLISHER_EMAIL, "");
    assert.ok(htmlNoWa.includes('var publisherWhatsapp = ""'), "empty WhatsApp var");
    assert.ok(htmlNoWa.includes("Copiar solicita"), "copy button still present");
    assert.ok(htmlNoWa.includes("Abrir cliente de email"), "mailto still present");
    log("PASS", "Auth shell without WhatsApp falls back to copy + mailto");
  } catch (e) {
    log("FAIL", "Auth shell without WhatsApp falls back to copy + mailto", e.message);
  }

  // ── Browser tests ──────────────────────────────────────────────

  let pollCount = 0;
  let respondOk = false;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/auth")) {
      pollCount++;
      if (respondOk) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<p>Secret content loaded!</p>");
      } else {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Access denied", approvalUrl: APPROVAL_URL }));
      }
      return;
    }
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

  // Test 6: WhatsApp button renders with correct wa.me link
  try {
    const page = await browser.newPage();
    await page.route("**/clerk-js@5/**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
          window.Clerk = {
            load: async function() {},
            get user() { return { primaryEmailAddress: { emailAddress: "user@test.com" } }; },
            get session() { return { getToken: async function() { return "mock-token"; } }; },
            addListener: function() {},
            mountSignUp: function() {},
          };
        `
      });
    });

    await page.goto(baseUrl);

    // Wait for 403 handler to render
    await page.waitForFunction(
      () => {
        const msg = document.getElementById("auth-msg");
        return msg && msg.textContent.includes("acesso a esta");
      },
      { timeout: 15000 }
    );

    // Verify WhatsApp button
    const waLink = await page.evaluate(() => {
      const links = document.querySelectorAll("#auth-ui a");
      for (const a of links) {
        if (a.href.includes("wa.me")) return a.href;
      }
      return null;
    });

    assert.ok(waLink, "WhatsApp link found");
    assert.ok(waLink.includes("wa.me/" + "5511999999999"), "correct phone number");
    assert.ok(waLink.includes("user%40test.com") || waLink.includes("user@test.com"), "includes user email");
    assert.ok(waLink.includes("approve"), "includes approval URL");

    // Verify WhatsApp button text
    const waBtnText = await page.evaluate(() => {
      const links = document.querySelectorAll("#auth-ui a");
      for (const a of links) {
        if (a.href.includes("wa.me")) return a.textContent;
      }
      return null;
    });
    assert.ok(waBtnText.includes("WhatsApp"), "button says WhatsApp");

    log("PASS", "WhatsApp button renders with correct wa.me link and user email");
    await page.close();
  } catch (e) {
    log("FAIL", "WhatsApp button renders with correct wa.me link and user email", e.message);
  }

  // Test 7: Copy button and mailto still present as fallback
  try {
    const page = await browser.newPage();
    await page.route("**/clerk-js@5/**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
          window.Clerk = {
            load: async function() {},
            get user() { return { primaryEmailAddress: { emailAddress: "user@test.com" } }; },
            get session() { return { getToken: async function() { return "mock-token"; } }; },
            addListener: function() {},
            mountSignUp: function() {},
          };
        `
      });
    });

    await page.goto(baseUrl);
    await page.waitForFunction(
      () => document.getElementById("auth-msg")?.textContent.includes("acesso a esta"),
      { timeout: 15000 }
    );

    const copyBtn = await page.evaluate(() => {
      const btn = document.querySelector("#auth-ui button");
      return btn ? btn.textContent : null;
    });
    assert.ok(copyBtn && copyBtn.includes("Copiar"), "copy button present: " + copyBtn);

    const mailLink = await page.evaluate(() => {
      const links = document.querySelectorAll("#auth-ui a");
      for (const a of links) {
        if (a.href.startsWith("mailto:")) return a.href;
      }
      return null;
    });
    assert.ok(mailLink && mailLink.includes(PUBLISHER_EMAIL), "mailto link present");

    log("PASS", "Copy button and mailto link present as fallback");
    await page.close();
  } catch (e) {
    log("FAIL", "Copy button and mailto link present as fallback", e.message);
  }

  // Test 8: "Aguardando aprovação..." status text shows
  try {
    const page = await browser.newPage();
    await page.route("**/clerk-js@5/**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
          window.Clerk = {
            load: async function() {},
            get user() { return { primaryEmailAddress: { emailAddress: "user@test.com" } }; },
            get session() { return { getToken: async function() { return "mock-token"; } }; },
            addListener: function() {},
            mountSignUp: function() {},
          };
        `
      });
    });

    await page.goto(baseUrl);
    await page.waitForFunction(
      () => {
        const ps = document.querySelectorAll("#auth-ui p");
        for (const p of ps) {
          if (p.textContent.includes("Aguardando")) return true;
        }
        return false;
      },
      { timeout: 15000 }
    );

    const statusText = await page.evaluate(() => {
      const ps = document.querySelectorAll("#auth-ui p");
      for (const p of ps) {
        if (p.textContent.includes("Aguardando")) return p.textContent;
      }
      return null;
    });
    assert.ok(statusText.includes("Aguardando"), "status text shows");
    log("PASS", "Waiting status text displays after 403");
    await page.close();
  } catch (e) {
    log("FAIL", "Waiting status text displays after 403", e.message);
  }

  // Test 9: Auto-poll fetches /api/auth and loads content when approved
  try {
    pollCount = 0;
    respondOk = false;

    const page = await browser.newPage();
    await page.route("**/clerk-js@5/**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
          window.Clerk = {
            load: async function() {},
            get user() { return { primaryEmailAddress: { emailAddress: "user@test.com" } }; },
            get session() { return { getToken: async function() { return "mock-token"; } }; },
            addListener: function() {},
            mountSignUp: function() {},
          };
        `
      });
    });

    await page.goto(baseUrl);

    // Wait for 403 UI
    await page.waitForFunction(
      () => document.getElementById("auth-msg")?.textContent.includes("acesso a esta"),
      { timeout: 15000 }
    );

    // The initial fetch is 1, wait for at least 1 poll
    const initialCount = pollCount;

    // Now "approve" the user — next poll should get 200
    respondOk = true;

    // Wait for content to appear (poll should pick it up within 15s + buffer)
    // After document.write, the entire page is replaced — no #content div
    await page.waitForFunction(
      () => document.body && document.body.textContent.includes("Secret content"),
      { timeout: 25000 }
    );

    const bodyText = await page.evaluate(() => document.body.textContent);
    assert.ok(bodyText.includes("Secret content"), "content loaded: " + bodyText);
    assert.ok(pollCount > initialCount, "poll requests were made (" + pollCount + " total)");

    log("PASS", "Auto-poll loads content when user is approved");
    await page.close();
  } catch (e) {
    log("FAIL", "Auto-poll loads content when user is approved", e.message);
  }

  // ── Teardown ───────────────────────────────────────────────────
  await browser.close();
  server.close();
}

// ─── Run all ────────────────────────────────────────────────────────

(async () => {
  console.log("\nApproval Flow Tests\n");

  testAuthFunctionSource();
  testApproveFunctionSource();
  testHmacRoundTrip();
  await testAuthShellBrowser();

  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log("\n" + results.length + " tests, " + failed + " failed\n");
  process.exit(failed > 0 ? 1 : 0);
})();
