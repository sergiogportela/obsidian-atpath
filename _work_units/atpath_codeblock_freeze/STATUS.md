Updated at 2026-06-04 11:35

Open WU. Root cause **mapped and codex-reviewed** (9-agent workflow); no code changed yet. The freeze is the per-keystroke editor hot paths processing `@path` inside code blocks because they lack the fence exclusion `scanAtPathRefs` already has. ReDoS empirically disproven. Awaiting a scope decision + empirical confirmation before patching.

## Done
- Mapping workflow (7 explorers → synthesis → codex review, `codex_used: true`) → findings/001.
- Verified: structural gap in `buildDecorations` (831-937), `onTrigger` (521-538), `scheduleDocRetoken` (1126); folder-encode is a transient (≤4 encodes/session, memoized), not a per-keystroke loop; sustained drivers are whole-doc encode + autocomplete fuzzy.
- Found 2 latent bugs: P3 unsorted-ranges false-negative in `buildExcludedRanges`/`isInExcludedRange`; P2 full-doc rescan-per-build if the naive guard is added unmemoized.
- Env: plugin v1.8.3 live; Obsidian CLI works but installer out of date (eval/dev:errors/dev:console only).

## Open (from plans/001)
- **Phase 0 decision gate** — confirm which hot path dominated (needs affected vault): `showTokenCounts` value, vault file count, whether path prefixes are real `TFolder`s, editor mode; perf dump via `window.__atpath_perf_dump()`.
- **Fix** — F1 (fence-guard `buildDecorations`, memoized) always; F2 (`onTrigger`) / F3 (cap whole-doc encode) per Phase 0; F4 (fix P3) + F5 (extract helpers to atpath-core for tests) required once F1 reuses the helper.
- **Tests** — `tests/excluded-ranges.test.js` (incl. inline-before-fence ordering), fence-skip oracle, regex time-budget.
- **Codex review of the final diff** before ship.

## Awaiting user
Scope decision: run Phase 0 empirical confirmation first vs implement the coherent fence-aware superset directly. See plans/001.
