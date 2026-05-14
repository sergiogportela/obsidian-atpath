# Plan A — Status bar overhaul + folder autocomplete

Source prompt: `../prompts/001_improvements.md`
Codex review of prior revision: 14 findings (1 critical, 10 major, 3 minor) — folded in below.

This plan covers two related features that live in the editor/status-bar/suggest layer. **Folder autocomplete is upgraded from a suggester tweak to a full folder-reference feature** (per user decision): scanner, renderer, click, copy, and token policy all learn about folder refs. Plan B (`003_plan_file_explorer_token_counts.md`) consumes the shared helpers defined here.

---

## 0. Shared API (precondition for both plans)

To prevent folder semantics from leaking inconsistently between Plan A (editor) and Plan B (file explorer), both plans depend on a small shared module — proposed location `src/atpath-core.js` (callable from `src/main.js` and any future modules):

| Export | Purpose | Used by |
|---|---|---|
| `resolveAtPathTarget(ref, app, sourcePath) -> { kind: "file"\|"folder"\|"missing", target: TFile\|TFolder\|null, normalizedPath: string }` | Single source of truth for converting a scanned `@path` (file or folder) into a resolved target. | Scanner, click handler, copy, hover popover, file-explorer decoration. |
| `getFileTokens(path)` (delegates to existing `getTokenCount`) | Per-file token count via mtime cache. | Status bar, popover, folder aggregation. |
| `getFolderTokens(folderPath)` | Sum of non-ignored descendant file tokens. Backed by `folderTokenCache` (Plan B). | Status bar (folder ref totals), file-explorer badges. |
| `isIgnored(vaultPath)` | Hand-rolled ignore matcher (see Plan B §3.3). | Folder copy, folder token sum, file-explorer badge. |
| `enumerateFolderCandidates(query, sourcePath)` | Folder-aware candidate list with same-repo / cross-repo / loose ordering. | `AtPathSuggest`. |

