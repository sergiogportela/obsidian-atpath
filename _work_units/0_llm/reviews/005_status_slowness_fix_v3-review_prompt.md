# Review: AtPath status-bar slowness fix plan (005, revised)

## Requirements

- Obsidian becomes "extremely slow" and the bottom status bar freezes
  when a note containing `@folder/...` references is the active editor.
  User repro note: `STATUS_ai_dev.md` (~30 `@_work_units/...` refs plus
  a couple of folder refs). (paraphrase of the user's repro report)
- Console error observed during the freeze:
  `File system operation timed out` (after roughly 2 hours).
- A `localStorage.atpath_perf = "1"` instrumentation pass produced
  the following counters in the freeze-repro session:

  ```
  getFolderTokens.calls               = 6
  getFolderTokens.walkedFiles         = 31771
  getFolderTokens.encoded             = 551
  getFolderTokens.skippedTooLarge     = 12
  getFolderTokens.encodeSize.lt1k     = 51
  getFolderTokens.encodeSize.1-5k     = 287
  getFolderTokens.encodeSize.5-20k    = 134
  getFolderTokens.encodeSize.20-100k  = 20
  getFolderTokens.encodeSize.100k+    = 59
  updateStatusBar.calls               = 6
  updateStatusBar.totalMs             = 2 samples (4 calls hung mid-await
                                                    when Obsidian froze)
  getTokenCount.cachedRead avg        = ~13 sec
  ```

- AtPath is being prepared for the Obsidian Community Plugins
  directory; code must comply with the rules summarized in `CLAUDE.md`
  (no `console.log`, no `innerHTML`, sentence case for user-facing
  text, all promises awaited or `void`-ed, no `var`, etc.).
- The plan must be executable by a fresh agent with no prior session
  context: file paths, line ranges, function signatures, return
  shapes, settings keys, helper definitions, and acceptance criteria
  must all be self-contained in the plan document.

## Work product

- Plan to review: `_work_units/improvements/plans/005_status_slowness_fix.md`

  This is the third iteration of the plan. Two prior reviews are in
  `_work_units/0_llm/reviews/` (`005_status_slowness_fix_review.md`
  and `005_status_slowness_fix_v2-review.md`); the current plan was
  rewritten to incorporate findings from both.

  Diff against `main`:
  ```
  git -C /Users/sergio/Documents/code/obsidian_plugin_atpath log -1 --stat -- _work_units/improvements/plans/005_status_slowness_fix.md
  git -C /Users/sergio/Documents/code/obsidian_plugin_atpath show HEAD -- _work_units/improvements/plans/005_status_slowness_fix.md
  ```

- Prior diagnosis plan referenced by 005:
  `_work_units/improvements/plans/004_status_slowness_diagnosis.md`

- Implementation files the plan modifies:
  - `src/atpath-core.js` (`getFolderTokens`, `getCachedFolderTokens`,
    `clearFolderTokenMemo`)
  - `src/main.js` (`getTokenCount`, `scheduleFolderTokenFetch`,
    `updateStatusBar`, `_renderLinkedPopover`, CM6 inline decoration
    rendering, markdown post-processor rendering, `DEFAULT_SETTINGS`,
    `AtPathSettingTab.display`, copy-selected handlers)

- Build command: `npm run build` (esbuild, output `main.js`).
- Test command: `npm test`.

## Supporting references

- @_work_units/improvements/plans/005_status_slowness_fix.md
- @_work_units/improvements/plans/004_status_slowness_diagnosis.md
- @_work_units/0_llm/reviews/005_status_slowness_fix_review.md
- @_work_units/0_llm/reviews/005_status_slowness_fix_v2-review.md
- @src/atpath-core.js
- @src/main.js
- @CLAUDE.md
- @COMMUNITY_PLUGINS.md
