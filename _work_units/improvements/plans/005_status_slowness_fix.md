# 005 — FIX: Folder-ref token sums freeze the status bar

## TL;DR for the fresh agent

The slowness in `STATUS_ai_dev.md` is caused by a single function:
`getFolderTokens` in `src/atpath-core.js:147-168`. It walks the entire
folder subtree, then kicks off **every** per-file token job in a single
unbounded `Promise.all`. On a folder ref pointing at `_work_units/...`,
the walk produced **31,771 file lookups**, of which **551 actually ran
`cachedRead + encode`** on the main thread — including 59 files in the
100KB+ bucket (~195 ms each via `gpt-tokenizer`).

`updateStatusBar` (`src/main.js:2580-2608`) compounds the freeze: it
`await`s `getFolderTokens` *inline* inside its `for (const ref of refs)`
loop. So the status-bar refresh is blocked for the entire duration of
the folder walk — that's why the bottom bar becomes unclickable. The
filesystem layer eventually times out at ~2 hours with
`File system operation timed out`.

This plan ships five surgical changes that:

1. **A.** Cap any one folder walk at `maxFolderFiles` files via a
   short-circuit traversal (no full pre-walk), in-flight dedupe, and
   memo-epoch correctness against concurrent invalidation
2. **B.** Add the new settings and wire memo invalidation when caps change
3. **C.** Stop `updateStatusBar` from `await`ing the walk — render a
   placeholder, schedule the fetch, re-render when it settles. Render
   `linkedTotal` with a `+` suffix when any target is pending/over-cap
4. **D.** Render the over-cap and pending affordances at every
   consumer (CM6 inline, post-processor, popover slow + fast paths) via
   one shared `formatLinkedTargetCount(t)` helper, with `pending` /
   `overCap` baked into the popover `renderSig`
5. **E.** Gate the copy actions so over-cap / pending folder rows
   cannot recreate the freeze via "Copy selected"

No new abstractions beyond the shared helper, no backwards-compat
shims, no settings migration. Clean break — per user preference
[[feedback_approach]].

---

## Evidence (perf dump excerpts from the freeze repro)

From the `localStorage.atpath_perf = "1"` instrumentation Phase 1 run.
Numbers are the user's actual session before Obsidian froze:

```
getFolderTokens.calls               = 6
getFolderTokens.walkedFiles         = 31771   (sum across 6 calls)
getFolderTokens.encoded             = 551
getFolderTokens.skippedTooLarge     = 12
getFolderTokens.encodeSize.lt1k     = 51
getFolderTokens.encodeSize.1-5k     = 287
getFolderTokens.encodeSize.5-20k    = 134
getFolderTokens.encodeSize.20-100k  = 20
getFolderTokens.encodeSize.100k+    = 59     ← ~195 ms each, on main thread

updateStatusBar.calls               = 6
updateStatusBar.totalMs             = 2 samples (the other 4 were mid-await
                                      when the freeze killed the dump)

getTokenCount.cachedRead avg        = ~13 sec   ← not FS slowness; this is
                                                   the resolved promise sitting
                                                   queued behind blocking encode
                                                   work on the same loop
```

Console: `File system operation timed out` after ~2 hours (the OS-level
fs layer giving up on a queued read). No exception inside the plugin.

Scan timing (`scanAtPathRefs`, MatchDecorator viewport rebuilds, popover
render, buffer encode) all timed in **single-digit ms** — they are
**not** the bottleneck. The diagnosis from plan 004 was correct:
folder-ref fan-out is the only meaningful contributor.

---

## Root cause, in code

### `src/atpath-core.js:147-168` — unbounded Promise.all

```javascript
async function getFolderTokens(folderPath) {
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!(folder instanceof TFolder)) return 0;
  if (folderTokenMemo.has(folderPath)) return folderTokenMemo.get(folderPath);
  const sizeCapBytes = (plugin.settings && plugin.settings.maxFileSizeMB
    ? plugin.settings.maxFileSizeMB
    : 5) * 1024 * 1024;
  const tasks = [];
  (function walk(node) {
    for (const c of node.children) {
      if (c instanceof TFolder) {
        walk(c);
      } else if (c instanceof TFile && !isIgnored(c.path) && c.stat.size <= sizeCapBytes) {
        tasks.push(getFileTokens(c.path));   // ← starts the promise immediately
      }
    }
  })(folder);
  const counts = await Promise.all(tasks);   // ← all 551 encode jobs in flight
  const total = counts.reduce((a, b) => a + (b || 0), 0);
  folderTokenMemo.set(folderPath, total);
  return total;
}
```

