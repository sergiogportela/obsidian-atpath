# Plan B — File explorer token counts (per-file + per-folder)

Source prompt: `../prompts/001_improvements.md`

This feature is tracked separately from Plan A because it requires patching into Obsidian's internal file-explorer view (no public decorator API exists), introduces new infrastructure (ignore patterns, folder aggregation), and carries a different Community Plugin review risk profile.

---

## 1. Goal

Show a **per-file token count** next to every file in Obsidian's File Explorer sidebar, plus a **recursively-aggregated total** next to every folder. Counts respect user-configured **ignore patterns** (default: `90_archive/`) and the existing `Skip files above N MB` setting. If the internal-API approach is unacceptable to plugin review, fall back to a dedicated **"Folder stats"** right-sidebar view.

---

## 2. Current state (verified against `src/main.js`)

- **Zero** file-explorer integration today (no `getLeavesOfType("file-explorer")`, no nav-file DOM mutation).
- Per-file token count exists via `getTokenCount(vaultPath)` (L1705) with mtime-keyed cache `tokenCache` (L1562). Cache is invalidated on `create|delete|rename|modify` events (L1581–1595). This is reusable as-is.
- No folder traversal anywhere. `app.vault.getFiles()` is called for unrelated reasons (HTML scope, wikilink repair) but never recursively aggregated.
- No ignore-pattern infrastructure today; only content-based exclusions (YAML frontmatter, fenced code) inside `getTokenCount`.

---

## 3. Approach

### 3.1 Primary: file-explorer decoration via internal `fileItems`

Use the standard pattern observed in Novel Word Count, File Explorer Note Count, and Obsidian File Color:

```js
const leaves = this.app.workspace.getLeavesOfType("file-explorer");
for (const leaf of leaves) {
  const view = leaf.view;
  const items = view.fileItems; // internal: Record<vaultPath, FileItem>
  for (const [path, item] of Object.entries(items)) {
    const el = item.selfEl; // .nav-file-title | .nav-folder-title
    decorate(el, path);
  }
}
```

The `selfEl` for each `fileItem` is the row's title element. We append a single `<span class="atpath-token-badge">` and update its text on every refresh. **All mutation is per-instance** — no `FileExplorerView.prototype` patching (which Community Plugin reviewers increasingly push back on).

**Startup race:** the file-explorer leaf may be deferred on app launch. Use `app.workspace.onLayoutReady(...)` first; if `fileItems` is still empty, attach a one-shot `MutationObserver` to the workspace root watching for `[data-type="file-explorer"] .nav-files-container`, then disconnect.

**Subscriptions** (all via `registerEvent`, so they auto-clean on unload):
- `workspace.on('layout-change')` — handles folder expand/collapse re-rendering new `fileItems`.
- `vault.on('create' | 'delete' | 'rename' | 'modify')` — invalidates affected entries and recomputes their parents incrementally.
- `vault.on('rename')` — also re-decorates moved item's new selfEl.

**Cleanup (`onunload`):** strip every appended `<span class="atpath-token-badge">` we added; disconnect any MutationObserver.

### 3.2 Folder aggregation

Maintain a parallel **folder token map**:

```js
folderTokenCache: Map<folderPath, { tokens, fileCount, includedCount }>
```

