# Plan A — Status bar overhaul + folder autocomplete

Source prompt: `../prompts/001_improvements.md`
Codex review history is in §13. Two rounds: 14 findings (round 1) + 11 findings affecting this plan (round 2). All folded in inline; no finding dismissed.

This plan covers two related features that live in the editor/status-bar/suggest layer. **Folder autocomplete is upgraded from a suggester tweak to a full folder-reference feature** (per user decision): scanner, renderer, click, copy, and token policy all learn about folder refs. Plan B (`003_plan_file_explorer_token_counts.md`) consumes the shared helpers defined here.

---

## 0. Shared API (precondition for both plans)

To prevent folder semantics from leaking inconsistently between Plan A (editor) and Plan B (file explorer), both plans depend on a small shared module — proposed location `src/atpath-core.js`.

**Module shape — plugin-bound factory, not free exports.** Codex flagged that bare exports lack the plugin/app/settings context every helper needs (resolve-paths logic reads `settings.repos`, ignore matcher reads settings, token cache lives on the plugin instance). The module therefore exports a single factory:

```js
// src/atpath-core.js
module.exports = function createAtPathCore(plugin) {
  const { app } = plugin;
  return {
    resolveAtPathTarget(ref, sourcePath) { /* uses app + plugin.settings */ },
    getFileTokens(path) { /* delegates to plugin.getTokenCount */ },
    getFolderTokens(folderPath) { /* async; see §3.4.5 */ },
    isIgnored(vaultPath) { /* reads plugin.settings.tokenCountIgnorePatterns */ },
    enumerateFolderCandidates(query, sourcePath) { /* uses app.vault */ },
    formatAtPathInsertion(target, sourcePath, mode) { /* shared by suggest + drop, see §3.4.7 */ },
  };
};
```

`src/main.js` calls `this.core = createAtPathCore(this)` in `onload` and routes every call site through `this.core.*`. This keeps the helpers testable (pass a fake plugin) and prevents settings drift between the two plans.

| Export | Purpose | Used by |
|---|---|---|
| `resolveAtPathTarget(ref, sourcePath) -> { kind: "file"\|"folder"\|"missing", target: TFile\|TFolder\|null, normalizedPath: string }` | Single source of truth for converting a scanned `@path` (file or folder) into a resolved target. | Scanner, click handler, copy, hover popover, file-explorer decoration. |
| `getFileTokens(path)` (delegates to existing `getTokenCount`) | Per-file token count via mtime cache. | Status bar, popover, folder aggregation. |
| `getFolderTokens(folderPath)` **(async)** | Returns a Promise of the sum of non-ignored descendant file tokens. Backed by `folderTokenCache` (Plan B). **Always async** because per-file tokenization goes through `vault.cachedRead`. | Status bar (folder ref totals), file-explorer badges. |
| `isIgnored(vaultPath)` | Hand-rolled ignore matcher (see Plan B §3.3). | Folder copy, folder token sum, file-explorer badge. |
| `enumerateFolderCandidates(query, sourcePath)` | Folder-aware candidate list with same-repo / cross-repo / loose ordering. **`sourcePath` is required** so slash-trigger autocomplete can resolve same-repo prefixes. | `AtPathSuggest`. |
| `formatAtPathInsertion(target, sourcePath, mode)` | **Shared formatter** that produces the insertion string for both suggest-pick and drop. Computes the same-repo / cross-repo / vault-absolute display path from `target.path` + `sourcePath`. Returns `@<displayPath>` (or wikilink for files when `mode === "wikilink"`); folders always emit `@<displayPath>/`. | `AtPathSuggest.selectSuggestion`, `insertAtPathRefs` (drop). |

