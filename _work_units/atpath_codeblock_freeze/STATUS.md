Updated at 2026-06-04 19:05

Open WU. Root cause **measured and reproduced end-to-end** (findings/002). The freeze is **~83 seconds** of synchronous `gpt-tokenizer encode()` over **`.heic` photos that `BINARY_EXTENSIONS` forgot to denylist**, triggered when an `@path` crosses a folder that contains them (`@_work_units/ai_dev/` → 13 HEICs). The code block is **incidental** — the same freeze fires in prose. Fence guard deferred to UX. **Fix design decided** → plans/002: content sniff (`looksBinary`) + completed denylist fast-path + null-cache at `getTokenCount`; folder byte-budget (R2) as defense-in-depth; fence guard (R3) deferred. Plan under codex review before implementation.

## Done
- Mapping workflow + codex review → findings/001 (structural map; ReDoS disproven).
- **Measured root cause** → findings/002: Node harness (@_work_units/atpath_codeblock_freeze/scripts/measure_folder_encode.js) replicates `getFolderTokens` over the real files; live CLI confirmed every precondition (vault "Documents", 53,362 files, atpath v1.8.3, `showTokenCounts=true`, defaults `maxFolderFiles=500`/`batchSize=1`/`maxFileSizeMB=5`; 13 `.heic` indexed; `cachedRead(heic)` = 1,990,119 chars). ai_dev: ~83s now → ~0.4s text-only (~200×). Worst single file `IMG_1487.heic` = 9.3s in one uninterruptible `encode()`.
- Key correction to findings/001: not a transient spike — a sustained ~83s freeze; and `getTokenCount` (main.js:2484) already denylists `jpg/png/...` but **not `heic/heif`**.

## Open (implementation — gated on plan review)
- **Plan committed** → plans/002_binary_sniff_fix.md. Part A (freeze fix): `looksBinary` content sniff in @src/atpath-core.js + sniff/null-cache at `getTokenCount` (@src/main.js:2480) + completed denylist fast-path (@src/main.js:140). Part B (R2): folder byte-budget. R3 fence guard deferred.
- **Now:** plans/002 under `/review-codex` (plan-level checkpoint). Implementation blocked on the verdict.
- **After implementation:** unit tests (looksBinary + R2), `npm run build`, reload + re-type repro, re-run measure_folder_encode.js, then `/review-codex` on the final diff.
