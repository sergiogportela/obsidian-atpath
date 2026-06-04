Updated at 2026-06-04 20:10

Open WU. Root cause **measured, fixed, committed (`88e71ec` on main), and live-verified** in the running app (not yet released — still v1.8.3). The freeze is **~79 seconds** of synchronous `gpt-tokenizer encode()` over binary files that `BINARY_EXTENSIONS` forgot to denylist (`.heic` photos), triggered when an `@path` crosses a folder that contains them (`@_work_units/ai_dev/`). The code block is **incidental** — the same freeze fires in prose. Fence guard deferred to UX. **Part A of plans/002 is implemented**: a content sniff (`looksBinary`) at `getTokenCount` returning `null` **without caching** (keeps `tokenCache` numeric-only) + denylist additions (`heic/heif/tiff/tif`). Folder byte-budget (R2) and fence guard (R3) **deferred**.

## Done
- Mapping workflow + codex review → findings/001 (structural map; ReDoS disproven).
- **Measured root cause** → findings/002: Node harness (@_work_units/atpath_codeblock_freeze/scripts/measure_folder_encode.js) replicates `getFolderTokens` over the real files; live CLI confirmed every precondition (vault "Documents", 53,362 files, atpath v1.8.3, `showTokenCounts=true`, defaults `maxFolderFiles=500`/`batchSize=1`/`maxFileSizeMB=5`; 13 `.heic` indexed; `cachedRead(heic)` = 1,990,119 chars). Worst single file `IMG_1487.heic` = ~9 s (≈8.9–9.3 s across runs) in one uninterruptible `encode()`.
- Key correction to findings/001: not a transient spike — a sustained multi-second freeze; and `getTokenCount` (main.js:2484) already denylists `jpg/png/...` but **not `heic/heif`**.

## Implemented & committed (`88e71ec`, main) — codex clean ×2; live-verified; pending version bump
- **Part A (the whole plan now)** → plans/002_binary_sniff_fix.md, landed in the working tree: `looksBinary` pure export in @src/atpath-core.js (NUL-byte rule) + unit-test coverage; sniff wired into `getTokenCount` (@src/main.js) returning `null` **uncached** (cache stays numeric-only); denylist gained `heic/heif/tiff/tif` (@src/main.js:142).
- **Tests** 80/80 green (new @tests/binary-sniff.test.js — 23 cases: 22 `looksBinary` incl. exact 4095/4096 sample-boundary and c<32 upper-edge, plus 1 source-text structural guard that the sniff gate precedes `tokenCache.set`); `npm run build` regenerated `main.js`.
- **Codex review #1 (impl)** clean → @_work_units/0_llm/reviews/002-binary-sniff-impl-review.md (one P3 comment-only finding, fixed).
- **Codex review #2 (final patch diff)** clean → @_work_units/0_llm/reviews/002-binary-sniff-final-review.md — no blocking issues; Part A confirmed conformant (sniff at `getTokenCount` before `encode()` and before the cache write, sniffed binaries uncached, denylist limited to `heic/heif/tiff/tif`, regexes untouched); ran tests (80/80) + build + `git diff --check`; one P3 (a stale `76/76` count in plans/002 rollout step 1) fixed.
- **Post-fix re-measure** confirms the drop. `_work_units/ai_dev`: BEFORE=78741ms → AFTER=374ms (**211×**). Per-target: `ai_dev` 78741→374, `ai_dev/agent_orchestrator` 82204→196, `.../findings` 81348→141.
- **Sniff caught beyond denylist:** `.DS_Store` (extensionless macOS metadata binaries) — 10 in `ai_dev`, 4 in `agent_orchestrator`, 3 in `findings`. Their ext is `(none)`, so they are in **neither** the old nor the new (`heic/heif/tiff/tif`) denylist — only the `looksBinary` content sniff (NUL-byte rule) skips them. The `.heic`/`.jpg` files were caught by the **denylist** extension match, not the sniff.

## Live-verified (2026-06-04, running app, vault "Documents")
- Plugin reloaded; loaded `getTokenCount` confirmed to carry the sniff. Vault dev-loads this repo via symlink (`plugins/atpath → obsidian-atpath → repo`), so the committed build is what runs.
- Through the **real loaded plugin code** over **real vault files**: `IMG_1487.heic` → `getTokenCount`=`null` in **0 ms** (was ~9 s); markdown control still counts (475 tok, 2 ms). Full `ai_dev/` walk (235 files) = **316 ms**, 19 binaries `null`, 216 text counted; `dev:errors` clean. The ~78 s freeze is gone on the live plugin.

## Still pending
- **Committed** at `88e71ec` on `main` (pushed). **Version bump / release is a separate user step** — not yet done (still v1.8.3).
- **Deferred:** Part B (folder byte-budget) — prerequisites recorded in plan (distinct sentinel, `maxFolderBytes` memo invalidation mirroring @src/main.js:1521, default tuning). R3 fence guard.
