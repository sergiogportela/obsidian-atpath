# Review: STATUS.md relocation + slim, AGENTS.md STATUS contract, README settings refresh

## Requirements
- User request (verbatim):
  > "Okay, but I see that the current status file is inside the work units folder. I think you should fix that. And also make sure the readme is up to date and also fix it."
- User-supplied STATUS contract (verbatim, applied to the repo-root status file):
  > "Since this is a small repo, we don't really need status files inside the work units, we can use a single one on the repo root."
  >
  > # status-update
  >
  > Refresh one WU @STATUS.md. You may fix/move stale WU-doc facts when needed. External data is read-only.
  >
  > ## Contract
  > - First line: `Updated at YYYY-MM-DD HH:MM` local time.
  > - Factual snapshot only: current reality from WU docs, Git, source files, and explicit user requirements.
  > - ~30 lines max; link out instead of expanding.
  > - Start with 1-3 sentences describing current state.
  > - Other sections are optional; preserve useful existing structure when it works.
  > - List open work only when it comes from active plans/docs/user requests.
  > - Never add your own recommended next steps, priorities, or strategy.
  > - Sub-WU STATUS.md owns its scope; link, don't duplicate.
  >
  > ## Inputs
  > Use current @STATUS.md timestamp as the main boundary, with a ~24h lookback buffer for Git/docs/history to catch missed or near-boundary changes.
  > Check relevant WU docs, modified plans/findings/prompts, WU @AGENTS.md, sub-WU statuses, Git history, linked code/infra paths, and referenced external truth sources.
  >
  > ## Rules
  > - Verify carried-forward claims before keeping them.
  > - Closed detail belongs in linked plans/findings/commits, not STATUS.
  > - Before dropping useful facts, ensure they exist in the durable owner.
  > - Drift or unresolved facts become open factual items; do not repair external data here.
- Project conventions in `@AGENTS.md` (CLAUDE.md is a symlink).
- Memory note (persistent): user prefers the **simplest reliable approach**; clean breaks over backwards-compat shims; agent-driven verification over manual test steps.

## Work product
- Commit under review: `7ddd818` on `main` (`d8e71a8..7ddd818`). Diff: `git show 7ddd818`.
- Files in this commit:
  - `STATUS.md` (new, at repo root)
  - `AGENTS.md` (modified — STATUS reference moved out of `_work_units/` block; new "STATUS.md contract" subsection)
  - `README.md` (modified — settings table; community-plugin install line)
  - `_work_units/STATUS.md` (deleted)
- Prior STATUS content for comparison: `git show d8e71a8:_work_units/STATUS.md`.

## Supporting references
- `@STATUS.md` (new, repo-root version)
- `@AGENTS.md`
- `@README.md`
- `@_work_units/improvements/plans/` (Plan A, 002–006)
- `@_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md`
- `@src/main.js` (settings registration at lines 1494–1690 covers the README table)
- `@manifest.json`, `@package.json` (version `1.8.3`, `isDesktopOnly: false`)
- Git: branch `main`, head `7ddd818`, prior head `d8e71a8`. Working tree clean.
- `git log --oneline -10`
- `grep -rn "STATUS.md" .` (cross-doc references)