Plan A introduces every helper except `getFolderTokens`+`isIgnored`, which Plan B defines. To allow Plan A to ship before Plan B, both helpers ship in Plan A with **stubs**:
- `isIgnored(path) -> false` (no ignores until Plan B's settings/matcher land).
- `getFolderTokens(folderPath)` is **already async in the stub** so call sites don't change when Plan B's event-driven cache replaces it. The stub walks `TFolder.children` recursively, awaits `getFileTokens` per descendant, sums the result, and memoizes per `(folderPath, lastFolderMtime)` in a session-scoped `Map`. Memo entries are dropped on `file-open` (cheap and good-enough for the status-bar use case). Plan B replaces the body with a `folderTokenCache` lookup (still async to keep the contract; see Plan B §9).

Plan B replaces both stubs with full implementations without touching Plan A's call sites.

---

## 0.5 Prerequisite — Community Plugin compliance sweep

Codex correctly flagged that Plan A's acceptance criterion "no inline styles / unawaited promises" can't pass while existing `src/main.js` has multiple violations. Before any Plan A code lands, complete this **isolated, no-feature-change sweep**:

| Site | Issue | Fix |
|---|---|---|
| `src/main.js:81-82` | `ta.style.position = "fixed"; ta.style.opacity = "0";` in the clipboard fallback | Move to a dedicated `.atpath-clipboard-fallback` class in `styles.css`; assign via `ta.className`. |
| `src/main.js:1607` | `this.saveSettings();` (unawaited inside rename event) | `void this.saveSettings();` (acceptable inside a non-async event listener) OR await if the enclosing handler can be `async`. |
| `src/main.js:798`, `:858`, `:1724` | `plugin.getTokenCount(...).then(...)` — unhandled rejection branch | Either chain `.then(_, reject)` with a `console.warn` rejection arm OR refactor to `void (async () => { ... })()`. |
| `src/main.js:932`, `:994`, `:1085`, `:1205` | `.then((t) => { t.inputEl.type = "password"; })` on Setting builder chains | These are sync callbacks on already-resolved chains — wrap with `.then(_, console.warn)` or document as Setting API convention. (Low priority; flagged so reviewer can skim past.) |

Land this sweep as a separate commit before Plan A's first feature commit so the lint baseline is clean.

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

#### 3.4.1 Scanner regex + renderer coverage

**Avoid the second lookbehind.** `AT_PATH_RE` already uses `(?<=^|[\s(])`, flagged as an iOS-Safari risk; adding a second instance compounds the risk and `manifest.json` is not desktop-only (we want mobile parity for the rendered ref, even if the popover/badge features stay desktop). Implementation:

```js
// Anchor the boundary by capturing it instead of looking behind it.
// Group 1 = leading boundary (start-of-line, whitespace, or "(").
// Group 2 = folder path. Trailing slash is mandatory.
const AT_PATH_FOLDER_RE = /(^|[\s(])@([\w\p{L}\p{M}._-][\w\p{L}\p{M}./ _()&-]*?)\/(?=$|[\s)>,;:!?])/gu;
```

The scanner adjusts the captured `start` index by `m[1].length` to skip the leading boundary character. The same refactor should be applied to `AT_PATH_RE` in the compliance sweep (§0.5 follow-up); for Plan A we ship the new folder regex in capture-group form and leave the existing file regex untouched to bound the diff, with a TODO to migrate the file regex in a follow-up.

**Scanner ordering (minor finding m15).** `AT_PATH_RE` matches `@foo.md` greedily and `@foo.md/` would never reach the folder pass. Two-step fix:

1. **Run the folder pass first** in `scanAtPathRefs`. Record `(start, end)` of every folder match in an `excludedFolderRanges` list. Then run the file pass and skip any file match whose range overlaps the folder ranges.
2. As a defense-in-depth, also reject file matches whose `end` index is immediately followed by `/`. This stops a stray `@foo.md` from claiming a token that's actually part of `@foo.md/` (e.g., a file with `.md` in its name inside a folder named `notes/api/`).

`scanAtPathRefs` (L563) thus gains a folder pass producing entries shaped like the existing file entries but with `kind: "folder"`:

```js
{ kind: "folder", vaultPath: "notes/api", displayPath: "notes/api/",
  format: "legacy" | "wikilink", fullMatch: "@notes/api/",
  start: m.index + m[1].length, end: m.index + m[0].length }
```

`buildExcludedRanges` / `isInExcludedRange` already prevent matches inside fenced code and frontmatter — folder pass uses the same machinery.

**Critical finding C1 — renderer coverage.** Adding folder refs to the scanner does **not** automatically make them render in Live Preview or Reading mode. Two additional hook points must learn the folder form:

1. **Live Preview decoration** (`src/main.js:610`, `buildAtPathViewPlugin`). Currently uses `MatchDecorator({ regexp: AT_PATH_RE, … })`. Replace with a custom `ViewPlugin` that runs both `AT_PATH_RE` and `AT_PATH_FOLDER_RE` against the visible ranges and builds a `DecorationSet` from the combined matches. The widget for a folder ref renders a folder icon and the count from `getFolderTokens(path)` (async — render `…` placeholder first, dispatch a transaction to refresh once resolved). Cursor-inside behavior identical to file branch (mark, not replace).
2. **Reading-mode postprocessor** (`src/main.js:777-868`, `registerPostProcessor`). The legacy-text walker uses `AT_PATH_RE`. Extend it: run folder regex first on the same `textContent`, split into folder + file + plain spans, and emit `<a class="atpath-link atpath-folder-link">` for folder refs with the folder icon + token span. Wikilinks branch (rendered as `a.internal-link`) doesn't need a folder branch — Obsidian only renders file targets via `internal-link`; folder refs that survive the wikilink path don't exist (per §3.4.7, folders always use legacy form).

Both call sites read `plugin.core.resolveAtPathTarget` to pick the right icon/click handler; this is the same resolver the scanner uses.

#### 3.4.2 Target resolution

`resolveAtPathTarget(ref, app, sourcePath)`:

- If `ref.kind === "folder"`: `app.vault.getAbstractFileByPath(ref.vaultPath)` → if `instanceof TFolder` return `{ kind: "folder", target, normalizedPath: target.path }`; else `kind: "missing"`.
- File refs unchanged (existing `metadataCache.getFirstLinkpathDest` path).
- Returned by both `scanAtPathRefs` consumers and the status-bar popover.

#### 3.4.3 Click handler

In the existing click-to-open path for `@path` refs (currently file-only via `workspace.openLinkText`), add a folder branch. **Best-effort, iterate all leaves.** Codex flagged that `revealInFolder` is not a documented public API and that only-`[0]` contradicts the multi-leaf reality from Plan B §3.1.1. Single helper used by every click-into-folder site:

```js
function revealFolderInExplorer(app, folder) {
  const leaves = app.workspace.getLeavesOfType("file-explorer");
  let revealed = false;
  for (const leaf of leaves) {
    const view = leaf.view;
    try {
      if (typeof view?.revealInFolder === "function") {
        view.revealInFolder(folder);
        revealed = true;
      }
    } catch (err) {
      // Internal API drift — try next leaf, fall through to fallback below.
      console.warn("[atpath] revealInFolder failed", err);
    }
  }
  if (!revealed) {
    // Best-effort fallback: open the folder note if one exists; otherwise no-op.
    void app.workspace.openLinkText(folder.path, "", false).catch(() => {});
  }
}
```

Notes:
- Multi-leaf reveal is intentional — if the user has two explorer panes, both should expand and highlight. Matches Plan B's per-leaf decoration model.
- Wrapped in `try/catch` so an Obsidian API rename doesn't crash the click path; `console.warn` surfaces it without breaking flow.
- Fallback is `void`-ed because we genuinely don't care if it fails (folder notes are optional).

#### 3.4.4 Copy semantics

`copyNoteWithAtPaths({ paths: Set<string> })`:

- For each ref, if `kind === "folder"`: enumerate `target.children` recursively, filter out `isIgnored(child.path)` and oversized files (existing `maxFileSizeMB`), then inline each remaining file's content using the existing per-file inlining template.
- File-ref behavior unchanged.
- Folder copy emits a header like `--- @folder/ (12 files, 3,300 tokens) ---` so the user can locate where the folder block starts in the output. Single header style, no nesting markers.

#### 3.4.5 Token policy — **async contract**

`getFolderTokens(folderPath)` returns a **Promise** of `sum( getFileTokens(c.path) )` for every descendant `TFile` where `!isIgnored(c.path)` and size ≤ `maxFileSizeMB`. The async contract is mandatory because `getTokenCount` (L1705) calls `vault.cachedRead` — there is no synchronous code path.

Plan A stub:

```js
async function getFolderTokens(folderPath) {
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!(folder instanceof TFolder)) return 0;
  const memoKey = folderPath; // mtime-keyed invalidation comes with Plan B
  if (folderTokenSumCache.has(memoKey)) return folderTokenSumCache.get(memoKey);
  const tasks = [];
  (function walk(node) {
    for (const c of node.children) {
      if (c instanceof TFolder) walk(c);
      else if (c instanceof TFile && !isIgnored(c.path) && fileUnderSizeCap(c))
        tasks.push(getFileTokens(c.path));
    }
  })(folder);
  const counts = await Promise.all(tasks);
  const total = counts.reduce((a, b) => a + b, 0);
  folderTokenSumCache.set(memoKey, total);
  return total;
}
```

Every consumer (status-bar linked total, popover rows, copy folder header) must therefore `await` the call. Live Preview / Reading mode renderers render a `…` placeholder synchronously, dispatch the resolve, and refresh on completion. Cache cleared on `file-open` (per §0).

Plan B replaces the body with a `folderTokenCache` lookup that is still async (returns a resolved Promise of the cached number, or kicks off a subtree index and resolves when complete; see Plan B §9).

#### 3.4.6 Suggester behavior

Extend `AtPathSuggest.getSuggestions` (L438) to enumerate folders via `enumerateFolderCandidates(query, sourcePath)`:

- **Source: traverse `app.vault.getRoot()`.** Codex flagged that `getAllFolders()` and `getAllLoadedFiles()` are not documented public Vault APIs. Use:
  ```js
  function* walkFolders(folder) {
    for (const c of folder.children) {
      if (c instanceof TFolder) { yield c; yield* walkFolders(c); }
    }
  }
  const all = [...walkFolders(app.vault.getRoot())]; // root itself excluded
  ```
  Cached per-session and invalidated on `vault.on('create' | 'delete' | 'rename')` for `TFolder` instances.
- **Source-aware slash-trigger rule.** If the query (text after `@` up to cursor) ends with `/`, treat the prefix as a folder path. **Resolution is source-aware** so same-repo prefixes like `@notes/` work when the active note lives under `_repos/foo/...`:
  1. **Same-repo first.** If `sourcePath` lives under a repo prefix (e.g., `_repos/foo/`), try `getAbstractFileByPath("_repos/foo/" + prefix)`. If it resolves to a `TFolder`, return only its immediate children, prefixed back with the same-repo relative form via `formatAtPathInsertion`.
  2. **Vault-absolute fallback.** If same-repo lookup fails, try `getAbstractFileByPath(prefix)` (the prior vault-absolute behavior).
  3. **Cross-repo prefix.** If neither resolves, fall back to substring match on full paths starting with that prefix.
- Otherwise: fuzzy-score files **and** folders together; folders get a **1.3× score bias** so they're not buried.
- Same-repo / cross-repo / loose three-tier ordering still applies (folders sorted within the same tier as files).
- Hard-cap 50 (existing cap).

The slash-trigger logic lives in `enumerateFolderCandidates(query, sourcePath)` (sourcePath required, never default to `""`); the suggester passes `this.context?.file?.path ?? ""`.

#### 3.4.7 Rendering and insertion — **shared formatter**

- `renderSuggestion` (L493): folder rows get `setIcon(iconEl, "folder")`; path rendered with trailing `/`.
- `selectSuggestion` (L502): calls **`core.formatAtPathInsertion(target, sourcePath, mode)`** — the single formatter used by both suggest and drop (§3.5.3). The formatter:
  - Computes the display path (same-repo relative if `target.path` is under the source's repo prefix; cross-repo `<repo>/...` if under a different `_repos/` prefix; vault-absolute otherwise). This is the existing logic in `selectSuggestion` lifted into one place.
  - Files: emits `"@" + displayPath` (legacy) or `fileManager.generateMarkdownLink(target, sourcePath, "", "@" + displayPath)` (wikilink).
  - Folders: emits `"@" + displayPath + "/"` regardless of `mode`.
  - Appends a single trailing space when the consumer is `selectSuggestion` (re-triggers autocomplete); drop omits the trailing space (drop has its own join logic, §3.5.3).
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

#### 3.5.3 Insertion — **shares the §3.4.7 formatter**

`insertAtPathRefs(view, pos, refs)`:

- Reads `sourcePath` from `view.state.field(editorInfoField).file?.path ?? ""` — required so the formatter can compute same-repo / cross-repo display paths (Codex M8: the prior draft referenced undefined `relPath` and raw `folder.path`, neither correct).
- For each `ref`, call `core.formatAtPathInsertion(ref.target, sourcePath, mode)` where `mode = plugin.settings.useWikilinks ? "wikilink" : "legacy"`. Files honor the wikilink mode; folders always emit `@<displayPath>/` per the formatter contract. **No drop-specific formatting code path.**
- Join multi-ref drops with a single space (preserves reflow); a trailing space is appended at the end so the cursor lands ready for more typing.
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

#### 3.5.6 Settings — **Compartment-based runtime toggle**

| Setting | Default | Notes |
|---|---|---|
| `enableDragDropAtPath` | `true` | Disable to fully restore Obsidian's default drag behavior (image embed, etc.) |

**Implementation note (Codex M10).** Once an editor extension is registered via `registerEditorExtension`, it cannot be unregistered without restarting the plugin. Use a CodeMirror 6 `Compartment` so the setting toggle works without reload:

```js
const dragDropCompartment = new Compartment();

// During onload:
this.registerEditorExtension(
  dragDropCompartment.of(plugin.settings.enableDragDropAtPath ? buildDragDropExtension(plugin) : [])
);

// On settings change:
for (const leaf of app.workspace.getLeavesOfType("markdown")) {
  const view = leaf.view?.editor?.cm; // CM6 EditorView
  view?.dispatch({
    effects: dragDropCompartment.reconfigure(
      plugin.settings.enableDragDropAtPath ? buildDragDropExtension(plugin) : []
    ),
  });
}
```

When `false`, the compartment contains the empty extension `[]` — Obsidian's built-in drop handler runs as today. When toggled back to `true`, the compartment is reconfigured live without a reload.

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

## 6. Implementation strategy — agent delegation

The implementing agent (the human's primary Claude session) **must delegate aggressively** during this plan. Plan A touches a dozen call sites across `src/main.js`, two renderer pipelines, the suggester, the status bar, and a new CM6 extension; doing every read/edit in the main context is wasteful and risks losing track of the cross-cutting contracts (`formatAtPathInsertion`, async `getFolderTokens`, `resolveAtPathTarget`). The defaults below should be treated as the floor, not the ceiling — when in doubt, delegate.

### Delegation defaults

| Agent | When to use it |
|---|---|
| **Explore** (read-only) | Locating code, mapping call sites, verifying line numbers, surveying current DOM structure, finding existing CSS classes. **First action of every session** is an Explore survey before any edit. Specify `"medium"` for single-area work, `"very thorough"` for cross-cutting changes (renderer + scanner + suggester touch many sites). |
| **general-purpose** | Multi-step refactors that span several files but don't need architectural input — e.g., "extract these 6 inline-style sites into a `.atpath-clipboard-fallback` class and verify with a re-grep." |
| **Plan** | Whenever a sub-decision needs architecture (e.g., "should the popover use Portal-style detachment or stay anchored?"). Do **not** spawn Plan for code-writing tasks. |
| **code-reviewer** (via `Agent({ subagent_type: "general-purpose", ... })` with a review-only prompt) | After each commit, before pushing — independent second-opinion read of the diff. |

**Global rules (CLAUDE.md):**
- Pass `model: "opus"` on every Agent invocation (highest-capability subagents per project rule).
- Run independent subagents **in parallel** (single message, multiple `Agent` blocks) whenever their work doesn't depend on each other.
- Never delegate **understanding** — the main agent reads the agent's report and decides. Don't say "based on findings, implement it"; read the findings, then write the edit yourself or hand a specific, file-and-line-scoped edit to a follow-up agent.
- `ultrareview` is user-triggered (the human runs `/ultrareview` manually). The main agent does **not** invoke it; just suggest it at the end of a feature if useful.

---

## 7. Implementation steps (in order)

Each step lists `[DELEGATE: <agent>]` where delegation is the recommended path. Steps without a tag are short enough that the main agent should handle them directly.

0. **Initial Explore — survey current state** `[DELEGATE: Explore, "very thorough"]`.
   Prompt the Explore subagent to verify every line-numbered reference in §2 and §0.5 against the current `src/main.js` (lines drift between revisions), to map every call site of `getTokenCount`, `AT_PATH_RE`, `scanAtPathRefs`, `copyNoteWithAtPaths`, `addStatusBarItem`, `AtPathSuggest`, `buildAtPathViewPlugin`, and `registerPostProcessor`, and to enumerate existing CSS classes in `styles.css` that we might collide with. Report under 400 words with file:line citations. **Do not edit anything in this step.**

1. **Community Plugin compliance sweep** (§0.5) — land as a **separate commit** before feature work. `[DELEGATE: general-purpose]` for the inline-style → CSS-class extraction (it touches 4+ sites mechanically); the main agent reviews the diff and commits.

2. **Carve out `src/atpath-core.js`** with the plugin-bound factory (§0). Wire `this.core = createAtPathCore(this)` in `onload`. Ship Plan A with stubs for `isIgnored` / async `getFolderTokens` per §0. Includes `formatAtPathInsertion` (shared by suggest + drop). `[DELEGATE: general-purpose]` for the routing rewrite (every existing helper call switches to `this.core.*`); main agent reviews and tests.

3. **Renderer hook updates (C1)**: rewrite `buildAtPathViewPlugin` (Live Preview) to consume both file + folder regexes; extend `registerPostProcessor` (Reading mode) legacy-text walker to handle folder refs. Both branches use `core.resolveAtPathTarget` and async `getFolderTokens` with a `…` placeholder + refresh-on-resolve. **Main agent writes this** — the async-render-refresh dance is subtle and re-reading a subagent's CM6 transaction code burns the context anyway. **`[DELEGATE: Explore]` first** to confirm exactly what `MatchDecorator` consumers expect and how the existing post-processor branches are wired.

4. **Refactor status bar setup**: two `addStatusBarItem()` calls; preserve click-to-copy on the note segment. Short — main agent.

5. **CodeMirror 6 update listener**: 80 ms debounce for doc-change re-tokenization; immediate selection updates. Active-buffer tokenization via `encode(editor.getValue()).length`. `Platform.isMobile` guard. Main agent.

6. **Build the popover**: stylesheet-anchored DOM; mouseenter/leave + 150 ms grace; click-to-pin + click-outside dismissal; `registerHoverLinkSource` integration; all async listeners properly awaited or `void`-ed. **Main agent writes the DOM + listeners**; `[DELEGATE: general-purpose]` for the styles.css additions if they balloon past ~80 lines.

7. **Folder regex + scanner pass**: add `AT_PATH_FOLDER_RE` in capture-group form (no second lookbehind); run folder pass first; defense-in-depth reject for file matches followed by `/`. Respect existing excluded-ranges. Main agent.

8. **`resolveAtPathTarget`**: file + folder branches; consumers (click, popover, copy, renderers) switch to using it. `[DELEGATE: general-purpose]` for the call-site rewrite once the resolver is in place — there are 5+ call sites and the rewrite is mechanical.

9. **Click handler folder branch**: `revealFolderInExplorer` helper iterates all explorer leaves, falls back to `openLinkText`. Main agent.

10. **`copyNoteWithAtPaths({ paths })`** folder branch: descendant walk, ignore filter, max-size filter, header line. Awaits `getFolderTokens` for the header count. Main agent.

11. **`AtPathSuggest`** updates: source-aware `enumerateFolderCandidates` traversing `app.vault.getRoot()`; slash-trigger same-repo → vault-absolute → prefix fallback chain; 1.3× bias; folder rendering; folder insertion via `core.formatAtPathInsertion`. Main agent.

12. **Drag-and-drop extension** (§3.5): CM6 `EditorView.domEventHandlers({dragover, drop})` inside a `Compartment` for runtime toggle; `extractDraggedVaultPaths` with three-tier MIME probe; `insertAtPathRefs` calls `core.formatAtPathInsertion`; 50-ref cap with `Notice`. **`[DELEGATE: Plan]` first** to confirm the Compartment reconfigure approach against the current Obsidian + CodeMirror versions if there's any doubt; otherwise main agent writes it.

13. **Settings**: three new fields (`statusBarShowSelection`, `suggestFolders`, `enableDragDropAtPath`); drop `folderInsertTrailingSlash`. Drag-drop toggle reconfigures the compartment live across open leaves. Main agent.

14. **Automated tests** (see §11). `[DELEGATE: general-purpose]` — tests are well-scoped and the agent can iterate against `node --test` without context cost on the main session.

15. **Independent diff review before push** `[DELEGATE: general-purpose with code-review prompt]`. Hand the subagent the full diff and a checklist: (a) all promises awaited / `.catch()`-ed / `void`-ed, (b) no inline styles, no `innerHTML`, no `console.log`, no `var`, no `fetch`, (c) sentence-case UI strings, (d) renderer covers both `@file` and `@folder/`, (e) suggest and drop produce identical text via `formatAtPathInsertion`. Cap report at 300 words. Main agent acts on findings, then commits and pushes.

16. **Manual smoke test** against a real vault. Main agent (can't be delegated — needs the user's vault + eyes).

17. **(Optional, user-triggered.)** Suggest the user run `/ultrareview` on the PR once 0–16 are green. Do **not** invoke it from the main agent.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Active-buffer tokenizer cost on huge notes | 80 ms debounce + revision-keyed in-memory cache; `gpt-tokenizer` benchmarks ~1 M tokens/s on note-sized inputs |
| `AT_PATH_FOLDER_RE` over-matches inside URLs, code, lists | Same `buildExcludedRanges` machinery as file regex; required trailing `/(?=$|[\s)>,;:!?])` boundary |
| Folder-note collisions (path resolves to both folder and folder-note `.md`) | `resolveAtPathTarget` always returns folder for `@folder/`; the file resolves under `@folder/folder.md`. Convention documented in README |
| `revealInFolder` not present on older Obsidian | Feature-detect; fall back to `workspace.openLinkText` (folder-note) then no-op |
| Wikilink mode + folder = legacy form may surprise users | Setting help text states folders always use `@folder/`; popover always shows the rendered form regardless of mode |
| Popover anchored absolute inside segment escapes status-bar overflow clip | `position: fixed` fallback rule in `styles.css` with `bottom: var(--status-bar-height, 28px)`; verified during manual test |
| Lookbehinds in new folder regex unsupported on old iOS Safari | New folder regex uses **capture-group boundary** (`(^|[\s(])` + `m[1].length` offset), avoiding an additional lookbehind. Existing `AT_PATH_RE` lookbehind is the only remaining instance; documented for migration in the §0.5 follow-up. `manifest.json` stays multi-platform |
| Drag-and-drop intercepts an Obsidian-native drag we don't recognize (regression: image embed stops working) | `extractDraggedVaultPaths` returns empty for any payload it doesn't explicitly recognize, AND we only call `preventDefault()` inside `dragover`/`drop` when refs are non-empty. Unknown payloads bubble to Obsidian's default handler. Tested against image drag, external file drag, intra-editor text drag |
| Obsidian renames the internal drag MIME between versions | Three-tier fallback (internal JSON MIME → `text/uri-list` → `text/plain`). One failure mode = path-only insertion instead of full wikilink — still functional. Detected at runtime, logged via `console.warn` once if the internal MIME goes missing |
| Drop from file explorer onto its own folder section accidentally fires editor drop | Editor extension is scoped to the CM6 editor DOM via `EditorView.domEventHandlers`; events on the file-explorer pane never reach our handler |
| Multi-file drag of 1000s of files freezes paste | 50-ref cap with `Notice`; insertion is a single CM6 transaction so undo is one step |

---

## 9. Out of scope

- File-explorer sidebar decoration (Plan B).
- Persisting popover checkbox state.
- User-reorderable status bar segments.
- Mobile support (status bar items are desktop-only per Obsidian docs).
- Folder-note convention switch in the settings.

---

## 10. Acceptance criteria

- Status bar shows two segments; selection count appears within ~100 ms of selecting text.
- **Note count reflects unsaved edits within 80 ms.** (Regression from current state.)
- Hover popover opens within ~50 ms; survives moving cursor between segment and panel; click-pins; click-outside dismisses.
- "Copy selected" produces note + only checked targets' contents (files inline directly; folders inline all non-ignored descendants under a single header).
- Typing `@proj` shows folder rows mixed with files (1.3× bias); typing `@notes/` shows only immediate children of `notes/`.
- `@notes/api/` in a note is **clickable** (reveals folder in **every** open explorer leaf via best-effort helper), **renderable in both Live Preview and Reading mode** (folder icon + async token count), **copyable** (descendants inlined), and **counted** (awaited sum in linked total).
- File ref `@foo.md` followed by `/` (i.e., `@foo.md/`) resolves as a folder reference, not a file reference (scanner ordering m15).
- Slash-trigger autocomplete inside `_repos/foo/note.md` types `@notes/` and resolves to `_repos/foo/notes/` first (source-aware), falling back to vault-absolute `notes/` only if same-repo doesn't exist.
- Suggester insert and drag-drop insert produce **identical** text for the same `(target, sourcePath, mode)` triple (shared formatter contract).
- Toggling `enableDragDropAtPath` in settings takes effect on the next drop **without reload** (Compartment reconfigure).
- Wikilink-mode setting still works for files; folder inserts are always `@folder/`.
- **Dragging a file** from the file explorer onto the editor inserts a working `@path` ref at the drop point, respecting wikilink/legacy mode.
- **Dragging a folder** from the file explorer onto the editor inserts `@folder/` at the drop point, regardless of wikilink/legacy mode.
- **Dragging multiple selected rows** inserts each ref space-separated in one undo step; 50-ref cap shows a `Notice` and inserts the first 50.
- **Dragging an image or external file** (non-vault) onto the editor still works as before (Obsidian default).
- `enableDragDropAtPath = false` fully restores Obsidian's default drag behavior.
- Plugin unload restores original DOM and disconnects all listeners.
- No `console.log`, `innerHTML`, inline styles, `fetch()`; all promises awaited / `.catch()`-ed / `void`-ed.

---

## 11. Automated test plan

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

Manual smoke test in §7 step 16 still runs (real vault, narrow window, light/dark theme, deferred file-explorer).

---

## 12. Dependencies on Plan B

Plan A ships with stubs (`isIgnored -> false`, `getFolderTokens -> synchronous walk`). When Plan B lands:
- `isIgnored` becomes the hand-rolled matcher (Plan B §3.3).
- `getFolderTokens` becomes the event-driven `folderTokenCache` consumer.
- No Plan A call site changes.

---

## 13. Codex review

This plan has been audited twice by `codex exec --sandbox read-only --skip-git-repo-check`. Every finding has been folded into the body of the plan inline — no recommendation was dismissed. This section is the audit trail.

### Round 1 — prior revision (14 findings: 1 critical, 10 major, 3 minor)

Pre-drag-and-drop revision of Plan A. The round-1 audit drove the structural changes the plan now treats as load-bearing:

- Established the **shared `atpath-core.js` module** so file/folder helpers don't drift between Plan A (editor) and Plan B (file explorer).
- Decided the **plugin-bound factory** shape over free exports (helpers need `app` + `plugin.settings` context).
- Replaced ad-hoc `getAllFolders()` / `getAllLoadedFiles()` (undocumented Vault APIs) with `app.vault.getRoot()` traversal.
- Fixed the `getFolderTokens` contract to be **async from day one** (the stub already returns a Promise) so Plan B's event-driven cache can drop in without changing Plan A call sites.
- Killed the `folderInsertTrailingSlash` setting (trailing slash is mandatory; making it optional creates dead text).
- Hardened the popover against inline-style violations (all positioning lives in `styles.css`, JS toggles a `hidden` attribute / `.is-open` class only).

### Round 2 — post drag-and-drop (15 total findings; 11 affect Plan A: 3 critical, 7 major, 1 minor)

Audit run after the drag-and-drop section (§3.5) was added and after the renderer-coverage gap was suspected. Findings folded into the indicated sections:

| ID | Severity | Subject | Folded into |
|---|---|---|---|
| **C1** | critical | Renderer coverage for `@folder/` — adding folder refs to the scanner doesn't make them render. Live Preview and Reading-mode hooks needed dedicated branches. | §3.4.1 (renderer coverage block); §7 step 3 |
| **C2** | critical | `getFolderTokens` must be async because `vault.cachedRead` has no sync path. The contract is async from the stub; renderers paint a `…` placeholder and refresh on resolve. | §3.4.5; §0 (stub contract) |
| **C4** | critical | Acceptance criterion "no inline styles / unawaited promises" can't pass while current `src/main.js` has multiple violations. Required a prerequisite compliance sweep. | §0.5; §7 step 1 |
| **M5** | major | `revealInFolder` is internal and `getLeavesOfType("file-explorer")[0]` ignores split-pane reality. | §3.4.3 (`revealFolderInExplorer` helper iterates all leaves with try/catch + fallback) |
| **M6** | major | Suggester slash-trigger was vault-absolute only; doesn't work when the active note lives under `_repos/foo/`. | §3.4.6 (source-aware: same-repo → vault-absolute → prefix fallback) |
| **M7** | major | `enumerateFolderCandidates` was missing a required `sourcePath` parameter for same-repo resolution. | §3.4.6 / §0 module surface |
| **M8** | major | Drop-insertion referenced undefined `relPath` / raw `folder.path`; would have produced broken or inconsistent inserts vs suggester. | §3.4.7 / §3.5.3 (single `formatAtPathInsertion(target, sourcePath, mode)` shared by suggest + drop) |
| **M9** | major | Second lookbehind in `AT_PATH_FOLDER_RE` would have compounded the existing iOS-Safari risk. | §3.4.1 (capture-group boundary `(^|[\s(])` + `m[1].length` offset, no second lookbehind) |
| **M10** | major | `registerEditorExtension` cannot be unregistered; the drag-drop toggle would have required a plugin reload to take effect. | §3.5.6 (CodeMirror 6 `Compartment` for runtime reconfigure) |
| **M14** | major | Status bar's "linked total" needs `getFolderTokens` to work for any `@folder/` ref the user has typed, not just folders visible in the explorer. | §3.4.5 + Plan B §9 visibility-independent contract |
| **m15** | minor | Scanner ordering: `AT_PATH_RE` matches `@foo.md` greedily so `@foo.md/` would never reach the folder pass. | §3.4.1 (run folder pass first; defense-in-depth reject file matches followed by `/`) |

### How to re-run

```sh
codex exec --sandbox read-only --skip-git-repo-check \
  --prompt 'Review _work_units/improvements/plans/002_plan_statusbar_and_folder_autocomplete.md. Focus on: contract drift between Plan A and Plan B, async vs sync helper signatures, Obsidian internal-API surface area, Community Plugin rule violations, regex correctness on iOS Safari. Report findings as critical/major/minor with file:section references.'
```

`/ultrareview` (user-triggered) is suggested as the final gate after this plan is implemented, before opening the PR.
