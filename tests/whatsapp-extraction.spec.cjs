#!/usr/bin/env node
// Tests for WhatsApp phone extraction from contactUrl.
//
// Run: node tests/whatsapp-extraction.spec.cjs

const assert = require("node:assert");
const { buildAuthShell } = require("../src/auth-shell-builder.js");

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

console.log("\nWhatsApp Extraction + Auth Shell Tests\n");

// Helper: replicate the extraction logic from _executePublish
function extractWhatsApp(contactUrl) {
  const waMatch = contactUrl.match(/wa\.me\/(\d+)/);
  return waMatch ? waMatch[1] : "";
}

// ── Test 1: Extracts phone from wa.me URL ────────────────────────
try {
  assert.strictEqual(extractWhatsApp("https://wa.me/5511999999999"), "5511999999999");
  assert.strictEqual(extractWhatsApp("https://wa.me/5521987654321"), "5521987654321");
  assert.strictEqual(extractWhatsApp("http://wa.me/1234567890"), "1234567890");

  log("PASS", "Extracts phone from wa.me URLs");
} catch (e) {
  log("FAIL", "Extracts phone from wa.me URLs", e.message);
}

// ── Test 2: Returns empty for non-WhatsApp URLs ──────────────────
try {
  assert.strictEqual(extractWhatsApp("https://example.com"), "");
  assert.strictEqual(extractWhatsApp("mailto:user@example.com"), "");
  assert.strictEqual(extractWhatsApp(""), "");
  assert.strictEqual(extractWhatsApp("https://telegram.me/user"), "");

  log("PASS", "Returns empty for non-WhatsApp URLs");
} catch (e) {
  log("FAIL", "Returns empty for non-WhatsApp URLs", e.message);
}

// ── Test 3: Auth shell renders with extracted WhatsApp number ────
try {
  const html = buildAuthShell("Test Note", "pk_test_123", "test@example.com", "5511999999999");

  assert.ok(html.includes('"5511999999999"'), "WhatsApp number embedded in auth shell");
  assert.ok(html.includes("wa.me/"), "WhatsApp link logic present");
  assert.ok(html.includes("Solicitar acesso via WhatsApp"), "WhatsApp button text present");

  log("PASS", "Auth shell renders with WhatsApp number");
} catch (e) {
  log("FAIL", "Auth shell renders with WhatsApp number", e.message);
}

// ── Test 4: Auth shell works with empty WhatsApp ─────────────────
try {
  const html = buildAuthShell("Test Note", "pk_test_123", "test@example.com", "");

  assert.ok(html.includes('""'), "Empty WhatsApp variable");
  // WhatsApp button is conditional on publisherWhatsapp being truthy
  assert.ok(html.includes("if (publisherWhatsapp && approvalUrl)"), "WhatsApp conditional check present");

  log("PASS", "Auth shell works with empty WhatsApp (fallback to email)");
} catch (e) {
  log("FAIL", "Auth shell works with empty WhatsApp (fallback to email)", e.message);
}

// ── Test 5: Auth shell uses document.write for content delivery ───
try {
  const html = buildAuthShell("Test Note", "pk_test_123", "test@example.com", "");

  assert.ok(html.includes("document.write(html)"), "document.write present");
  assert.ok(html.includes("document.open()"), "document.open present");
  assert.ok(html.includes("document.close()"), "document.close present");
  assert.ok(!html.includes("content.innerHTML"), "no innerHTML assignment");

  log("PASS", "Auth shell uses document.write for content delivery");
} catch (e) {
  log("FAIL", "Auth shell uses document.write for content delivery", e.message);
}

// ── Test 6: Vercel.json rewrite pattern bypasses atpath/ ─────────
try {
  // Replicate the vercel.json rewrite from _executePublish
  const rewritePattern = "/((?!api/|atpath/).*)";
  const regex = new RegExp(rewritePattern.replace(/^\/(.*)\/$/, "$1").replace(/\(\?!/, "(?!"));

  // These should NOT match (bypass rewrite — served directly)
  assert.ok(!"api/auth.js".match(/^(?!api\/|atpath\/).*/), "api/ paths bypass rewrite");
  // Actually, let me test this differently — the rewrite source means
  // paths NOT starting with api/ or atpath/ get rewritten to /index.html
  // So atpath/myapp/style.css should NOT be rewritten
  const sourceRegex = /^((?!api\/|atpath\/).*)$/;
  assert.ok(!sourceRegex.test("api/auth.js"), "api/ path not rewritten");
  assert.ok(!sourceRegex.test("atpath/myapp/style.css"), "atpath/ static asset not rewritten");
  assert.ok(!sourceRegex.test("atpath/myapp/logo.png"), "atpath/ binary asset not rewritten");
  assert.ok(sourceRegex.test("some-page.html"), "Regular page IS rewritten to index.html");
  assert.ok(sourceRegex.test("nested/page"), "Nested page IS rewritten to index.html");

  log("PASS", "Vercel.json rewrite pattern bypasses api/ and atpath/");
} catch (e) {
  log("FAIL", "Vercel.json rewrite pattern bypasses api/ and atpath/", e.message);
}

// ── Summary ──────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("\n" + results.length + " tests, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
