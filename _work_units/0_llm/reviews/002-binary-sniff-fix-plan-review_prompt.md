# Review: Plan 002 — binary-sniff fix for the AtPath @path token-count freeze

## Requirements
- (paraphrase) Most minimal, most surgical change that makes the token-count freeze impossible.
- (verbatim, WU rule) "Keep token-count behavior for **real text files byte-identical** — only non-text/over-budget files change (to 'no count')."
- (verbatim, WU rule) "The freeze fix is at `getTokenCount` (main.js:2480)" — the single point both the folder walk and single-file `@`-refs flow through.
- (verbatim, WU rule) "No regex changes."
- Source-of-truth docs for the diagnosis and constraints: findings/002 (measured root cause), findings/001 (structural map), PRD.md, the WU AGENTS.md.

## Work product
- Plan to inspect: @_work_units/atpath_codeblock_freeze/plans/002_binary_sniff_fix.md (committed at `b524062`).
- Code the plan proposes to change (current, unmodified, for reference):
  - @src/main.js — `getTokenCount` (lines 2480-2500), `BINARY_EXTENSIONS` (140-149), `formatLinkedTargetCount` (181-184), `DEFAULT_SETTINGS` (218-223), core import block (193-204).
  - @src/atpath-core.js — `getFolderTokens` (178-254), `module.exports` (532-543).
- Run the test suite with: `node --test --require ./tests/_setup.js tests/*.test.js`

## Supporting references
- @_work_units/atpath_codeblock_freeze/findings/002_measured_binary_encode.md
- @_work_units/atpath_codeblock_freeze/findings/001_freeze_root_cause_map.md
- @_work_units/atpath_codeblock_freeze/PRD.md
- @_work_units/atpath_codeblock_freeze/AGENTS.md
- @_work_units/atpath_codeblock_freeze/scripts/measure_folder_encode.js
- @tests/folder-tokens.test.js (existing test-harness pattern the plan extends)
