# 004 — STATUS: AtPath plugin still slow on notes with many @path refs

## TL;DR for the fresh agent

Obsidian is still **extremely slow** when a note with ~30 `@path/...` references is open in the active editor, even after three targeted "obvious" performance fixes were applied. The user reproduced this on `STATUS_ai_dev.md` (a note with ~30 `@_work_units/...` refs and a couple of folder refs).

**Three fixes have already been applied** in the working tree (uncommitted). They didn't move the needle. The diagnosis was probably wrong, or the real culprit is elsewhere — most likely in something this fix pass did not touch.

**Recommended approach (per user):** stop guessing. Add structured diagnostic logging at every plausible hot path, ask the user to reload and reproduce, then collect data and fix the actual bottleneck. Do not revert the existing fixes — they are at worst harmless. Build on them.

---

## Repro

- Open `STATUS_ai_dev.md` (a note with ~30 `@<vault-path>` refs to files plus `@<folder>/` refs).
- The note's editor becomes laggy on every keystroke.
- Hovering or pinning the status-bar popover compounds the slowness; user reports the previous (rAF-driven) version actually crashed Obsidian.
- The current version no longer crashes — but is "extremely slow."

There is **no error in the console** (none reported). Slowness is purely main-thread saturation.

---

## What is already done (do not redo)

All three fixes live in the uncommitted working tree on `main`. Build is clean, tests are 30/30 green.

### Fix A — `_scheduleRefresh` debounce: rAF → setTimeout(150ms)

`src/main.js:2410-2419` (`_scheduleRefresh`) and `src/main.js:2105` (field init).

Old: every async token fetch resolution scheduled `requestAnimationFrame` → empty `view.dispatch()` + `updateStatusBar()`. With 30 async fetches resolving over many frames, this fired up to 30 dispatches over ~30 frames at plugin warmup.

New: same logic but coalesced with a single 150ms `setTimeout`. Renamed field `_rafScheduled` → `_refreshTimer`. Still calls `view.dispatch()` (this is the trigger that makes the CM6 renderer ViewPlugin see `plugin.tokenCacheDirty` and rebuild inline `(N tokens)` decorations — see `buildAtPathViewPlugin` at `src/main.js:785-799` and `buildWikilinkViewPlugin` at `src/main.js:907-918`).

### Fix B — Incremental popover render

`src/main.js:2625` (`_renderLinkedPopover`).

Old: every call to `_renderLinkedPopover` ran `popoverEl.empty()` and rebuilt all rows from scratch — including `setIcon()` SVG creation and 6 `addEventListener` calls per row.

New: caches per-path row refs in `this._popoverRowMap` and tracks `this._popoverBuiltSig` (order-sensitive + includes active file path). Fast path runs when `_popoverBuiltSig === renderSig` AND `_popoverRowMap` exists — only updates header text, each row's count text, and each row's checkbox `.checked` state. Slow path runs only when DOM identity actually changed (target list changed, target order changed, or active file changed).

Selection state still gated by `_linkedSig` (sorted) via `_popoverCheckedSig` so checkboxes are preserved across selection-preserving rerenders.

### Fix C — `mouseover` → `mouseenter` on row

`src/main.js:2721-2733`.

Old `mouseover` bubbled, so cursor crossing child elements (checkbox/icon/path span) fired `workspace.trigger("hover-link", ...)` multiple times per row visit.

New `mouseenter` does not bubble — one fire per row entry.

### Codex review

Codex (gpt-5.5) found one Low-severity issue in the original fix: the build signature was sorted (set identity), so switching to another note with the same target set would reuse stale DOM rows AND keep the previous note's `sourcePath` captured in each `mouseenter` listener closure. Fixed by introducing the order-sensitive + sourcePath-aware `renderSig`. Codex's pass after the fix: "No other in-scope issues found in the three crash-fix changes."

Review prompt + result are saved at `_work_units/0_llm/reviews/popover-crash-fixes-review_prompt.md` and `popover-crash-fixes-review.md`.

---

