# Plan A — Status bar overhaul + folder autocomplete

Source prompt: `../prompts/001_improvements.md`

This plan covers two related features that both live in the editor/status-bar/suggest layer and do **not** require patching internal Obsidian APIs. The file-explorer sidebar token-count feature is tracked separately in `003_plan_file_explorer_token_counts.md` because its review risk and infrastructure (ignore patterns, internal-plugin patching) are different.

---

## 1. Goals

1. **Bigger, segmented status bar** with three live counts:
   - **Note tokens** (current note body)
   - **Linked @path tokens** (sum across all `@path` / wikilink references in the note)
   - **Selection tokens** (only shown when the editor selection is non-empty)
2. **Rich hover popover** on the linked-tokens segment listing each referenced file with its individual token count and a checkbox per file. The popover offers a **"Copy selected"** button that copies the note plus only the checked files.
3. **Folder autocomplete** — typing `@` should suggest folders alongside files; selecting a folder inserts `@<folder>/` (trailing slash, matching the syntax the rename pipeline already supports).

---

## 2. Current state (verified against `src/main.js`)

- Status bar: one `addStatusBarItem()` at L1575–1577, rendered by `updateStatusBar()` (L1750–1810). Tooltip is a plain-text `aria-label` (L1803–1809). Click handler at L1669 calls `copyNoteWithAtPaths()` (L1812–1862).
- Token counting: `getTokenCount(vaultPath)` at L1705, with a `tokenCache: Map<path, {mtime, tokens}>` initialized at L1562 and invalidated on vault `create|delete|rename|modify` events (L1581–1595).
- Selection token count: **not implemented** today.
- `@` autocomplete: `AtPathSuggest extends EditorSuggest` at L413–515. Candidates come from `app.vault.getFiles()` (L443) — folders are filtered out. Three-tier ranking: same-repo, cross-repo, loose vault.
- Rename pipeline (`updateAtPathReferences` L2557–2665) **already handles folders** — it detects `isFolder` and appends `/` in all three passes. So folder *references* are a first-class concept; only the *suggester* is files-only.

---

## 3. Design

### 3.1 Status bar — segments

Use **two `addStatusBarItem()` calls** (Obsidian recommends one item per independently clickable block; Novel Word Count and Vault Stats both do this):

```
[ Note: 1,240 ]   [ @paths: 8,612  (5) ]
```

When there is a non-empty editor selection, the **note segment** transitions into a "selection" mode:

```
[ Selection: 312 of 1,240 ]   [ @paths: 8,612  (5) ]
```

- "Selection" is shown alongside the full note total so the user keeps context.
- A distinct CSS class (`atpath-status-selection`) lets us style the selection state (e.g., subtle highlight).

DOM per item:

```html
<div class="status-bar-item mod-clickable atpath-status-note">
  <span class="atpath-label">Note</span>
  <span class="atpath-value">1,240</span>
</div>
<div class="status-bar-item mod-clickable atpath-status-linked">
  <span class="atpath-label">@paths</span>
  <span class="atpath-value">8,612</span>
  <span class="atpath-count">(5)</span>
</div>
```

Both segments retain `aria-labelledby` for accessibility. Labels (`.atpath-label`) are hidden via CSS under `~600px` to keep narrow-window readability — numbers stay.

Click behavior:
- Click on **note** segment → existing `copyNoteWithAtPaths()` (current behavior preserved on the most discoverable target).
- Click on **linked** segment → opens the popover (same panel as hover, sticky until dismissed).

### 3.2 Selection-aware updates

