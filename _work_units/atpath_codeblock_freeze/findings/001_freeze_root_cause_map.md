# Finding 001 — @path-in-codeblock 100% CPU freeze: root-cause map

Produced by a 9-agent mapping workflow (7 read-only explorers → synthesis → adversarial codex review, `codex_used: true`). All line numbers refer to @src/main.js unless noted. Full raw workflow output was captured at run time (task `wgiyj6ms0`); the durable distillation is below.

## Incident

Typing `@_work_units/ai_dev/agent_orchestrator/findings/v2_cli_design_ideas.md` **character by character inside a fenced ` ``` ` code block** drove Obsidian to ~100% CPU / froze. The note lives in a different vault (colm-as-kedro iCloud vault). Code-block content should be inert for AtPath; the user reasonably expects `@path` inside a fence to do nothing.

## Confirmed structural root cause

AtPath has exactly one piece of code-block awareness — `buildExcludedRanges` (717-744) + `isInExcludedRange` (746-752) — and it is wired **only** into `scanAtPathRefs` (callers at 757/763/789/810), which feeds the status bar, copy-with-contents, and migration. The **per-keystroke editor hot paths are all fence-unaware**:

1. **CM6 decoration builder** `buildAtPathViewPlugin.buildDecorations` (831-937) runs `AT_PATH_FOLDER_RE` (842) and `AT_PATH_RE` (899) over `view.visibleRanges` on every doc change (update() rebuilds at 942-955 on docChanged | viewportChanged | selectionSet | tokenCacheDirty). No `buildExcludedRanges` call. Per match, with `settings.showTokenCounts` on (default true), it resolves the target and schedules a token fetch (folder branch 853-869, file branch 909-913).
2. **Autocomplete trigger** `AtPathSuggest.onTrigger` (521-538) returns a valid trigger for `@` inside a fence (no fence guard); `getSuggestions` (540-554, 100ms debounce) → `_computeSuggestions` (556-647) runs a subsequence prefilter (614) + Obsidian fuzzy DP over the survivor set (618-632), capped only by `slice(0,50)` **after** scoring+sorting (646).
3. **Whole-doc tokenizer** `scheduleDocRetoken` (1115-1131) runs synchronous `encode(view.state.doc.toString())` (1126) 80ms after every doc change — fence-unaware **and not gated on `showTokenCounts`**. `recomputeSelection` (1142) encodes the selection on every selection change.

`encode()` (imported at line 7, `gpt-tokenizer/model/gpt-4o`) is pure synchronous CPU and is the documented cause of the prior ~100%-one-core freeze (STATUS Plan 003 / Plans 004–005).

## Refined mechanism (codex review correction — important)

The first-pass synthesis over-attributed the freeze to a *sustained per-keystroke* folder-token encode loop. The codex reviewer verified that is **false**:

- `getFolderTokens` (@src/atpath-core.js:178-254) **memoizes per folder for the plugin lifetime** (`folderTokenMemo`, 136/183) and dedupes in-flight (`folderTokenInflight` 185-186; plugin `_inFlightFolderTokenFetches` at main.js:2226/2534). Each distinct folder is encoded **at most once per session**. Typing the deep path yields only **4 folder matches total** (at the slash after `_work_units`, `…/ai_dev`, `…/agent_orchestrator`, `…/findings`; the final `.md` is a *file* match). So folder-encode is a **transient spike**, not a per-keystroke loop. It can hard-hitch on the *first* encode of a folder with many/large descendants (capped at `maxFolderFiles=500`, batched with `setTimeout(0)` yields at 244) but cannot alone produce a *sustained* freeze.
- The genuinely **sustained** per-keystroke costs are the fence-unaware **whole-doc `encode()`** (1126) and the **autocomplete fuzzy compute** (Plan 007 measured ~284ms/keystroke pre-fix; residual 150–250ms still open per STATUS.md:30).
- `resolveAtPath` (475-479) is O(1) `getAbstractFileByPath` + 5s-cached `discoverRepoRoots`. The full-vault `getFiles().filter` at 503 is `resolveAtPathBroad` (**migration-only**), so the "per-keystroke vault scan" worry from one explorer is a **red herring**.

**Most likely real picture:** a transient hitch from the first folder-subtree encode (only if a path prefix resolves to a real folder in the *active* vault), layered on top of the always-on whole-doc encode and the fuzzy compute — all firing where they should be inert.

## Verified negatives (do not chase these)

- **ReDoS is disproven.** All four regexes (`AT_PATH_RE` 705, `AT_PATH_FOLDER_RE` 711, reading-mode copy 1300, inline-code backreference 738) were benchmarked against the exact path and adversarial inputs: 1.4MB scanned in ~2–3.5ms, linear; 40k-char no-dot word in 0.22ms. Every repeat is over a single character class (no nested quantifier); the lookbehind is fixed/zero-width. A regex rewrite would fix nothing and risks changing match semantics.
- **No zero-width-match infinite loop.** Every match consumes at least `@`+content, so the unguarded `while ((m = re.exec(text)))` loops cannot spin on a stuck `lastIndex`.

## Bugs found along the way (verified)

- **P3 — latent ordering bug in `buildExcludedRanges`/`isInExcludedRange`.** Ranges are returned in insertion order (YAML, then *all* fenced, then *all* inline-code) — **not sorted by start**. `isInExcludedRange` early-breaks on `if (start > pos) break;` assuming sorted input. Consequence: an `@path` inside an inline `` `code` `` span that *textually precedes* a fence is wrongly reported **not** excluded. The specific freeze repro (`@path` inside a triple-backtick fence) is **not** affected (fence ranges precede inline ranges), but any fix that reuses this helper in a hot path inherits the bug. **Must fix (sort, or drop the early break) before reusing in the editor path.**
- **P2 — naive fix would add its own per-keystroke cost.** Calling `buildExcludedRanges(view.state.doc.toString())` inside `buildDecorations` recomputes a full-document copy+scan on *every* build (including every cursor move / selection change / token refresh). ~2.5ms at 1.4MB so tolerable, but it should be **memoized by doc identity** (recompute only on `docChanged`).
- **Known asymmetries (out of scope for the minimal fix, noted):** `buildWikilinkViewPlugin` (1031-1107) MatchDecorator schedules a token fetch (~1048) with no fence exclusion (single-file, mtime-cached, deduped — low severity); reading-mode `markdownPostProcessor` TreeWalker (1299) also lacks exclusion (render-only, not the typing path).

## Open discriminators (gate fix scope — need the live vault)

The single-spot `buildDecorations` guard is **necessary but possibly insufficient**. Which fix is *minimal-and-sufficient* depends on facts only the affected vault can answer:

1. **Was `settings.showTokenCounts` ON?** Every encode-driven decoration path is gated on it (853/909/2504/2529); `scheduleDocRetoken`/`recomputeSelection` are **not**. If it was OFF, the `buildDecorations` token branches were already skipped → the freeze is the whole-doc encode and/or autocomplete, and the decoration guard is a near no-op.
2. **Did any path prefix resolve to a real `TFolder` in the *active* vault?** If yes → rank-1 folder-encode transient is live. If all no (likely, the path is cross-vault) → rank-1 cannot fire; the sustained drivers (whole-doc encode, fuzzy) own the freeze.
3. **Editor mode** (Live Preview / Source / Reading) and **note size** + **vault file count** — set which path dominates and how large the encode/fuzzy passes are.

## Environment (verified via Obsidian CLI, read-only)

- Plugin loaded: `atpath` **v1.8.3** (eval probe, try-wrapped per runbook).
- CLI works but **installer is out of date** (loads `obsidian-1.12.7.asar`): `eval` / `dev:errors` / `dev:console` work; `plugins:enabled` / `dev:screenshot` / `dev:css` / `dev:cdp` / `vaults` silently fail (banner only).
- `dev:errors` empty (no `dev:debug on` yet, but also: a CPU spin throws nothing — empty errors *supports* the busy-loop-not-crash framing).
- `ATPATH_PERF` instrumentation (12-68) exists, gated on `localStorage['atpath-perf']==='1'`, exposes `window.__atpath_perf_dump()` (62) — the single best lever to attribute per-keystroke ms across `vp.atpath.buildDecorations`, `buffer.encode.doc`, `getFolderTokens.*`, and the suggest compute. **Reset-on-read; call once.**

## Test surface

Runner: `node --test --require ./tests/_setup.js tests/*.test.js`. Closest harnesses: @tests/regex.test.js (short inputs only, no timing assert), @tests/folder-tokens.test.js (cap/dedupe/epoch/yield). `buildExcludedRanges`/`isInExcludedRange`/`scanAtPathRefs` live in @src/main.js and are **not exported** (main.js exports only `AtPathPlugin` at 4124), so they are not unit-testable today — extracting the two pure range helpers to @src/atpath-core.js is the minimal test-enabling refactor (and the right place to fix P3).
