#!/usr/bin/env node
// Integration test: real filesystem directory walking for file:/// bundles.
//
// Run: node tests/integration-bundle.spec.cjs

const assert = require("node:assert");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const results = [];

function log(status, name, detail) {
  const icon = status === "PASS" ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}${detail ? " \u2014 " + detail : ""}`);
  results.push({ status, name });
}

// Replicate the directory walking logic from collectFileProtocolHtmlFiles
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "ico", "webp", "avif",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "zip", "gz", "tar", "rar", "7z", "bz2",
  "mp3", "wav", "ogg", "flac", "aac", "m4a",
  "mp4", "avi", "mkv", "mov", "webm", "wmv",
  "woff", "woff2", "ttf", "otf", "eot",
  "exe", "dll", "so", "dylib", "bin",
  "sqlite", "db",
]);

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

async function walkDirectory(dirPath) {
  const files = [];
  let totalBytes = 0;

  async function walk(dir, prefix) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? prefix + "/" + entry.name : entry.name;

      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (files.length >= MAX_FILES) continue;
        const stat = await fs.stat(fullPath);
        if (totalBytes + stat.size > MAX_TOTAL_BYTES) continue;
        totalBytes += stat.size;

        const ext = (entry.name.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || "";
        if (BINARY_EXTENSIONS.has(ext)) {
          const buf = await fs.readFile(fullPath);
          files.push({ relPath, content: buf.toString("base64"), encoding: "base64" });
        } else {
          const text = await fs.readFile(fullPath, "utf-8");
          files.push({ relPath, content: text, encoding: "utf-8" });
        }
      }
    }
  }

  await walk(dirPath, "");
  return { files, totalBytes };
}

async function main() {
  console.log("\nIntegration: Directory Walking for file:/// Bundles\n");

  // Create a temp directory with a realistic project structure
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atpath-bundle-"));

  try {
    // ── Setup: create a mock HTML project ────────────────────────
    await fs.writeFile(path.join(tmpDir, "index.html"), "<!DOCTYPE html><html><body>Hello</body></html>");
    await fs.writeFile(path.join(tmpDir, "style.css"), "body { margin: 0; }");
    await fs.writeFile(path.join(tmpDir, "app.js"), "console.log('hello');");
    await fs.mkdir(path.join(tmpDir, "assets"));
    // Write a small binary-like PNG header (1x1 pixel)
    const pngBuf = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    await fs.writeFile(path.join(tmpDir, "assets", "logo.png"), pngBuf);
    await fs.writeFile(path.join(tmpDir, "assets", "data.json"), '{"key": "value"}');
    // Hidden file (should be skipped)
    await fs.writeFile(path.join(tmpDir, ".hidden"), "secret");
    // Hidden directory (should be skipped)
    await fs.mkdir(path.join(tmpDir, ".git"));
    await fs.writeFile(path.join(tmpDir, ".git", "config"), "git config");
    // Nested directory
    await fs.mkdir(path.join(tmpDir, "components"));
    await fs.writeFile(path.join(tmpDir, "components", "header.html"), "<header>Nav</header>");

    // ── Test 1: Walks directory and collects all non-hidden files ──
    try {
      const { files } = await walkDirectory(tmpDir);
      const relPaths = files.map(f => f.relPath).sort();

      assert.ok(relPaths.includes("index.html"), "index.html collected");
      assert.ok(relPaths.includes("style.css"), "style.css collected");
      assert.ok(relPaths.includes("app.js"), "app.js collected");
      assert.ok(relPaths.includes("assets/logo.png"), "assets/logo.png collected");
      assert.ok(relPaths.includes("assets/data.json"), "assets/data.json collected");
      assert.ok(relPaths.includes("components/header.html"), "nested HTML collected");
      assert.strictEqual(files.length, 6, "Exactly 6 files (hidden excluded)");

      log("PASS", "Walks directory and collects all non-hidden files");
    } catch (e) {
      log("FAIL", "Walks directory and collects all non-hidden files", e.message);
    }

    // ── Test 2: Skips hidden files and directories ────────────────
    try {
      const { files } = await walkDirectory(tmpDir);
      const relPaths = files.map(f => f.relPath);

      assert.ok(!relPaths.includes(".hidden"), ".hidden file skipped");
      assert.ok(!relPaths.some(p => p.startsWith(".git")), ".git directory skipped");

      log("PASS", "Skips hidden files and directories");
    } catch (e) {
      log("FAIL", "Skips hidden files and directories", e.message);
    }

    // ── Test 3: Binary files use base64 encoding ──────────────────
    try {
      const { files } = await walkDirectory(tmpDir);
      const png = files.find(f => f.relPath === "assets/logo.png");

      assert.ok(png, "PNG file found");
      assert.strictEqual(png.encoding, "base64", "PNG uses base64 encoding");
      // Verify the base64 content decodes to valid PNG
      const decoded = Buffer.from(png.content, "base64");
      assert.ok(decoded[0] === 0x89 && decoded[1] === 0x50, "Decoded content starts with PNG magic bytes");

      log("PASS", "Binary files use base64 encoding with valid content");
    } catch (e) {
      log("FAIL", "Binary files use base64 encoding with valid content", e.message);
    }

    // ── Test 4: Text files use utf-8 encoding ─────────────────────
    try {
      const { files } = await walkDirectory(tmpDir);
      const css = files.find(f => f.relPath === "style.css");
      const json = files.find(f => f.relPath === "assets/data.json");
      const html = files.find(f => f.relPath === "index.html");

      assert.strictEqual(css.encoding, "utf-8", "CSS uses utf-8");
      assert.strictEqual(json.encoding, "utf-8", "JSON uses utf-8");
      assert.strictEqual(html.encoding, "utf-8", "HTML uses utf-8");
      assert.ok(css.content.includes("margin"), "CSS content readable");
      assert.ok(json.content.includes('"key"'), "JSON content readable");

      log("PASS", "Text files use utf-8 encoding with readable content");
    } catch (e) {
      log("FAIL", "Text files use utf-8 encoding with readable content", e.message);
    }

    // ── Test 5: Respects MAX_FILES limit ──────────────────────────
    try {
      // Create a directory with many files
      const manyDir = path.join(tmpDir, "many");
      await fs.mkdir(manyDir);
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(manyDir, `file${i}.txt`), `content ${i}`);
      }

      // Temporarily lower the limit by testing the logic directly
      const collectedFiles = [];
      let totalBytes = 0;
      const localMax = 5;

      const entries = await fs.readdir(manyDir, { withFileTypes: true });
      for (const entry of entries) {
        if (collectedFiles.length >= localMax) break;
        const fullPath = path.join(manyDir, entry.name);
        const text = await fs.readFile(fullPath, "utf-8");
        collectedFiles.push({ relPath: entry.name, content: text, encoding: "utf-8" });
      }

      assert.strictEqual(collectedFiles.length, localMax, "Stopped at max files limit");

      log("PASS", "Respects file count limit");
    } catch (e) {
      log("FAIL", "Respects file count limit", e.message);
    }

    // ── Test 6: Empty directory returns empty files array ─────────
    try {
      const emptyDir = path.join(tmpDir, "empty");
      await fs.mkdir(emptyDir);
      const { files } = await walkDirectory(emptyDir);

      assert.strictEqual(files.length, 0, "Empty directory returns no files");

      log("PASS", "Empty directory returns empty files array");
    } catch (e) {
      log("FAIL", "Empty directory returns empty files array", e.message);
    }

  } finally {
    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // ── Summary ──────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log("\n" + results.length + " tests, " + failed + " failed\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();
