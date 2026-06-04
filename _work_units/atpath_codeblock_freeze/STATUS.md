Updated at 2026-06-04 18:10

Open WU. Root cause **measured and reproduced end-to-end** (findings/002). The freeze is **~83 seconds** of synchronous `gpt-tokenizer encode()` over **`.heic` photos that `BINARY_EXTENSIONS` forgot to denylist**, triggered when an `@path` crosses a folder that contains them (`@_work_units/ai_dev/` → 13 HEICs). The code block is **incidental** — the same freeze fires in prose. Fence guard demoted to UX. Awaiting a fix-design decision (denylist vs allowlist vs binary sniff).

## Done
- Mapping workflow + codex review → findings/001 (structural map; ReDoS disproven).
- **Measured root cause** → findings/002: Node harness (@_work_units/atpath_codeblock_freeze/scripts/measure_folder_encode.js) replicates `getFolderTokens` over the real files; live CLI confirmed every precondition (vault "Documents", 53,362 files, atpath v1.8.3, `showTokenCounts=true`, defaults `maxFolderFiles=500`/`batchSize=1`/`maxFileSizeMB=5`; 13 `.heic` indexed; `cachedRead(heic)` = 1,990,119 chars). ai_dev: ~83s now → ~0.4s text-only (~200×). Worst single file `IMG_1487.heic` = 9.3s in one uninterruptible `encode()`.
- Key correction to findings/001: not a transient spike — a sustained ~83s freeze; and `getTokenCount` (main.js:2484) already denylists `jpg/png/...` but **not `heic/heif`**.

## Open (fix design — needs user)
- **Primary fix** at the single decision point `getTokenCount` (@src/main.js:2484), which both the folder walk and single-file refs flow through: (a) complete the denylist, (b) allowlist text extensions, or (c) binary sniff (NUL-byte check). See findings/002 + plans/001.
- **Defense-in-depth:** total-folder-bytes budget (the `maxFolderFiles=500` cap is the wrong dimension); lower effective per-file cap.
- **Secondary (was primary):** fence guard so code blocks are inert — UX/correctness, not the freeze fix.
- **Tests + codex review** of the final diff before ship.

## Awaiting user
Fix-design decision: denylist-completion vs allowlist vs binary sniff (+ whether to bundle the fence guard now). See findings/002 §"The fix".