- **Lazy build**: on first sight of a folder's `selfEl`, compute by walking its `TFolder.children` recursively, skipping ignored paths and oversized files. Cache result.
- **Delta updates** on vault events: when a file changes, walk *upward* through its parent chain, adjusting each ancestor's running total by `(newTokens - oldTokens)`. This avoids re-summing whole subtrees on each save.
- **Debounce DOM updates** at 750 ms after a burst of vault events (matches Novel Word Count's pattern).

### 3.3 Ignore patterns

New setting: `tokenCountIgnorePatterns` (multiline string textarea, gitignore-style).

- Default value: `90_archive/\n.obsidian/\n.trash/`
- Parse with **`picomatch`** (already used by Omnisearch and File Ignore; small footprint; supports `!negation`, `**`, glob extensions).
- Match against vault-relative paths; folders match both `foo/` and `foo`.
- Ignored files: badge is **not rendered** (cleaner than rendering `0`).
- Ignored folders: badge says e.g. `— archived` (or simply hidden, with a hover title explaining); their token contribution is excluded from ancestor totals.

### 3.4 Badge rendering

```html
<span class="atpath-token-badge" aria-label="1,240 tokens">1.2k</span>
```

- Short-form numbers (`1.2k`, `8.6k`, `124k`) to avoid stretching the tree.
- Hover tooltip shows full count and (for folders) file count: `1,240 tokens · 12 files`.
- Color via CSS var that reacts to total magnitude (subtle: `--text-muted` for small, `--text-normal` for large) — purely a visual nudge.
- Spinner / dimmed state while a folder is being computed for the first time.

Token unit shown is GPT-4o (matches existing inline badges and status bar).

### 3.5 Fallback view (always shipped)

Even if the primary decoration works, ship a `registerView("atpath-folder-stats")` right-sidebar pane:

```
Folder stats
─────────────────
[ Refresh ]   [ ☐ Include archive ]

▾ /
  ▾ notes/                 24,310
    api.md                  1,210
    spec.md                 3,300
  ▾ src/                   18,440
    main.py                 2,440
    ...
  /90_archive/             — ignored
```

This pane is the **authoritative** UI:
- Survives any future Obsidian update that breaks the internal `fileItems` patch.
- Strengthens the Community Plugin submission by giving the feature a non-internal-API home.
- Provides a one-shot "Refresh all" affordance for users who don't want live updates.

---

## 4. Settings additions

Append to `DEFAULT_SETTINGS` (L113–127) and `SettingTab` (L875–1017):

| Setting | Default | Notes |
|---|---|---|
| `showFolderTokenBadges` | `true` | Master toggle for file-explorer decoration |
| `tokenCountIgnorePatterns` | `90_archive/\n.obsidian/\n.trash/` | Multiline textarea, gitignore-style |
| `folderBadgeFormat` | `"short"` | `"short"` (`1.2k`) or `"full"` (`1,240`) |
| `enableFolderStatsView` | `true` | Toggle the right-sidebar fallback view |

Settings labels sentence-case (Community Plugin rules).

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Internal API breakage on Obsidian update.** `fileItems` and `selfEl` are undocumented. | (a) Defensive type checks before mutation. (b) The fallback right-sidebar view stays useful even if decoration fails. (c) Wrap the patch in `try/catch` and `console.warn` on failure (no `console.log` per rules). |
| **Community Plugin reviewer flags internal access.** | Justify in submission notes: per-instance `fileItems` iteration is the accepted ecosystem pattern (Novel Word Count, File Color); no prototype patching; full cleanup on unload. Fallback view shows feature does not depend solely on internal patching. |
| **Large vault performance** (10k+ files). | (a) Lazy decoration — only currently-rendered `fileItems` are touched. (b) Delta updates instead of full subtree re-sum. (c) Debounce 750 ms. (d) Honor existing `maxFileSizeMB` setting to skip giant files in counts. |
| **Ignore-pattern dependency bloat.** `picomatch` is ~12 kB minified. | Acceptable — already used by widely-adopted plugins. Alternative: hand-roll a small glob matcher if review pushes back on the dep. |
| **First-paint flicker** when folder counts are still being computed. | Render placeholder `…` immediately, swap to real number when ready; no layout shift since badge has a `min-width`. |
| **mtime-based cache misses on Obsidian's atomic-rename writes.** | Already mitigated by current `modify` event handling; verify edge cases for cloud-sync flows. |

---

## 6. Implementation steps (in order)

1. **Add ignore-pattern infrastructure.** Pull in `picomatch`, build `isIgnored(path)` helper, wire to `DEFAULT_SETTINGS`. Test with default `90_archive/` against a real vault.
2. **Extract a `getFolderTokenCount(folderPath)`** function. Recursive walk of `TFolder.children`, honors ignore + max-size, populates `folderTokenCache`.
3. **Build the decorator**:
   - `decorateFileExplorer()` method on the plugin
   - `setBadge(selfEl, tokens, kind)` low-level DOM helper
   - Hook to `workspace.onLayoutReady` + MutationObserver fallback
   - `layout-change` + vault-event subscriptions
4. **Delta-update logic.** When `getTokenCount` cache changes for a file, propagate delta up the parent chain into `folderTokenCache`, then refresh affected `fileItems[*].selfEl` badges.
5. **Badge styling** in `styles.css`. Short-form formatter helper. Hover tooltip with full breakdown.
6. **Fallback view.** New `FolderStatsView extends ItemView`, registered with `registerView`. Manual refresh button + checkbox to include ignored. Command palette command "Open folder stats".
7. **Settings panel.** Four new fields, with help text. Live-validate the ignore-pattern textarea (show a `Notice` if a line fails to parse).
8. **Manual smoke test.**
   - Real vault with 1k+ files; verify decoration appears within ~500 ms of load.
   - Add/rename/delete files; verify badges update.
   - Toggle ignore for `90_archive/`; verify ancestor totals shrink.
   - Test on narrow window, light + dark theme, with file-explorer panel collapsed and re-opened.
   - Run with the master toggle off — confirm no DOM mutations remain.

---

## 7. Out of scope

- Custom badge positioning per row (icons vs. trailing).
- Streaming counts for very large files (we honor `maxFileSizeMB` instead).
- A standalone vault-wide stats panel — the right-sidebar view covers this.
- Integration with `.gitignore` files in the vault (could be a future enhancement; for now we use plugin-local ignore patterns).
- Mobile support (file explorer rendering differs significantly on mobile; revisit later).

---

## 8. Acceptance criteria

- Every file row in the file-explorer shows a token badge (or no badge if ignored / too large).
- Every folder row shows an aggregated badge; collapsing/expanding a folder does not duplicate or strip badges.
- Default ignore (`90_archive/`) excludes archived files from folder totals out of the box.
- Edits to the ignore-patterns textarea take effect within ~1 s.
- Disabling `showFolderTokenBadges` removes all badges immediately; re-enabling restores them.
- Right-sidebar "Folder stats" view works independently and shows the same numbers.
- Plugin unload leaves the file-explorer DOM exactly as it was found.
- No `console.log`, no `innerHTML`, no inline styles (Community Plugin rules).