Every push of `getFileTokens(c.path)` immediately starts an `async`
chain that (on cache miss) calls `vault.cachedRead` and then a
synchronous `encode()`. With no batching and no event-loop yield, the
main thread chews through them back-to-back.

### `src/main.js:2580-2608` — status bar awaits the walk

```javascript
for (const ref of refs) {
  ...
  if (resolved.kind === "folder") {
    const cached = this.core.getCachedFolderTokens(normalizedPath);
    if (cached != null) tokens = cached;
    else {
      try {
        tokens = await this.core.getFolderTokens(normalizedPath);  // ← blocks UI
      } catch (err) {
        console.warn("[atpath] folder token sum failed", err);
        tokens = 0;
      }
    }
  } else {
    tokens = await this.getTokenCount(normalizedPath);
  }
  ...
}
```

This is why the *status bar itself* freezes. Even if `getFolderTokens`
were fast, this loop should not block on first-paint of the bar; if it
did, hovering the bar to inspect numbers would be unusable on cold
state.

---

## Fix design

Five surgical changes. Order matters — A unblocks B, B+C unblock D, D
exposes the rows that E must gate.

### Fix A — `getFolderTokens`: short-circuit cap + small-batch encode + yield + in-flight + epoch

`src/atpath-core.js:147-168`. Replace the body of `getFolderTokens` with:

1. Walk the subtree, but **stop as soon as `paths.length > maxFolderFiles`**
   so a 30k-file folder never costs a full traversal. Render
   `> N files` instead of an exact count.
2. If short-circuited: memoize a sentinel
   `{ overCap: true, fileCount: paths.length }` (note: `fileCount` is
   `> maxFolderFiles`, not exact — see render rule below) and return.
3. Otherwise, process the path list in batches of `settings.folderEncodeBatchSize`
   (default **1**, not 4: a single 100KB file can already burn ~195 ms,
   and 4×195ms = 780ms violates the 150ms keystroke target). Between
   batches, `await new Promise(r => setTimeout(r, 0))` to release the
   main thread.
4. Sum and memoize as today, **but only if the memo epoch did not
   change while the walk was running** (see step 6).
5. Add `folderTokenInflight`, a `Map<folderPath, Promise>`. Set it
   before the first await; if a second caller asks for the same
   folder while a walk is in flight, return the same promise. Delete
   in `finally`.
6. Add `folderTokenEpoch`, a counter incremented in
   `clearFolderTokenMemo`. Snapshot it at the start of `getFolderTokens`;
   only memoize the completed result if it is unchanged at the end.
   This prevents a long-running batch from writing stale data after
   a vault event (modify/create/delete/rename/file-open) has cleared
   the memo for newer numbers.

Pseudocode:

```javascript
let folderTokenEpoch = 0;
const folderTokenInflight = new Map();

function clearFolderTokenMemo(folderPath) {
  folderTokenEpoch++;
  if (folderPath) folderTokenMemo.delete(folderPath);
  else folderTokenMemo.clear();
}

async function getFolderTokens(folderPath) {
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!(folder instanceof TFolder)) return 0;
  const memo = folderTokenMemo.get(folderPath);
  if (memo !== undefined) return memo;

  const inflight = folderTokenInflight.get(folderPath);
  if (inflight) return inflight;

  const promise = (async () => {
    const settings = plugin.settings || {};
    const sizeCapBytes = (settings.maxFileSizeMB || 5) * 1024 * 1024;
    const maxFiles = settings.maxFolderFiles || 500;
    const batchSize = settings.folderEncodeBatchSize || 1;
    const startEpoch = folderTokenEpoch;

    const paths = [];
    let overCap = false;
    (function walk(node) {
      if (overCap) return;
      for (const c of node.children) {
        if (overCap) return;
        if (c instanceof TFolder) walk(c);
        else if (c instanceof TFile && !isIgnored(c.path) && c.stat.size <= sizeCapBytes) {
          paths.push(c.path);
          if (paths.length > maxFiles) { overCap = true; return; }
        }
      }
    })(folder);

    if (overCap) {
      const sentinel = { overCap: true, fileCount: paths.length }; // > maxFiles
      if (folderTokenEpoch === startEpoch) folderTokenMemo.set(folderPath, sentinel);
      return sentinel;
    }

    let total = 0;
    for (let i = 0; i < paths.length; i += batchSize) {
      const slice = paths.slice(i, i + batchSize);
      const counts = await Promise.all(slice.map(getFileTokens));
      for (const n of counts) total += n || 0;
      if (i + batchSize < paths.length) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
    if (folderTokenEpoch === startEpoch) folderTokenMemo.set(folderPath, total);
    return total;
  })();

  folderTokenInflight.set(folderPath, promise);
  try { return await promise; }
  finally { folderTokenInflight.delete(folderPath); }
}
```

