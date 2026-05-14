# Plan B — File explorer token counts (per-file + per-folder)

Source prompt: `../prompts/001_improvements.md`
Codex review of prior revision folded in.
Final codex review (post drag-and-drop): 4 findings affecting Plan B (1 critical, 3 major) — folded in below.

This plan owns the **ignore-pattern infrastructure** and the **event-driven folder token cache** that Plan A stubs out. It also patches Obsidian's internal file-explorer view to decorate every file/folder row with a token-count badge.

---

## 1. Goal

Show a **per-file token count** next to every file in Obsidian's file explorer sidebar, plus a **recursively-aggregated total** next to every folder. Counts respect user-configured **ignore patterns** (default: `90_archive/`) and the existing `Skip files above N MB` setting. If the internal-API approach is rejected by the Community Plugin reviewer, fall back to a dedicated **"Folder stats"** right-sidebar view.

---

## 2. Current state (verified against `src/main.js`)

- **Zero** file-explorer integration today (no `getLeavesOfType("file-explorer")`, no DOM mutation).
- Per-file `getTokenCount(vaultPath)` (L1705) with mtime-keyed cache `tokenCache` (L1562).
- **Cache event subscriptions (L1581–1605): `modify`, `delete`, `rename` only — `create` is NOT subscribed.** Newly created files are tokenized lazily on first read. Plan B adds explicit `create` handling (§3.2.4).
- No folder traversal, no ignore-pattern infra, no `picomatch` (or any glob lib) currently in dependencies.
- `app.vault.configDir` is the supported way to refer to the `.obsidian` folder (CLAUDE.md compliance rule).

---

## 3. Approach

### 3.1 Decorator surface — multi-leaf, pop-out window, mobile aware

Use the per-instance `fileItems` pattern (Novel Word Count / File Color / File Explorer Note Count). **No `FileExplorerView.prototype` patching.**

```js
const leaves = this.app.workspace.getLeavesOfType("file-explorer");
for (const leaf of leaves) {
  const view = leaf.view;
  const items = view?.fileItems;
  if (!items) continue;
  for (const [path, item] of Object.entries(items)) {
    decorate(item.selfEl, path);
  }
}
```

#### 3.1.1 Multi-leaf

Multiple file-explorer leaves can exist simultaneously (split panes). Iterate **all** matching leaves, not just `[0]`. Maintain `decoratedLeafIds: Set<string>` to track which leaves have been instrumented this run; `layout-change` handler diffs added/removed leaves.

#### 3.1.2 Pop-out windows

When the user pops a leaf out into a separate Electron window (`workspace.openPopoutLeaf` or drag-out), the file explorer can move. Subscribe to `workspace.on('window-open')` and `workspace.on('window-close')`; re-scan leaves on both. Each pop-out window has its own DOM root — the decorator iterates `leaf.view.containerEl`, which already resolves to the correct window's `.nav-files-container`. No JS positioning needed; CSS handles all visuals.

#### 3.1.3 Mobile

File-explorer rendering differs on mobile (different leaf type and tree DOM). **Plan B is desktop-only at v1**: early-return when `Platform.isMobile`. Stub setting `showFolderTokenBadges` is hidden in the settings UI on mobile. Mobile support is a future enhancement.

#### 3.1.4 Deferred file-explorer leaf

On launch the file-explorer leaf may be deferred. Sequence:
1. `app.workspace.onLayoutReady(...)` first.
2. If `getLeavesOfType("file-explorer")` is empty OR every leaf's `fileItems` is empty, attach a `MutationObserver` to `workspace.containerEl` watching for `[data-type="file-explorer"] .nav-files-container`. On first hit, re-run the decorator and disconnect the observer.
3. If still empty after 5 s, log once via `console.warn` and stop trying.

#### 3.1.5 Subscriptions (all via `registerEvent`, auto-cleaned on unload)

- `workspace.on('layout-change')` — folder expand/collapse renders new `fileItems`; pop-out moves; new splits.
- `workspace.on('window-open')` / `workspace.on('window-close')` — pop-out window plumbing.
- `vault.on('create' | 'modify' | 'delete' | 'rename')` — see §3.2 for cache semantics.
- `metadataCache.on('changed')` — not subscribed; per-file token count is content-based and `modify` already fires on save.

