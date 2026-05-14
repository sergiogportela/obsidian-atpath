# Review: AtPath status-bar slowness fix plan (plan 005)

## What to review

The plan at `_work_units/improvements/plans/005_status_slowness_fix.md`.

## Repo context

AtPath is an Obsidian community plugin that recognizes `@path/to/file`
and `@folder/` references in markdown notes, autocompletes them, shows
inline `(N tokens)` decorations using `gpt-tokenizer`, and surfaces a
status-bar segment that sums tokens across all linked targets.

Relevant code (read these before reviewing):

- `src/atpath-core.js:147-168` — `getFolderTokens` (the target of Fix A)
- `src/main.js:2440-2460` — `getTokenCount` (per-file tokenizer)
- `src/main.js:2487-2508` — `scheduleFolderTokenFetch`
- `src/main.js:2534-2619` — `updateStatusBar` (target of Fix C)
- `src/main.js:770-820` — CM6 inline decoration token rendering (Fix D site 1)
- `src/main.js:1410-1450` — markdown post-processor token rendering (Fix D site 2)
- `src/main.js:2740-2840` — `_renderLinkedPopover` (Fix D site 3)
- `src/main.js:206-223` — `DEFAULT_SETTINGS`
- `src/main.js:1480-1540` — settings tab rendering near `maxFileSizeMB`

## Evidence that motivated the plan

A `localStorage.atpath_perf = "1"` instrumentation run produced:

```
getFolderTokens.calls               = 6
getFolderTokens.walkedFiles         = 31771
getFolderTokens.encoded             = 551
getFolderTokens.encodeSize.100k+    = 59     (~195 ms each on main thread)
updateStatusBar.totalMs             = 2 samples out of 6 calls
                                       (4 hung mid-await when Obsidian froze)
getTokenCount.cachedRead avg        = ~13 sec   (resolved promises queued
                                                  behind blocking encode work)
```

Console: `File system operation timed out` after ~2 hours.

## What I want from this review

Be ruthless. The diagnosis on plan 004 already missed once; the user
wants this fix to actually land. Specifically:

1. **Correctness of the diagnosis.** Does the plan correctly identify
   the freeze cause? Is there a more proximate culprit I'm missing
   (e.g., something in CM6 viewport rebuilds, scan regex, popover
   render) that the perf data could plausibly point at? Single-digit
   ms readings for those is meant to rule them out — confirm or
   challenge.

2. **Correctness of Fix A.** The cap-then-batch-then-yield design.
   - Is `setTimeout(0)` the right yield primitive, or should it be
     `requestIdleCallback` / `queueMicrotask` / something else?
   - Is batch size 4 reasonable? Memo: a 100KB file is ~195 ms of
     synchronous encode work, so a batch of 4 = ~780 ms of blocking
     per yield. Should the batch be size 1 for safety?
   - Does the sentinel return shape (`{ overCap, fileCount }`) leak
     anywhere I missed?
   - Concurrency model: do I need to worry about a second
     `getFolderTokens(samePath)` racing in while the first is still
     batching? The memo is set only at end — two in-flight walks
     would each repeat the encode work. Worth adding an in-flight
     map?

3. **Correctness of Fix C.** Dropping the inline `await` in
   `updateStatusBar` and using `scheduleFolderTokenFetch` + placeholder.
   - Is the `pending: true` row going to look weird in the popover
     when the user opens it the first time?
   - The status-bar **total** (`linkedTotal`) excludes pending and
     over-cap folders. Will users find that confusing? Better to show
     `linkedTotal + "+"` when any folder is pending?
   - Generation token (`gen !== this._statusBarGen`) — does the
     proposed code still respect it correctly?

4. **Settings.** Do the two new keys (`maxFolderFiles`,
   `folderEncodeBatchSize`) have the right defaults? Are the labels
   sentence-case per `COMMUNITY_PLUGINS.md`?

5. **Memo invalidation.** I flagged "memo poisoning by sentinel" as a
   risk. Is the proposed mitigation (clear memo when settings change)
   sufficient? Should I also clear it on file create/delete in the
   relevant folder? The plugin already has folder-cache invalidation
   somewhere — see `clearFolderTokenMemo`.

6. **Test plan.** Are the proposed unit tests sufficient and testable
   given the existing test harness? Is the Playwright agent path
   realistic for an Electron app like Obsidian — should I fall back
   to the user-paste-perf-dump approach as primary instead?

7. **Anything out of scope I should bring in.** Or anything *in*
   scope that should be cut.

## Output format

Issue list ordered by severity:

- **Critical:** plan is wrong here, fix won't work or will regress.
- **High:** plan has a real gap; should address before implementation.
- **Medium:** plan should clarify or tighten this point.
- **Low:** nit / style / minor wording.

For each issue: file/line or plan section, the problem, and a
suggested resolution.

End with a one-line verdict: "Ship as written", "Ship with the
high/critical changes applied", or "Needs rework — here's why."

## Constraints

- No backwards-compat shims. Clean break is preferred.
- No `console.log`; use `console.warn/error/debug`.
- No `innerHTML`; use DOM API.
- Sentence case for user-facing text.
- All promises awaited, `.catch()`-ed, `.then(_, reject)`-ed, or `void`-ed.

## References

- @_work_units/improvements/plans/005_status_slowness_fix.md
- @_work_units/improvements/plans/004_status_slowness_diagnosis.md
- @src/atpath-core.js
- @src/main.js
- @CLAUDE.md