Notes:

- `setTimeout(0)` is the right yield primitive. `queueMicrotask` would
  not release to paint/input; `requestIdleCallback` can starve under
  user interaction.
- The walk itself is still synchronous up to `maxFolderFiles + 1`
  files. With the short-circuit that is bounded; for a 500-cap vault
  this is cheap (filesystem tree traversal in memory). Acknowledged
  residual risk: if the user raises `maxFolderFiles` to a very large
  number, the walk prefix can become a noticeable hitch. Not mitigated
  in this plan.

**Return type change:** `getFolderTokens` now returns either a `number`
or a sentinel object `{ overCap: true, fileCount }`. Update
`getCachedFolderTokens` to return the same shape. All callers must
handle both. To find every consumer:

```
git grep -nE "getFolderTokens|getCachedFolderTokens" src/
git grep -n "t\.tokens" src/
```

Each rendering site that currently shows `formatTokens(n)` must
handle the over-cap shape via the shared `formatLinkedTargetCount(t)`
helper from Fix D.

### Fix B — Settings additions + memo invalidation wiring

`src/main.js:206-223` (`DEFAULT_SETTINGS`):

```javascript
maxFolderFiles: 500,
folderEncodeBatchSize: 1,
```

Settings tab (`AtPathSettingTab.display`, near the existing
`maxFileSizeMB` row at `src/main.js:1497`):

- "Max files per folder reference" — number input, default 500. Help
  text: "Folder @path references that resolve to more files than this
  show `> N files (skipped)` instead of a token count, to avoid
  freezing Obsidian on huge folders."
- "Folder encode batch size" — number input, default 1. Help text:
  "Lower = smoother UI but slower folder counts. Raise only if your
  vault is small."

Both validated to positive integers. Sentence case per
`COMMUNITY_PLUGINS.md` rules.

**Memo invalidation on settings change** (this is part of Fix B, not a
risk-section afterthought):

- `maxFolderFiles` `onChange` and `maxFileSizeMB` `onChange` must call
  `plugin.core.clearFolderTokenMemo()` (no arg → wipe all) after
  `saveSettings()`, then trigger the next refresh path (`updateStatusBar`,
  any open popover, any visible CM6 view) with the returned promise
  awaited / `void`-ed per project rules.
- `folderEncodeBatchSize` `onChange` saves but does not clear memo —
  it only changes future walks.

### Fix C — `updateStatusBar`: never block on uncached folders, mark partial total

`src/main.js:2580-2608`. Replace the inline `await getFolderTokens` with
schedule-and-skip:

```javascript
let pendingOrOverCap = false;
for (const ref of refs) {
  const resolved = this.core.resolveAtPathTarget(ref, activeFile.path);
  if (resolved.kind === "missing") continue;
  const normalizedPath = resolved.normalizedPath;
  if (seen.has(normalizedPath)) continue;
  seen.add(normalizedPath);

  let tokens = null;
  let overCap = null;
  if (resolved.kind === "folder") {
    const cached = this.core.getCachedFolderTokens(normalizedPath);
    if (cached == null) {
      this.scheduleFolderTokenFetch(normalizedPath, this._lastEditorView);
      // render placeholder this pass; re-render fires when fetch settles
      linkedTargets.push({ kind: "folder", path: normalizedPath, tokens: null, pending: true });
      pendingOrOverCap = true;
      continue;
    }
    if (cached && typeof cached === "object" && cached.overCap) {
      overCap = cached;
    } else {
      tokens = cached;
    }
  } else {
    tokens = await this.getTokenCount(normalizedPath);
  }
  if (gen !== this._statusBarGen) return;

  if (overCap) {
    linkedTargets.push({ kind: "folder", path: normalizedPath, tokens: 0, overCap });
    pendingOrOverCap = true;
  } else if (tokens != null) {
    linkedTotal += tokens;
    linkedTargets.push({ kind: resolved.kind, path: normalizedPath, tokens });
  }
}
```

