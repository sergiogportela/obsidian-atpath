# Plan 002 — Binary-sniff fix for the @path token-count freeze (committed approach)

> Supersedes the option menu in plans/001 §"Revised approach". This plan **commits** to one
> approach and is the implementation spec. Evidence:
> @_work_units/atpath_codeblock_freeze/findings/002_measured_binary_encode.md.
> Guiding constraint (unchanged): **most minimal, most surgical** change that makes the freeze
> impossible — stop feeding non-text bytes to `gpt-tokenizer`.

## Decision

The freeze is `.heic` photos missing from `BINARY_EXTENSIONS` (@src/main.js:140-149), tokenized
as text by `getTokenCount` (@src/main.js:2480) → synchronous `encode()` (~78s for one folder).
The denylist already missed `heic` and will miss the next format. We therefore fix this by
**deciding on what the file actually is, not on its filename**:

- **(c) content sniff — the correctness layer.** After `cachedRead` returns the string (which
  already happens, *before* `encode`), check whether it looks like binary; if so, skip `encode`.
  Catches `heic` and every present/future binary format, keeps every real-text count.
- **(a) completed denylist — a free fast-path.** Keep `BINARY_EXTENSIONS` and add the missing
  image/RAW formats, so known binaries skip even the read. After this change the denylist is a
  *performance* shortcut only — no longer load-bearing for correctness (the sniff is the backstop).
- **null-caching** the sniff verdict so single-file binary `@`-refs don't re-read every keystroke.
- **(Part B / R2) folder byte-budget** as defense-in-depth for the many-large-**text**-files case
  the sniff does not address.
- **(R3) fence guard — deferred** to its own change (correctness/UX, not the freeze fix).

Rationale for picking (c) over (a)-alone or (b)-allowlist:
- (a) alone is the same bug class waiting to recur (next un-listed binary format freezes again).
- (b) allowlist fails *safe* against the freeze but silently drops legit token counts for any
  exotic-but-real text extension — a behavior regression for real text, which the WU hard rules
  forbid ("keep real-text counts byte-identical").
- (c) is the only approach robust to unknown/future formats **and** byte-identical for real text.
  It mirrors how `git`, `grep -I`, and `file(1)` classify content (NUL byte / non-printable ratio).
  The read already happens before `encode`; the read is cheap, the `encode` is the killer — so the
  sniff costs ~nothing relative to what it prevents.

Measured target (findings/002): `ai_dev` folder ~78,000 ms → ~400 ms (~200×).

---

## Part A — The freeze fix (ships first)

### A1. `looksBinary(content)` — new pure export in @src/atpath-core.js

Lives at module scope alongside the other pure exports (`isSubsequenceCI`,
`extractDraggedVaultPaths`), added to `module.exports` (@src/atpath-core.js:532-543). Pure, no
Obsidian deps → directly unit-testable under `node --test`.

```js
// Heuristic: does this decoded string look like binary data rather than text?
// Mirrors git / grep -I / file(1): a NUL byte is a hard binary signal; a high
// ratio of U+FFFD (failed UTF-8 decode) or non-whitespace control chars over a
// leading sample means binary. Real text/code/data files score ~0 and are never
// skipped, so token counts for genuine text stay byte-identical.
function looksBinary(content) {
  const sample = content.slice(0, 4096);
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;                            // NUL → binary (git's rule)
    if (c === 0xFFFD) suspicious++;                      // U+FFFD: failed UTF-8 decode
    else if (c < 9 || (c > 13 && c < 32)) suspicious++;  // control chars (allow \t \n \r)
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}
```

Why this shape:
- Obsidian `cachedRead` decodes file bytes as UTF-8. A HEIC's bytes contain NUL (`0x00` is valid
  UTF-8 → survives as `charCode 0`) → the `c === 0` early-return catches HEIC inside the first
  4096 chars. Verified live: `cachedRead(IMG_1487.heic)` returns a 1,990,119-char string.
- Files with no early NUL but high entropy decode to many `U+FFFD` + control chars → the 10% ratio
  catches them.
- Multibyte real text (CJK, emoji) decodes to valid non-control chars → `suspicious` stays 0 →
  never flagged. Markdown/JS/JSON/CSV/YAML score 0.
- `slice(0, 4096)` bounds the scan to ~4k iterations (<1 ms); independent of file size.

### A2. Integrate the sniff + null-cache at `getTokenCount` (@src/main.js:2480-2500)

Single choke point — both the folder walk (`getFolderTokens → getFileTokens → getTokenCount`) and
single-file `@`-refs flow through here, so one edit covers both (findings/002 §"Single-file @refs").

