# 006 — FIX: Linked-@paths popover hides the filename

## TL;DR

The status-bar "Linked @paths" popover currently renders each row's path
**left-anchored** and truncates the *tail*. With the long
`arbi_shared/_repos/<repo>/...` paths that are typical of this vault,
that means the user sees the repo prefix and **cannot see the filename**
(see screenshot in the most recent triage message).

Two surgical fixes:

1. **Display logic (parity with inline nodes).** Render the popover row
   label via the same `core.computeDisplayPath(targetPath, sourcePath)`
   helper that the inline CM6 widget and post-processor already use. When
   the popover row's target lives in the same `_repos/<repo>` root as the
   active note, this collapses the displayed path to the repo-relative
   portion. When it lives in a different repo, it collapses to
   `<repo-name>/<rest>`. When the target isn't under `_repos/` at all,
   the helper returns the path unchanged — same behavior as today, just
   reached through the shared helper.

2. **Head-truncation CSS.** Anchor the ellipsis on the **left** side of
   the path cell so the filename remains visible. The current CSS for
   `.atpath-linked-popover-path` already attempts this with
   `direction: rtl; text-align: left;`, but it also sets
   `unicode-bidi: plaintext`, which forces the paragraph direction to be
   inferred from the first strong character of the content. Because the
   paths begin with Latin letters (strong-LTR), the inferred paragraph
   direction is LTR — so `direction: rtl` has no effect on the truncation
   side. The `text-overflow: ellipsis` lands at the right edge and the
   filename gets clipped.

Both root causes are confirmed:

- `_renderLinkedPopover` at `src/main.js:2932-2935` builds
  `pathSpan` with `text: t.kind === "folder" ? t.path + "/" : t.path` —
  i.e. the raw vault path, never piped through `core.computeDisplayPath`.
- `styles.css:203-214` sets `direction: rtl; text-align: left;` together
  with `unicode-bidi: plaintext`. Per the W3C bidi spec, `plaintext`
  resolves paragraph direction from the first strong character and
  **ignores the element's `direction` property**, so the head-truncation
  trick is silently a no-op for ASCII paths.

The fix is small. No new settings, no test infrastructure changes, no
build pipeline changes.

## Files touched

- `src/main.js` — popover slow-path rebuild
- `styles.css` — popover path cell
- `tests/popover-display-path.test.js` — **NEW**: unit test for the
  shared `computeDisplayPath` shape we depend on here (smoke check that
  same-repo collapses to bare relpath; cross-repo collapses to
  `<repo>/<rest>`; non-repo passthrough is unchanged)
- *No changes* to `src/atpath-core.js` — the helper already exists and
  is exported as `core.computeDisplayPath`.

## Implementation

### Fix 1 — Popover row label uses `computeDisplayPath`

In `_renderLinkedPopover` (`src/main.js:2810+`), the slow-path rebuild
loop currently does:

```js
const pathSpan = row.createSpan({
  cls: "atpath-linked-popover-path",
  text: t.kind === "folder" ? t.path + "/" : t.path,
});
const rowTitle = t.pending
  ? "Still counting…"
  : t.overCap
    ? "Skipped: over the configured max-files limit"
    : (t.kind === "folder" ? t.path + "/" : t.path);
pathSpan.setAttribute("title", rowTitle);
row.setAttribute("title", rowTitle);
```

Change to:

```js
const displayLabel = this.core.computeDisplayPath(t.path, sourcePath) +
  (t.kind === "folder" ? "/" : "");
const pathSpan = row.createSpan({ cls: "atpath-linked-popover-path" });
// Wrap in <bdi> so the path itself reads LTR even though the container
// is direction:rtl (which we use solely to anchor the ellipsis on the
// LEFT — see styles.css notes below).
pathSpan.createEl("bdi", { text: displayLabel });

// Title tooltip carries the FULL vault path so the user can still see
// where the file actually lives on disk if the displayed label was
// collapsed.
const fullPath = t.kind === "folder" ? t.path + "/" : t.path;
const rowTitle = t.pending
  ? "Still counting…"
  : t.overCap
    ? "Skipped: over the configured max-files limit"
    : fullPath;
pathSpan.setAttribute("title", rowTitle);
row.setAttribute("title", rowTitle);
```

