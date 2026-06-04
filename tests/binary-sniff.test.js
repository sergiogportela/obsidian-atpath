"use strict";

// looksBinary is the content sniff that gates gpt-tokenizer's encode() in
// getTokenCount (src/main.js). It mirrors git / grep -I / file(1): a NUL byte
// in the leading 4096-char sample is a hard binary signal; otherwise a >10%
// ratio of U+FFFD (failed UTF-8 decode) or non-whitespace control chars over
// the sample means binary. Real UTF-8 text/code/data scores ~0 and is never
// skipped, so token counts for genuine text stay byte-identical.
//
// These tests lock both sides of the 0.1 ratio gate and the NUL early-return,
// using self-verifying fixture constructions (count/length arithmetic shown in
// comments) so the gate is provably exercised above and below threshold.
// Control / NUL / U+FFFD chars are built via String.fromCharCode (never literal
// bytes) so the fixtures are unambiguous in source and survive transport intact.
//
// --- getTokenCount -> null -> no-cache integration invariant (NOTE) ---------
// Plan 002 (§ "Token-cache invariant") asks to also assert that a binary file
// makes getTokenCount return null AND leaves no tokenCache entry. That invariant
// is NOT exercised here, and deliberately so: the real getTokenCount lives in
// src/main.js, which cannot be required under `node --test` (it pulls in
// @codemirror/* and gpt-tokenizer, which tests/_setup.js does not fake). The
// buildPlugin fake in tests/folder-tokens.test.js *replaces* plugin.getTokenCount
// with a stub returning 10 and never mocks app.vault.cachedRead, so it cannot
// drive the real read -> sniff -> encode path either. Writing a fake-driven test
// would secretly test a re-implemented copy of the logic, not the real method —
// misleading, so it is omitted. Per the plan's own fallback, the invariant is
// instead covered (a) structurally — looksBinary returns before tokenCache.set,
// so a sniffed binary is never stored (src/main.js getTokenCount), keeping the
// cache numeric-only — and (b) by the manual reload check in plan 002 rollout
// step 4 (re-type the binary @ref, confirm no token badge / never a "null" badge).
// This file's job is to exhaustively pin looksBinary itself, which is the only
// piece that is purely unit-testable.

const test = require("node:test");
const assert = require("node:assert/strict");

const { looksBinary } = require("../src/atpath-core.js");

const NUL = String.fromCharCode(0); // U+0000, the hard binary signal
const CTRL = String.fromCharCode(1); // U+0001: a non-whitespace control char (c < 9)
const CTRL_HI = String.fromCharCode(0x1b); // U+001B (ESC): upper control window (c > 13 && c < 32)
const CTRL_EDGE = String.fromCharCode(14); // U+000E: first suspicious char just above the \t..\r (9..13) whitelist
const FFFD = String.fromCharCode(0xfffd); // replacement char: a failed UTF-8 decode
const CTRL_US = String.fromCharCode(31); // U+001F: last char of the upper control window (c < 32)
const VT = String.fromCharCode(11); // U+000B vertical tab: inside the allowed 9..13 whitespace band
const FF = String.fromCharCode(12); // U+000C form feed: inside the allowed 9..13 whitespace band

// --- NUL byte (hard binary signal, early return) ---------------------------

test("looksBinary: NUL byte in first 4096 chars -> true", () => {
  // NUL at index 5, well within the 4096-char sample -> c === 0 early return.
  assert.equal(looksBinary("hello" + NUL + "world"), true);
});

test("looksBinary: NUL after 100 leading chars (still < 4096) -> true", () => {
  // NUL at index 100, inside the sample -> early return before the ratio gate.
  assert.equal(looksBinary("a".repeat(100) + NUL), true);
});

test("looksBinary: NUL exactly at the last sampled index (4095) -> true", () => {
  // 'a'*4095 + NUL has length 4096, so slice(0, 4096) includes the NUL at the
  // last sampled index (4095). It is scanned -> c === 0 early return -> true.
  assert.equal(looksBinary("a".repeat(4095) + NUL), true);
});

test("looksBinary: NUL exactly one past the sample (index 4096) -> false", () => {
  // 'a'*4096 + NUL: slice(0, 4096) is the 4096 leading "a" only; the NUL at
  // index 4096 is never scanned -> suspicious 0/4096 = 0 -> false. This is the
  // EXACT slice boundary of the documented long-preamble false-negative: a
  // binary whose first 4096 chars are clean ASCII passes the sniff and reaches
  // encode() (bounded by maxFileSizeMB).
  assert.equal(looksBinary("a".repeat(4096) + NUL), false);
});