Track selection and content via a CodeMirror 6 update listener (registered through `registerEditorExtension`). The existing `editor-change` workspace event does **not** fire on selection-only changes (confirmed by Better Word Count's implementation and Obsidian forum thread 68617):

```js
EditorView.updateListener.of((update) => {
  if (update.docChanged || update.selectionSet) scheduleRefresh(update);
});
```

- Debounce content updates at **80 ms** (gpt-tokenizer is fast on note-sized inputs; Better Word Count uses ~50 ms).
- Selection updates fire immediately (cheap: `state.sliceDoc(from, to)` then `encode().length`).
- Also subscribe to `workspace.on('active-leaf-change')` and `workspace.on('file-open')` for editor switches.
- Mobile guard: skip the editor extension when `Platform.isMobile` is true (the official status bar docs note custom items are unsupported there).

### 3.3 Linked-files hover popover

No official Obsidian API exposes an interactive hover popover from a status bar item. (`setTooltip` is plain-text only; `HoverPopover` is tied to link previews.) Plugins that need this build their own floating `<div>`. We will do the same.

**Anatomy:**

```
┌────────────────────────────────────────────────┐
│ Linked @paths  · 8,612 tokens · 5 files        │
├────────────────────────────────────────────────┤
│ ☑  notes/api.md                       1,210    │
│ ☑  src/main.py                        2,440    │
│ ☑  docs/spec.md                       3,300    │
│ ☑  other-repo/src/util.ts             1,180    │
│ ☐  archive/old.md                       482    │
├────────────────────────────────────────────────┤
│ Selected: 8,130 tokens                         │
│ [ Select all ] [ None ]  [ Copy selected ]     │
└────────────────────────────────────────────────┘
```

**Behavior:**
- Appears on `mouseenter` of the `linked` segment; remains while the cursor is over either the segment or the panel.
- ~150 ms grace timeout on `mouseleave` so the user can move into the panel without it dismissing.
- Click on the segment makes the popover **sticky** (a `click-outside` listener dismisses it).
- Each row is a `<label>` wrapping a native `<input type="checkbox">` plus the file path and per-file token count. Clicking the row toggles the checkbox.
- "Copy selected" calls a new internal `copyNoteWithAtPaths({ paths: Set<string> })` variant that filters which references to inline.
- Hovering a row also opens the file in Obsidian's standard hover-preview via `app.workspace.trigger('hover-link', {…})` so users get the existing preview experience.

**Positioning:** the panel is appended to `document.body`, `position: absolute`, `bottom: <statusBarHeight + 8px>`, `z-index: var(--layer-popover)`. Width clamps to `min(420px, 90vw)` with `max-height: 60vh` and internal scroll for long lists.

**State persistence:** checkbox state is **per-note in memory only** — cleared on `file-open`. Persisting selection across reloads is out of scope (avoids new settings sprawl).

### 3.4 Folder autocomplete in `AtPathSuggest`

Extend `getSuggestions()` (L438) to also enumerate folders:

```js
const folders = this.app.vault.getAllFolders
  ? this.app.vault.getAllFolders(false)
  : this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder);
```

(The newer `getAllFolders(includeRoot)` API is available on Obsidian 1.5+; fall back to the filter for older versions.)

**Ranking & filtering:**
- If the query (text after `@` up to cursor) **ends with `/`**, return folders only, stripping the trailing `/` before fuzzy-matching `folder.path`. This is the convention from `obsidian-note-autocreation` and matches Obsidian's own quick-switcher behavior.
- Otherwise, fuzzy-score files **and** folders together; give folders a **1.3× score bias** so they're not buried under deeper file matches.
- Folder candidates are subject to the same same-repo / cross-repo / loose three-tier ordering as files.
- Hard-cap the candidate list at 50 (current cap).

**Rendering** (`renderSuggestion`, L493):
- Folder rows get a `folder` icon via `setIcon(iconEl, "folder")` and the path is rendered with a trailing `/`.
- File rows keep the existing render path.

**Insertion** (`selectSuggestion`, L502):
- **Legacy mode**: insert `"@" + folder.path + "/ "` (trailing slash + space, matching `@folder/` syntax and re-triggering the suggester naturally if the user keeps typing).
- **Wikilink mode**: insert `[[<linkpath>|@<folder>/]]` — uses `fileManager.generateMarkdownLink` if the folder has a folder-note, otherwise constructs the wikilink manually with the folder path and `@folder/` display. Note that core Obsidian wikilinks normally target files; folder-wikilink rendering will degrade to bare text in standard Obsidian but AtPath's own renderer will still resolve it (verify against current renderer paths during implementation).

**Edge cases:**
- Root folder (`path === ""`) is excluded.
- Folder rename propagation already works (L2557–2665) — no changes there.
- New helper `enumerateFolderCandidates(query)` so the same code feeds any future folder-typed UI.

---

## 4. Settings additions

Add to `DEFAULT_SETTINGS` (L113–127) and to the settings tab (L875–1017):

| Setting | Default | Notes |
|---|---|---|
| `statusBarShowSelection` | `true` | Toggle the selection segment |
| `suggestFolders` | `true` | Disables folder autocomplete if user prefers files-only |
| `folderInsertTrailingSlash` | `true` | If false, insert `@<folder>` without `/` (corner case for power users) |

All labels sentence-case per `CLAUDE.md` community-plugin rules.

---

## 5. Styling

Add to `styles.css`:
- `.atpath-status-note`, `.atpath-status-linked`, `.atpath-status-selection` (state class)
- `.atpath-label`, `.atpath-value`, `.atpath-count` (already implied above)
- `.atpath-linked-popover`, `.atpath-linked-popover-row`, `.atpath-linked-popover-footer`
- Media query: hide `.atpath-label` below 600 px width
- No inline styles (per community-plugin rules)

---

## 6. Implementation steps (in order)

1. **Refactor status bar setup**: split the single `addStatusBarItem()` into `noteSegment` + `linkedSegment` (each with `.mod-clickable`). Keep the current click-to-copy on the note segment so users don't lose existing muscle memory.
2. **Add selection tracking**: register a CodeMirror 6 update listener; debounce content updates at 80 ms; fire selection updates immediately. Update both segments in `updateStatusBar()`.
3. **Build the popover component**:
   - DOM construction with native checkboxes
   - mouseenter/mouseleave + 150 ms grace
   - click-to-pin behavior with click-outside dismissal
   - hover-link preview integration
4. **New `copyNoteWithAtPaths({ paths })`**: refactor existing function to accept an optional `Set<string>` filter; default behavior unchanged (all refs).
5. **Extend `AtPathSuggest.getSuggestions()`** to include folders, with the slash-trigger rule and the 1.3× bias.
6. **Update `renderSuggestion` and `selectSuggestion`** for folder rows.
7. **Settings**: three new fields wired into `SettingTab` with sentence-case labels.
8. **Manual smoke test** against a real vault: large note with many `@paths`, fresh note with selection, narrow-window status bar, folder autocomplete including `Projects/2025/` chained navigation, wikilink mode insertion.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| CodeMirror 6 update listener fires on every keystroke and could lag on huge notes | 80 ms debounce + mtime-keyed cache on `getTokenCount` already covers re-tokenization cost |
| Popover steals focus / breaks keyboard nav | `tabindex="0"` on segment; popover is hover/click only; checkboxes are real `<input>` elements |
| Wikilink to a folder may not resolve cleanly in stock Obsidian render | Document the limitation; rely on AtPath's own renderer for folder wikilinks; the legacy `@folder/` form remains the recommended insertion in wikilink mode if it doesn't resolve well |
| Folder + file mixed suggestions surprise existing users | Settings toggle `suggestFolders` defaults on but can be disabled; the slash-trigger rule means folders only dominate when explicitly requested |
| Community Plugin review may flag custom hover panel as "non-standard tooltip" | Documented justification: no official API supports interactive content; matches pattern used by multiple shipped community plugins (statusbar-pomo, statusbar-organizer) |

---

## 8. Out of scope

- File-explorer sidebar decoration (Plan B).
- Persisting per-note checkbox state across reloads.
- Reordering of status bar segments by the user.
- Mobile support for the new segments (status bar is officially desktop-only).

---

## 9. Acceptance criteria

- Status bar shows two segments; selection count appears within ~100 ms of selecting text.
- Hover popover opens within ~50 ms of mouseenter, dismisses cleanly on mouseleave with grace, and survives moving the cursor between segment and panel.
- "Copy selected" produces the note + only the checked files' contents.
- Typing `@proj` shows folder rows mixed with files; typing `@projects/` shows folders only under that prefix.
- All existing behavior (single-click status bar, copy with all @paths, wikilink/legacy mode toggle) preserved.
- No `console.log`, no `innerHTML`, no inline styles, no `fetch()` (Community Plugin rules).
