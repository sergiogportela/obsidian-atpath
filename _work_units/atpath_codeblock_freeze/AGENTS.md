# AGENTS — atpath_codeblock_freeze WU

WU-specific rules. Repo-wide rules: @AGENTS.md (root, symlinked as CLAUDE.md). CLAUDE.md here is a symlink to this file.

## Scope
Fix the @path-in-codeblock 100% CPU freeze with the most minimal surgical change. Source of truth: PRD.md, STATUS.md, **findings/002 (measured root cause)**, findings/001 (structural map), plans/001 (revised).

## Measured root cause (findings/002 — read first)
The freeze is **`.heic` photos missing from `BINARY_EXTENSIONS`** (@src/main.js:140-149), tokenized as text by `getTokenCount` (@src/main.js:2484) → `encode()`. ~78s for `ai_dev`. The **code block is incidental** — the same freeze fires in prose. The fence guard is demoted to secondary UX.

## Hard rules for this WU
- **The freeze fix is at `getTokenCount` (main.js:2484)** — the single point both the folder walk and single-file `@`-refs flow through. Fix the non-text gap here (denylist-completion / allowlist / binary sniff — decision pending). Don't reach for the fence guard as the freeze fix.
- **No regex changes.** ReDoS is empirically disproven (findings/001); editing `AT_PATH_RE`/`AT_PATH_FOLDER_RE` is wasted effort and risks match semantics.
- Keep token-count behavior for **real text files byte-identical** — only non-text/over-budget files change (to "no count").
- If/when doing the secondary **fence guard**: reuse `buildExcludedRanges`/`isInExcludedRange`, fix the P3 ordering bug first, guard with the **absolute** offset (`absStart = from + m.index`), and memoize ranges by doc identity.
- Re-measure with @_work_units/atpath_codeblock_freeze/scripts/measure_folder_encode.js after the fix to prove the dominant cost dropped.

## Commands
- Tests: `node --test --require ./tests/_setup.js tests/*.test.js`
- Build: `npm run build` (edit src/main.js → regenerates committed main.js)
- Reload after build: `obsidian plugin:reload id=atpath` (CLI installer is out of date — only eval/dev:errors/dev:console work)
- Perf lever: `localStorage['atpath-perf']='1'` → reload → `window.__atpath_perf_dump()` (reset-on-read, call once)

## Codex review
Required on the critical paths: root-cause review is done (findings/001). Run `/review-codex` again on the final patch diff before ship.