#### 3.1.6 Cleanup (`onunload`)

Strip every appended `.atpath-token-badge` we own; disconnect MutationObserver; clear caches. **Use `Map<HTMLElement, HTMLElement>` keyed by `selfEl` with the appended badge `<span>` as value** — `WeakSet` was wrong (not iterable, can't enumerate during cleanup). The `Map` also doubles as the duplicate-prevention lookup (§3.4): before appending, check `badgeMap.has(selfEl)`; if yes, update the existing badge's `textContent` in place.

Memory note: a `Map<HTMLElement, …>` holds strong references, so explorer leaves that get destroyed mid-session would leak. Guard against this:
- `layout-change` handler diffs the live `fileItems` against `badgeMap.keys()` and deletes entries whose `selfEl` is no longer attached (`!document.contains(el)`).
- `onunload` iterates `badgeMap.values()` once to remove every badge `<span>`, then calls `badgeMap.clear()`.

(An alternative — `WeakMap<HTMLElement, HTMLElement>` — gives garbage-collection for free but is also not iterable. We choose `Map` + explicit pruning so the cleanup pass is auditable.)

### 3.2 Folder aggregation — explicit contribution map

The prior plan said "adjust each ancestor by `(newTokens - oldTokens)`" but `tokenCache` only stores the *new* number after `getTokenCount` runs — the *old* contribution is lost the moment cache is invalidated. Fix: introduce a **separate contribution map**.

#### 3.2.1 Data structures

```js
// Per-file contribution snapshot used for delta math. Distinct from tokenCache.
contributionMap: Map<vaultPath, {
  tokens: number,        // last known token count for this file
  parents: string[],     // all ancestor folder paths (root → leaf), excluding ""
  ignored: boolean,      // was this file matched by ignore patterns at snapshot time
  skipped: boolean,      // was this file skipped due to size or non-markdown extension
}>

// Aggregated per-folder.
folderTokenCache: Map<folderPath, {
  tokens: number,        // sum of non-ignored, non-skipped descendants
  fileCount: number,     // total descendant files (incl. ignored/skipped)
  includedCount: number, // descendants actually counted toward tokens
  generation: number,    // bumped on every full rebuild; used to cancel stale walks
}>
```

#### 3.2.2 Operations

**State-transition rules (explicit, addressing Codex M12).** Every file has three boolean dimensions: `present` (in vault), `included` (counts toward tokens), `skipped-or-ignored` (in vault but suppressed). Each operation produces the new triple and applies *exactly one* delta per ancestor:

| Transition | `fileCount` Δ | `includedCount` Δ | `tokens` Δ |
|---|---|---|---|
| Absent → included (new file, eligible) | `+1` | `+1` | `+new.tokens` |
| Absent → skipped/ignored (new file, suppressed) | `+1` | `0` | `0` |
| Included → included, tokens change (modify with no flag change) | `0` | `0` | `new.tokens − old.tokens` |
| Included → skipped/ignored (flag flip; modify or settings save) | `0` | `−1` | `−old.tokens` |
| Skipped/ignored → included (un-ignore, or grow under size cap is **not** counted — see note below) | `0` | `+1` | `+new.tokens` |
| Included → absent (delete) | `−1` | `−1` | `−old.tokens` |
| Skipped/ignored → absent (delete) | `−1` | `0` | `0` |

Notes:
- **Modify of an ignored file**: re-tokenization is **skipped entirely** (no point computing tokens we'll never count). The flag check happens first; only files whose new flag is `included` get tokenized. This prevents the "double-counts on modify" bug Codex flagged.
- The `size cap` flag (`skipped`) is recomputed on every modify because file size changed. Use the size from `TFile.stat.size` (no read needed). The `ignored` flag is recomputed on every settings save (matcher changed) but stays constant across modify (matcher unchanged).
- The new triple is committed to `contributionMap[path]` **after** the deltas are applied. If anything throws mid-walk, the cache is left in the pre-delta state.

**Add or update a file** (`create`, `modify`, or first sight during initial walk):
1. Compute new `{tokens, ignored, skipped, parents}` for `path`. If `ignored || skipped`, skip tokenization (set `tokens: 0`).
2. Look up `old = contributionMap.get(path)`; if missing, treat as `{tokens: 0, parents: [], ignored: false, skipped: false, present: false}`.
3. Determine the transition row above and the delta triple `(Δfile, Δincl, Δtokens)`.
4. Walk the **union** of `old.parents` and `new.parents`. For ancestors in both, apply the delta. For ancestors only in `old.parents` (this is a move — see below), subtract `old` contribution. For ancestors only in `new.parents`, add `new` contribution.
5. Commit `contributionMap[path] = new`.

**Delete a file**:
1. Read `old = contributionMap.get(path)`; if missing, no-op.
2. Apply `(−1, old.included ? −1 : 0, old.included ? −old.tokens : 0)` to each ancestor in `old.parents`.
3. `contributionMap.delete(path)`.

**Rename a file** (TFile only):
1. Run the **delete** sequence on `oldPath`.
2. Run the **add/update** sequence on `newPath` (recomputes parents, re-evaluates ignore flag against the new path).

**Rename or move a folder with descendants — full subtree delete + re-add (critical finding C3).** The prior plan only swapped keys, which leaves the *old ancestors* still inflated (they no longer contain the subtree but their counts still include it) and the *new ancestors* missing (they now contain the subtree but their counts haven't been bumped). Cross-parent moves (`a/sub/` → `b/sub/`) hit this. Correct sequence:

1. `vault.on('rename')` fires once for the folder itself; descendants are NOT re-emitted.
2. Detect folder rename via `file instanceof TFolder`. Also detect whether it's a pure rename (`dirname(old) === dirname(new)`) or a move (`dirname(old) !== dirname(new)`).
3. Enumerate all entries in `contributionMap` whose key starts with `oldPath + "/"` — call this `affected[]`.
4. For each `affected[i]`:
   a. Apply the **delete** sequence using `old.parents` (subtracts from old ancestors).
   b. Rewrite the key from `oldPath + suffix` to `newPath + suffix`.
   c. Re-evaluate `ignored` against the new path (the ignore matcher may flip if `oldPath` matched a pattern that `newPath` doesn't, or vice versa).
   d. Apply the **add/update** sequence at the new key with freshly computed `parents` (climbs from `newPath`).
5. Rewrite any keys in `folderTokenCache` from `oldPath...` to `newPath...`. Aggregated values for the *moved subtree's internal folders* don't change in absolute value; their parent-chain bookkeeping is already handled by steps 4a–4d above.
6. Bump `generation` so any in-flight walks abort.

Pure renames (`dirname(old) === dirname(new)`) still go through this path; in that case `old.parents` and `new.parents` for every descendant share all ancestors above `dirname(old)`, so the deltas cancel for the shared ancestors and only the moved-subtree folders see net change (which is what we want).

**Ignore-pattern change** (settings save):
1. Bump `generation`.
2. For each `contributionMap[path]`: re-evaluate `ignored`; if it flipped, walk the transition table above (Included → ignored or Ignored → Included). For Ignored → Included transitions where `tokens` was `0` (never computed), enqueue a tokenization task instead of applying the delta synchronously.
3. Schedule a debounced badge refresh.

#### 3.2.3 Bounded background queue

Walking 10 k files synchronously will lock the UI. Use a bounded async queue:

```js
class TokenizeQueue {
  constructor(concurrency = 2) { ... }
  enqueue(path) { ... }   // dedupes if already pending
  cancel(generation) { ... }
}
```

- Concurrency 2 on desktop (gpt-tokenizer is sync-CPU work; 2 parallel via `await new Promise(r => setTimeout(r))` yields the event loop between files).
- Dedupes in-flight tokenization of the same `path`.
- Each task tagged with the queue's `generation` at enqueue time; if `generation` changed (settings save, folder rename) the task short-circuits before running.
- Visible rows render a **placeholder badge** (`…`) immediately; real number swaps in when the queue produces it. Placeholder reserved via a fixed `min-width` so layout doesn't shift.

#### 3.2.4 `create` event handling and vault-load flood

Plugin currently doesn't subscribe to `create`. Plan B adds the subscription but **must not** flood the queue on vault load (Obsidian fires `create` for every file during initial index).

Mitigation: gate `create`-driven enqueues behind `app.workspace.onLayoutReady` AND a 1-second post-ready settle window. During the settle window, batch new paths; one full sweep runs after the window closes. Subsequent `create` events (real new files) enqueue individually.

#### 3.2.5 DOM debounce

Decorator's `paintBadges()` runs no more than once every **750 ms** (rAF-throttled coalescing). Tokenization completion events flag affected rows; the next paint cycle updates them all in one pass.

### 3.3 Ignore patterns — **hand-rolled matcher, no new deps**

(User chose hand-rolled over `picomatch` per global "ask first" rule.)

New setting `tokenCountIgnorePatterns` (multiline string, gitignore-ish). Default:

```
90_archive/
```

Note: **do not** ship literal `.obsidian/` or `.trash/` in the default — `app.vault.configDir` is the supported abstraction. Both are always-excluded by the matcher regardless of patterns (see below).

#### 3.3.1 Matcher rules (minimal subset of gitignore)

| Pattern | Meaning |
|---|---|
| `foo/` | Any path whose first segment is `foo` (folder match) |
| `foo/bar/` | Any path starting with `foo/bar/` |
| `*.md` | Any file with `.md` extension (path leaf only) |
| `**/draft-*` | Any path whose any segment starts with `draft-` |
| `!foo/bar.md` | Negation — re-include after a broader exclude |
| `# comment` | Comment line, ignored |
| (blank line) | Ignored |

Implementation: compile each non-comment line to a simple regex (~50 LOC). Negation lines run a second pass to un-set matches.

#### 3.3.2 Always-excluded paths (not user-configurable)

- `app.vault.configDir` and everything beneath it
- The vault's trash (`.trash` is the default but `vault.getConfig?.("trashOption")` may shift it; use the API where available, fall back to literal `".trash"` as last resort)

These are excluded from decoration entirely (no badge rendered, no contribution map entry).

#### 3.3.3 Live validation

The settings textarea live-validates each line; an invalid line shows a `Notice` and is skipped. Saving triggers the §3.2.2 "Ignore-pattern change" flow.

### 3.4 Badge rendering — **single, unambiguous UX**

Resolve prior plan's self-contradiction: ignored files get **no badge**. Period.

```html
<span class="atpath-token-badge" aria-label="1,240 tokens">1.2k</span>
```

- Short-form numbers (`1.2k`, `8.6k`, `124k`).
- Fixed `min-width: 3em` to prevent column-width jitter on number changes.
- `pointer-events: none` so the badge never steals clicks from the row title.
- `aria-label` carries the full number for screen readers; CSS hover via the row tooltip surfaces full count + file count for folders.
- **Ignored files**: no `<span>` appended; cleanup ensures no stale badge if a path becomes ignored later.
- **Ignored folders**: no badge on the folder row either; descendants of an ignored folder are also unbadged.
- **In-flight (queue still computing)**: placeholder content `…`; placeholder also has the fixed `min-width` so swap-in is layout-neutral.
- **Duplicate-prevention**: before appending, check `selfEl.querySelector(".atpath-token-badge")`; if found, update its text instead of appending a second.

### 3.5 Fallback view (always shipped)

`registerView("atpath-folder-stats")` right-sidebar pane, plus command "Open folder stats":

```
Folder stats
─────────────────
[ Refresh ]   [ ☐ Include ignored ]

▾ /
  ▾ notes/                 24,310
    api.md                  1,210
    spec.md                 3,300
  ▾ src/                   18,440
  /90_archive/             —
```

Authoritative UI that survives an Obsidian internal-API change. Strengthens Community Plugin submission by demonstrating the feature has a public-API home.

---

## 4. Settings additions

| Setting | Default | Notes |
|---|---|---|
| `showFolderTokenBadges` | `true` | Master toggle for file-explorer decoration (hidden on mobile) |
| `tokenCountIgnorePatterns` | `90_archive/` | Multiline textarea, hand-rolled matcher syntax |
| `folderBadgeFormat` | `"short"` | `"short"` (`1.2k`) or `"full"` (`1,240`) |
| `enableFolderStatsView` | `true` | Toggle the fallback sidebar view |

All labels sentence-case. `configDir` and trash auto-excluded — not exposed as a setting.

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Internal `fileItems`/`selfEl` breaks on Obsidian update | (a) Defensive type checks; (b) wrap each per-leaf scan in `try/catch` + `console.warn`; (c) fallback view remains useful even if decoration fails entirely. |
| Community Plugin reviewer flags internal access | Justify in submission notes: per-instance iteration is the accepted ecosystem pattern; no prototype patching; full cleanup; public-API fallback view shipped. |
| 10 k+ file vaults lock UI | Bounded queue concurrency 2; placeholder badges; lazy-decorate currently-rendered rows only; settle-window on initial vault load. |
| First-paint flicker | Placeholder `…` with fixed `min-width`; 750 ms paint debounce. |
| Pop-out window decoration missed | `window-open` / `window-close` subscriptions; decorator iterates `leaf.view.containerEl` so the right window is touched. |
| mtime cache misses on cloud-sync atomic-rename writes | Existing `modify` handler already invalidates; verify with a Sync/iCloud scenario in smoke test. |
| Folder rename with deep descendants | Path-prefix rewrite in both `contributionMap` and `folderTokenCache`; no re-tokenization needed since content didn't change. |
| `create`-flood on vault load | Settle window after `onLayoutReady`; single batched sweep instead of N enqueues. |

---

## 6. Implementation steps (in order)

1. **Replace Plan A stubs** in `src/atpath-core.js`: real `isIgnored` (§3.3 matcher) and real `getFolderTokens` (§9 — `folderTokenCache` lookup + `enqueueSubtreeIndex` for cache misses, async contract preserved).
2. **Contribution map + folder cache infrastructure** (§3.2.1).
3. **Token queue** with concurrency / dedupe / generation cancellation (§3.2.3).
4. **Vault event handlers** — `create` (with settle-window), `modify`, `delete`, `rename` (file vs. folder branches).
5. **Decorator core** — per-leaf scan, MutationObserver fallback, multi-leaf + pop-out support.
6. **Badge DOM** + cleanup `Map<selfEl, badgeEl>` with `document.contains` pruning on `layout-change` (§3.1.6); styles in `styles.css`.
7. **Settings panel** — four fields, live-validation of ignore patterns.
8. **Fallback `FolderStatsView`** — `ItemView` subclass; refresh button; include-ignored toggle.
9. **Automated tests** (see §10).
10. **Manual smoke test** — large vault (1 k+ files), folder rename with 100+ descendants, ignore pattern toggle, pop-out leaf, deferred file-explorer, dark/light theme, plugin disable → DOM clean.

---

## 7. Out of scope

- Mobile support (deferred; file-explorer DOM differs significantly).
- `.gitignore` file integration (future enhancement).
- Streaming counts for huge files (we honor `maxFileSizeMB`).
- Per-row badge positioning customization.
- Per-folder ignore-pattern overrides.

---

## 8. Acceptance criteria

- Every visible file row shows a token badge OR no badge if ignored/oversized/in-configDir/in-trash.
- Every visible folder row shows an aggregated badge with the sum of non-ignored, non-oversized descendants.
- **Folder rename** (same parent): badges remain correct without re-tokenizing any file.
- **Folder move** (cross-parent rename, e.g., `a/sub/` → `b/sub/`): old ancestors' counts shrink by the moved subtree's contribution; new ancestors' counts grow by the same amount; subtree internal totals unchanged. No re-tokenization.
- `getFolderTokens(path)` from Plan A's status bar returns the correct count for any folder, even if that folder has never been rendered in the explorer (visibility-independent).
- **File create / modify / delete**: badges and ancestor totals update within ~1 s.
- Edits to ignore patterns take effect within ~1 s; previously-ignored folders re-decorate, newly-ignored folders shed their badges.
- Disabling `showFolderTokenBadges` removes all badges within one paint cycle; re-enabling restores them.
- Right-sidebar "Folder stats" view shows the same numbers as the inline badges; "Include ignored" reveals the hidden ones.
- Plugin unload leaves the file-explorer DOM identical to pre-load state.
- Pop-out window with a file-explorer leaf is decorated correctly.
- No `console.log`, `innerHTML`, hardcoded `.obsidian`, inline styles, `fetch`, or unawaited promises.

---

## 9. Migration / interaction with Plan A — **visibility-independent `getFolderTokens`**

- Plan A ships with stub `isIgnored -> false` and a session-scoped **async** `getFolderTokens`. **Plan B's first step replaces both stubs in `src/atpath-core.js`.** No Plan A call sites change.
- Status bar's "linked tokens" total automatically benefits from the real `getFolderTokens` once Plan B lands.
- Copy-with-folder honors the same `isIgnored` once Plan B lands.

**Critical finding M13 — `folderTokenCache` must serve arbitrary linked folders, not just visible-row folders.** Plan B's cache as initially designed was populated lazily as folders became visible in the explorer. Plan A's status-bar popover and renderers need the count for *any* `@folder/` ref the user has typed, regardless of whether that folder's row is currently visible in the explorer. The cache contract must therefore be:

```js
async getFolderTokens(folderPath) {
  const cached = folderTokenCache.get(folderPath);
  if (cached) return cached.tokens;
  // Not yet aggregated. Enqueue a subtree index and await completion.
  return enqueueSubtreeIndex(folderPath);
}
```

`enqueueSubtreeIndex(folderPath)`:
1. Resolves the `TFolder`; returns `0` if missing.
2. Recursively enumerates all descendant `TFile`s; for each, enqueues a tokenization task in `TokenizeQueue` (§3.2.3) if not already cached in `contributionMap`.
3. Awaits all enqueued tasks (with `generation` cancellation).
4. Walks the subtree once more, summing `contributionMap[child.tokens]` for `child where !ignored && !skipped`. Writes the result to `folderTokenCache[folderPath]`.
5. Returns the sum.

This makes `getFolderTokens` work for any path regardless of whether the explorer has ever rendered that folder. The decorator (visible-row code path) calls the same function — first call from the decorator populates the cache; subsequent calls (from Plan A or the decorator's re-paint) return the cached value.

**Deduplication**: if a second `enqueueSubtreeIndex(path)` arrives while one is in flight for the same path, return the existing in-flight Promise (keyed in a `Map<path, Promise>` cleared on resolve). Prevents duplicate enqueues when both the explorer and the status bar request the same folder.

---

## 10. Automated test plan

| Target | Test cases |
|---|---|
| Ignore matcher | `foo/`, `foo/bar/`, `*.md`, `**/draft-*`, `!foo/bar.md` negation, comments, blank lines. Verify `configDir` and trash always excluded regardless of patterns. |
| `contributionMap` add/update | New file → parents updated. Modify changes token count → ancestor deltas correct. Modify flips ignored → ancestors lose contribution. |
| `contributionMap` delete | Parents' totals shrink; entry removed. |
| `contributionMap` file rename | Old key removed; new key with correct parents; deltas net to zero in shared ancestors. |
| `contributionMap` folder rename (same parent) | Keys path-prefix-swapped; ancestors above shared parent net to zero delta; no re-tokenization; `generation` bumped. |
| `contributionMap` folder move (cross-parent) | Old ancestors lose subtree contribution; new ancestors gain subtree contribution; subtree-internal totals unchanged; no re-tokenization. |
| Transition table | Each row from §3.2.2 hits exactly the expected `(Δfile, Δincl, Δtokens)` triple. Specifically: modify-with-flag-flip does not double-count; modify of ignored file is not retokenized. |
| `getFolderTokens` visibility independence | Calling `getFolderTokens(unvisitedFolderPath)` resolves to the correct sum; in-flight dedupe returns the same Promise for concurrent calls. |
| `folderTokenCache` generation cancellation | In-flight walk with old generation aborts before committing results. |
| Queue dedupe | Enqueueing the same path twice yields one tokenization. |
| Queue concurrency | At most N tasks running concurrently. |
| `create` settle window | N synthetic `create` events within 1 s of `onLayoutReady` produce one batched sweep, not N enqueues. |
| Badge DOM | Duplicate-prevention: re-decorating the same `selfEl` updates the existing badge, doesn't append a second. Cleanup removes every badge we appended (`WeakSet` audit). |
| Ignored UX | Ignored file → no badge appended; ignored folder → no badge appended; descendants unbadged; "Include ignored" in fallback view shows them. |

Manual smoke test in §6 step 10 still runs in addition.