// --- High-entropy: ratio well over the 10% gate -> true --------------------

test("looksBinary: control chars ~16.7% (well over 10%) -> true", () => {
  // 50 "a" + 10 U+0001 (control, c < 9). length 60, suspicious 10.
  // 10/60 = 0.1666... > 0.1 -> true.
  assert.equal(looksBinary("a".repeat(50) + CTRL.repeat(10)), true);
});

test("looksBinary: U+FFFD-heavy ~16.7% (failed UTF-8 decode) -> true", () => {
  // 50 "a" + 10 U+FFFD. length 60, suspicious 10 (each FFFD counts).
  // 10/60 = 0.1666... > 0.1 -> true.
  assert.equal(looksBinary("a".repeat(50) + FFFD.repeat(10)), true);
});

test("looksBinary: upper-window control chars (ESC 0x1B) ~16.7% -> true", () => {
  // 0x1B (27) matches only the (c > 13 && c < 32) half of the gate, not c < 9.
  // 50 "a" + 10 U+001B. length 60, suspicious 10. 10/60 = 0.1666... > 0.1 -> true.
  // The CTRL fixtures use code 1 (the c < 9 half), so this locks the upper
  // control window: a mutation breaking only `(c > 13 && c < 32)` flips it false.
  assert.equal(looksBinary("a".repeat(50) + CTRL_HI.repeat(10)), true);
});

test("looksBinary: control char just above the \\r whitelist (0x0E) -> true", () => {
  // 0x0E (14) is the first code point above the allowed 9..13 (\t \n \v \f \r)
  // whitespace band, so it must count as suspicious. 50 "a" + 10 U+000E ->
  // 10/60 = 0.1666... > 0.1 -> true. Pins the lower edge (c > 13) of the upper
  // window; \r (13) in the whitespace-only test confirms the other side stays
  // allowed, so 13 -> not counted, 14 -> counted is locked from both sides.
  assert.equal(looksBinary("a".repeat(50) + CTRL_EDGE.repeat(10)), true);
});

test("looksBinary: last upper-window control char (US 0x1F) ~16.7% -> true", () => {
  // 0x1F (31) is the highest code still inside (c > 13 && c < 32). 50 "a" + 10
  // U+001F -> 10/60 = 0.1666... > 0.1 -> true. Pins the UPPER edge (c < 32) of
  // the window; the space test below confirms 32 is NOT counted, so a `c <= 32`
  // mutation (which would also count space) is caught from both sides.
  assert.equal(looksBinary("a".repeat(50) + CTRL_US.repeat(10)), true);
});

test("looksBinary: space (0x20) is printable, never suspicious -> false", () => {
  // 0x20 (32) is the first printable char, one past the upper control window
  // (c < 32). 50 "a" + 10 spaces -> suspicious 0 -> false. A `c <= 32` mutation
  // would count space and flip this true, so this locks the c < 32 upper bound.
  assert.equal(looksBinary("a".repeat(50) + " ".repeat(10)), false);
});

// --- Ratio gate boundary (locks strict > 0.1) ------------------------------

test("looksBinary: just under threshold = 9% -> false (tight bracket below the gate)", () => {
  // 91 "a" + 9 U+0001. length 100, suspicious 9. 9/100 = 0.09 which is NOT > 0.1
  // -> false. Pairs with the 10% (false, exactly-at) and 11% (true) cases for a
  // 1%-spaced bracket straddling the 0.1 gate.
  assert.equal(looksBinary("a".repeat(91) + CTRL.repeat(9)), false);
});

test("looksBinary: just over threshold = 11% -> true", () => {
  // 89 "a" + 11 U+0001. length 100, suspicious 11.
  // 11/100 = 0.11 > 0.1 -> true. Engineered just above the gate.
  assert.equal(looksBinary("a".repeat(89) + CTRL.repeat(11)), true);
});

test("looksBinary: exactly at threshold = 10% -> false (gate is strict >)", () => {
  // 90 "a" + 10 U+0001. length 100, suspicious 10.
  // 10/100 = 0.1 which is NOT > 0.1 (strict greater-than) -> false.
  // Locks that the boundary value itself does not flip to binary.
  assert.equal(looksBinary("a".repeat(90) + CTRL.repeat(10)), false);
});

// --- Real-text fixtures -> false -------------------------------------------