## Why the fixes did not solve it

Best guesses (unverified — this is exactly why we need data, not more guessing):

1. **The popover was a red herring.** User reports slowness *with the popover hidden too* — every keystroke is laggy on the note. The popover-rebuild loop only fires when popover is rendered (or about to be). Editor lag during typing implies the bottleneck is upstream of `_renderLinkedPopover`. Most likely candidates:
   - `_debouncedUpdateStatusBar()` (300ms) — fires on every `editor-change`, calls full `updateStatusBar()` which calls `scanAtPathRefs` over the full document AND awaits 30 `getTokenCount` calls AND `_renderLinkedPopover()`. Even if the popover render is cheap now, the scan + token fetches can be heavy.
   - `buildAtPathViewPlugin` / `buildWikilinkViewPlugin` update paths run `decorator.createDeco(view)` on every CM6 update where `tokenCacheDirty || update.selectionSet`. With 30 refs that's 30 regex matches and 30 decoration constructions per redecorate. `update.selectionSet` fires on every cursor move — including arrow keys held down.
   - `buildBufferCountListener` (registered for desktop only — `src/main.js:2113`) runs on every CM6 update. If it tokenizes the full document text on each update that's expensive for big notes. Have NOT inspected its body yet.

2. **`encode()` on the full document body.** `updateStatusBar` calls `encode(content).length` to get note tokens. `encode` from `gpt-tokenizer` is not cheap on a multi-KB markdown document. If `_noteBufferTokens` is reset (which happens on `file-open` and `active-leaf-change`) and the buffer listener hasn't ticked yet, every keystroke during debounce could trigger a fresh full-document tokenize. `src/main.js:2456-2461`.

3. **`getTokenCount` and `getFolderTokens`.** First-pass through 30 refs on note open does 30 async I/O + 30 tokenize calls. While `tokenCache: Map` (`src/main.js:2101`) memoizes, the FIRST encounter pays the cost. Folder fetches also walk subtree files and tokenize each. Could be hogging the main thread.

4. **Hover-link preview spawning.** With `mouseenter` now correctly firing once per row, hover on the popover still triggers Obsidian's core hover-preview which reads + parses each linked note. For ~30 popover rows hovered quickly, that's still pile-up. May or may not matter.