Current (2484-2499):
```js
const ext = file.extension.toLowerCase();
if (BINARY_EXTENSIONS.has(ext)) return null;
if (file.stat.size > this.settings.maxFileSizeMB * 1024 * 1024) return null;
const cached = this.tokenCache.get(vaultPath);
if (cached && cached.mtime === file.stat.mtime) { /* cacheHit */ return cached.tokens; }
/* cacheMiss */
const content = await ATPATH_PERF.timeAsync("getTokenCount.cachedRead", () => this.app.vault.cachedRead(file));
/* …perf bucket… */
const tokens = ATPATH_PERF.time("getTokenCount.encode", () => encode(content).length);
this.tokenCache.set(vaultPath, { mtime: file.stat.mtime, tokens });
return tokens;
```

Change — insert the sniff between `cachedRead` and `encode`, and cache the skip verdict:
```js
const content = await ATPATH_PERF.timeAsync("getTokenCount.cachedRead", () => this.app.vault.cachedRead(file));
if (looksBinary(content)) {
  ATPATH_PERF.inc("getTokenCount.sniffedBinary");
  this.tokenCache.set(vaultPath, { mtime: file.stat.mtime, tokens: null }); // cache the skip → no re-read next keystroke
  return null;
}
/* …perf bucket… */
const tokens = ATPATH_PERF.time("getTokenCount.encode", () => encode(content).length);
this.tokenCache.set(vaultPath, { mtime: file.stat.mtime, tokens });
return tokens;
```

Cache-safety check (verified against the call sites):
- The existing hit check `if (cached && cached.mtime === file.stat.mtime) return cached.tokens;`
  works unchanged when `tokens` is `null` — it returns `null` and short-circuits the re-read.
- `scheduleTokenFetch` (@src/main.js:2512-2518) only refreshes when `tokens != null`, so a cached
  `null` correctly means "no count, don't repaint."
- The folder walk sums with `total += n || 0` (@src/atpath-core.js:242), so `null` contributes 0.
- No code distinguishes "absent from cache" from "cached as null" in a way that breaks (`.get()`
  returns `undefined` when absent; both fail the `cached &&` guard the same way). If `tokenCache`
  is persisted, `{mtime, tokens: null}` serializes fine.

Import `looksBinary` into main.js's existing core destructure (@src/main.js:193-204):
```js
const {
  createAtPathCore,
  /* … */
  isSubsequenceCI,
  extractDraggedVaultPaths: coreExtractDraggedVaultPaths,
  looksBinary,
} = require("./atpath-core");
```

### A3. Complete the denylist (@src/main.js:140-149) — fast-path only

Add the missing raster/RAW/exotic image formats so known binaries skip the read entirely (the
sniff still backstops anything not listed):
```
heic, heif, tiff, tif, jxl, psd, dng, cr2, nef, arw, raw, orf, rw2, raf, heics
```
After this, the denylist is purely a `cachedRead`-avoidance optimization; correctness no longer
depends on its completeness.

### Part A behavior contract
- Real text/code/data files: **byte-identical** token counts (sniff returns false → same `encode`).
- `.heic`/`.heif` and any other binary: **no count** (was: ~9s synchronous freeze each).
- Folder walk and single-file refs: both covered by the one `getTokenCount` edit.

---

## Part B — Folder byte-budget (R2, defense-in-depth; separable commit)

The sniff fully fixes the *measured* freeze (binary photos). It does **not** bound a folder of many
large **real-text** files (e.g. 100 × 2 MB markdown = 200 MB of legit text → slow but un-skippable
encode). `maxFolderFiles = 500` caps the wrong dimension (the 13 HEICs were ~58 MB at <500 files).
R2 adds a total-**bytes-actually-encoded** budget to `getFolderTokens` (@src/atpath-core.js:178-254).

Design (budget on bytes we actually tokenize, so binaries skipped by the sniff don't count):
- New setting `maxFolderBytes` (proposed default **16 MB** — ~2.4 s worst-case of pure text encode;
  tunable, see Open questions). Register in `DEFAULT_SETTINGS` (@src/main.js:218-223) and the
  settings tab (@src/main.js near 1505-1540, beside `maxFileSizeMB`/`maxFolderFiles`).
- In the encode loop (@src/atpath-core.js:222-246): keep a running `encodedBytes`. After each file
  resolves, add that file's `stat.size` **only when its count came back non-null** (i.e. it was a
  real text file that got encoded — binaries return null and contribute nothing). When
  `encodedBytes > maxFolderBytes`, stop and return the over-cap sentinel.
