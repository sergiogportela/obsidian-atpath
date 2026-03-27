#!/usr/bin/env node
// Playwright test for auth shell 403 handler:
// Verifies publisher email display, copy button, and mailto fallback.
//
// Run: npx -p playwright node tests/auth-shell-403.spec.cjs

const { chromium } = require("playwright");
const http = require("node:http");
const assert = require("node:assert");
const { buildAuthShell } = require("../src/auth-shell-builder.js");

const DUMMY_PK = "pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXY$";
const PUBLISHER_EMAIL = "publisher@example.com";

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

(async () => {
  const html = buildAuthShell("Test Page", DUMMY_PK, PUBLISHER_EMAIL);

  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/auth")) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
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

  console.log("\nAuth Shell 403 Tests\n");

  // Helper: set up a page with mocked Clerk that triggers fetchContent → 403
  async function setup403Page() {
    const page = await browser.newPage();

    // Block real Clerk CDN — we'll inject a mock
    await page.route("**/clerk-js@5/**", (route) => route.abort());

    await page.goto(baseUrl);

    // Inject mock Clerk that simulates a signed-in user
    await page.evaluate(() => {
      window.Clerk = {
        load: async function() {},
        user: {
          primaryEmailAddress: { emailAddress: "user@test.com" }
        },
        session: {
          getToken: async function() { return "mock-token"; }
        },
        addListener: function() {},
        mountSignUp: function() {},
      };
    });

    // Trigger initClerk manually (since we blocked CDN script.onload)
    await page.evaluate(() => {
      // Find and call initClerk by re-running the auth flow with our mock
      const clerk = window.Clerk;
      const authUI = document.getElementById("auth-ui");
      const authMsg = document.getElementById("auth-msg");

      async function fetchContent() {
        authMsg.textContent = "Verificando acesso...";
        const token = await clerk.session.getToken();
        const resp = await fetch("/api/auth?page=main", {
          headers: { Authorization: "Bearer " + token }
        });

        if (resp.status === 403) {
          const email = (clerk.user.primaryEmailAddress && clerk.user.primaryEmailAddress.emailAddress) || "";
          authMsg.textContent = "Você não tem acesso a esta página.";

          // The actual 403 handler code is in the HTML — we need to trigger it
          // Instead, we'll dispatch a custom event
          window._403triggered = true;
        }
      }

      return fetchContent();
    });

    return page;
  }

  // ── Test 1: HTML structure has no innerHTML in 403 block ─────────
  try {
    // The 403 handler should use textContent, not innerHTML
    assert.ok(!html.includes("authMsg.innerHTML"), "403 block does NOT use innerHTML");
    assert.ok(html.includes("authMsg.textContent = 'Voc"), "403 block uses textContent");
    log("PASS", "403 handler uses textContent, not innerHTML");
  } catch (e) {
    log("FAIL", "403 handler uses textContent, not innerHTML", e.message);
  }

  // ── Test 2: Copy button exists in generated HTML ────────────────
  try {
    assert.ok(html.includes("Copiar solicita"), "Copy button text present");
    assert.ok(html.includes("navigator.clipboard.writeText"), "Uses clipboard API");
    assert.ok(html.includes("fallbackCopy"), "Has fallback copy function");
    log("PASS", "Copy button and clipboard logic present in HTML");
  } catch (e) {
    log("FAIL", "Copy button and clipboard logic present in HTML", e.message);
  }

  // ── Test 3: Publisher email is shown via textContent ─────────────
  try {
    assert.ok(html.includes("Entre em contato:"), "Email label text present");
    assert.ok(html.includes("emailLabel.textContent"), "Email set via textContent");
    log("PASS", "Publisher email displayed via textContent");
  } catch (e) {
    log("FAIL", "Publisher email displayed via textContent", e.message);
  }

  // ── Test 4: Mailto link present as secondary option ─────────────
  try {
    assert.ok(html.includes("Abrir cliente de email"), "Mailto link text present");
    assert.ok(html.includes("mailLink.href = 'mailto:'"), "Mailto href constructed");
    log("PASS", "Mailto link available as secondary option");
  } catch (e) {
    log("FAIL", "Mailto link available as secondary option", e.message);
  }

  // ── Test 5: fallbackCopy uses execCommand('copy') ───────────────
  try {
    assert.ok(html.includes("document.execCommand('copy')"), "execCommand fallback present");
    assert.ok(html.includes("Copiado!"), "Success feedback text present");
    log("PASS", "Fallback copy uses execCommand");
  } catch (e) {
    log("FAIL", "Fallback copy uses execCommand", e.message);
  }

  // ── Test 6: Browser-based 403 flow renders all elements ─────────
  try {
    const page = await browser.newPage();
    await page.route("**/clerk-js@5/**", (route) => {
      // Serve a minimal script that sets window.Clerk mock
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
          window.Clerk = {
            load: async function(opts) {},
            get user() { return { primaryEmailAddress: { emailAddress: "user@test.com" } }; },
            get session() { return { getToken: async function() { return "mock-token"; } }; },
            addListener: function(cb) {},
            mountSignUp: function() {},
          };
        `
      });
    });

    await page.goto(baseUrl);

    // Wait for the 403 handler to render — it will fetch /api/auth → 403
    await page.waitForFunction(
      () => {
        const msg = document.getElementById("auth-msg");
        return msg && msg.textContent.includes("acesso a esta");
      },
      { timeout: 15000 }
    );

    // Verify publisher email is visible
    const emailText = await page.evaluate(() => {
      const ps = document.querySelectorAll("#auth-ui p");
      for (const p of ps) {
        if (p.textContent.includes("contato")) return p.textContent;
      }
      return null;
    });
    assert.ok(emailText && emailText.includes(PUBLISHER_EMAIL), "Publisher email visible: " + emailText);

    // Verify copy button exists
    const copyBtnText = await page.evaluate(() => {
      const btn = document.querySelector("#auth-ui button");
      return btn ? btn.textContent : null;
    });
    assert.ok(copyBtnText && copyBtnText.includes("Copiar"), "Copy button text: " + copyBtnText);

    // Verify mailto link exists as secondary
    const mailHref = await page.evaluate(() => {
      const links = document.querySelectorAll("#auth-ui a");
      for (const a of links) {
        if (a.href.startsWith("mailto:")) return a.href;
      }
      return null;
    });
    assert.ok(mailHref && mailHref.includes(PUBLISHER_EMAIL), "Mailto link present: " + mailHref);

    log("PASS", "Browser 403 flow renders email, copy button, and mailto link");
    await page.close();
  } catch (e) {
    log("FAIL", "Browser 403 flow renders email, copy button, and mailto link", e.message);
  }

  // ── Teardown ───────────────────────────────────────────────────
  await browser.close();
  server.close();

  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log("\n" + results.length + " tests, " + failed + " failed\n");
  process.exit(failed > 0 ? 1 : 0);
})();
