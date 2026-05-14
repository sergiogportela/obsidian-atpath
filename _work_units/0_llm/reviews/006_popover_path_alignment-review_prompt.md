# Review: Plan 006 — Linked-@paths popover hides the filename

## Requirements
- User feedback (verbatim from the request that prompted this plan):
  > "It's working, but the text of the @ path names are still justified
  > to the wrong side, so I'm seeing the beginning of the path before I
  > see the naming of the file, and I'm not able to see the whole file.
  > Also, the name should be from repo root if they are part of a repo,
  > using the same logic that the paths already use on the nodes
  > themselves."
- Plan document at `@_work_units/improvements/plans/006_popover_path_alignment.md`
- Project conventions in `@AGENTS.md` (same as `CLAUDE.md` symlink) —
  community-plugin compliance rules apply (no `console.log`, no
  `innerHTML`, no inline styles, no `var`, sentence case, all promises
  handled, regex lookbehinds flagged, `requestUrl` over `fetch`).

## Work product
- Plan: `@_work_units/improvements/plans/006_popover_path_alignment.md`
- Code already applied in this branch:
  - `@src/main.js` — popover slow-path rebuild (search for
    `_renderLinkedPopover`, around lines 2810–3017).
  - `@styles.css` — `.atpath-linked-popover-path` rule and new
    `.atpath-linked-popover-path > bdi` rule (around lines 203–222).
  - `@tests/popover-display-path.test.js` — NEW test file.
- Shared helper relied on: `computeDisplayPath` in
  `@src/atpath-core.js` (function definition around line 90, exported
  via `createAtPathCore` returns at line 410 and as a module export at
  line 422).
- Existing helper usage references for parity comparison: see
  `@src/atpath-core.js` lines 301, 323, 333, 358, 370, 389 (other
  callers of `computeDisplayPath`).

## Supporting references
- Build: `npm run build`
- Tests: `node --test --require ./tests/_setup.js tests/*.test.js`
- Current test count: 41 passing (4 added in this plan).
- Plan 005 review prompts and outputs (same review pipeline, prior
  iteration):
  `@_work_units/0_llm/reviews/005_status_slowness_fix_review_prompt.md`,
  `@_work_units/0_llm/reviews/005_status_slowness_fix_v3-review.md`
- Git status snapshot at start of session: branch `main`, working tree
  modified `main.js`, `src/main.js`, `styles.css` plus new
  `tests/popover-display-path.test.js` and the plan file itself.