When rendering the status-bar segment, if `pendingOrOverCap` is true,
display the total as `formatTokens(linkedTotal) + "+"` (e.g. `12k+`)
and update the `aria-label` to clarify that some targets are not yet
counted. Apply the same `+` rule to the popover header total. This is
honest about partial information without silently hiding it.

Notes:

- The per-file `await this.getTokenCount(normalizedPath)` is kept
  inline because per-file `getTokenCount.encode` was single-digit ms
  in this repro and `maxFileSizeMB` already caps the worst case. This
  is a **known residual risk**: a cold note with many uncached
  100KB+ file refs could still hitch. Concurrency-limiting per-file
  refs is out of scope for this plan; revisit if a future repro
  shows it.
- `pending: true` tells the popover renderer (Fix D) to display "…"
  for that row.
- The existing `scheduleFolderTokenFetch` already calls
  `_scheduleRefresh` on completion which calls `updateStatusBar` — so
  the placeholder gets replaced automatically as soon as the (now
  yielding) walk finishes. The scheduler still has a synchronous
  prefix until the walk's first `await`; with the short-circuit cap
  in Fix A that prefix is bounded.

### Fix D — Render affordances via one shared helper

Three render sites need to handle the sentinel and the `pending` row.
Introduce one shared helper to keep slow + fast paths consistent:

```javascript
// utility used by every consumer that previously called formatTokens(t.tokens)
function formatLinkedTargetCount(t) {
  if (t.pending) return "…";
  if (t.overCap) return "> " + t.overCap.fileCount + " files";
  return formatTokens(t.tokens || 0);
}
```

Sites:

1. **CM6 inline decoration** (`src/main.js:773-775`):
   ```javascript
   const cached = plugin.core.getCachedFolderTokens(resolved.normalizedPath);
   if (cached == null) {
     plugin.scheduleFolderTokenFetch(resolved.normalizedPath, view);
     tokenStr = "…";
   } else if (cached && typeof cached === "object" && cached.overCap) {
     tokenStr = formatLinkedTargetCount({ overCap: cached });
   } else {
     tokenStr = formatTokens(cached);
   }
   ```

2. **Post-processor span** (`src/main.js:1418-1428`): same shape.
   Replace the `.then((tokens) => ...)` to handle the sentinel from
   the `getFolderTokens` resolution as well.

3. **Status bar popover** (`src/main.js:_renderLinkedPopover`,
   `src/main.js:2740`-onward):
   - Use `formatLinkedTargetCount(t)` in the slow render and in the
     fast path's count update — currently the fast path uses
     `formatTokens(t.tokens || 0)` directly, which would render `0`
     for an over-cap or pending row.
   - Add `pending` and `overCap` (truthiness) to the `renderSig` so a
     row transitioning from pending → over-cap → counted forces a
     full re-render rather than a fast-path patch. The fast path may
     still be used for token count drift on already-counted rows.
   - Update the row tooltip / class / `title` in the fast path too:
     "Skipped: over the configured max-files limit" for over-cap,
     "Counting…" for pending.
   - The popover header total uses the same `formatTokens(total) +
     (anyPendingOrOverCap ? "+" : "")` rule as Fix C.
   - The "Copy selected" footer's selected-token total uses
     `formatLinkedTargetCount` too, treating pending/over-cap as `0`
     **and** disabling the row from being counted in the selection
     (see Fix E).

### Fix E — Gate copy actions for over-cap / pending rows

`src/main.js:2955`, `src/main.js:3086`, and any other "Copy selected"
or "Copy selected + note" handlers:

- A row with `t.pending` or `t.overCap` must be **unchecked and
  disabled** in the popover's selection UI. Show a tooltip: "Skipped:
  too many files" / "Still counting…".
