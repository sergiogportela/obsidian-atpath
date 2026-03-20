## Codex review

• Assessment
  Good direction, but I would not execute this as one branch. Part 1 and Part 3 fit the current codebase.
  Part 2 is a separate sync system and, as written, it conflicts with the native mobile-link goal.

  1. The biggest flaw is the mobile/native-link story. If the stored wikilink target remains _repos/
     repo/..., Obsidian native graph/backlinks/rename still depend on a path that does not exist on iOS.
     Your plugin fallback only restores plugin-owned actions like open/copy/publish, not native Obsidian
     link behavior. That clashes with the goal and the current resolution model in src/main.js:165.
  2. scanAtPathRefs() is the right direction, but it cannot live only in src/main.js. Parsing is duplicated
     across live preview, reading mode, status bar, copy, collect/publish, and html-builder.js today: src/
     main.js:274, src/main.js:359, src/main.js:1039, src/main.js:1086, src/main.js:1185, src/html-
     builder.js:273. html-builder.js has no plugin instance, so you need a shared parser plus a separate
     resolver.
  3. The setting should be “preferred insert format”, not global linkFormat. Mixed legacy + wikilink
     content is unavoidable after partial migration, skipped refs, pasted notes, and old files. Parsing
     must always support both.
  4. Rename handling needs its own design. The current plugin fully rewrites raw @path text on rename in
     src/main.js:1432. With wikilinks, Obsidian should own target updates; the plugin should only repair
     stale @... aliases after core rename finishes. Otherwise you risk double writes and races.
  5. The live-preview plan assumes native .internal-link elements can be post-processed. Reading mode
     likely can. Live Preview is currently a custom MatchDecorator widget in src/main.js:276, not native
     link DOM. I would treat that as an unverified assumption until checked at runtime.
  6. Part 2 needs a persisted bake manifest, not only mtime comparison. To safely support mobile edits back
     to real repos, you need at least last-bake hashes/mtimes so you can distinguish “source changed”,
     “baked changed”, and “both changed”. Without that, desktop edits can be clobbered. Also this must be
     strictly desktop-gated because the plugin is currently mobile-capable in manifest.json:9. There is
     also no existing diff/review UI to reuse beyond the publish modals in src/main.js:562.
  7. If mobile matters, this is the right moment to remove the existing regex lookbehinds rather than
     preserve them. They are already documented as an iOS review risk in COMMUNITY_PLUGINS.md:17.
  8. Fuzzy autocomplete is the safest part. It maps cleanly onto src/main.js:202, but prepareFuzzySearch /
     renderResults are still assumptions here, not something the current repo proves is available.

  What I’d change

  Split it:

  1. Shared parser/resolver layer first, dual-format support always on, and preserve current display
     semantics so same-repo refs still show @src/file.ext, not forced @repo/src/file.ext.
  2. Wikilink insertion + migration + copy/publish/status-bar updates.
  3. Fuzzy autocomplete.
  4. Separate desktop-only bake prototype only after deciding the canonical link target that must exist on
     both desktop and mobile.

  The plan is strong on intent, but Part 2 is underdesigned enough that it will derail the rest if you keep
  it bundled. If you want, I can rewrite this into an implementation-ready phased plan.



## Context

Three problems to solve together in a new branch from `main`:
1. `@path` syntax invisible to Obsidian graph/backlinks/hover/rename
2. `_repos/` symlinks don't sync via iCloud → iOS sees nothing
3. Autocomplete weaker than Obsidian's native fuzzy search

All existing features must keep working: auto-update paths on rename, token counting, copy-to-clipboard, publish.

---

## Part 1: Wikilink Format

`@repo/path/file.ext` → `[[_repos/repo/path/file.ext|@repo/path/file.ext]]`

### Implementation

**Core** (`src/main.js`):
- New regex: `const WIKILINK_ATPATH_RE = /\[\[([^\]|]+)\|@([^\]]+)\]\]/g`
- Keep legacy `AT_PATH_RE` for backward compat
- Unified `scanAtPathRefs(content, sourcePath, plugin)` → `{ vaultPath, displayPath, format, start, end }[]`
- New setting `linkFormat: "wikilink" | "legacy"`, auto-detected on first load

**Autocomplete** (`AtPathSuggest`, line 202):
- `selectSuggestion()` (line 265): insert `[[${file.path}|@${display}]] `
- `onTrigger()`: unchanged (`@` trigger)

**CM6 Live Preview** (`buildAtPathViewPlugin`, line 276):
- Wikilink format: Obsidian renders natively. ViewPlugin adds `atpath-link` class + `data-tokens` + context menu to `.internal-link` elements with `@`-prefixed text
- Legacy format: existing `MatchDecorator` unchanged

**Reading Mode** (`registerPostProcessor`, line 359):
- Wikilink format: find `.internal-link` with `@` text → add `atpath-link` class + token spans
- Legacy format: keep existing TreeWalker

**Token counting / Status bar**: use `scanAtPathRefs()`

