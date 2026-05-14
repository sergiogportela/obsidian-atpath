**Findings**

1. **Medium: `scheduleFolderTokenFetch` still starts synchronous folder work on the status-bar path.**  
   In the proposed `updateStatusBar` change, `this.scheduleFolderTokenFetch(...)` is called inline before rendering the placeholder (`005_status_slowness_fix.md:247-252`). The current scheduler immediately calls `this.core.getFolderTokens(folderPath).then(...)`, and the proposed `getFolderTokens` still walks the subtree synchronously before its first `await` (`005_status_slowness_fix.md:164-178`). For over-cap folders it can return after the full walk without yielding at all. That means the “never block on uncached folders” guarantee is not fully true. Defer the actual `getFolderTokens` call with `setTimeout(..., 0)` or make the folder walk itself incremental/early-aborting.

2. **Medium: Popover fast path can keep rendering stale/wrong pending or over-cap counts.**  
   Fix D says to render `pending` as `"…"` and over-cap as `"> N files"` (`005_status_slowness_fix.md:306-310`), but the current popover fast path updates count text with `formatTokens(t.tokens || 0)` and its render signature only includes `kind:path`, not `pending`, `overCap`, or token state. A pending row becoming over-cap or counted can reuse the fast path and show `0` unless that path is explicitly updated. Add a shared formatter for row counts and use it in both slow and fast paths, including tooltip updates.

3. **Low: The memo invalidation mitigation is listed only under Risks, not in the implementation/test path.**  
   The plan correctly identifies stale memo poisoning when `maxFolderFiles` or `maxFileSizeMB` changes (`005_status_slowness_fix.md:429-433`), but the implementation order only says to add settings rows (`005_status_slowness_fix.md:324`) and the tests do not cover invalidation. This is easy to miss during implementation. Move memo clearing into Fix B/implementation order and add a test that changing the cap clears cached numeric and sentinel folder results.

4. **Low: The cap still requires a full subtree walk to report an exact file count.**  
   The proposed cap collects every eligible path before deciding whether the folder is over-cap (`005_status_slowness_fix.md:164-178`). That avoids mass encoding, but it does not cap traversal cost, and it preserves a synchronous worst case for very large folder trees. Consider stopping once `maxFolderFiles + 1` eligible files are found and rendering `"> 500 files"` instead of an exact count, or yield during traversal if exact counts are required.

**Residual Risk**

The plan is directionally sound for the measured bottleneck: it removes unbounded folder tokenization and moves uncached folder counts out of the awaited status-bar loop. The main remaining risk is that “scheduled” folder work is still partly synchronous unless the scheduler or traversal is changed.