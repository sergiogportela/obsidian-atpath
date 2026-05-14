Diagnosis: I buy the main diagnosis. The perf data strongly points to unbounded folder token fan-out plus the inline `await` in `updateStatusBar`; single-digit timings for scan, CM6 decoration rebuilds, and popover render are enough to rule them out for this repro. The plan still has some real gaps before implementation.

**Critical**

None.

**High**

- [005_status_slowness_fix.md:145](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/improvements/plans/005_status_slowness_fix.md:145): Batch size `4` is too high for the measured cost. Four 100 KB encodes can block ~780 ms before the `setTimeout(0)` yield, which violates the 150 ms latency target.
  Suggested resolution: use batch size `1` by default. `setTimeout(0)` is the right primitive here; `queueMicrotask` would not release to paint/input, and `requestIdleCallback` can starve. Also stop claiming `maxFileSizeMB` caps the worst case, since 100 KB already measured at ~195 ms.

- [src/atpath-core.js:147](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/atpath-core.js:147), [src/main.js:1422](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:1422): Fix A needs a core-level in-flight map. `scheduleFolderTokenFetch` dedupes only callers that go through it; the post-processor still calls `core.getFolderTokens()` directly, and future direct callers can race.
  Suggested resolution: add `folderTokenInflight`, set it before the first await, return the same promise for the same folder, and delete it in `finally`.

- [005_status_slowness_fix.md:429](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/improvements/plans/005_status_slowness_fix.md:429), [src/main.js:2268](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2268): Memo invalidation must handle in-flight stale writes, not just cached sentinels. Current vault events already clear folder memo on modify/create/delete/rename/file-open, but a long-running batch can finish after that clear and re-memoize stale data.
  Suggested resolution: add a folder-token memo generation/epoch. Increment it in `clearFolderTokenMemo`; only memoize a completed result if the epoch is unchanged.

- [src/main.js:2777](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2777), [src/main.js:2833](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2833), [src/main.js:2908](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2908): Fix D is incomplete for popover fast-path updates. A row can go from pending to over-cap with the same `renderSig`; the fast path currently only updates count text/checkbox, and selected total treats unknown folders as `0`.
  Suggested resolution: add one helper like `formatLinkedTargetCount(t)` and use it in fast path, slow path, selected total, and header. Either include pending/overCap state in `renderSig` or update tooltip/classes/title in the fast path too.

- [src/main.js:2955](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2955), [src/main.js:3086](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:3086): Over-cap folders remain selectable in the popover, and copy actions still walk/read/tokenize every descendant. That can recreate the same freeze via “Copy selected” or “Copy selected + note.”
  Suggested resolution: pending and over-cap folder rows should be unchecked/disabled for copy, or the copy paths must enforce `maxFolderFiles` and skip with a Notice.

**Medium**

- [005_status_slowness_fix.md:164](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/improvements/plans/005_status_slowness_fix.md:164): Exact `fileCount` requires walking the entire subtree before returning the sentinel. That is much cheaper than encoding, but still scales badly.
  Suggested resolution: stop once `paths.length > maxFolderFiles` and display `> 500 files` instead of exact `> 551 files`, or count exactly with a yielding traversal.

- [005_status_slowness_fix.md:312](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/improvements/plans/005_status_slowness_fix.md:312): Excluding pending/over-cap folders from `linkedTotal` is honest but visually ambiguous.
  Suggested resolution: render the total as partial, for example `12k+`, whenever any linked target is pending or over-cap. Do the same in the popover header and aria label.

- [src/main.js:2599](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2599), [005_status_slowness_fix.md:406](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/improvements/plans/005_status_slowness_fix.md:406): Keeping file refs inline is acceptable for this repro, but the rationale is too strong. Cold file refs can still block on synchronous encode.
  Suggested resolution: either soften this as a known residual risk, or use `scheduleTokenFetch` plus placeholders for uncached file refs too.

- [005_status_slowness_fix.md:357](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/improvements/plans/005_status_slowness_fix.md:357): Playwright verification is unlikely to be reliable for Obsidian unless it is launched with a remote debugging endpoint.
  Suggested resolution: make the fresh `ATPATH_PERF` dump the primary verification path. Treat Playwright/Electron automation as opportunistic.

- [src/main.js:1497](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:1497): Settings invalidation should be explicit. `maxFolderFiles` and `maxFileSizeMB` changes must clear folder token memo and refresh displays; `folderEncodeBatchSize` does not need memo clearing.
  Suggested resolution: in those setting `onChange` handlers, save settings, clear folder memo where needed, then call the token refresh path with promises handled.

**Low**

- [005_status_slowness_fix.md:197](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/improvements/plans/005_status_slowness_fix.md:197): “There are 6 call sites” is misleading; the list shows fewer direct call sites and misses aggregate render consumers like selected totals.
  Suggested resolution: replace the count with “grep all `getFolderTokens`, `getCachedFolderTokens`, and `t.tokens` render paths.”

Verdict: Ship with the high/critical changes applied.