Notes on the fast path:
- `renderSig` (line 2849) already includes `sourcePath` as a prefix, so
  switching to a note in a different repo invalidates the cached row map
  and triggers a slow-path rebuild — which is exactly when the display
  label would change. **No fast-path changes needed.**
- The fast path only mutates `countEl`, `cb`, and row title (lines
  2872–2890). Those are based on per-target state (`pending`, `overCap`,
  `tokens`), not on `sourcePath`. So nothing else moves.

### Fix 2 — Head-truncation CSS that actually works

Replace lines 203–214 of `styles.css`:

```css
.atpath-linked-popover-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-monospace);
  /* Container is RTL so text-overflow:ellipsis lands at the LEFT (head
     truncation), keeping the filename visible at the right. The inner
     <bdi> below carries direction:ltr so the path itself still reads
     left-to-right, not reversed. */
  direction: rtl;
  text-align: left;
}
.atpath-linked-popover-path > bdi {
  direction: ltr;
  unicode-bidi: isolate;
}
```

Why this works where the previous CSS didn't:
- Removing `unicode-bidi: plaintext` lets the container's
  `direction: rtl` actually take effect for paragraph-level layout, so
  `text-overflow: ellipsis` clips at the **start** (visually: left side).
- Wrapping the path text in `<bdi>` with `direction: ltr;
  unicode-bidi: isolate` isolates the path content from the container's
  RTL direction so the characters render in the natural reading order —
  `notes/api/v1.md`, not `dm.1v/ipa/seton` — while still letting the
  bidi algorithm correctly render RTL filenames (Hebrew, Arabic) inside
  the path. `isolate` is the `<bdi>` default; we keep it explicit for
  clarity. (Codex review v1 caught the original `bidi-override` here,
  which would have force-flipped RTL filename glyphs.)

### Fix 3 — Cover-our-back test

Add `tests/popover-display-path.test.js` (new file). It does **not** boot
the popover (no DOM); it just asserts that the helper we now rely on for
the popover row label has the three shapes the popover needs:

1. Target in same repo as source → returns the bare relative path
   (e.g. `findings/foo.md`).
2. Target in different repo → returns `<repo>/<rest>` (e.g.
   `repo-b/findings/foo.md`).
3. Target outside `_repos/` → passthrough (returns input unchanged).

This is a thin test — it's basically a smoke test for the helper's
contract that the popover depends on, so a future refactor of
`computeDisplayPath` that breaks our assumption surfaces in CI rather
than only in the UI.

## Out of scope

- The CM6 inline widget already calls `computeDisplayPath` via
  `enumerateFolderCandidates` / `formatAtPathInsertion`. No changes there.
- The status bar's note/linked-tokens totals are numeric, not paths. No
  alignment changes needed.
- The "no `<bdi>`" content of `pathSpan` for the **fast path** is a
  non-issue: the fast path doesn't replace the path text, only the
  count / checkbox state / title. The first slow-path build sets the
  `<bdi>` once and it persists.

## Verification

1. `npm run build` — bundle ok.
2. `node --test --require ./tests/_setup.js tests/*.test.js` — all 37
   existing tests still pass, plus 3 new `popover-display-path` cases.
3. Manual: in Obsidian, open a note with @paths pointing at long
   `_repos/<repo>/.../some-file.md` targets and click the linked-tokens
   status bar segment. Each row should show the filename at the right
   edge; if the path is too long for the cell, the **prefix** (not the
   filename) should be the ellipsized side. For targets in the same repo
   as the active note, the displayed path should start with the in-repo
   relative path (no `_repos/<repo>/` prefix).
4. (Optional) Resize the popover narrower by adjusting
   `.atpath-linked-popover` `width: min(640px, 95vw)` in DevTools and
   confirm the filename remains visible.

## Risk surface

- **Single CSS rule change** with a well-understood bidi semantics
  swap. Test in two views: very long paths (head truncation visible) and
  very short paths (no truncation needed — should render the same as
  before).
- The `<bdi>` element is universally supported (HTML5 element since
  ~2014, supported in every Obsidian-bundled Electron version).
- `computeDisplayPath` is already heavily exercised by `core.test.js` /
  `enumerateFolderCandidates` / `formatAtPathInsertion`, so the helper
  itself isn't new territory — we're just routing one more caller
  through it.