- The copy paths must defensively skip such rows even if a stale
  selection list contains them, and emit a `Notice` ("Skipped N
  folder(s): over the configured max-files limit").
- This prevents "Copy selected" from triggering the same unbounded
  walk we just removed from the status bar.

---

## Implementation order

1. **`src/atpath-core.js`**: rewrite `getFolderTokens` per Fix A —
   short-circuit walk, batch=1 default, in-flight map, epoch counter.
   Update `clearFolderTokenMemo` to bump the epoch. Update
   `getCachedFolderTokens` doc comment to note the union return shape.
   Build, run unit tests.
2. **`src/main.js`**: add settings keys (Fix B), settings tab rows,
   wire `maxFolderFiles` / `maxFileSizeMB` `onChange` to clear folder
   memo and trigger the refresh path.
3. **`src/main.js`**: update `updateStatusBar` per Fix C, including
   `pending`/`overCap` fields on `linkedTargets` and the `+` total
   suffix when partial.
4. **`src/main.js`**: add the shared `formatLinkedTargetCount(t)`
   helper. Update the 3 render sites for Fix D. Find them with:
   ```
   git grep -nE "getFolderTokens|getCachedFolderTokens" src/
   git grep -n "t\.tokens" src/
   ```
   (Don't trust a hardcoded count — there are aggregate render
   consumers like the popover selected-total.) Include `pending` /
   `overCap` truthiness in the popover `renderSig`. Update tooltips /
   classes / `title` in the fast path.
5. **`src/main.js`**: gate copy actions per Fix E — disable selection
   for over-cap/pending rows, defensive skip + `Notice` in the copy
   handlers.
6. **`src/main.js`**: update `scheduleFolderTokenFetch.then` callback
   to no-op gracefully when the result is a sentinel (no token sum to
   surface — the next render reads it from the cache anyway).
7. `npm run build` to regenerate `main.js`.
8. Run automated test suite.
9. Verification (see test plan).

---

## Test plan

Per user preference [[feedback_verification]]: agent-driven, no manual
steps for the user beyond "open Obsidian and the test note."

### Automated (must pass before declaring done)

- `npm test` — all existing tests still pass.
- New unit tests in `tests/`:
  - `getFolderTokens` returns a number when files ≤ cap.
  - `getFolderTokens` returns `{ overCap: true, fileCount }` when
    files > cap; memoizes the sentinel; **walk short-circuits** at
    `cap + 1` (assert traversal stops without visiting all subtree
    files via a spy on `node.children` access or a counter).
  - `getFolderTokens` yields between batches (use a fake timer + a
    counter that ticks on every macrotask flush; assert at least one
    macrotask boundary occurred mid-walk for a >batch-size folder).
  - `getFolderTokens` in-flight dedupe: two concurrent calls for the
    same folder share one promise (assert `getFileTokens` is called
    `paths.length` times, not `2 × paths.length`).
  - `getFolderTokens` epoch invalidation: bump epoch mid-walk via
    `clearFolderTokenMemo`; assert the result is **not** memoized
    after completion.
  - `clearFolderTokenMemo` from `maxFolderFiles` `onChange` clears
    both numeric and sentinel folder results.
  - `updateStatusBar` does not call `getFolderTokens` for an
    uncached folder ref — instead calls `scheduleFolderTokenFetch`
    and emits a placeholder row with `pending: true`.
  - Status-bar total renders with `+` suffix when any target is
    pending or over-cap.
  - Popover `formatLinkedTargetCount` returns `…` for pending,
    `> N files` for over-cap, `formatTokens(n)` otherwise — used in
    both slow and fast paths.
  - Popover `renderSig` differs across pending → over-cap → counted
    transitions for the same row.
  - Copy-selected handler skips over-cap / pending rows and emits a
    `Notice`.

### Verification (primary: ATPATH_PERF; opportunistic: Playwright)

The fresh `ATPATH_PERF` dump from a real Obsidian session is the
**primary** verification path — the prior repro's dump is what
diagnosed this whole class of bugs, and we trust it more than any
Electron automation. After build:

1. Ask the user to open Obsidian, run `localStorage.atpath_perf = "1"`,
   open `STATUS_ai_dev.md`, type for ~10 sec, then run the dump
   command and paste the output.
2. Acceptance: `getFolderTokens.encoded` ≤ `maxFolderFiles ×
   number-of-folder-refs`; no `cachedRead.avg` blow-up; no console
   `File system operation timed out`.

Opportunistic agent-driven path (try first; fall back to the user
dump if Electron automation cannot drive Obsidian):

1. Spawn a Playwright agent to open Obsidian (it should already be
   running; if not, the agent should report).
2. Open `STATUS_ai_dev.md`.
3. Capture a status-bar screenshot within **2 seconds** of file open.
4. Verify the bottom bar is interactive (agent clicks the linked-paths
   segment; popover opens).
5. Verify popover rows for over-cap folders show `> N files`, not a
   spinner-forever or a number; verify the header total has a `+`.
6. Type 10 characters in the editor; verify keystroke latency stays
   under 150 ms (sample input handler timing via `performance.now()`
   in `browser_run_code_unsafe`).
7. After ~10 sec wait, verify in-cap folder rows have replaced the
   "…" placeholder with a real number and the header total no
   longer has a `+` (if all targets resolved).

---

## Rollback strategy

All changes are scoped to `src/atpath-core.js` and `src/main.js`.
There is no settings migration: new keys default safely if absent
(`Object.assign({}, DEFAULT_SETTINGS, await this.loadData())` already
fills missing keys at load).

If the fix regresses behavior, revert with one commit:

```
git revert <fix-commit-sha>
npm run build
```

The instrumentation (`ATPATH_PERF.*`) added in plan 004 stays in
place — it was harmless (`localStorage`-gated) and remains useful for
post-fix verification.

---

## Out of scope (intentionally)

- **Per-file ref concurrency limiting.** A note with 100 single-file
  `@path` refs would still serialize through `await this.getTokenCount`
  in the status-bar loop. Per the perf dump, this is not currently a
  freeze source: per-file `getTokenCount.encode` is single-digit ms
  for small files, and `maxFileSizeMB` already caps the worst case.
  This is acknowledged as a **known residual risk** for cold notes
  with many uncached 100KB+ file refs. If a future repro shows it
  matters, batch them the same way Fix A batches folder files.
- **Background warmup of folder counts.** We could pre-walk visible
  folder refs on file open. We don't, because the placeholder UX
  from Fix C is good enough and pre-walking creates work the user
  may never need (e.g. they close the file before the popover opens).
- **Worker-thread tokenization.** `gpt-tokenizer` is synchronous and
  runs on the main thread. Moving it to a worker is a larger change
  with bundler implications; defer until the cap+yield approach is
  proven insufficient.
- **Cap UX in settings tab beyond a number input.** No "preview your
  vault's largest folders" widget. Number input + clear help text is
  enough.

---

## Risks

- **Sentinel-shape callers.** Several call sites; easy to miss one
  and render `[object Object]`. Mitigation: the grep instructions in
  Implementation step 4, plus the `formatLinkedTargetCount` helper
  unit test guarding the format contract.
- **Walk prefix is still synchronous up to `maxFolderFiles + 1`.**
  With the short-circuit this is bounded for default settings, but a
  user who raises the cap to e.g. 50,000 will see the walk prefix
  hitch. Acknowledged residual risk; revisit with a yielding
  traversal if it bites.
- **Per-file cold path can still hitch.** See Out of scope —
  documented as a known residual risk.

---

## Acceptance criteria

- Opening `STATUS_ai_dev.md` produces an interactive status bar
  within 2 seconds.
- Hovering / pinning the popover does not freeze Obsidian.
- Over-cap folders display `> N files` in inline decorations and in
  the popover, with the status-bar total showing `12k+` (or similar)
  when partial.
- In-cap folders eventually display their real number after the
  background walk completes; the `+` suffix drops once all targets
  resolve.
- "Copy selected" cannot be triggered on over-cap / pending rows;
  attempting it emits a `Notice` and skips them.
- Editor keystroke latency stays under 150 ms.
- All automated tests green.
- A fresh `ATPATH_PERF` dump shows `getFolderTokens.encoded` ≤
  `maxFolderFiles` × number-of-folder-refs (i.e. the cap is
  respected), and `getFolderTokens.walkedFiles` ≤
  `(maxFolderFiles + 1)` × number-of-folder-refs (i.e. the
  short-circuit traversal kicked in).
