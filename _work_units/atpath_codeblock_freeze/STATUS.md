Updated at 2026-06-04 20:10

Open WU. Root cause **measured and reproduced end-to-end** (findings/002). The freeze is **~83 seconds** of synchronous `gpt-tokenizer encode()` over **`.heic` photos that `BINARY_EXTENSIONS` forgot to denylist**, triggered when an `@path` crosses a folder that contains them (`@_work_units/ai_dev/` → 13 HEICs). The code block is **incidental** — the same freeze fires in prose. Fence guard deferred to UX. **Fix design decided and plan-reviewed** → plans/002 (revised after codex review): content sniff (`looksBinary`) at `getTokenCount` returning `null` **without caching** (keeps `tokenCache` numeric-only) + unambiguous denylist additions (`heic/heif/tiff/tif` only). Folder byte-budget (R2) and fence guard (R3) **deferred**. Plan ready to implement (Part A).

## Done
- Mapping workflow + codex review → findings/001 (structural map; ReDoS disproven).
- **Measured root cause** → findings/002: Node harness (@_work_units/atpath_codeblock_freeze/scripts/measure_folder_encode.js) replicates `getFolderTokens` over the real files; live CLI confirmed every precondition (vault "Documents", 53,362 files, atpath v1.8.3, `showTokenCounts=true`, defaults `maxFolderFiles=500`/`batchSize=1`/`maxFileSizeMB=5`; 13 `.heic` indexed; `cachedRead(heic)` = 1,990,119 chars). ai_dev: ~83s now → ~0.4s text-only (~200×). Worst single file `IMG_1487.heic` = 9.3s in one uninterruptible `encode()`.
- Key correction to findings/001: not a transient spike — a sustained ~83s freeze; and `getTokenCount` (main.js:2484) already denylists `jpg/png/...` but **not `heic/heif`**.

## Open (implementation — plan reviewed, ready)
- **Plan reviewed** → codex verdict at @_work_units/0_llm/reviews/002-binary-sniff-fix-plan-review.md (conditional endorsement: ship Part A after the null-cache + denylist fixes; defer Part B). Plan revised to fold both P1s + the P2 narrowing in.
- **Part A (the whole plan now)** → plans/002_binary_sniff_fix.md: `looksBinary` pure export in @src/atpath-core.js + sniff at `getTokenCount` (@src/main.js:2480) returning `null` **without caching** + denylist additions `heic/heif/tiff/tif` (@src/main.js:140). No reader changes (cache stays numeric-only).
- **Deferred:** Part B (folder byte-budget) — prerequisites recorded in plan (distinct sentinel, `maxFolderBytes` memo invalidation mirroring @src/main.js:1521, default tuning). R3 fence guard.
- **After implementation:** `tests/binary-sniff.test.js` + cache-invariant test, `npm run build`, reload + re-type repro, re-run measure_folder_encode.js, then `/review-codex` on the final diff.
