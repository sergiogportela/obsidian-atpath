# Plan 002 — Binary-sniff fix for the @path token-count freeze (committed approach)

> Supersedes the option menu in plans/001 §"Revised approach". This plan **commits** to one
> approach and is the implementation spec. Evidence:
> @_work_units/atpath_codeblock_freeze/findings/002_measured_binary_encode.md.
> Guiding constraint (unchanged): **most minimal, most surgical** change that makes the freeze
> impossible — stop feeding non-text bytes to `gpt-tokenizer`.
>
> **Revised after plan-level codex review** (@_work_units/0_llm/reviews/002-binary-sniff-fix-plan-review.md).
> Net changes from the first draft: null-caching **dropped** (kept `tokenCache` numeric-only);
> denylist additions **trimmed** to unambiguous formats; Part B (folder byte-budget) **deferred**;
> sniff guarantee **narrowed** with explicit edge cases. See §"Resolved by review" at the bottom.

## Decision

The freeze is `.heic` photos missing from `BINARY_EXTENSIONS` (@src/main.js:140-149), tokenized
as text by `getTokenCount` (@src/main.js:2480) → synchronous `encode()` (~78s for one folder).
The denylist already missed `heic` and will miss the next format. We therefore fix this by
**deciding on what the file actually is, not on its filename**:

- **(c) content sniff — the correctness layer.** After `cachedRead` returns the string (which
  already happens, *before* `encode`), check whether it looks like binary; if so, skip `encode`
  and return `null`. Catches `heic` and every present/future binary format, keeps every real-text
  count. The verdict is **not cached** — see A2 for why (keeps `tokenCache` numeric-only).
- **(a) completed denylist — a free fast-path.** Keep `BINARY_EXTENSIONS` and add the missing
  **unambiguous** raster formats, so known binaries skip even the read. After this change the
  denylist is a *performance* shortcut only — no longer load-bearing for correctness (the sniff is
  the backstop). Additions are restricted to formats with no plausible real-text use (see A3).
- **(Part B / R2) folder byte-budget — deferred.** Defense-in-depth for the many-large-**text**-files
  case the sniff does not address; the review found it is not required for the measured freeze and
  has unresolved UI/invalidation/default questions. Moved to "Deferred" with its prerequisites.
- **(R3) fence guard — deferred** to its own change (correctness/UX, not the freeze fix).

Rationale for picking (c) over (a)-alone or (b)-allowlist:
- (a) alone is the same bug class waiting to recur (next un-listed binary format freezes again).
- (b) allowlist fails *safe* against the freeze but silently drops legit token counts for any
  exotic-but-real text extension — a behavior regression for real text, which the WU hard rules
  forbid ("keep real-text counts byte-identical").
- (c) is the only approach robust to unknown/future formats **and** byte-identical for real UTF-8
  text. It mirrors how `git`, `grep -I`, and `file(1)` classify content (NUL byte / non-printable
  ratio). The read already happens before `encode`; the read is cheap, the `encode` is the killer —
  so the sniff costs ~nothing relative to what it prevents.

Measured target (findings/002): `ai_dev` folder ~78,000 ms → ~400 ms (~200×).

---

## Part A — The freeze fix (ships first; the whole plan now)

### A1. `looksBinary(content)` — new pure export in @src/atpath-core.js

Lives at module scope alongside the other pure exports (`isSubsequenceCI`,
`extractDraggedVaultPaths`), added to `module.exports` (@src/atpath-core.js:532-543). Pure, no
Obsidian deps → directly unit-testable under `node --test`.

