# Plan 007 — @path autocomplete slowness: diagnosis + fix

Seeded by `_work_units/improvements/prompts/0_llm/006_logwatch_autocomplete_perf_and_explorer_tokencount_prep.md` (task 2). Diagnosed live via the Obsidian CLI runbook against the user's real ~64k-file vault.

## Root cause (measured live)

`AtPathSuggest.getSuggestions` ran on **every keystroke** and, per call:

1. Built a display string for **every** vault file + folder (`computeDisplayPath` × ~64k) — cheap (~13–23ms).
2. Ran Obsidian's `prepareFuzzySearch` scorer against **all** of them, then sorted the matched tiers — the bottleneck.

Live timings (real keystrokes, 58.9k files): **avg 284ms, max 387ms per keystroke**. Phase breakdown for a 3-char query: display loop ~13ms, fuzzy + sort ~317ms.

Per-query breakdown (cold, no cache; 64,085 candidates) showed why a naive prefilter is not enough — common prefixes barely shrink the set, and fuzzy DP cost grows with query length:

| query | survivors (subsequence) | fuzzy + sort |
|---|---|---|
| `p` | 60,506 | 45ms |
| `pa` | 57,949 | 128ms |
| `pat` | 53,601 | 228ms |
| `path` | 20,612 | 136ms |

No debounce, no per-query memoization, no prefilter existed.

## Fix (shipped in `src/main.js`)

Three layers, all behavior-preserving for result *contents*:

1. **Debounce (primary).** `getSuggestions` now returns a Promise resolved ~100ms after the user pauses; superseded calls are left unresolved (Obsidian uses only the latest), avoiding empty-list flicker. A fast 5-keystroke burst collapses from **5 computes → 1** (verified live).
2. **Subsequence prefilter.** New pure `isSubsequenceCI(query, text)` in `atpath-core.js` gates the expensive fuzzy scorer so it only runs on strings that can match. It is a deliberate *superset* of the scorer's matcher (ASCII-lowercase, no diacritic folding) so it never drops a candidate fuzzy would keep.
3. **Incremental narrowing.** `_buildSuggestCandidates` builds the full `{kind,target,display,tier}` list once into `this._suggestCache`. When the query only grows (`query.startsWith(cache.query)`), the next keystroke narrows the prior survivor set instead of rescanning the vault — sound because fuzzy matching is monotonic. `plugin._suggestVaultGen` (bumped on create/delete/rename) invalidates the cache when the file set or any path changes; sourcePath/showFolders changes also invalidate.

## Verification

- 57 unit tests pass (`node --test --require ./tests/_setup.js tests/*.test.js`), incl. new `tests/suggest-prefilter.test.js` locking the subsequence semantics + the monotonicity invariant the cache relies on.
- Live (CLI, reloaded plugin, no errors): `getSuggestions` returns a Promise; `_computeSuggestions` present; 5-keystroke burst → `computes=1`.

## Residual / optional follow-up

One compute can still cost ~150–250ms for a *generic* 2–3 char query the user pauses on (survivor set ~50k). The only remaining lever is **capping the number of expensive fuzzy evaluations** (cheap pre-rank → run Obsidian fuzzy on top-N only). Deferred deliberately: it changes result *ranking* for huge match sets, so it needs explicit sign-off rather than a silent change. Debounce already removes the per-keystroke multiplier, which was the reported symptom.
