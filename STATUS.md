Updated at 2026-05-18 20:50

# AtPath — Status

Plugin at **v1.8.3** on `main`, listed in the official Obsidian Community Plugins registry (`id: atpath`). Built `main.js` committed; 48 unit tests passing via `node --test --require ./tests/_setup.js tests/*.test.js`. Agent diagnosis runbook landed in `AGENTS.md` on 2026-05-15 (CLI-based, see "Testing" → "Agent diagnosis runbook"); CLI gotchas appended 2026-05-18 after the DnD diagnosis loop.

## Shipped plans

| Plan | Title | Last commit | Status |
|---|---|---|---|
| A | Initial @path autocomplete + scaffolding | `c9f4625` | shipped |
| 002 | Status bar + folder autocomplete | (history) | shipped |
| 003 | File explorer token counts | (history) | shipped |
| 004 | Status-bar slowness diagnosis | `f006122` | shipped (diagnosis) |
| 005 | Status-bar slowness fix | `aff5d54` | shipped 2026-05-15 (codex-reviewed v3) |
| 006 | Linked-@paths popover head-truncation | `e49a454` | shipped 2026-05-15 (codex-reviewed v1) |
| 005-prompt | DnD @path regression fix (Prec.highest) | `72e7424` | shipped 2026-05-18 |

See [`_work_units/improvements/plans/`](_work_units/improvements/plans/) for plan documents.

## Environment

- Obsidian: desktop **1.12.7** (app), installer **1.7.7** (out of date — prints upgrade nag on every CLI call).
- CLI registered at `/usr/local/bin/obsidian`. `dev:screenshot`, `dev:css`, `dev:cdp`, `vaults` silently fail until the installer is refreshed; remaining commands verified working (see AGENTS.md core-commands table).
- AtPath confirmed loaded at 1.8.3 and enabled.

## Open follow-ups

- [ ] Refresh Obsidian installer (download fresh DMG from https://obsidian.md/download) to unlock `dev:screenshot`/`dev:css`/`dev:cdp`/`vaults`.
- [ ] Fix latent mobile bug at `src/main.js:383` — `plugin.app.vault.adapter.getBasePath()` is called without the `typeof === "function"` guard used at line 1158. `manifest.json` has `isDesktopOnly: false`, so this throws on mobile.

## Latest research

- [`_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md`](_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md) — adopt official Obsidian CLI as agent diagnosis channel; skip full E2E framework for now.
