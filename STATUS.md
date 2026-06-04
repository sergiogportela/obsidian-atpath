Updated at 2026-06-04 20:14

# AtPath — Status

Plugin at **v1.8.4** on `main`, listed in the official Obsidian Community Plugins registry (`id: atpath`). Plan 003 (file-explorer token counts) is **SHELVED in a git stash** (`stash@{0}`) — implemented + codex-reviewed + 101 tests green, but the manual smoke test on a real vault showed it is **not usable**: exact `gpt-tokenizer` BPE over the whole vault pins the renderer's single JS thread at ~100% of one core on first display (folder badges force tokenizing every descendant), and nothing is persisted so the cost is re-paid on every launch. Working tree reverted to pre-plan HEAD `4ff4c32` (built `main.js` restored); resuming requires an approximate/cheaper token estimate + a persisted cache (see follow-ups). Agent diagnosis runbook landed in `AGENTS.md` on 2026-05-15 (CLI-based, see "Testing" → "Agent diagnosis runbook"); CLI gotchas appended 2026-05-18 after the DnD diagnosis loop.

## Shipped plans

| Plan | Title | Last commit | Status |
|---|---|---|---|
| A | Initial @path autocomplete + scaffolding | `c9f4625` | shipped |
| 002 | Status bar + folder autocomplete | (history) | shipped |
| 003 | File explorer token counts | `stash@{0}` | **SHELVED (stashed, not committed)** — ignore matcher + tokenize queue + contributionMap/folderTokenCache + vault-event handlers + file-explorer badge decorator + `FolderStatsView` + 4 settings fields. Codex-reviewed, 101 tests green, but smoke-failed on perf (see intro + follow-ups). Recover with `git stash apply stash@{0}`. |
| 004 | Status-bar slowness diagnosis | `f006122` | shipped (diagnosis) |
| 005 | Status-bar slowness fix | `aff5d54` | shipped 2026-05-15 (codex-reviewed v3) |
| 006 | Linked-@paths popover head-truncation | `e49a454` | shipped 2026-05-15 (codex-reviewed v1) |
| 005-prompt | DnD @path regression fix (Prec.highest) | `72e7424` | shipped 2026-05-18 |
| 007 | @path autocomplete slowness fix (debounce + prefilter + narrowing) | `2d23bd1` | shipped 2026-05-29 (codex-reviewed) |
| 002 (codeblock_freeze) | Binary-sniff freeze fix — `looksBinary` sniff at `getTokenCount` + `heic`/`heif`/`tiff`/`tif` denylist | `40a39ec` | **released v1.8.4** 2026-06-04 (codex ×2 clean; live-verified ~78s→316ms over `ai_dev/`). See [`plan`](_work_units/atpath_codeblock_freeze/plans/002_binary_sniff_fix.md) |

See [`_work_units/improvements/plans/`](_work_units/improvements/plans/) for plan documents.

## Environment

- Obsidian: desktop **1.12.7** (app), installer **1.7.7** (out of date — prints upgrade nag on every CLI call).
- CLI registered at `/usr/local/bin/obsidian`. `dev:screenshot`, `dev:css`, `dev:cdp`, `vaults` silently fail until the installer is refreshed; remaining commands verified working (see AGENTS.md core-commands table).
- AtPath confirmed loaded at 1.8.3 and enabled.

## Open follow-ups

- [ ] (Plan 007 codex P2) Debounce timer in `AtPathSuggest.getSuggestions` (`src/main.js:547`) is only cleared by the next trigger; a dismissed trigger (e.g. typing a space) still runs one full-vault `_computeSuggestions` after the suggest UI closes. Cancel the timer on suggest close.
- [ ] (Optional, Plan 007 residual) Cap expensive fuzzy evaluations per query to cut the single ~150–250ms compute on generic 2–3 char queries. Deferred: alters ranking for huge match sets, needs sign-off.
- [ ] (Plan 003 SHELVED — perf blocker) Smoke test on a real vault pinned the renderer JS thread at ~100% of one core on first file-explorer display. Cause: exact `gpt-tokenizer` BPE `encode()` is synchronous and runs once per file; folder badges aggregate every descendant, so showing top-level folder badges forces near-full-vault tokenization on the single JS thread (queue concurrency 2 doesn't help — both tasks' `encode()` calls run serially on the one thread). Code is preserved in `git stash@{0}`.
- [ ] (Plan 003 prerequisite #1 — approximate tokenizer) Replace exact gpt-tokenizer BPE with a cheap approximation (e.g. chars/4 or word-count heuristic, optionally exact-on-demand for a single hovered file). Removes the per-file CPU cost that makes first-run unusable.
- [ ] (Plan 003 prerequisite #2 — persistent cache) Persist per-file token snapshots (keyed by path + mtime/size) across restarts so the cost is paid once, not on every launch. Currently only `settings` is saved via `saveData`/`loadData`; `contributionMap`/`folderTokenCache` are in-memory only.
- [ ] Refresh Obsidian installer (download fresh DMG from https://obsidian.md/download) to unlock `dev:screenshot`/`dev:css`/`dev:cdp`/`vaults`. Note: the registered CLI symlink at `/usr/local/bin/obsidian` is gone; the binary still works directly at `/Applications/Obsidian.app/Contents/MacOS/obsidian` (re-register via Settings → CLI to restore the symlink).
- [x] Fixed latent mobile bug in `openInDefaultApp` — `getBasePath()` was called without the `typeof === "function"` guard. Now guarded (mobile shows a Notice instead of throwing) and the desktop-only menu items are gated behind `Platform.isMobile`.

## Latest research

- [`_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md`](_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md) — adopt official Obsidian CLI as agent diagnosis channel; skip full E2E framework for now.
