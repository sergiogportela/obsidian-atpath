# Review: AtPath code-block @path freeze — root-cause diagnosis and proposed fix

## Requirements
- Symptom under investigation: typing an `@path` reference inside a fenced code block (```` ``` ````) in a markdown note caused Obsidian to spike to 100% CPU and freeze. The note path was deep/long: `_work_units/ai_dev/agent_orchestrator/findings/v2_cli_design_ideas.md`.
- Source of truth is `src/main.js` and `src/atpath-core.js` (NOT the built `main.js` bundle).
- Goal: identify the root cause of the freeze and assess whether the proposed fix below is correct, minimal, and sufficient.

## Work product
Proposed fix (not yet applied):
- In `buildAtPathViewPlugin.buildDecorations` (`src/main.js:831-937`), compute `const excluded = buildExcludedRanges(view.state.doc.toString())` once per build, then add `if (isInExcludedRange(absStart, excluded)) continue;` at the top of the folder exec loop (after `absStart` is computed near line 847) and the file exec loop (after `absStart` near line 901), before any token-fetch scheduling.
- `buildExcludedRanges` / `isInExcludedRange` are defined at `src/main.js:716-752` and are currently called only by `scanAtPathRefs` (`src/main.js:755-828`).

## Supporting references
- `@src/main.js` — key sites: `AT_PATH_RE` (705), `AT_PATH_FOLDER_RE` (711), `buildExcludedRanges`/`isInExcludedRange` (716-752), `scanAtPathRefs` (755-828), `buildAtPathViewPlugin.buildDecorations` (830-937), ViewPlugin `update()` (939-956), `AtPathSuggest.onTrigger`/`getSuggestions`/`_computeSuggestions` (515-701), `buildBufferCountListener`/`scheduleDocRetoken` (1111-1167), `resolveAtPath` (475-479), `resolveAtPathBroad` (481-511), `getTokenCount` (2480-2500), `scheduleTokenFetch` (2502-2525), `scheduleFolderTokenFetch` (2527-2551), `_scheduleRefresh` (2553-2570).
- `@src/atpath-core.js` — `resolveAtPathFromSource` (44-63), `resolveAtPathFolderFromSource` (65-88), `resolveAtPathTarget` (145-163), `getFolderTokens` (178-254), `getCachedFolderTokens` (259-261).
- `@STATUS.md` — open follow-ups and shelved Plan 003 perf note.
- `@_work_units/improvements/plans/005_status_slowness_fix.md` — prior folder-token fan-out freeze diagnosis and fix.
- `@_work_units/improvements/plans/007_autocomplete_slowness_fix.md` — autocomplete debounce/prefilter/narrowing work and documented residual.
- Run existing unit tests: `node --test --require ./tests/_setup.js tests/*.test.js`.
