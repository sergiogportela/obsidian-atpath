# AtPath — Status

Living index of plans, reviews, research, and open follow-ups.
Update this file when a plan ships, a review completes, or research lands.

## Currently shipped

| Plan | Title | Commit(s) | Status |
|---|---|---|---|
| Plan A | Initial @path autocomplete + plugin scaffolding | (early commits) | shipped |
| 002 | Status bar + folder autocomplete | (history) | shipped |
| 003 | File explorer token counts | (history) | shipped |
| 004 | Status-bar slowness diagnosis | f006122, 293366a | shipped (diagnosis) |
| 005 | Status-bar slowness fix | `aff5d54` | **shipped 2026-05-15** — 41 tests, codex-reviewed v3 |
| 006 | Linked-@paths popover head-truncation + repo-relative display | `e49a454` | **shipped 2026-05-15** — codex-reviewed v1 |

Built artifact: `main.js` (committed). Tests: 41 passing.

## Latest research

| Doc | Date | Outcome |
|---|---|---|
| [`0_llm/research/2026-05-15_obsidian_log_and_cli_access.md`](0_llm/research/2026-05-15_obsidian_log_and_cli_access.md) | 2026-05-15 | Adopt **official Obsidian CLI** (1.12.7+) as agent diagnosis channel. Fallbacks: Logstravaganza plugin, DIY in-plugin logger, or `--remote-debugging-port=9222` + CDP. Skip E2E test framework for now — unit tests + CLI-driven manual loop is the right balance. |

## Environment

- **Obsidian:** desktop 1.12.7 (app), **installer 1.7.7** (out of date).
  In-app update bumped the asar to 1.12.7, but the installer binary is
  pre-CLI. On every CLI invocation Obsidian prints:
  `Your Obsidian installer is out of date. Please download the latest
  installer which includes better CLI support: https://obsidian.md/download`.
- **CLI registered:** `/usr/local/bin/obsidian` resolves; `obsidian
  version` → `1.12.7 (installer 1.7.7)`.
- **AtPath loaded:** `obsidian eval code='app.plugins.plugins.atpath
  ?.manifest?.version'` → `1.8.3`. Listed in `obsidian plugins:enabled`.

## CLI diagnosis matrix (2026-05-15, installer 1.7.7)

Tested live against the active vault — recorded what works **today**
versus what needs the installer refresh.

| Command | Status | Notes |
|---|---|---|
| `obsidian version` | ✅ | Reports app + installer version |
| `obsidian help` | ✅ | Full command list, 100+ commands |
| `obsidian plugins:enabled` | ✅ | Lists `atpath` correctly |
| `obsidian plugin:reload id=atpath` | ✅ | No output; reload confirmed via eval |
| `obsidian eval code='…'` | ✅ | Returns `=> <value>`; works on any expression |
| `obsidian dev:debug on` | ✅ | One-time attach per session; required for console capture |
| `obsidian dev:errors` | ✅ | After `dev:debug on`. Clean output: "No errors captured." |
| `obsidian dev:console` | ✅ | After `dev:debug on`. Captures live plugin debug logs |
| `obsidian dev:console level=error` | ✅ | Level filter (log/warn/error/info/debug) works |
| `obsidian dev:dom selector='…'` | ✅ | Returns outerHTML; supports `text`/`inner`/`all`/`attr` |
| `obsidian dev:screenshot path=…` | ❌ | Silent failure — needs newer installer |
| `obsidian dev:css selector='…'` | ❌ | Empty output — needs newer installer |
| `obsidian dev:cdp method=Page.captureScreenshot` | ❌ | Empty output — needs newer installer |
| `obsidian vaults` | ❌ | Empty output — needs newer installer |

### Verified surfaces against AtPath

- Status bar (Plan A §3.1, Plan 005 perf fix):
  `obsidian eval code='document.querySelector(".atpath-status-linked")
  ?.getAttribute("aria-label")'` → `@paths (2): 39k` ✅
- Linked-files popover (Plan A §3.3, Plan 006 head-truncation fix):
  `obsidian dev:dom selector=".atpath-status-linked"` returns the full
  popover DOM with `direction: rtl` container + `<bdi>` paths exactly as
  `styles.css` declares ✅
- @path links rendered in current view:
  `obsidian eval code='document.querySelectorAll(".atpath-link").length'`
  → `2` ✅

## Open follow-ups

- [x] ~~Confirm Obsidian version with user~~ — on 1.12.7 desktop.
- [ ] **Update the installer** (download a fresh `Obsidian-x.y.z.dmg`
      and reinstall) to unlock `dev:screenshot`, `dev:css`, `dev:cdp`,
      `vaults`. Existing vault + settings are preserved; this is the
      Electron binary refresh, not a data migration.
- [ ] **Add an agent diagnosis runbook** to `AGENTS.md` once the
      installer is refreshed. Working channel today:
      `dev:debug on` → `dev:errors` → `dev:console level=error` →
      `dev:dom selector="…"` → `eval code='…'` for live probes.
- [ ] **Fix latent mobile bug:** `src/main.js:383` calls
      `plugin.app.vault.adapter.getBasePath()` without the
      `typeof === "function"` guard used at line 1158. Since
      `manifest.json` has `isDesktopOnly: false`, this throws on mobile.
      Not an upgrade blocker; flagged during the 1.12.7 compatibility
      audit.

## Repo conventions reminder

- `CLAUDE.md` is a symlink to `AGENTS.md` — edit `AGENTS.md` only.
- Plan documents live under `_work_units/improvements/plans/`.
- Prompt/feedback documents live under `_work_units/improvements/prompts/`.
- LLM-driven review prompts and outputs live under `_work_units/0_llm/reviews/`.
- LLM-driven research notes live under `_work_units/0_llm/research/`.
- Tests live under `tests/`, run via
  `node --test --require ./tests/_setup.js tests/*.test.js`.
- Built `main.js` is committed (per release workflow expectations).