```js
// Heuristic: does this decoded string look like binary data rather than text?
// Mirrors git / grep -I / file(1): a NUL byte is a hard binary signal; a high
// ratio of U+FFFD (failed UTF-8 decode) or non-whitespace control chars over a
// leading sample means binary. Genuine UTF-8 text/code/data scores ~0 and is
// never skipped, so token counts for real text stay byte-identical. Known edge
// cases (UTF-16/32, tiny control-heavy files, long ASCII preambles) are
// documented under "Sniff limitations"; all degrade safely to "no count".
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
  4096 chars. Verified live: `cachedRead(IMG_1487.heic)` returns a 1,990,119-char string with NUL.
- Files with no early NUL but high entropy decode to many `U+FFFD` + control chars → the 10% ratio
  catches them.
- Multibyte real text (CJK, emoji) decodes to valid non-control chars → `suspicious` stays 0 →
  never flagged. Markdown/JS/JSON/CSV/YAML score 0.
- `slice(0, 4096)` bounds the scan to ~4k iterations (<1 ms); independent of file size. (`git`
  samples ~8000 bytes; 4096 is sufficient for the measured HEIC and every common binary header,
  which carry NUL/control bytes in their first few hundred bytes. See "Sniff limitations" for the
  long-preamble false-negative this trades away.)

### A2. Integrate the sniff at `getTokenCount` (@src/main.js:2480-2500) — **do not cache the skip**

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

Change — insert the sniff between `cachedRead` and `encode`, returning `null` **without writing to
the cache**:
```js
const content = await ATPATH_PERF.timeAsync("getTokenCount.cachedRead", () => this.app.vault.cachedRead(file));
if (looksBinary(content)) {
  ATPATH_PERF.inc("getTokenCount.sniffedBinary");
  return null;  // NOT cached — see "Why not cache the skip" below
}
/* …perf bucket… */
const tokens = ATPATH_PERF.time("getTokenCount.encode", () => encode(content).length);
this.tokenCache.set(vaultPath, { mtime: file.stat.mtime, tokens });
return tokens;
```

**Why not cache the skip (the review's P1, addressed by NOT introducing the problem).**
The first draft cached `{ mtime, tokens: null }`. The review found that four render-time cache
readers do `if (cached) … formatTokens(cached.tokens)` — @src/main.js:911, :1050, :1281, :1440 —
and `formatTokens(null)` returns the literal string `"null"` (since `null < 1000` → `String(null)`),
so a sniffed binary would paint a `"null"` token badge. Rather than teach all four readers (and any
future reader) a three-state `cached.tokens == null` dance, we keep the simpler, more reliable
invariant: **`tokenCache` only ever holds numeric token counts.** Consequences:
- A binary file is never stored → always a cache-miss → `getTokenCount` re-reads + re-sniffs and
  returns `null` each time. The repeated cost is one **already-Obsidian-cached** `cachedRead` (a
  cached-string return, not a disk read) + a <1 ms 4096-char scan. The `encode` — the only
  expensive step — is never run. The folder path is additionally protected by `folderTokenMemo`
  (permanent per-folder sum memo, @src/atpath-core.js:183), so a binary inside a walked folder is
  read+sniffed once per walk, then the whole sum is memoized.
- **No reader changes are needed** (911/1050/1281/1440 keep working): they only ever see a numeric
  `cached.tokens` or an absent entry. This is strictly more surgical than the four-reader patch.

The existing cache-hit/miss machinery is otherwise untouched: `scheduleTokenFetch`
(@src/main.js:2502-2525) already no-ops its refresh when `tokens == null`, and the folder walk sums
with `total += n || 0` (@src/atpath-core.js:242), so `null` contributes 0.

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

### A3. Complete the denylist (@src/main.js:140-149) — unambiguous fast-path only

Add **only** the common, unambiguously-binary raster image formats that the existing list
(png/jpg/jpeg/gif/bmp/svg/ico/webp/avif/…) happens to omit:
```
heic, heif, tiff, tif
```
**Deliberately NOT added** (the review's P1): `raw`, `jxl`, `psd`, `dng`, `cr2`, `nef`, `arw`,
`orf`, `rw2`, `raf`, `heics`. The denylist runs *before* the sniff, so every entry is an
**unconditional** skip with no content check — adding generic `raw` would zero out a genuine text
`*.raw` file, violating "real text byte-identical." These exotic/RAW/ambiguous formats are instead
left to fall through to the sniff (A1), which classifies them correctly by content; the 5 MB
`maxFileSizeMB` cap (@src/main.js:2486, runs before `cachedRead`) caps the read cost for the large
ones. So correctness for them does not depend on listing them, and we take zero ambiguity risk.

After this, the denylist is purely a `cachedRead`-avoidance optimization for the four common
formats; correctness no longer depends on its completeness.

### Part A behavior contract
- Real **UTF-8** text/code/data files: **byte-identical** token counts (sniff returns false → same
  `encode`). This is the WU's "real text byte-identical" guarantee, scoped to UTF-8 (what Obsidian
  reads and what real notes are). Non-UTF-8 edge cases are enumerated next.
- `.heic`/`.heif`/`.tiff`/`.tif` and any other content the sniff flags as binary: **no count** (was:
  ~9s synchronous freeze each).
- Folder walk and single-file refs: both covered by the one `getTokenCount` edit.

### Sniff limitations (the review's P2 — narrowed claim, accepted as safe degradation)
`looksBinary` is a heuristic. Its known mis-classifications all degrade *safely* (to "no count" — no
freeze, no crash) and none affect the measured HEIC fix:
- **False-positive on UTF-16/UTF-32 text.** These encodings interleave NUL bytes, so a UTF-16 `.md`
  would be sniffed as binary → "no count." Accepted: Obsidian stores notes as UTF-8; a UTF-16 file
  is an edge case, and "no count" is a safe degradation, not a regression of the freeze guarantee.
- **False-positive on tiny control-heavy files.** A very small file (e.g. <~20 chars) with ≥2
  non-whitespace control chars can exceed the 10% ratio. Genuine tiny text essentially never
  contains non-whitespace control bytes, and the failure mode is "no count." **Decision: no
  min-length floor** — adding one would only convert these safe "no count"s back into encodes for
  no real-text benefit, against the minimalism constraint.
- **False-negative on a binary with a >4096-char ASCII preamble.** Such a file passes the sniff and
  reaches `encode`. This requires an unusual format (common binaries carry NUL/control bytes in
  their first few hundred bytes); the `maxFileSizeMB` cap bounds the worst-case `encode` cost. If a
  real such format ever appears, widen the sample (git uses ~8000) or sample multiple windows.

---

## Deferred — Part B (folder byte-budget, R2) and R3 fence guard

### Part B — folder byte-budget (R2), deferred per review
The sniff fully fixes the *measured* freeze (binary photos). It does **not** bound a folder of many
large **real-text** files (e.g. 100 × 2 MB markdown = 200 MB of legit text → slow but un-skippable
encode). `maxFolderFiles = 500` caps the wrong dimension (the 13 HEICs were ~58 MB at <500 files).
The review's recommendation: **defer** — it is not required for the measured HEIC freeze, and it has
three unresolved prerequisites that must be settled before it ships:

1. **Distinct sentinel, not the over-cap reuse.** A byte-budget trip is *not* a max-files trip, but
   the current UI titles say "Skipped: over the configured max-files limit" (@src/main.js:2865,
   :2925) and the count renderer shows `> N files` (`formatLinkedTargetCount`, @src/main.js:181-184).
   Part B must add a reason field / distinct sentinel shape and update the renderer + both title
   copy sites, or it mislabels the cause to the user.
2. **`maxFolderBytes` memo invalidation.** A new `maxFolderBytes` setting changes `getFolderTokens`
   results, so its settings handler must `clearFolderTokenMemo()` + set `tokenCacheDirty` +
   `_scheduleRefresh()` — exactly mirroring the `maxFolderFiles` handler at @src/main.js:1521-1531.
   The first draft only said "register the setting"; without this, the change silently doesn't take
   effect until reload.
3. **Default value.** Proposed 16 MB (~2.4 s worst-case pure-text encode) — needs validating against
   real folders so it neither janks nor cuts off legitimately-countable folders; consider deriving
   from `maxFileSizeMB`.

Design sketch when picked up (budget on bytes we actually tokenize, so sniff-skipped binaries don't
count): register `maxFolderBytes` in `DEFAULT_SETTINGS` (@src/main.js:218-223) + the settings tab
(beside `maxFileSizeMB`/`maxFolderFiles`, with the invalidation wiring from #2); in the encode loop
(@src/atpath-core.js:222-246) keep a running `encodedBytes`, adding each file's `stat.size` **only
when its count came back non-null**, and stop + return the (new, distinct) over-budget sentinel when
`encodedBytes > maxFolderBytes`. This is sanctioned by the WU rule "only non-text/**over-budget**
files change (to 'no count')."

### R3 — fence guard, deferred
Make code-block content inert for AtPath (no linkification, no token fetch). A correctness/UX item,
**not** the freeze fix (the same freeze fires in prose). Implement per the F1/F4/F5 detail in
plans/001 §"Original plan" if/when wanted; ships separately.

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
- NUL only **after** char 4096 (clean preamble) → `false` (documents the long-preamble
  false-negative limitation as intended behavior, so a future widening of the sample is a conscious
  choice, not an accidental regression).

### Token-cache invariant (extend `tests/folder-tokens.test.js` if the fakes allow)
- Using the existing `buildPlugin` fakes, a file whose synthetic content reads as binary →
  `getTokenCount` returns `null` **and** leaves `tokenCache` with no entry for it (locks the
  "numeric-only cache" invariant that makes the four readers safe without changes). If the current
  fakes can't drive `getTokenCount`'s `cachedRead`, note it and cover the invariant via the manual
  reload check in rollout step 4 instead.

(Part B byte-budget tests are deferred with Part B.)

### Re-measure (manual, not in `node --test`)
Re-run @_work_units/atpath_codeblock_freeze/scripts/measure_folder_encode.js after Part A to prove
`ai_dev` drops ~78,000 ms → ~400 ms. (The script must be taught the sniff to mirror the plugin, or
assert HEICs are skipped via the completed denylist — note which in the finding update.)

---

## Verification & rollout

1. ✅ DONE — `node --test --require ./tests/_setup.js tests/*.test.js` — all green (existing suite + new
   `binary-sniff.test.js`). (Measured: 80/80 tests green — 23 in `binary-sniff.test.js`, incl. the exact
   4095/4096 sample boundary, the `c < 32` upper-window edge, and a source-text structural guard.)
2. ✅ DONE — `npm run build` — regenerate committed `main.js`.
3. ⏳ pending — `obsidian plugin:reload id=atpath` (per WU runbook; CLI installer out of date — only
   eval/dev:errors/dev:console work). (Needs a running app.)
4. ⏳ pending — Re-type the original deep path `@_work_units/ai_dev/agent_orchestrator/findings/…` in the
   colm-as-kedro vault — confirm it resolves **instantly**, no CPU pin, and the binary refs show
   **no** token badge (never a `"null"` badge). (Needs a running app.)
5. ✅ DONE — Re-run `measure_folder_encode.js` — confirm the ~200× drop; update findings/002 with the
   post-fix number. (Measured: `_work_units/ai_dev` BEFORE=78741ms → AFTER=374ms, ~211× drop.
   Per-target: `_work_units/ai_dev` 78741→374ms; `_work_units/ai_dev/agent_orchestrator`
   82204→196ms; `_work_units/ai_dev/agent_orchestrator/findings` 81348→141ms. The content sniff
   caught binaries **beyond** the denylist: `.DS_Store` extensionless macOS metadata files —
   10 in `_work_units/ai_dev`, 4 in `agent_orchestrator`, 3 in `findings`. These have ext "(none)"
   so they are in neither the old nor the new (`heic`/`heif`/`tiff`/`tif`) denylist; only the
   `looksBinary` content sniff (NUL-byte rule) skips them. The `.heic`/`.jpg` files, by contrast,
   were caught by the denylist extension match, not the sniff.)
6. ✅ DONE — `/review-codex` on the **final patch diff** (the second codex checkpoint; the first was the
   findings/001 root-cause review, and *this plan* was the plan-level checkpoint). (Codex #1 on the
   impl came back clean — 1 P3 fixed; codex #2 on the final diff also came back clean — no blocking
   issues, Part A confirmed conformant (sniff at `getTokenCount` before `encode()` and before the cache
   write, sniffed binaries uncached, denylist limited to `heic/heif/tiff/tif`, regexes untouched), with
   1 P3 — this rollout line's then-stale `76/76` count, now fixed in step 1. →
   @_work_units/0_llm/reviews/002-binary-sniff-final-review.md.)
7. ✅ DONE — Update WU STATUS.md + PRD pointer; fold durable WHY/WHAT into the `looksBinary`/`getTokenCount`
   docstrings. (Done for the `looksBinary`/`getTokenCount` docstrings and the STATUS files.)

## Resolved by review (was "Open questions")
- **null-cache** → **dropped.** Keeps `tokenCache` numeric-only; no `"null"` badge possible; no
  reader changes (A2).
- **denylist additions** → **trimmed** to `heic/heif/tiff/tif`; ambiguous/exotic formats fall to the
  sniff (A3).
- **Part B** → **deferred**; not required for the measured freeze; prerequisites recorded above.
- **small-file ratio floor** → **no floor**; safe degradation to "no count" (Sniff limitations).
- **`maxFolderBytes` default** → moot until Part B is picked up (recorded as prerequisite #3).

### Still open (only if/when Part B is revived)
- Final `maxFolderBytes` default + whether to derive it from `maxFileSizeMB`.
- Whether the size-cap branch (`stat.size > maxFileSizeMB`, @src/main.js:2486) should also be
  surfaced with the same distinct "over-budget" sentinel for symmetry.

## Out of scope
- Regex rewrite / `{1,256}` bound (ReDoS disproven, findings/001).
- Shelved Plan 003 (approximate tokenizer + persistent cache).
- Wikilink ViewPlugin + reading-mode post-processor fence-unawareness (documented asymmetries).
