Updated at 2026-05-29 20:40

# AtPath — Status

Plugin at **v1.8.3** on `main`, listed in the official Obsidian Community Plugins registry (`id: atpath`). Built `main.js` committed; 57 unit tests passing via `node --test --require ./tests/_setup.js tests/*.test.js`. Agent diagnosis runbook landed in `AGENTS.md` on 2026-05-15 (CLI-based, see "Testing" → "Agent diagnosis runbook"); CLI gotchas appended 2026-05-18 after the DnD diagnosis loop.

## Shipped plans

| Plan | Title | Last commit | Status |
|---|---|---|---|
| A | Initial @path autocomplete + scaffolding | `c9f4625` | shipped |
| 002 | Status bar + folder autocomplete | (history) | shipped |
| 003 | File explorer token counts | — | **NOT shipped** — spec only (`003_plan_file_explorer_token_counts.md`); zero file-explorer integration in code (`isIgnored` is a stub, no badge wiring). Prior "shipped" entry was inaccurate. |
| 004 | Status-bar slowness diagnosis | `f006122` | shipped (diagnosis) |
| 005 | Status-bar slowness fix | `aff5d54` | shipped 2026-05-15 (codex-reviewed v3) |
| 006 | Linked-@paths popover head-truncation | `e49a454` | shipped 2026-05-15 (codex-reviewed v1) |
| 005-prompt | DnD @path regression fix (Prec.highest) | `72e7424` | shipped 2026-05-18 |
| 007 | @path autocomplete slowness fix (debounce + prefilter + narrowing) | `2d23bd1` | shipped 2026-05-29 (codex-reviewed) |

See [`_work_units/improvements/plans/`](_work_units/improvements/plans/) for plan documents.

## Environment

- Obsidian: desktop **1.12.7** (app), installer **1.7.7** (out of date — prints upgrade nag on every CLI call).
- CLI registered at `/usr/local/bin/obsidian`. `dev:screenshot`, `dev:css`, `dev:cdp`, `vaults` silently fail until the installer is refreshed; remaining commands verified working (see AGENTS.md core-commands table).
- AtPath confirmed loaded at 1.8.3 and enabled.

## Open follow-ups

- [ ] (Plan 007 codex P2) Debounce timer in `AtPathSuggest.getSuggestions` (`src/main.js:547`) is only cleared by the next trigger; a dismissed trigger (e.g. typing a space) still runs one full-vault `_computeSuggestions` after the suggest UI closes. Cancel the timer on suggest close.
- [ ] (Optional, Plan 007 residual) Cap expensive fuzzy evaluations per query to cut the single ~150–250ms compute on generic 2–3 char queries. Deferred: alters ranking for huge match sets, needs sign-off.
- [ ] Plan 003 (File explorer token counts) is **unimplemented** — only spec + core stubs (`isIgnored` returns `false`, `getFolderTokens` Plan A version) exist. Repo is ready to start it; no blocking debt.
- [ ] Refresh Obsidian installer (download fresh DMG from https://obsidian.md/download) to unlock `dev:screenshot`/`dev:css`/`dev:cdp`/`vaults`. Note: the registered CLI symlink at `/usr/local/bin/obsidian` is gone; the binary still works directly at `/Applications/Obsidian.app/Contents/MacOS/obsidian` (re-register via Settings → CLI to restore the symlink).
- [x] Fixed latent mobile bug in `openInDefaultApp` — `getBasePath()` was called without the `typeof === "function"` guard. Now guarded (mobile shows a Notice instead of throwing) and the desktop-only menu items are gated behind `Platform.isMobile`.

## Latest research

- [`_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md`](_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md) — adopt official Obsidian CLI as agent diagnosis channel; skip full E2E framework for now.
