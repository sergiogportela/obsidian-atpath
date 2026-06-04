"use strict";
// Replicates getFolderTokens (src/atpath-core.js:178-254) as faithfully as
// possible OUTSIDE Obsidian, to measure the synchronous gpt-tokenizer encode
// cost that fires when an @path crosses a folder boundary in the editor.
//
// Faithful to the plugin:
//   - walk ALL files under the folder (not just .md) — core.js:203
//   - skip files > maxFileSizeMB (default 5MB)                — core.js:205
//   - if (#files-under-cap) > maxFolderFiles (default 500) -> overCap, encode 0
//   - else encode(content) per file, batchSize=1 with a macrotask yield between
//   - getFileTokens -> getTokenCount -> cachedRead(text) -> encode(content)
//
// Run: node _work_units/atpath_codeblock_freeze/scripts/measure_folder_encode.js
const fs = require("fs");
const path = require("path");
const { encode } = require("gpt-tokenizer/model/gpt-4o");

const MAX_FILE_BYTES = 5 * 1024 * 1024; // settings.maxFileSizeMB default 5
const MAX_FOLDER_FILES = 500; // settings.maxFolderFiles default

// The plugin's actual denylist (src/main.js:140-149). getTokenCount returns
// null for these BEFORE encoding (line 2485). NOTE: no "heic" / "heif".
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

const VAULT_REPO =
  "/Users/sergio/Library/Mobile Documents/iCloud~md~obsidian/Documents/arbi_shared/_repos/colm-as-kedro";
const TARGETS = [
  "_work_units/ai_dev",
  "_work_units/ai_dev/agent_orchestrator",
  "_work_units/ai_dev/agent_orchestrator/findings",
];

function walkFiles(root) {
  const out = [];
  (function rec(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(p);
    }
  })(root);
  return out;
}

function measure(folderAbs, label) {
  const all = walkFiles(folderAbs);
  // Apply the size cap exactly as the plugin does (skip > MAX_FILE_BYTES).
  const underCap = [];
  let skippedBig = 0;
  let unreadable = 0;
  for (const p of all) {
    let sz;
    try {
      sz = fs.statSync(p).size;
    } catch (e) {
      unreadable++;
      continue;
    }
    if (sz > MAX_FILE_BYTES) {
      skippedBig++;
      continue;
    }
    underCap.push(p);
  }

  const overCap = underCap.length > MAX_FOLDER_FILES;

  // Pre-read content (NOT timed) so we time only encode(), matching the
  // plugin where cachedRead is async/cached and encode() is the CPU burn.
  const contents = [];
  for (const p of underCap) {
    try {
      contents.push(fs.readFileSync(p, "utf8"));
    } catch (e) {
      unreadable++;
    }
  }

  // Text extensions a token-count feature legitimately wants to encode.
  const TEXT_EXT = new Set([
    "md", "markdown", "txt", "text", "csv", "tsv", "json", "yaml", "yml",
    "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
    "c", "h", "cpp", "hpp", "css", "scss", "html", "xml", "toml", "ini",
    "sh", "bash", "zsh", "sql", "log", "org", "rst",
  ]);
  const extOf = (p) => {
    const b = path.basename(p);
    const i = b.lastIndexOf(".");
    return i > 0 ? b.slice(i + 1).toLowerCase() : "";
  };

  let totalTokens = 0;
  let totalBytes = 0;
  let maxFileMs = 0;
  let maxFileName = "";
  let textOnlyMs = 0;
  let textOnlyBytes = 0;
  let textOnlyTokens = 0;
  let curPluginMs = 0; // ACTUAL plugin: all files NOT in BINARY_EXTENSIONS
  let curPluginMaxMs = 0;
  let curPluginMaxName = "";
  const perFileMs = [];
  const byExt = new Map(); // ext -> {ms, bytes, n}
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i];
    const bytes = Buffer.byteLength(c, "utf8");
    totalBytes += bytes;
    const f0 = process.hrtime.bigint();
    const tok = encode(c).length;
    const ms = Number(process.hrtime.bigint() - f0) / 1e6;
    totalTokens += tok;
    perFileMs.push(ms);
    const ext = extOf(underCap[i]) || "(none)";
    const agg = byExt.get(ext) || { ms: 0, bytes: 0, n: 0 };
    agg.ms += ms; agg.bytes += bytes; agg.n += 1;
    byExt.set(ext, agg);
    if (TEXT_EXT.has(ext)) {
      textOnlyMs += ms; textOnlyBytes += bytes; textOnlyTokens += tok;
    }
    if (!BINARY_EXTENSIONS.has(ext)) {
      curPluginMs += ms;
      if (ms > curPluginMaxMs) { curPluginMaxMs = ms; curPluginMaxName = path.basename(underCap[i]); }
    }
    if (ms > maxFileMs) {
      maxFileMs = ms;
      maxFileName = path.basename(underCap[i]);
    }
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;

  perFileMs.sort((a, b) => a - b);
  const pct = (q) =>
    perFileMs.length ? perFileMs[Math.floor((perFileMs.length - 1) * q)] : 0;

  console.log(`\n=== ${label} ===`);
  console.log(`  files on disk:        ${all.length}`);
  console.log(`  skipped (>5MB):       ${skippedBig}`);
  console.log(`  unreadable/evicted:   ${unreadable}`);
  console.log(`  files under cap:      ${underCap.length}`);
  console.log(
    `  OVER maxFolderFiles?  ${overCap} (cap=${MAX_FOLDER_FILES}) ${
      overCap ? "-> plugin encodes 0 (overCap sentinel)" : "-> plugin encodes ALL below"
    }`
  );
  if (overCap) return;
  console.log(`  naive all-files:      ${totalMs.toFixed(0)} ms, ${totalTokens.toLocaleString()} tok (includes denylisted types — NOT what the plugin does)`);
  console.log(`  >> ACTUAL plugin now: ${curPluginMs.toFixed(0)} ms  (encodes everything NOT in BINARY_EXTENSIONS; heic is NOT denylisted) <<`);
  console.log(`     worst file (now):  ${curPluginMaxName} (${curPluginMaxMs.toFixed(1)} ms synchronous block)`);
  console.log(`  per-file p50/p95/max: ${pct(0.5).toFixed(1)} / ${pct(0.95).toFixed(1)} / ${maxFileMs.toFixed(1)} ms`);
  console.log(`  --- TEXT-ONLY (proposed fix: encode only text extensions) ---`);
  console.log(`    bytes:  ${(textOnlyBytes / 1024).toFixed(0)} KB   tokens: ${textOnlyTokens.toLocaleString()}`);
  console.log(`    >> encode time: ${textOnlyMs.toFixed(0)} ms  (vs ${totalMs.toFixed(0)} ms all-files = ${(totalMs / Math.max(textOnlyMs, 0.01)).toFixed(0)}x faster) <<`);
  const rows = [...byExt.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
  console.log(`  --- top file types by encode time ---`);
  for (const [ext, a] of rows) {
    const isText = TEXT_EXT.has(ext) ? "text" : "BINARY/other";
    console.log(`    .${ext.padEnd(10)} ${a.ms.toFixed(0).padStart(7)} ms  ${(a.bytes / 1024).toFixed(0).padStart(7)} KB  n=${a.n}  [${isText}]`);
  }
}

console.log("gpt-tokenizer gpt-4o — folder encode cost replication");
console.log("warmup:", encode("warmup").length, "tokens");
for (const t of TARGETS) {
  measure(path.join(VAULT_REPO, t), t);
}