5. **CM6 `view.dispatch()` cost in `_scheduleRefresh`.** Even with 150ms debounce, the empty dispatch still re-runs every registered ViewPlugin (atpath + wikilink + Obsidian core). With `update.selectionSet` removed from the trigger (we don't set it), this dispatches with no changes — and the renderer's `update()` checks `plugin.tokenCacheDirty || update.selectionSet`, which means the empty dispatch DOES rebuild decorations (because `tokenCacheDirty` was set right before the timer scheduled). That's the intent — but on a 30-ref note this rebuilds all 30 decorations.

---

## Important files and code locations

### Primary hot paths (read these first)

- `src/main.js:2427-2504` — `updateStatusBar()`. Entry point hit by many events. Calls `scanAtPathRefs`, awaits 30 `getTokenCount`/`getFolderTokens`, calls `_renderStatusBarSegments`, then `_renderLinkedPopover`.
- `src/main.js:2422-2425` — `_debouncedUpdateStatusBar()` (300ms). Fires on `editor-change`, `vault.modify`, `vault.delete`.
- `src/main.js:2410-2419` — `_scheduleRefresh()` (150ms). Fires when async token fetches resolve.
- `src/main.js:2625-2790` — `_renderLinkedPopover()` (with fast path).
- `src/main.js:785-859` — `buildAtPathViewPlugin` (`@path` decoration in Live Preview). Its `update()` rebuilds all decorations whenever `tokenCacheDirty || update.selectionSet`.
- `src/main.js:907-960` — `buildWikilinkViewPlugin` (wikilink-style `[[@path]]` decoration). Same pattern.
- `src/main.js:~960-995` — `buildBufferCountListener`. **NOT INSPECTED.** Likely tokenizes on update; check first.
- `src/main.js:2358-2390` — `getTokenCount()`, `scheduleTokenFetch()`.
- `src/main.js:2392-2408` — `scheduleFolderTokenFetch()`.
- `src/main.js:607-…` — `scanAtPathRefs()`. Regex scan over full document text. Cost should be O(doc size); 30 matches is fine but the regex is non-trivial.
- `src/main.js:5` — `AT_PATH_RE` regex (has a lookbehind, flagged as known iOS-incompatibility risk).

### Event wiring (where the hot paths are triggered from)

- `src/main.js:2186-2270` — `vault.on('modify' | 'create' | 'delete' | 'rename')`, `workspace.on('active-leaf-change' | 'file-open' | 'editor-change')`.
- `src/main.js:2111-2115` — `registerEditorExtension(buildAtPathViewPlugin(this))`, `registerEditorExtension(buildWikilinkViewPlugin(this))`, conditional `buildBufferCountListener`.
- `src/main.js:2171` — `registerHoverLinkSource("atpath-status", ...)` — required for `workspace.trigger("hover-link", ...)` from popover rows.

### Status bar / popover

- `src/main.js:2120-2183` — status bar DOM construction (`noteBarEl`, `linkedBarEl`, `_popoverEl`), `_wireLinkedPopoverEvents`.
- `src/main.js:2564-2624` — popover show/hide/pin handlers (`_showPopover`, `_scheduleHidePopover`, `_hidePopoverImmediate`).

### Test files (Tier 1 + Tier 2 — keep them green)

- `tests/*.test.js` — 30 tests, all passing. Mostly cover `resolveAtPathTarget`, `enumerateFolderCandidates`, `formatAtPathInsertion`, and `AT_PATH_RE` matches. None measure perf.

### Build

- `esbuild.config.mjs` — bundles `src/main.js` → `main.js`. No minify. `npm run build`.
- `package.json` — `npm test` runs node's built-in test runner against `tests/*.test.js`.

---

## Suggested next-agent approach

### Phase 1 — instrument before changing anything else

Add a tiny perf-marker helper at module top of `src/main.js`:

```js
const ATPATH_PERF = (() => {
  const enabled = (typeof window !== "undefined") && window.localStorage &&
                  window.localStorage.getItem("atpath-perf") === "1";
  const counts = new Map();
  const times = new Map();
  return {
    enabled,
    inc(label) {
      if (!enabled) return;
      counts.set(label, (counts.get(label) || 0) + 1);
    },
    time(label, fn) {
      if (!enabled) return fn();
      const t0 = performance.now();
      try { return fn(); }
      finally {
        const dt = performance.now() - t0;
        times.set(label, (times.get(label) || 0) + dt);
        counts.set(label, (counts.get(label) || 0) + 1);
      }
    },
    async timeAsync(label, fn) {
      if (!enabled) return fn();
      const t0 = performance.now();
      try { return await fn(); }
      finally {
        const dt = performance.now() - t0;
        times.set(label, (times.get(label) || 0) + dt);
        counts.set(label, (counts.get(label) || 0) + 1);
      }
    },
    dump() {
      const rows = [];
      for (const [k, n] of counts) {
        const ms = times.get(k);
        rows.push({ label: k, count: n, totalMs: ms ? ms.toFixed(1) : "-" });
      }
      console.warn("[atpath-perf]", rows);
      counts.clear();
      times.clear();
    },
  };
})();
// expose dump for the user to call: window.__atpath_perf = ATPATH_PERF;
```

Toggle via `localStorage.setItem("atpath-perf", "1")` and reload. Wrap (at minimum) these call sites:

- `updateStatusBar` entry — count
- `scanAtPathRefs` invocations + time (`time("scan", () => scanAtPathRefs(...))`)
- `_renderLinkedPopover` slow vs fast path (two separate labels)
- `buildAtPathViewPlugin` update path (count `decorator.createDeco` calls — these dominate when many refs)
- `buildWikilinkViewPlugin` update path
- `buildBufferCountListener` update path (count + time the encode call if there is one)
- `encode(content).length` in `updateStatusBar` (`time("encode-note", ...)`)
- `getTokenCount` cache-miss path
- `getFolderTokens` cache-miss path

Expose `window.__atpath_perf_dump = () => ATPATH_PERF.dump()` so the user can call it from the dev console after 10 seconds of typing.

### Phase 2 — reproduce + collect

Ask the user to:
1. Enable `localStorage.setItem("atpath-perf", "1")` and reload.
2. Open `STATUS_ai_dev.md`.
3. Wait 5 seconds (let any plugin warmup settle).
4. Type a sentence (~30 chars).
5. Hover the popover.
6. Run `window.__atpath_perf_dump()` and paste the output.

From that table the bottleneck will be obvious: whichever label has high `totalMs` or 100s of `count` over the 10-second window.

### Phase 3 — fix only what the data implicates

Common fix patterns once you know the bottleneck:

- If `encode-note` dominates: only call `encode` lazily, drop the fallback in `updateStatusBar`. Trust the buffer listener.
- If renderer `createDeco` dominates: stop re-decorating on `selectionSet` (only re-decorate on `docChanged || tokenCacheDirty`). The current "rebuild on selection" is overkill — selection should never change link visuals.
- If `_scheduleRefresh` dispatch dominates: replace the empty `view.dispatch()` with a `StateEffect` keyed to a "tokens-updated" event and re-decorate only when that effect arrives. Cleaner than empty transactions.
- If `_renderLinkedPopover` slow-path fires too often: the empty-targets branch + slow-path mix may be too aggressive. Check whether `_linkedTargets` is rebuilt with `kind:path` order changing across calls when the doc text hasn't changed.
- If hover preview spawns dominate: don't trigger `hover-link` from popover rows unless the user actually pauses on a row (delay 150-200ms after `mouseenter`).
- If `scanAtPathRefs` dominates: it's regex-only and should be cheap; if not, profile the regex with `RegExp.exec` count.

### Phase 4 — verify + commit

- Re-run the same repro with `atpath-perf` still on. Confirm the dominant label dropped by an order of magnitude.
- Disable perf logging (remove `localStorage` flag from instructions).
- Either leave the perf scaffolding in place (gated by localStorage, no cost when disabled) OR remove it. User's call.
- Commit + push.

---

## Constraints to respect

- **Do not revert** any of fix A/B/C. They are at worst no-ops.
- **Community plugin compliance** (`CLAUDE.md`): no `console.log` (use `console.warn`/`console.debug`), no `innerHTML`, no inline styles (use `styles.css`), no `var`, all promises awaited/voided. Status bar is desktop-only; mobile path must not regress.
- **`_lastEditorView.dispatch()` is load-bearing**: removing it means inline `(N)` counts never refresh until the next natural CM6 update. The user is OK with refresh latency but not with counts disappearing.
- **30 tests must stay green**. They do not measure perf but they pin behavior.
- **Build target**: `npm run build` produces `main.js` which is committed. Always rebuild before testing in Obsidian.

---

## Files modified in current working tree (uncommitted)

- `src/main.js` — fixes A/B/C plus earlier UX fixes (popover RTL ellipsis, "Copy selected" / "Copy selected + note" split, drag-and-drop DOM capture).
- `main.js` — esbuild output.
- `styles.css` — popover width bump + RTL ellipsis CSS for path span (already reviewed).
- `_work_units/improvements/prompts/002_include_drag_and_drop.md`, `003_plan_a_fixes.md` — request docs (untracked).
- `_work_units/0_llm/reviews/popover-crash-fixes-review_prompt.md`, `popover-crash-fixes-review.md` — codex review artifacts (untracked).

To see the full diff: `git -C /Users/sergio/Documents/code/obsidian_plugin_atpath diff src/main.js styles.css`.

---

## One more thing

The user said: "logging and diagnosing the correct problem is indeed the best approach going forward." That is the instruction. Do not ship a fourth speculative fix. Instrument, measure, then fix exactly what the data points to.
