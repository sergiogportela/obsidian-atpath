# Finding 002 — MEASURED root cause: `.heic` photos missing from the binary denylist (~83s freeze)

Supersedes the "transient folder-encode spike" framing in findings/001 (§"Refined mechanism"). The freeze is **sustained ~83 seconds**, not a transient hitch.

## The one-line cause

`BINARY_EXTENSIONS` (@src/main.js:140-149) denylists `png, jpg, jpeg, gif, bmp, svg, ico, webp, avif, …` — **but omits `heic`** (the default iPhone photo format) and `heif`. `getTokenCount` (@src/main.js:2484-2485) skips `encode()` only for denylisted extensions, so every `.heic` in a referenced folder falls through, gets `cachedRead` into a ~2M-char string, and is tokenized. 13 HEICs in `_work_units/ai_dev` → ~9s each → **~83s of pinned main-thread CPU**. `.jpg` (also present) IS denylisted, so it is correctly skipped — the freeze is specifically the formats the denylist forgot.

This is a textbook argument **for an allowlist or a binary sniff over a denylist**: the denylist already missed `heic` and will miss the next format (`heif`, `jxl`, `tiff`, `psd`, RAW: `dng/cr2/nef/arw`, …).

## How this was measured (no Obsidian freeze required)

1. Node harness @_work_units/atpath_codeblock_freeze/scripts/measure_folder_encode.js replicates `getFolderTokens` (@src/atpath-core.js:178-254) exactly — same walk, same 5MB per-file cap, same 500-file cap — over the real on-disk files, using the bundled `gpt-tokenizer/model/gpt-4o`.
2. Live Obsidian CLI probes confirmed every precondition on the affected vault ("Documents", 53,362 files, atpath v1.8.3):
   - `settings.showTokenCounts = true` (gates the folder fetch in `buildDecorations`).
   - `maxFolderFiles = 500`, `folderEncodeBatchSize = 1`, `maxFileSizeMB = 5` (all defaults).
   - 13 `.heic` files indexed in the vault — **exact match** to the disk walk.
   - `cachedRead` on `IMG_1487.heic` returns **1,990,119 characters** → Obsidian decodes the binary to a ~2MB string and hands it to `encode()`.

## The numbers (`_work_units/ai_dev`, 243 files)