- **Reuse the existing sentinel shape** `{ overCap: true, fileCount }` (@src/atpath-core.js:217),
  with `fileCount` = files processed before the trip. `formatLinkedTargetCount` (@src/main.js:181-184)
  already renders it as `"> N files"`; all sentinel call sites (main.js:864, 1424, 1432, 2641, 2808,
  2865, 2899, 2925, 2933) keep working unchanged.

This is explicitly sanctioned by the WU hard rule: "only non-text/**over-budget** files change (to
'no count')." It does change behavior for very-large real-text folders (count → "> N files"), which
is the intended, safe degradation.

---

## Deferred — R3 fence guard

Make code-block content inert for AtPath (no linkification, no token fetch). Now a correctness/UX
item, **not** the freeze fix (the same freeze fires in prose). Implement per the F1/F4/F5 detail in
plans/001 §"Original plan" if/when wanted; ships separately. Not in this plan's scope.

---

## Tests

Land in the existing `node --test --require ./tests/_setup.js tests/*.test.js` harness.

### `tests/binary-sniff.test.js` (new) — `looksBinary` pure unit tests
- NUL byte anywhere in first 4096 chars → `true`.
- Synthetic high-entropy string (≫10% U+FFFD / control chars) → `true`.
- Real-text fixtures → `false`: markdown, JS source, JSON, CSV, YAML, a CJK/emoji UTF-8 string,
  and text containing only `\t`/`\n`/`\r` whitespace.
- Text with a *few* control chars **under** the 10% threshold → `false` (locks the ratio gate).
- Empty string → `false` (guarded by `sample.length > 0`).

### `tests/folder-tokens.test.js` (extend) — Part B byte-budget
Following the existing `buildPlugin`/`makeFolder` fakes:
- Files whose summed `stat.size` exceeds a low `maxFolderBytes` → result is the
  `{ overCap: true }` sentinel; memoized as the sentinel (mirrors the existing cap test at
  lines 58-74).
- Files under budget → numeric sum unchanged (regression guard: byte-budget never trips for
  small folders → existing tests at lines 47-56 stay green).
- A file whose synthetic `getTokenCount` returns `null` (binary) does **not** add to
  `encodedBytes` (budget counts only encoded text).

### Re-measure (manual, not in `node --test`)
Re-run @_work_units/atpath_codeblock_freeze/scripts/measure_folder_encode.js after Part A to prove
`ai_dev` drops ~78,000 ms → ~400 ms. (The script must be taught the sniff to mirror the plugin, or
assert HEICs are skipped via the completed denylist — note which in the finding update.)

---

## Verification & rollout

1. `node --test --require ./tests/_setup.js tests/*.test.js` — all green (existing 41 + new).
2. `npm run build` — regenerate committed `main.js`.
3. `obsidian plugin:reload id=atpath` (per WU runbook; CLI installer out of date — only
   eval/dev:errors/dev:console work).
4. Re-type the original deep path `@_work_units/ai_dev/agent_orchestrator/findings/…` in the
   colm-as-kedro vault — confirm it resolves **instantly**, no CPU pin.
5. Re-run `measure_folder_encode.js` — confirm the ~200× drop; update findings/002 with the
   post-fix number.
6. `/review-codex` on the **final patch diff** (the second codex checkpoint; the first was the
   findings/001 root-cause review, and *this plan* is reviewed before implementation).
7. Update WU STATUS.md + PRD pointer; fold durable WHY/WHAT into the `looksBinary`/`getTokenCount`
   docstrings.

## Open questions (for the plan review)
- `maxFolderBytes` default: 16 MB proposed. Too high (>2 s of text still janks) / too low (cuts off
  legitimately countable folders)? Or derive from `maxFileSizeMB`?
- Is Part B worth the surface-area now, or defer it too (sniff alone fixes the reported bug)?
- `looksBinary` 4096-char sample + 10% ratio: any real-text file class (BOM/UTF-16, unusual
  encodings Obsidian still decodes) that could false-positive? Small files (<~50 chars) are more
  ratio-sensitive — acceptable (safe degradation to "no count"), or guard with a min-length floor?
- Should the size-cap branch (`stat.size > maxFileSizeMB`, main.js:2486) also cache `null` for
  symmetry, or leave that pre-existing behavior untouched to stay surgical?

## Out of scope
- Regex rewrite / `{1,256}` bound (ReDoS disproven, findings/001).
- Shelved Plan 003 (approximate tokenizer + persistent cache).
- Wikilink ViewPlugin + reading-mode post-processor fence-unawareness (documented asymmetries).
