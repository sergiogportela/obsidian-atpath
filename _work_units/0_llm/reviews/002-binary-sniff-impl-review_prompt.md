# Review: Plan 002 binary-sniff freeze-fix implementation (Part A)

## Requirements
- (paraphrase) AtPath is an Obsidian plugin. A `@path` reference into a folder containing `.heic` photos pins the renderer's single JS thread at ~100% CPU (~78s for one folder) because `getTokenCount` feeds the photo's decoded bytes to `gpt-tokenizer`'s synchronous `encode()`.
- The implementation is specified by `_work_units/atpath_codeblock_freeze/plans/002_binary_sniff_fix.md` (sections A1, A2, A3 are Part A; Part B and the R3 fence guard are explicitly deferred).
- WU hard rules, verbatim from `_work_units/atpath_codeblock_freeze/CLAUDE.md`:
  - "The freeze fix is at `getTokenCount` (main.js:2484) — the single point both the folder walk and single-file `@`-refs flow through. Fix the non-text gap here (denylist-completion / allowlist / binary sniff — decision pending). Don't reach for the fence guard as the freeze fix."
  - "No regex changes. ReDoS is empirically disproven (findings/001); editing `AT_PATH_RE`/`AT_PATH_FOLDER_RE` is wasted effort and risks match semantics."
  - "Keep token-count behavior for real text files byte-identical — only non-text/over-budget files change (to \"no count\")."
- Repo-wide Obsidian Community Plugin code rules are summarized in `CLAUDE.md` (repo root) under "Code rules (enforced by eslint-plugin-obsidianmd)".

## Work product
- Uncommitted working-tree changes to two tracked files and one new untracked file:
  - `src/atpath-core.js` — new module-scope `looksBinary` function and its `module.exports` entry.
  - `src/main.js` — `BINARY_EXTENSIONS` additions; `looksBinary` added to the `./atpath-core` destructure; a sniff block inserted in `getTokenCount` between the `cachedRead` call and the `encode` call.
  - `tests/binary-sniff.test.js` — new (untracked) unit tests for `looksBinary`.
- The committed root `main.js` is a generated esbuild bundle of `src/main.js`; it has also been regenerated in the working tree.
- Access the changes:
  - `git -C /Users/sergio/Documents/code/obsidian_plugin_atpath status --short`
  - `git -C /Users/sergio/Documents/code/obsidian_plugin_atpath --no-pager diff -- src/atpath-core.js src/main.js`
  - `tests/binary-sniff.test.js` is new and untracked; read it directly.
- Run the unit tests: `node --test --require ./tests/_setup.js tests/*.test.js`
- Build: `npm run build` (regenerates root `main.js` from `src/main.js` via `esbuild.config.mjs`).

## Supporting references
- Plan: `_work_units/atpath_codeblock_freeze/plans/002_binary_sniff_fix.md`
- Measured root cause: `_work_units/atpath_codeblock_freeze/findings/002_measured_binary_encode.md`
- Structural map: `_work_units/atpath_codeblock_freeze/findings/001*` (if present)
- Prior plan-level review of this plan: `_work_units/0_llm/reviews/002-binary-sniff-fix-plan-review.md`
- WU rules: `_work_units/atpath_codeblock_freeze/CLAUDE.md`
- Token-count call sites: `getTokenCount`, `scheduleTokenFetch`, the `formatTokens` helper, and the `tokenCache.get` readers in `src/main.js`; the folder walk (`getFolderTokens`) in `src/atpath-core.js`.
