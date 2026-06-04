# Plan 001 — Surgical fix workflow for the @path-in-codeblock freeze

Evidence: @_work_units/atpath_codeblock_freeze/findings/001_freeze_root_cause_map.md.
Guiding constraint: **most minimal, most surgical** change that makes the freeze impossible — addressing the real invariant ("code-block content is inert for AtPath") rather than patching one symptom.

## Decision gate (do this BEFORE writing the patch)

The codex review proved the one-line `buildDecorations` guard is *necessary but possibly insufficient*: if the freezing vault had `showTokenCounts` OFF or no path prefix resolved to a local folder, the dominant cost is the fence-unaware whole-doc encode and/or autocomplete fuzzy — which that guard does not touch. So scope is gated on empirical confirmation.

**Phase 0 — Confirm which hot path dominated (needs the live vault).**
1. (Agent, no Obsidian) Re-run the two node harnesses to lock in: regexes linear; the deep path produces exactly 4 folder matches + 1 file match. (Already done; keep as the committed regression baseline.)
2. (Agent, via Obsidian CLI `eval`) On the affected vault: read `settings.showTokenCounts`, `app.vault.getFiles().length`, and whether each prefix (`_work_units`, `_work_units/ai_dev`, `_work_units/ai_dev/agent_orchestrator`, `_work_units/ai_dev/agent_orchestrator/findings`) is a `TFolder`. Confirm plugin version + editor mode.
3. (User keyboard + agent) Enable `localStorage['atpath-perf']='1'`, `obsidian plugin:reload id=atpath`, `obsidian dev:debug on`, then type the path char-by-char into a fenced block in a **throwaway scratch note** (not the 2.9MB real note). Capture `window.__atpath_perf_dump()` once. Read which label dominates `totalMs`: `getFolderTokens.*` (transient folder encode) vs `buffer.encode.doc` (sustained whole-doc encode) vs the suggest compute (sustained fuzzy).

Outcome decides the patch set below. If Phase 0 cannot be run, default to the **coherent superset** (all three keystroke paths made fence-aware) — still surgical, single-themed, and guaranteed sufficient.

## The fix (apply the subset Phase 0 proves necessary; superset is the safe default)

All changes in @src/main.js + the test-enabling extraction in @src/atpath-core.js. **No regex changes** (ReDoS disproven).

- **F1 — Fence-guard the CM6 decoration builder (always).** In `buildDecorations` (831-937): compute excluded ranges once, **memoized by `view.state.doc` identity** (recompute only when the doc changed, not on cursor/selection moves — avoids the P2 regression). In both exec loops, `if (isInExcludedRange(absStart, excluded)) continue;` using the **absolute** start (`absStart = from + m.index`), placed *before* the token-fetch branches (853/909). Severs the rank-1 chain and stops in-fence linkification.
- **F2 — Fence-guard the autocomplete trigger (if Phase 0 shows the suggest compute fires, or by default).** In `onTrigger` (521-538): early-`return null` when the cursor position is inside a fenced/inline-code region. `onTrigger` only has the line, not absolute offsets, so use a cheap line-local fence-state check (or CM6 `syntaxTree`/`tokenTypeAt` at the cursor). Kills the sustained fuzzy compute inside code blocks.
- **F3 — Bound the whole-doc tokenizer (if Phase 0 shows `buffer.encode.doc` dominates).** In `scheduleDocRetoken` (1126): skip exact `encode()` when `text.length` exceeds a threshold (mirror `maxFileSizeMB`) and/or fall back to a chars/4 estimate, doing exact encode only on idle. This is the most likely *sustained* 100%-CPU driver on a large note and is independent of code blocks.
- **F4 — Fix the P3 ordering bug (required once F1 reuses the helper).** Sort ranges by start in `buildExcludedRanges` (or remove the `start > pos` early-break in `isInExcludedRange`). Prevents the inline-code-before-fence false-negative.
- **F5 — Extract `buildExcludedRanges`/`isInExcludedRange` to @src/atpath-core.js** and re-export; update the `scanAtPathRefs` call sites to import them. Pure functions, zero Obsidian deps — enables unit tests and is the right home. (Do F4 in the same move.)
- **Deferred / documented asymmetry:** wikilink ViewPlugin (1031) + reading-mode post-processor (1299) fence-unawareness — note in STATUS, fix only if a follow-up demands consistency.

## Tests (land in the existing node --test harness)

- `tests/excluded-ranges.test.js` (new): `buildExcludedRanges` brackets fence/inline/frontmatter correctly; **inline-code-before-fence ordering** regression (locks F4); the exact deep path inside a fence → every `@`/slash position reported excluded.
- Fence-skip oracle: same `isInExcludedRange(start, ranges)` filter F1 uses → in-fence path yields **0** folder/file refs; same path in prose yields **4 folder + 1 file**.
- `tests/regex.test.js`: add a time-budget assertion (1.4MB and 40k-char no-dot under a generous bound) to lock in regex linearity against future edits.

## Implementation workflow (orchestrated, with codex on the critical paths)

Phased Workflow, pipelined per change where independent:
1. **Phase 0 (confirm)** — node harness agent ∥ CLI-probe agent; gate scope on results (+ user repro/perf-dump).
2. **Extract + P3** — one agent does F5+F4 with its unit tests (isolation: worktree).
3. **Fix** — one agent per needed change (F1 always; F2/F3 per Phase 0), each writing its own test; pipelined.
4. **Build + regression** — `npm run build`; `node --test …`; `obsidian plugin:reload id=atpath` + re-type repro; re-capture perf dump to **prove the dominant label dropped to ~0**.
5. **Codex review of the diff** — `/review-codex` agent on the final patch (the second codex checkpoint; the first was the root-cause review in this finding). Block ship on `endorse`/`endorse_with_changes` with changes applied.

## Out of scope

- Regex rewrite / `{1,256}` bound (ReDoS disproven).
- Zero-width `lastIndex++` guard (no zero-width match producible) — optional defense-in-depth only.
- Broad shelved Plan 003 (approximate tokenizer + persistent cache). F3 is a local cap, not that effort.