test("looksBinary: markdown snippet -> false", () => {
  const md = [
    "# Heading",
    "",
    "Some **bold** and _italic_ text with a [link](https://example.com).",
    "",
    "- item one",
    "- item two",
    "",
    "> a blockquote",
    "",
    "    indented code",
  ].join("\n");
  // No NUL, no control bytes besides \n; suspicious 0 -> false.
  assert.equal(looksBinary(md), false);
});

test("looksBinary: JS source snippet -> false", () => {
  const js = [
    "\"use strict\";",
    "function add(a, b) {",
    "\treturn a + b; // tab-indented",
    "}",
    "const xs = [1, 2, 3].map((n) => n * 2);",
    "module.exports = { add, xs };",
  ].join("\n");
  // Only \t and \n as control chars, both whitelisted -> suspicious 0 -> false.
  assert.equal(looksBinary(js), false);
});

test("looksBinary: JSON object string -> false", () => {
  const json = JSON.stringify(
    { id: "atpath", nested: { a: 1, b: [true, false, null] }, name: "AtPath" },
    null,
    2
  );
  assert.equal(looksBinary(json), false);
});

test("looksBinary: CSV block -> false", () => {
  const csv = [
    "id,name,score",
    "1,alice,42",
    "2,bob,17",
    "3,carol,99",
  ].join("\n");
  assert.equal(looksBinary(csv), false);
});

test("looksBinary: YAML block -> false", () => {
  const yaml = [
    "id: atpath",
    "name: AtPath",
    "tags:",
    "  - obsidian",
    "  - autocomplete",
    "nested:",
    "  enabled: true",
    "  count: 3",
  ].join("\n");
  assert.equal(looksBinary(yaml), false);
});

test("looksBinary: CJK (Japanese) UTF-8 text -> false", () => {
  // Valid multibyte text decodes to non-control, non-FFFD code points -> 0.
  assert.equal(looksBinary("これはテストです。日本語のテキスト。"), false);
});

test("looksBinary: emoji string -> false", () => {
  // Emoji (incl. surrogate pairs) decode to valid code points, none control.
  assert.equal(looksBinary("hello 👋 world 🌍 done ✅🚀🎉"), false);
});

test("looksBinary: whitespace-only (\\t \\n \\v \\f \\r) -> false", () => {
  // All five (codes 9..13) are inside the allowed control band -> suspicious 0.
  // Including \v (11) and \f (12) exercises the MIDDLE of the 9..13 band, not
  // just its \t/\n/\r endpoints, proving the whole band is treated as text.
  assert.equal(looksBinary("\t\n\r" + VT + FF + "\t" + VT + "\n" + FF + "\r"), false);
});

// --- Empty-string guard (sample.length > 0) --------------------------------

test("looksBinary: empty string -> false (length guard)", () => {
  // sample.length is 0, so the `sample.length > 0 && ...` guard short-circuits
  // to false even though 0/0 would otherwise be NaN.
  assert.equal(looksBinary(""), false);
});

// --- Structural guard: sniff gate precedes the cache write (integration) ----
// The NOTE at the top of this file explains why the getTokenCount -> null ->
// no-cache invariant cannot be exercised by requiring src/main.js. This test is
// the (a) structural backstop named there: it reads src/main.js as text and
// asserts, WITHIN the getTokenCount method body, that the `looksBinary(content)`
// early-return appears before `this.tokenCache.set(`. That ordering is exactly
// what keeps a sniffed binary out of the numeric-only cache. A refactor that
// moved the sniff below the cache write (or dropped it) would fail here.

test("structural: looksBinary gate precedes tokenCache.set in getTokenCount (src/main.js)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

  const start = src.indexOf("async getTokenCount(");
  assert.notEqual(start, -1, "getTokenCount method not found in src/main.js");
  // Scope to the method body: end at the next method definition.
  const end = src.indexOf("scheduleTokenFetch(", start);
  assert.notEqual(end, -1, "method boundary (scheduleTokenFetch) not found after getTokenCount");
  const body = src.slice(start, end);

  const sniffAt = body.indexOf("looksBinary(content)");
  const cacheAt = body.indexOf("this.tokenCache.set(");
  assert.notEqual(sniffAt, -1, "looksBinary(content) gate missing from getTokenCount");
  assert.notEqual(cacheAt, -1, "this.tokenCache.set(...) missing from getTokenCount");
  assert.ok(
    sniffAt < cacheAt,
    "looksBinary gate must precede tokenCache.set so a sniffed binary is never cached"
  );
});
