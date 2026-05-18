# Review: DnD @path fix (Prec.highest) — commits 72e7424 + 4efed1e on main

## Requirements

- From the originating prompt @_work_units/improvements/prompts/005_verify_plan_a_dnd_diagnosis.md:
  - "Verify Plan A (002) executed cleanly and diagnose why drag-and-drop @path inserts from the file explorer are broken."
  - "Prefer the simplest reliable fix (clean break, no backwards-compat shims)."
  - "Land a regression test for DnD after the fix (in scope)."
  - "@CLAUDE.md is a symlink — edit only @AGENTS.md."
- Community plugin compliance rules listed in @COMMUNITY_PLUGINS.md and summarised under "Obsidian Community Plugin compliance" in @AGENTS.md (paraphrase): no `console.log`; no `innerHTML`/`outerHTML`; never hardcode `.obsidian`; all promises awaited/`.catch()`-ed/`void`-ed; no `var`; sentence-case user-facing text; no default hotkeys; manifest naming constraints; semver version strings.
- Repo conventions: `CLAUDE.md` is a symlink to `AGENTS.md`; build output `main.js` is committed alongside `src/main.js`.
- Unit-test entry point (paraphrase): `node --test --require ./tests/_setup.js tests/*.test.js`.

## Work product

- Exact artefacts to inspect:
  - Commit `72e7424` — DnD CM6 extension wrapped in `Prec.highest`, stray `document` `drop` capture listener removed.
  - Commit `4efed1e` — `extractDraggedVaultPaths` moved into `src/atpath-core.js` as a pure function; new tests in `tests/drag-extract.test.js`; CLI gotchas appended under "Agent diagnosis runbook" in `AGENTS.md`; `STATUS.md` refreshed.
- Files touched across the two commits: `src/main.js`, `src/atpath-core.js`, `main.js` (built bundle), `tests/drag-extract.test.js`, `AGENTS.md`, `STATUS.md`.
- Mechanical commands:
  - Inspect commits: `git show 72e7424`, `git show 4efed1e`.
  - Build: `npm run build` (esbuild bundle).
  - Tests: `node --test --require ./tests/_setup.js tests/*.test.js` — currently 48 tests across `tests/*.test.js`.

## Supporting references

- @_work_units/improvements/prompts/005_verify_plan_a_dnd_diagnosis.md
- @_work_units/improvements/prompts/002_include_drag_and_drop.md
- @_work_units/improvements/plans/002_plan_statusbar_and_folder_autocomplete.md (DnD landed at §3.5 step 12, commit `534e9e1`)
- @AGENTS.md (symlinked to `CLAUDE.md`)
- @COMMUNITY_PLUGINS.md
- @STATUS.md
- CodeMirror 6 references: `EditorView.domEventHandlers` (`@codemirror/view`), `Compartment` and `Prec` (`@codemirror/state`).
- Obsidian CLI runbook: @AGENTS.md "Testing → Agent diagnosis runbook (Obsidian CLI)".
