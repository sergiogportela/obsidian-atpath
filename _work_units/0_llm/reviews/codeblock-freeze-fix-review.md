**Findings**

P1 [src/main.js:1031](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:1031): The proposed fix only gates the legacy Live Preview decorator. `buildWikilinkViewPlugin` still scans `WIKILINK_ATPATH_RE` and calls `plugin.scheduleTokenFetch(vaultPath, view)` from inside its `MatchDecorator` path at [src/main.js:1048](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:1048). A fenced code block containing `[[some/file.md|@some/file.md]]` can still trigger token work while editing. If the intended invariant is “no @path behavior inside excluded ranges,” this needs the same exclusion check or a shared decoration scanner.

P2 [src/main.js:521](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:521): Autocomplete still triggers inside fenced code blocks. `AtPathSuggest.onTrigger` only checks the line prefix/boundary and does not consult excluded ranges, so typing `@...` in code can still run the large-vault suggestion path in `_computeSuggestions` / `_buildSuggestCandidates` at [src/main.js:556](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:556). Plan 007 documents that one generic paused query can still cost ~150-250ms, so the proposed decoration-only fix does not fully make code-block typing inert.

P2 [src/main.js:831](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:831): Computing `buildExcludedRanges(view.state.doc.toString())` on every `buildDecorations` call would turn a visible-range decorator into a full-document scan on `docChanged`, `viewportChanged`, `selectionSet`, and `tokenCacheDirty` rebuilds at [src/main.js:942](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:942). The correctness direction is right, but cache the excluded ranges by `state.doc` identity or recompute only on doc changes; otherwise cursor movement/token refreshes in large notes pay full-document copy + regex cost.

P3 [src/main.js:717](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:717): `buildExcludedRanges` returns YAML, then all fenced ranges, then all inline-code ranges, while `isInExcludedRange` assumes sorted ranges and breaks on `start > pos` at [src/main.js:749](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:749). Inline code that appears before the first fenced block can be missed. Sort ranges before returning, or remove the early break. This is not the fenced-block freeze root cause, but reusing the helper in decorations expands reliance on this bug.

**Assessment**

The root-cause diagnosis is mostly correct for legacy Live Preview refs: `scanAtPathRefs` already excludes code blocks for the status bar, but `buildDecorations` does not, and it can schedule token work from code-block matches. Adding an excluded-range guard before token scheduling and decoration creation in both folder and file loops is the right local fix for that path.

The proposed fix is not sufficient as stated because wikilink decorations and autocomplete remain active in fenced code blocks, and it risks a new full-document hot-path cost unless the excluded ranges are cached.

**Tests**

`node --test --require ./tests/_setup.js tests/*.test.js` passes: 57/57.