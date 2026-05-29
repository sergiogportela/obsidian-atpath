# Context map — log-watch, @path autocomplete slowness, File Explorer token-count readiness

> Context-mapper output. This document maps relevant context only; it does **not** solve, diagnose root cause, or prescribe an implementation. Verify load-bearing claims before acting.

## Verbatim user requirements

> "See that this repo stopped in the middle of a second plan execution and I think the first plan execution wasn't completely finished, I don't remember. I need you to send explorer agents around and create a context map for the next agent using this skill /wu-context-mapper and commit and push the prompt."

> "The next agent requirements will be to keep watching the logs of Obsidian to see if everything is working as planned. I already noticed there is a lot of slowness on the autocomplete of the ad path, and I don't know what is causing that. And I also want to make sure that we are ready for the plan execution that will add the token counts on the File Explorer view. But your job is not to solve now, it's to create this context map prompt. Use as many explorers as needed."

Distilled tasks for the **next** agent (do not start until directed):
1. Keep watching Obsidian logs to confirm things work "as planned."
2. Investigate the **slowness on the @path autocomplete** (cause unknown to user).
3. Make sure the repo is **ready for the plan that adds token counts to the File Explorer view**.

## Repo state note (the "first/second plan" puzzle)

Working tree is **clean** and `main` is **up to date with origin** — nothing is literally mid-edit. The most recent committed work (prompt 005, DnD `@path` `Prec.highest` fix) is **fully finished**, including the codex P2 follow-up (`d42c16b`). No "second plan" artifact (prompt/plan 006+) exists in the repo. The likely referent of "first plan not finished" is **Plan 003 (File Explorer token counts): STATUS.md lists it "shipped" but it was never implemented** — only the spec + core stubs exist (see below). Confirm this reconciliation before acting.

## Relevant context

- `@STATUS.md` — snapshot dated 2026-05-18 (stale vs HEAD `12e2d2d`). "Shipped plans" table marks Plan 003 shipped via "(history)" with **no commit hash** — inaccurate; treat as the discrepancy to fix. "Environment" + "Open follow-ups" sections still current.
- **Log-watching (task 1)** — `@AGENTS.md` "Agent diagnosis runbook (Obsidian CLI)" section: per-session `obsidian dev:debug on`, then `dev:errors` / `dev:console level=error` / `dev:dom` / `eval`; rebuild+reload loop `npm run build && obsidian plugin:reload id=atpath`. Gotchas: `eval` drops return values (wrap in try/catch returning a string); `dev:console` is a **drain** (redirect to file once); small ring buffer (use distinct trace prefixes); pass `vault=<name>` since the agent runs from the repo, not the vault.
- Log env caveats — `@STATUS.md` Environment: app **1.12.7**, installer **1.7.7** (out of date → `dev:screenshot`/`dev:css`/`dev:cdp`/`vaults` silently fail; refresh DMG to unlock). CLI at `/usr/local/bin/obsidian`. Compliance forbids `console.log` (only `warn`/`error`/`debug`); plugin already emits `[atpath-trace]`/`[atpath-perf]` via `warn`.
- Log fallbacks + rationale — `@_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md` (Logstravaganza, DIY logger, CDP).
- **Autocomplete slowness (task 2)** — `@src/main.js:529` `getSuggestions(context)` is the per-keystroke hot path: `@src/main.js:558` iterates **all** `this.app.vault.getFiles()`, `@src/main.js:573` iterates `core.listAllFolders()`, each calls `computeDisplayPath` (`@src/atpath-core.js:90`) + Obsidian `prepareFuzzySearch` (`@src/main.js:549`), then sorts 3 tiers (`@src/main.js:588`). **No debounce, no per-query result memoization** (folder *list* is cached at `@src/atpath-core.js:259`, but display-paths/scores/sorts are recomputed every keystroke). Trigger/entry: `onTrigger` `@src/main.js:510`, class `AtPathSuggest` `@src/main.js:504`, registered `@src/main.js:2158`.
- Prior perf work (status bar, **not** autocomplete) — `@_work_units/improvements/plans/004_status_slowness_diagnosis.md` + `@_work_units/improvements/plans/005_status_slowness_fix.md`. Techniques already in tree: `setTimeout(150ms)` debounce on `_scheduleRefresh`, batched encode with `setTimeout(0)` yields, in-flight dedupe, `ATPATH_PERF` instrumentation (`@src/main.js:9`, localStorage-gated). These do **not** touch `getSuggestions`.
- **File Explorer token counts readiness (task 3)** — `@_work_units/improvements/plans/003_plan_file_explorer_token_counts.md` is the full spec (badges on file/folder rows, ignore patterns, event-driven contribution map, `TokenizeQueue`, fallback stats view, §12 codex findings C3/M11–M13). Plan doc states "Zero file-explorer integration today." **Not implemented**: only `getLeavesOfType("file-explorer")` use is `@src/main.js:401` (drag source, unrelated); `isIgnored` is a stub returning `false` `@src/atpath-core.js:150`; `getFolderTokens` (Plan A version) at `@src/atpath-core.js:146`.
- Token counts that **do** exist today (for contrast) — inline `@path` badges `@src/main.js:1204`, status-bar segments `@src/main.js:2191`, per-file `getTokenCount` `@src/main.js:2403`. Tests: `@tests/folder-tokens.test.js` covers Plan A stubs only (no Plan 003 surface).
- DnD work (last finished plan, for state confidence) — `@_work_units/improvements/prompts/005_verify_plan_a_dnd_diagnosis.md`, review `@_work_units/0_llm/reviews/005_dnd_prec_highest_fix-review.md` (P2 resolved by `d42c16b`). Untracked `@_work_units/0_llm/reviews/005_dnd_prec_highest_fix-review.stderr.log` is just the codex session log.
- Standing open follow-ups (`@STATUS.md`) — refresh Obsidian installer; latent mobile bug `@src/main.js:383` (`getBasePath()` unguarded vs the `typeof` guard at line 1158; `isDesktopOnly: false`).
- Build/test invariants — edit `@src/main.js`, `npm run build` to regenerate committed `@main.js`; tests via `node --test --require ./tests/_setup.js tests/*.test.js`.
