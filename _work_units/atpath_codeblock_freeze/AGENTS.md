# AGENTS — atpath_codeblock_freeze WU

WU-specific rules. Repo-wide rules: @AGENTS.md (root, symlinked as CLAUDE.md). CLAUDE.md here is a symlink to this file.

## Scope
Fix the @path-in-codeblock 100% CPU freeze with the most minimal surgical change. Source of truth: PRD.md, STATUS.md, findings/001, plans/001.

## Hard rules for this WU
- **No regex changes.** ReDoS is empirically disproven (findings/001); editing `AT_PATH_RE`/`AT_PATH_FOLDER_RE` is wasted effort and risks match semantics.
- The fix must keep prose behavior byte-for-byte identical — only matches inside fence/inline-code/frontmatter change.
- Reuse the existing `buildExcludedRanges`/`isInExcludedRange` helpers; fix the P3 ordering bug before reusing them in a hot path.
- Guard with the **absolute** offset (`absStart = from + m.index`), never the slice-relative `m.index`.
- Memoize excluded ranges by doc identity — do not recompute the full-doc scan on every cursor/selection change.

## Commands
- Tests: `node --test --require ./tests/_setup.js tests/*.test.js`
- Build: `npm run build` (edit src/main.js → regenerates committed main.js)
- Reload after build: `obsidian plugin:reload id=atpath` (CLI installer is out of date — only eval/dev:errors/dev:console work)
- Perf lever: `localStorage['atpath-perf']='1'` → reload → `window.__atpath_perf_dump()` (reset-on-read, call once)

## Codex review
Required on the critical paths: root-cause review is done (findings/001). Run `/review-codex` again on the final patch diff before ship.