Per-type encode cost (naive harness encodes everything; the plugin's denylist is applied in the rows below):

| file type | encode time | bytes | count | denylisted? |
|---|---|---|---|---|
| `.heic` | **82,236 ms** | 57.7 MB | 13 | **NO → encoded → the freeze** |
| `.jpg` | 5,393 ms | 4.0 MB | 5 | yes → skipped |
| `.md` | 399 ms | 2.6 MB | 204 | n/a → encoded (correct) |
| `.zip` / `.py` / `.txt` / none | <150 ms | — | — | mixed |

- **Actual plugin behavior now (denylist applied): 78,384 ms (~78 s)** of pinned main-thread CPU for `ai_dev` — essentially all 13 HEICs — the first time `@_work_units/ai_dev/` is crossed. (Naive all-files = 83.7s; the `.jpg` is correctly skipped.)
- **Worst single file: `IMG_1487.heic` = ~8.9 s in ONE synchronous `encode()` call** — uninterruptible (the `setTimeout(0)` yields are *between* files, never inside an `encode`).
- **Fixed (skip heic too / allowlist text): 386 ms — 217× faster.**
- **Cumulative across the deep path:** the 13 HEICs all live in `…/agent_orchestrator/findings/`, so each enclosing folder walks them. Measured per level: `ai_dev` 78.4s, `agent_orchestrator` 82.6s, `findings` 83.3s. Typing `@…/ai_dev/agent_orchestrator/findings/…` crosses all three boundaries → three distinct memo keys → **three separate ~80s encodes (minutes cumulative)** in one typing session. This is why the user's specific deep path froze so hard.

## Exact mechanism

1. Type `@_work_units/ai_dev/` in the editor. The path resolves (relative to the source note's repo root, @src/atpath-core.js:65-88) to a real `TFolder`: `arbi_shared/_repos/colm-as-kedro/_work_units/ai_dev`.
2. `buildAtPathViewPlugin.buildDecorations` (@src/main.js:831-937, folder branch ~853) sees the folder match and calls `scheduleFolderTokenFetch` → `getFolderTokens`.
3. `getFolderTokens` walks **all** `TFile` descendants (@src/atpath-core.js:203 — no extension filter in the walk), skipping only files `> maxFileSizeMB` (5MB, line 205). A ~2MB HEIC is **under** the cap, so it is included.
4. Each file → `getFileTokens` → `plugin.getTokenCount`. `getTokenCount` (@src/main.js:2484-2485) returns `null` for `BINARY_EXTENSIONS` — but `heic`/`heif` are **not in that set**, so it proceeds: `cachedRead(file)` decodes the binary to a ~2M-char string (verified live: `IMG_1487.heic` → 1,990,119 chars) → `encode(content)`. Tokenizing high-entropy binary bytes is pathologically slow (~9s/image).
5. `batchSize = 1` with `await setTimeout(0)` between files (lines 223-245) slices the work across macrotasks, so Obsidian never shows "page unresponsive" — but the main thread is saturated for ~83s. **= "100% CPU / froze".**

## Why the code block is incidental (critical)

The fence is **not** what makes this expensive. Typing `@_work_units/ai_dev/` in **prose** — the plugin's intended use — triggers the exact same ~83s freeze, because `getFolderTokens` runs identically regardless of code-block context. The single-spot `buildDecorations` fence guard (F1 in plans/001) would fix only the in-fence case and leave the freeze one keystroke away in normal text. **The fence guard is therefore demoted from "the fix" to a separate UX-correctness item.**

## Single-file @refs have the same hole

`@path/to/IMG_1487.heic` (a file ref, not a folder) routes `buildDecorations` file branch (~909) → `scheduleTokenFetch` → `getTokenCount`. Same `BINARY_EXTENSIONS` gap → same 9s synchronous block. The fix to the denylist/allowlist in `getTokenCount` covers both the folder and single-file paths in one place.

## The fix (measured-justified, replaces the F1-centric plan)

Primary — **stop tokenizing non-text content**. The single decision point is `getTokenCount` (@src/main.js:2484), which both the folder walk and single-file refs flow through. Options (product decision, see plans/001 revision):
- (a) Complete the denylist — add `heic, heif, tiff, tif, jxl, psd, dng, cr2, nef, arw, raw, …`. Smallest diff; still brittle (next format slips through).
- (b) **Allowlist** text/code/data extensions — only encode known-text. Reliable; risks excluding an exotic text extension from token counts.
- (c) **Binary sniff** — read the first ~1KB, skip if it contains NUL bytes / a high non-printable ratio. Format-agnostic, catches unknown binaries, keeps all real text. Most reliable; adds a tiny read.
- Measured effect (any of these, on ai_dev): ~83,000 ms → ~400 ms.

Defense-in-depth:
- Add a **total-folder-bytes budget** (the current `maxFolderFiles=500` caps the wrong dimension — 13 HEICs were ~58MB while well under 500 files).
- Consider a lower effective per-file cap for the folder-sum path so no single file blocks >~100ms.

Secondary (was primary): fence guard so code blocks are inert — correctness/UX, no longer the freeze fix.

## Corrections to findings/001

- "Transient spike, not sustained" (§Refined mechanism) is **wrong for this vault**: 13 un-denylisted HEICs → ~83s sustained. The memoization claim still holds (once per session per folder) but a once-per-session 83s freeze is still a freeze.
- "the perf dump attributes `getFolderTokens.*`" — correct after all: `getFolderTokens` records `getFolderTokens.batch` via `perf.timeAsync` (@src/atpath-core.js:225) through the `window.__atpath_perf` bridge (line 140). A live dump would show `getFolderTokens.batch ≈ tens of seconds`.
