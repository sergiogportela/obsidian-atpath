# Plan B — File explorer token counts (per-file + per-folder)

Source prompt: `../prompts/001_improvements.md`
Codex review of prior revision folded in.

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

Strip every appended `.atpath-token-badge` we own; disconnect MutationObserver; clear caches. Use `WeakSet<HTMLElement>` to remember which `selfEl`s we badged so the cleanup is deterministic.

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

**Add or update a file** (`create`, `modify`, or first sight during initial walk):
1. Compute new `{tokens, ignored, skipped}` for `path`.
2. If `path` already in `contributionMap`, compute deltas: `Δtokens = new.tokens - old.tokens` (or `-old.tokens` if newly ignored/skipped; or `+new.tokens` if previously ignored/skipped and now included).
3. Walk `parents`. For each ancestor folder: adjust `tokens`, `includedCount`, `fileCount`.
4. Overwrite `contributionMap[path]` with the new snapshot.

**Delete a file**:
1. Read `contributionMap[path]` for last-known `{tokens, parents, ignored, skipped}`.
2. Walk those parents; subtract `tokens` (if it was contributing), decrement `fileCount` and `includedCount` as appropriate.
3. Remove `contributionMap[path]`.

**Rename a file** (TFile only):
1. Run the delete sequence on `oldPath`.
2. Run the add/update sequence on `newPath`.

**Rename a folder with descendants** (the hard one):
1. `vault.on('rename')` fires once for the folder itself; **descendants are NOT re-emitted** by Obsidian.
2. Detect folder rename via `file instanceof TFolder`.
3. For every entry in `contributionMap` whose `parents` includes `oldPath`, rewrite the key (path prefix swap) and rebuild `parents`. No tokenization needed (content unchanged).
4. For every entry in `folderTokenCache` under `oldPath`, rewrite the key. The aggregated totals don't change values — only paths.
5. Bump `generation` so any in-flight walks abort.

**Ignore-pattern change** (settings save):
1. Bump `generation`.
2. For each `contributionMap[path]`: re-evaluate `ignored`; if it flipped, push deltas through `parents`.
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

1. **Replace Plan A stubs** in `src/atpath-core.js`: real `isIgnored` (§3.3 matcher) and real `getFolderTokens` (reads `folderTokenCache`).
2. **Contribution map + folder cache infrastructure** (§3.2.1).
3. **Token queue** with concurrency / dedupe / generation cancellation (§3.2.3).
4. **Vault event handlers** — `create` (with settle-window), `modify`, `delete`, `rename` (file vs. folder branches).
5. **Decorator core** — per-leaf scan, MutationObserver fallback, multi-leaf + pop-out support.
6. **Badge DOM** + cleanup `WeakSet`; styles in `styles.css`.
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
- **Folder rename** with descendants: badges remain correct without re-tokenizing any file.
- **File create / modify / delete**: badges and ancestor totals update within ~1 s.
- Edits to ignore patterns take effect within ~1 s; previously-ignored folders re-decorate, newly-ignored folders shed their badges.
- Disabling `showFolderTokenBadges` removes all badges within one paint cycle; re-enabling restores them.
- Right-sidebar "Folder stats" view shows the same numbers as the inline badges; "Include ignored" reveals the hidden ones.
- Plugin unload leaves the file-explorer DOM identical to pre-load state.
- Pop-out window with a file-explorer leaf is decorated correctly.
- No `console.log`, `innerHTML`, hardcoded `.obsidian`, inline styles, `fetch`, or unawaited promises.

---

## 9. Migration / interaction with Plan A

- Plan A ships with stub `isIgnored -> false` and a session-scoped synchronous `getFolderTokens`. **Plan B's first step replaces both stubs in `src/atpath-core.js`.** No Plan A call sites change.
- Status bar's "linked tokens" total automatically benefits from the real `getFolderTokens` once Plan B lands.
- Copy-with-folder honors the same `isIgnored` once Plan B lands.

---

## 10. Automated test plan

| Target | Test cases |
|---|---|
| Ignore matcher | `foo/`, `foo/bar/`, `*.md`, `**/draft-*`, `!foo/bar.md` negation, comments, blank lines. Verify `configDir` and trash always excluded regardless of patterns. |
| `contributionMap` add/update | New file → parents updated. Modify changes token count → ancestor deltas correct. Modify flips ignored → ancestors lose contribution. |
| `contributionMap` delete | Parents' totals shrink; entry removed. |
| `contributionMap` file rename | Old key removed; new key with correct parents; deltas net to zero in shared ancestors. |
| `contributionMap` folder rename | All affected keys path-prefix-swapped; no re-tokenization; `generation` bumped. |
| `folderTokenCache` generation cancellation | In-flight walk with old generation aborts before committing results. |
| Queue dedupe | Enqueueing the same path twice yields one tokenization. |
| Queue concurrency | At most N tasks running concurrently. |
| `create` settle window | N synthetic `create` events within 1 s of `onLayoutReady` produce one batched sweep, not N enqueues. |
| Badge DOM | Duplicate-prevention: re-decorating the same `selfEl` updates the existing badge, doesn't append a second. Cleanup removes every badge we appended (`WeakSet` audit). |
| Ignored UX | Ignored file → no badge appended; ignored folder → no badge appended; descendants unbadged; "Include ignored" in fallback view shows them. |

Manual smoke test in §6 step 10 still runs in addition.