**Copy & Publish**:
- `scanAtPathRefs()` for file collection
- Strip wikilinks in clipboard: `[[a|@b]]` → `@b`
- `html-builder.js`: handle both formats in `replaceAtPathsWithLinks()` / `replaceNestedAtPaths()`

**Rename handler**:
- Wikilink format: Obsidian updates link target. Plugin only updates stale display alias.
- Legacy format: keep existing 3-pass handler

**Migration**:
- Command: **"Dry-run: preview @path migration"** — reports counts, zero changes
- Command: **"Migrate @path references to wikilinks"** — converts resolvable, skips unresolvable

---

## Part 2: Mobile Bake (`_repos/_baked/`)

### Structure
```
_repos/
  myproject/        → symlink (desktop edits real repo files)
  otherrepo/        → symlink
  _baked/
    myproject/      ← real file copies (iCloud syncs to phone)
      src/utils.py
    otherrepo/
      ...
```

Notes stay in vault root — clean, untouched, LLM-friendly. Only repo file copies go in `_baked/`.

### Sync: Desktop → Mobile

**Auto-bake** (configurable interval, default 30min):
- Uses `this.registerInterval(window.setInterval(...))` — auto-cleaned on plugin unload
- Incremental: `readdir({withFileTypes:true})` + `stat()` mtime comparison (~40ms for 1000 files)
- Only copies files where source mtime > destination mtime
- Excludes `.git`, `node_modules`, `.DS_Store`, binary build artifacts
- Uses `requestIdleCallback` with 2000ms timeout to batch copy operations without blocking editor
- Obsidian vault events (`vault.on('modify')`) fire for all file types but can't detect external edits to symlink targets — so periodic mtime scan is necessary

**Ribbon button** — one-click manual refresh. Shows notice: "Baked: 15 updated, 3 new, 120 unchanged"

**Status bar indicator** — "Baked: 5min ago" or "Baked: stale"

**Command palette** — "Refresh baked repos"

### Sync: Mobile → Desktop

When user edits a file on mobile in `_repos/_baked/`, iCloud syncs it back to Mac. On next auto-bake cycle (or manual refresh), the plugin:
1. Compares `_baked/` files against real repo files
2. Detects files where `_baked/` copy is **newer** than the real file
3. Shows notice: **"3 files edited on mobile"**
4. Click opens a modal with the list + diffs
5. User confirms → plugin writes changes to real repo files
6. User dismisses → nothing changes, reminder stays

### Path resolution fallback

On mobile (where symlinks are broken), the plugin's `resolveAtPathFromSource()` tries the normal path first. If the file doesn't exist, falls back to `_repos/_baked/` path. Transparent to the user.

### Ignore files

**Project-level** (Codex = source of truth):
- Create `.codexignore` with `_baked/`
- Symlink `.claudeignore` → `.codexignore`

**Global-level** (propagates to codex2/codex3 via existing symlinks):
- Add `_baked` to `~/.codex/config.toml` ignore if supported

---

## Part 3: Fuzzy Autocomplete

### Changes to `AtPathSuggest` (`src/main.js:202-270`)

1. **`getSuggestions()`** (line 227): Replace `.includes()` with `prepareFuzzySearch(query)` → scored matches, sorted by `match.score`

2. **`renderSuggestion()`** (line 261): Use `renderResults()` to highlight fuzzy-matched characters

3. **`selectSuggestion()`** (line 265): Insert wikilink format when `linkFormat === "wikilink"`

---

## Files to modify
- `src/main.js` — regex, suggest, CM6, post-processor, tokens, copy/publish, rename, bake commands, migration
- `src/html-builder.js` — both formats in `replaceAtPathsWithLinks()`, `replaceNestedAtPaths()`; reuse `makeFence()`
- `styles.css` — `.internal-link.atpath-link` rules
- `.codexignore` — NEW: `_baked/`
- `.claudeignore` — NEW: symlink → `.codexignore`

## Existing code to reuse
- `makeFence()` (`html-builder.js:13`) — code fence collision
- `collectAtPathFiles()` (`main.js`) — file collection
- `resolveAtPathFromSource()` (`main.js:165`) — path resolution
- `BINARY_EXTENSIONS` (`main.js`) — skip binary files
- `formatTokens()` (`main.js`) — token display

## Verification
1. `npm run build` + reload plugin
2. `@` autocomplete → fuzzy matches with highlights → inserts `[[path|@path]]`
3. Live preview → styled `@path` with token count
4. Graph view shows connections; backlinks lists referencing note
5. Rename file → link target + display alias update
6. Copy → clipboard has clean `@path` (no wikilink syntax)
7. Dry-run migration → reports counts
8. Full migration → converts legacy refs
9. Ribbon button → bakes repo files to `_repos/_baked/`
10. Status bar shows bake freshness
11. Auto-bake fires on interval, only copies changed files
12. Edit file on mobile → desktop shows "edited on mobile" notice → diff → apply
13. `.codexignore` excludes `_baked/`