Plan A introduces every helper except `getFolderTokens`+`isIgnored`, which Plan B defines. To allow Plan A to ship before Plan B, both helpers ship in Plan A with **stubs**:
- `isIgnored(path) -> false` (no ignores until Plan B's settings/matcher land).
- `getFolderTokens(folderPath)` walks `TFolder.children` synchronously the first time and caches in-memory for the editor session (no persistence, no event-driven invalidation — that arrives with Plan B).

Plan B replaces both stubs with full implementations without touching Plan A's call sites.

---

## 1. Goals

1. **Bigger, segmented status bar** with three live counts:
   - **Note tokens** (current editor buffer, including unsaved edits)
   - **Linked @path tokens** (sum across all `@path` / wikilink references — files **and** folders)
   - **Selection tokens** (only shown when the editor selection is non-empty)
2. **Rich hover popover** on the linked-tokens segment listing each referenced target (file or folder) with its token count and a checkbox. **"Copy selected"** copies the note plus only the checked targets' contents.
3. **Folder autocomplete + linking**: typing `@` suggests folders alongside files; selecting a folder inserts `@<folder>/`; the resulting reference is clickable, renderable, copyable, and counted just like a file reference.
4. **Drag-and-drop from file explorer**: dragging one or more files/folders from the Obsidian file explorer onto the editor inserts the matching `@path` references at the drop point, preserving the user's wikilink/legacy preference and respecting the folder semantics from goal #3.

---

## 2. Current state (verified against `src/main.js`)

- **Status bar**: one `addStatusBarItem()` at L1575–1577, rendered by `updateStatusBar()` (L1750–1810). Tooltip is plain-text `aria-label` (L1803–1809). Click handler at L1669 calls `copyNoteWithAtPaths()` (L1812–1862).
- **Token counting**: `getTokenCount(vaultPath)` (L1705) reads the **saved** file via `cachedRead` — **does not reflect the unsaved editor buffer**. The active-note total displayed today is stale until the user saves. `tokenCache: Map<path, {mtime, tokens}>` initialized at L1562.
- **Cache invalidation events** (L1581–1605): `modify`, `delete`, `rename` only. **`create` is NOT subscribed** — newly created files are tokenized lazily on first read. Acceptable today; revisited in Plan B.
- **Selection token count**: not implemented.
- **`@` autocomplete**: `AtPathSuggest extends EditorSuggest` at L413–515. `getSuggestions` (L438) calls `app.vault.getFiles()` — files only, folders excluded.
- **Scanner regex** (L519): `AT_PATH_RE = /(?<=^|[\s(])@([\w\p{L}\p{M}./_-]+\.[\w]+|[\w\p{L}\p{M}./_-][\w\p{L}\p{M}./ _()&-]+?\.[\w]+)/gu`. Requires a trailing file extension — folder refs (no extension) **are not matched** by today's scanner, click handler, renderer, or copy.
- **Rename pipeline** (`updateAtPathReferences` L2557–2665) does already detect `isFolder` and append `/` in the rewrite passes — so the *output* format `@folder/` is known elsewhere, but the *input scanner* never recognizes folder refs to begin with.

---

## 3. Design

### 3.1 Status bar — two segments

Use **two `addStatusBarItem()` calls** (one per independently clickable block, matching Novel Word Count and Vault Stats):

```
[ Note: 1,240 ]   [ @paths: 8,612  (5) ]
```

When the editor selection is non-empty, the **note segment** swaps into selection mode (selection count alongside full note total, distinct CSS class for styling):

```
[ Sel: 312 / 1,240 ]   [ @paths: 8,612  (5) ]
```

DOM per segment is plain elements with class names — **no inline styles** anywhere; all layout in `styles.css`:

```html
<div class="status-bar-item mod-clickable atpath-status-note">
  <span class="atpath-label">Note</span>
  <span class="atpath-value">1,240</span>
</div>
<div class="status-bar-item mod-clickable atpath-status-linked" aria-haspopup="true">
  <span class="atpath-label">@paths</span>
  <span class="atpath-value">8,612</span>
  <span class="atpath-count">(5)</span>
</div>
```

`.atpath-label` is hidden via CSS under ~600 px viewport width so numbers stay legible on narrow windows.

Click behavior:
- **Note** segment → existing `copyNoteWithAtPaths()` (preserves current muscle memory).
- **Linked** segment → toggles the popover in **sticky** mode (click-outside dismisses).

Mobile: `Platform.isMobile` early-returns from `addStatusBarItem` plumbing; the segments do not render. (Status bar is officially desktop-only.)

### 3.2 Selection-aware updates — **correct buffer source**

The current bar reads `getTokenCount(activeFile.path)` (file on disk). Fix: read the **active editor buffer** for the note total.

Register a CodeMirror 6 update listener via `registerEditorExtension`:

```js
EditorView.updateListener.of((update) => {
  if (update.docChanged || update.selectionSet) scheduleRefresh(update);
});
```

- **Note total**: `encode(editor.getValue()).length` (gpt-tokenizer is fast on note-sized inputs). Cached in-memory keyed by the editor's `state.doc` revision — invalidated on every doc change.
- **Selection total**: `encode(state.sliceDoc(from, to)).length`. Fires immediately, no debounce (cheap, small slice).
- **Linked total**: still uses `getFileTokens(path)` / `getFolderTokens(path)` from the shared API — those are saved-file backed (the linked targets aren't in the active buffer).
- Debounce note re-tokenization at **80 ms** (matches Better Word Count).
- Also subscribe to `workspace.on('active-leaf-change')` and `workspace.on('file-open')` to refresh when the user switches notes.
- Editor extension is registered behind `!Platform.isMobile` for parity with the segments.

### 3.3 Linked-files hover popover — **stylesheet-driven, not absolute-positioned in JS**

No official Obsidian API exposes interactive hover content from a status bar item. Build a custom popover. Per Community Plugin rules we **may not write inline styles or set `.style.left/top` from JS**.

**Approach:** anchor the popover as a `position: absolute` child of the segment itself, all positioning lives in `styles.css`:

```html
<div class="status-bar-item mod-clickable atpath-status-linked">
  ...value markup...
  <div class="atpath-linked-popover" role="dialog" hidden>
    ...rows / footer...
  </div>
</div>
```

```css
.atpath-status-linked { position: relative; }
.atpath-linked-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  width: min(420px, 90vw);
  max-height: 60vh;
  overflow: auto;
  z-index: var(--layer-popover);
}
.atpath-linked-popover[hidden] { display: none; }
```

Show/hide via the boolean `hidden` attribute or a `.is-open` class — never via inline `style.display`. Width / position adjustments via CSS media queries, not JS measurement.

**Anatomy:**

```
┌──────────────────────────────────────────────┐
│ Linked @paths  · 8,612 tokens · 5 targets    │
├──────────────────────────────────────────────┤
│ ☑  📄 notes/api.md                  1,210    │
│ ☑  📄 src/main.py                   2,440    │
│ ☑  📁 docs/spec/                    3,300    │  ← folder, sum of contents
│ ☑  📄 other-repo/src/util.ts        1,180    │
│ ☐  📄 archive/old.md                  482    │
├──────────────────────────────────────────────┤
│ Selected: 8,130 tokens                       │
│ [ All ] [ None ]          [ Copy selected ]  │
└──────────────────────────────────────────────┘
```

**Behavior:**
- Appears on `mouseenter` of the segment; remains while cursor is over segment OR panel.
- 150 ms grace timeout on `mouseleave`.
- Click toggles **sticky** mode; click-outside listener dismisses.
- Each row is a `<label>` wrapping `<input type="checkbox">` + path + count. Clicking the row toggles the checkbox.
- **Hover-link preview integration**: register a hover-link source so file rows trigger Obsidian's native preview:
  ```js
  this.registerHoverLinkSource("atpath-status", { display: "AtPath status bar", defaultMod: true });
  ```
  Row mouseover dispatches `app.workspace.trigger("hover-link", { event, source: "atpath-status", hoverParent, targetEl, linktext, sourcePath })`. Folder rows skip hover-link (Obsidian's preview is file-only).
- **Async click handlers**: every async listener (especially the "Copy selected" button) wraps its inner promise so it's **awaited inside the listener or explicitly `void`-ed** — never returns a dangling promise (Community Plugin rule).

**Folder rows** show the folder's aggregated token sum (`getFolderTokens(path)`); checkbox state for a folder means "include all its non-ignored descendants in the copy."

**State persistence:** checkbox state is per-note in memory only; cleared on `file-open`.

### 3.4 Folder reference semantics (the critical finding)

Folder autocomplete is **end-to-end** — scanner, renderer, click, copy, count. This is the load-bearing change in Plan A.

#### 3.4.1 Scanner regex

Add a sibling regex (do NOT broaden `AT_PATH_RE` and risk over-matching today's file refs):

```js
// Matches @folder/ — trailing slash is required to disambiguate from a partially typed file ref.
const AT_PATH_FOLDER_RE = /(?<=^|[\s(])@([\w\p{L}\p{M}._-][\w\p{L}\p{M}./ _()&-]*?)\/(?=$|[\s)>,;:!?])/gu;
```

Behavior: matches `@notes/api/` (resolves to `notes/api`), `@90_archive/` (resolves to `90_archive`). Trailing slash is **mandatory** — that's the disambiguator vs `AT_PATH_RE`.

`scanAtPathRefs` (L563) gets a **third pass** for folder matches, producing entries shaped like the existing file entries but with `kind: "folder"`:

```js
{ kind: "folder", vaultPath: "notes/api", displayPath: "notes/api/",
  format: "legacy" | "wikilink", fullMatch: "@notes/api/",
  start: m.index, end: m.index + m[0].length }
```

`buildExcludedRanges` / `isInExcludedRange` already prevent matches inside fenced code and frontmatter — folder pass uses the same machinery.

#### 3.4.2 Target resolution

`resolveAtPathTarget(ref, app, sourcePath)`:

- If `ref.kind === "folder"`: `app.vault.getAbstractFileByPath(ref.vaultPath)` → if `instanceof TFolder` return `{ kind: "folder", target, normalizedPath: target.path }`; else `kind: "missing"`.
- File refs unchanged (existing `metadataCache.getFirstLinkpathDest` path).
- Returned by both `scanAtPathRefs` consumers and the status-bar popover.

#### 3.4.3 Click handler

In the existing click-to-open path for `@path` refs (currently file-only via `workspace.openLinkText`), add a folder branch:

```js
if (resolved.kind === "folder") {
  // Reveal in file explorer + expand
  app.workspace.getLeavesOfType("file-explorer")[0]?.view.revealInFolder?.(resolved.target);
}
```

(`revealInFolder` is the documented public API on `FileExplorerView`; if not present in the running Obsidian version, fall back to `workspace.openLinkText(resolved.normalizedPath, sourcePath)` which Obsidian routes to the folder note if one exists, otherwise no-ops.)

#### 3.4.4 Copy semantics

`copyNoteWithAtPaths({ paths: Set<string> })`:

- For each ref, if `kind === "folder"`: enumerate `target.children` recursively, filter out `isIgnored(child.path)` and oversized files (existing `maxFileSizeMB`), then inline each remaining file's content using the existing per-file inlining template.
- File-ref behavior unchanged.
- Folder copy emits a header like `--- @folder/ (12 files, 3,300 tokens) ---` so the user can locate where the folder block starts in the output. Single header style, no nesting markers.

#### 3.4.5 Token policy

`getFolderTokens(folderPath)` returns `sum( getFileTokens(c.path) )` for every descendant `TFile` where `!isIgnored(c.path)` and size ≤ `maxFileSizeMB`. In Plan A's stub: walks `TFolder.children` synchronously the first time, caches `folderTokenSumCache: Map<path, number>` for the editor session, invalidated on `file-open` (cheap and good-enough for the status-bar use case). Plan B replaces the cache with event-driven deltas.

#### 3.4.6 Suggester behavior

Extend `AtPathSuggest.getSuggestions` (L438) to enumerate folders via `enumerateFolderCandidates(query, sourcePath)`:

- Source: `app.vault.getAllFolders?.(false) ?? app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder)`. Root (`path === ""`) excluded.
- **Slash-trigger rule (precise):** if the query (text after `@` up to cursor) ends with `/`, treat the prefix as a folder path. Resolve that prefix via `getAbstractFileByPath`. If it resolves to a `TFolder`, return **only immediate children** of that folder (files + sub-folders), no fuzzy scoring across the whole vault. If it doesn't resolve, fall back to substring match on full paths starting with that prefix.
- Otherwise: fuzzy-score files **and** folders together; folders get a **1.3× score bias** so they're not buried.
- Same-repo / cross-repo / loose three-tier ordering still applies.
- Hard-cap 50 (existing cap).

#### 3.4.7 Rendering and insertion

- `renderSuggestion` (L493): folder rows get `setIcon(iconEl, "folder")`; path rendered with trailing `/`.
- `selectSuggestion` (L502): **legacy mode** inserts `"@" + folder.path + "/ "` (trailing slash + space — re-triggers the suggester naturally if the user keeps typing for a sub-folder).
- **Wikilink mode + folders**: `fileManager.generateMarkdownLink` is file-only and won't produce a working folder wikilink. **Decision:** when the user is in wikilink mode AND selects a folder, still insert the **legacy `@folder/` form**. The wikilink mode setting governs files only. Document this in the setting's help text. (Alternative — folder-note convention — rejected because not every vault uses folder notes and we'd need a convention switch.)

#### 3.4.8 Drop ambiguous setting

Drop the prior `folderInsertTrailingSlash` setting. The trailing slash is **mandatory** for the scanner to recognize folder refs; making it optional creates dead text.

### 3.5 Drag-and-drop from file explorer

Dragging a file or folder from Obsidian's file explorer onto the editor should insert a working `@path` reference at the drop point, so users can build prompt notes without switching to keyboard autocomplete.

#### 3.5.1 Hook point — CM6 DOM event handler

Register a CodeMirror 6 extension via `registerEditorExtension` that adds `drop` and `dragover` handlers to the editor DOM:

```js
EditorView.domEventHandlers({
  dragover(evt, view) {
    if (!extractDraggedVaultPaths(evt.dataTransfer)) return false;
    evt.preventDefault();              // signal we accept the drop
    evt.dataTransfer.dropEffect = "link";
    return true;
  },
  drop(evt, view) {
    const refs = extractDraggedVaultPaths(evt.dataTransfer);
    if (!refs?.length) return false;   // let Obsidian's default handler run
    evt.preventDefault();
    evt.stopPropagation();
    const pos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
    insertAtPathRefs(view, pos ?? view.state.selection.main.head, refs);
    return true;
  },
});
```

Calling `evt.preventDefault()` only when we successfully extract refs is the disambiguator: if `extractDraggedVaultPaths` returns nothing (external file, image paste, unrelated drag), we let Obsidian's built-in handler run untouched (preserves image-paste, embed-on-drop, etc.).

#### 3.5.2 `extractDraggedVaultPaths(dataTransfer) -> { kind, vaultPath, target }[]`

Probe `DataTransfer` in priority order; first match wins per drag:

1. **Obsidian's internal MIME** — Obsidian populates a JSON payload on its own drags. The exact MIME has shifted across versions, so probe defensively and accept any of `application/obsidian-files`, `application/obsidian-file`, or `application/x-obsidian-files`; parse as JSON; expect `{ files: [{ path }] }` or an array of `{ path }`.
2. **`text/uri-list`** — when Obsidian falls back to standard drag, the URIs look like `obsidian://open?vault=...&file=<path>` or `file:///abs/path`. Decode and strip the vault prefix (compare against `app.vault.adapter.getBasePath?.()` on desktop adapters).
3. **`text/plain`** — last resort; some Obsidian builds put the bare vault path here. Trim and resolve.

For each candidate path, resolve via `app.vault.getAbstractFileByPath(path)`:
- `TFile` → `{ kind: "file", vaultPath: path, target }`.
- `TFolder` → `{ kind: "folder", vaultPath: path, target }`.
- `null` → drop the candidate silently (don't insert a broken ref).

Skip the active note itself (resolved path equals `view.state.field(editorInfoField).file?.path`) — inserting a self-ref always inlines empty/recursive content.

#### 3.5.3 Insertion

`insertAtPathRefs(view, pos, refs)`:

- For each `ref`:
  - **File**: format the same way `AtPathSuggest.selectSuggestion` would — wikilink mode → `fileManager.generateMarkdownLink(target, sourcePath, "", "@" + displayPath)`; legacy mode → `"@" + relPath`. Respects the user's existing `useWikilinks` setting.
  - **Folder**: always legacy form `"@" + folder.path + "/"` (mirrors §3.4.7 decision — wikilink mode setting governs files only).
- Join multi-file drops with a single space (preserves reflow); a trailing space is appended so the cursor lands ready for more typing.
- Dispatch a single CM6 transaction so the drop is one undo step:
  ```js
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: "input.drop",
  });
  ```
- `userEvent: "input.drop"` lets the scanner's debounced re-scan treat the insertion as a normal edit (no special case in §3.4.1).

#### 3.5.4 Multi-file drops

Obsidian supports drag-selecting multiple file-explorer rows. The internal payload's `files` array carries all of them; iterate in order. Cap at 50 per drop to prevent accidental flood inserts; emit a `Notice("Drop limited to 50 paths")` if exceeded.

#### 3.5.5 Drag outside the editor

Drops on the status bar, popover, or settings panel are no-ops — the handler is bound to the CM6 editor DOM only; nothing intercepts elsewhere. Confirmed by `EditorView.domEventHandlers` scoping.

#### 3.5.6 Settings

| Setting | Default | Notes |
|---|---|---|
| `enableDragDropAtPath` | `true` | Disable to fully restore Obsidian's default drag behavior (image embed, etc.) |

When `false`, the editor extension is not registered — Obsidian's built-in drop handler runs as today.

#### 3.5.7 Composition with existing pipeline

The dropped text is just `@path` / `@folder/` literally. The existing scanner (§3.4.1), resolver (§3.4.2), click handler (§3.4.3), copy (§3.4.4), and token counter (§3.4.5) all pick it up automatically on next scan — no new code paths in those stages.

---

## 4. Settings additions

| Setting | Default | Notes |
|---|---|---|
| `statusBarShowSelection` | `true` | Toggle the selection segment |
| `suggestFolders` | `true` | Disable folder autocomplete entirely |
| `enableDragDropAtPath` | `true` | Insert `@path` refs when dragging files/folders from the explorer into the editor |

All labels sentence-case (Community Plugin rules). `folderInsertTrailingSlash` (from prior plan) removed.

---

## 5. Styling

Add to `styles.css` (no inline styles anywhere in JS):
- `.atpath-status-note`, `.atpath-status-linked`, `.atpath-status-selection`
- `.atpath-label`, `.atpath-value`, `.atpath-count`
- `.atpath-linked-popover`, `.atpath-linked-popover-row`, `.atpath-linked-popover-footer`
- Media query: hide `.atpath-label` below 600 px width
- Popover positioning rules from §3.3

---

## 6. Implementation steps (in order)

1. **Carve out `src/atpath-core.js`** with the shared API (§0). Re-export from `src/main.js`. Plan A ships with stubs for `isIgnored` / `getFolderTokens` per §0.
2. **Refactor status bar setup**: two `addStatusBarItem()` calls; preserve click-to-copy on the note segment.
3. **CodeMirror 6 update listener**: 80 ms debounce for doc-change re-tokenization; immediate selection updates. Active-buffer tokenization via `encode(editor.getValue()).length`. `Platform.isMobile` guard.
4. **Build the popover**: stylesheet-anchored DOM; mouseenter/leave + 150 ms grace; click-to-pin + click-outside dismissal; `registerHoverLinkSource` integration; all async listeners properly awaited or `void`-ed.
5. **Folder regex + scanner pass**: add `AT_PATH_FOLDER_RE`; third pass in `scanAtPathRefs` producing `kind: "folder"` entries; respects existing excluded-ranges.
6. **`resolveAtPathTarget`**: file + folder branches; consumers (click, popover, copy) switch to using it instead of inline `getFirstLinkpathDest`.
7. **Click handler folder branch**: `revealInFolder` + fallback.
8. **`copyNoteWithAtPaths({ paths })`** folder branch: descendant walk, ignore filter, max-size filter, header line.
9. **`AtPathSuggest`** updates: `enumerateFolderCandidates`; precise slash-trigger rule (immediate children of resolved folder); 1.3× bias; folder rendering; folder insertion (legacy form even in wikilink mode).
10. **Drag-and-drop extension** (§3.5): CM6 `EditorView.domEventHandlers({dragover, drop})`; `extractDraggedVaultPaths` with three-tier MIME probe; `insertAtPathRefs` shared with the suggester's formatter; 50-ref cap with `Notice`.
11. **Settings**: three new fields (`statusBarShowSelection`, `suggestFolders`, `enableDragDropAtPath`); drop `folderInsertTrailingSlash`.
12. **Automated tests** (see §10).
13. **Manual smoke test** against a real vault.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Active-buffer tokenizer cost on huge notes | 80 ms debounce + revision-keyed in-memory cache; `gpt-tokenizer` benchmarks ~1 M tokens/s on note-sized inputs |
| `AT_PATH_FOLDER_RE` over-matches inside URLs, code, lists | Same `buildExcludedRanges` machinery as file regex; required trailing `/(?=$|[\s)>,;:!?])` boundary |
| Folder-note collisions (path resolves to both folder and folder-note `.md`) | `resolveAtPathTarget` always returns folder for `@folder/`; the file resolves under `@folder/folder.md`. Convention documented in README |
| `revealInFolder` not present on older Obsidian | Feature-detect; fall back to `workspace.openLinkText` (folder-note) then no-op |
| Wikilink mode + folder = legacy form may surprise users | Setting help text states folders always use `@folder/`; popover always shows the rendered form regardless of mode |
| Popover anchored absolute inside segment escapes status-bar overflow clip | `position: fixed` fallback rule in `styles.css` with `bottom: var(--status-bar-height, 28px)`; verified during manual test |
| Lookbehinds in new folder regex unsupported on old iOS Safari | Lookbehind is already a known review risk for `AT_PATH_RE`; folder regex uses the same `(?<=^|[\s(])` form for consistency. Document together |
| Drag-and-drop intercepts an Obsidian-native drag we don't recognize (regression: image embed stops working) | `extractDraggedVaultPaths` returns empty for any payload it doesn't explicitly recognize, AND we only call `preventDefault()` inside `dragover`/`drop` when refs are non-empty. Unknown payloads bubble to Obsidian's default handler. Tested against image drag, external file drag, intra-editor text drag |
| Obsidian renames the internal drag MIME between versions | Three-tier fallback (internal JSON MIME → `text/uri-list` → `text/plain`). One failure mode = path-only insertion instead of full wikilink — still functional. Detected at runtime, logged via `console.warn` once if the internal MIME goes missing |
| Drop from file explorer onto its own folder section accidentally fires editor drop | Editor extension is scoped to the CM6 editor DOM via `EditorView.domEventHandlers`; events on the file-explorer pane never reach our handler |
| Multi-file drag of 1000s of files freezes paste | 50-ref cap with `Notice`; insertion is a single CM6 transaction so undo is one step |

---

## 8. Out of scope

- File-explorer sidebar decoration (Plan B).
- Persisting popover checkbox state.
- User-reorderable status bar segments.
- Mobile support (status bar items are desktop-only per Obsidian docs).
- Folder-note convention switch in the settings.

---

## 9. Acceptance criteria

- Status bar shows two segments; selection count appears within ~100 ms of selecting text.
- **Note count reflects unsaved edits within 80 ms.** (Regression from current state.)
- Hover popover opens within ~50 ms; survives moving cursor between segment and panel; click-pins; click-outside dismisses.
- "Copy selected" produces note + only checked targets' contents (files inline directly; folders inline all non-ignored descendants under a single header).
- Typing `@proj` shows folder rows mixed with files (1.3× bias); typing `@notes/` shows only immediate children of `notes/`.
- `@notes/api/` in a note is **clickable** (reveals folder in explorer), **renderable** (folder icon + path), **copyable** (descendants inlined), and **counted** (sum in linked total).
- Wikilink-mode setting still works for files; folder inserts are always `@folder/`.
- **Dragging a file** from the file explorer onto the editor inserts a working `@path` ref at the drop point, respecting wikilink/legacy mode.
- **Dragging a folder** from the file explorer onto the editor inserts `@folder/` at the drop point, regardless of wikilink/legacy mode.
- **Dragging multiple selected rows** inserts each ref space-separated in one undo step; 50-ref cap shows a `Notice` and inserts the first 50.
- **Dragging an image or external file** (non-vault) onto the editor still works as before (Obsidian default).
- `enableDragDropAtPath = false` fully restores Obsidian's default drag behavior.
- Plugin unload restores original DOM and disconnects all listeners.
- No `console.log`, `innerHTML`, inline styles, `fetch()`; all promises awaited / `.catch()`-ed / `void`-ed.

---

## 10. Automated test plan

Plan A introduces small, testable functions. Tests live under `tests/` and run with `node --test` (or `vitest` if approved as a dep — currently planning on the zero-dep `node:test` runner).

| Target | Test cases |
|---|---|
| `AT_PATH_FOLDER_RE` | Matches `@foo/`, `@foo/bar/`, `@90_archive/`; rejects `@foo` (no slash), `@foo.md` (file), `@foo/bar` (no trailing slash). Inside fenced code → excluded. Inside URL `http://...` → excluded by boundary rules. |
| `scanAtPathRefs` | Mixed file + folder + wikilink in one document yields correctly typed entries with correct ranges. |
| `resolveAtPathTarget` | Folder → `kind:"folder"`. Missing folder → `kind:"missing"`. File ref unchanged. |
| `enumerateFolderCandidates` | Slash-trigger with resolved folder returns only immediate children; with unresolved prefix returns prefix-match list. Non-slash query returns files + folders with bias. |
| `copyNoteWithAtPaths` (folder branch) | Mock vault with 3 files in a folder + 1 ignored: output includes 2 non-ignored, single header, ignored excluded. Oversized file skipped. |
| Popover row checkbox filter | `{ paths: Set }` filter inlines only checked targets; "Copy selected" with zero checked = no inlined refs. |
| Buffer token counter | Selection slice tokens; full doc tokens; revision-cache hit/miss. |
| `extractDraggedVaultPaths` | Internal MIME JSON → list of `TFile`/`TFolder` refs. `text/uri-list` with `obsidian://` URLs → resolved. `text/plain` with bare vault path → resolved. Unknown payload → `null` (handler bails out). Path matching the active note → skipped. Non-existent path → skipped silently. |
| `insertAtPathRefs` | File in legacy mode → `@<path>`. File in wikilink mode → `[[…|@<path>]]` via `generateMarkdownLink`. Folder in either mode → `@<path>/`. Multi-ref drop → space-separated single transaction; cursor lands at end. >50 refs → `Notice` + first 50 only. |
| Drag-and-drop hook | `dragover` with recognized payload calls `preventDefault`; with unrecognized payload returns `false` (default behavior preserved). `drop` outside the editor DOM does not trigger our handler. `enableDragDropAtPath=false` → extension not registered, default drag behavior intact. |

Manual smoke test in §6 step 12 still runs (real vault, narrow window, light/dark theme, deferred file-explorer).

---

## 11. Dependencies on Plan B

Plan A ships with stubs (`isIgnored -> false`, `getFolderTokens -> synchronous walk`). When Plan B lands:
- `isIgnored` becomes the hand-rolled matcher (Plan B §3.3).
- `getFolderTokens` becomes the event-driven `folderTokenCache` consumer.
- No Plan A call site changes.
