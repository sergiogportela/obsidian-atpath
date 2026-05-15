# Review: Obsidian log / CLI / dev-console access research

## Requirements
- User feedback (verbatim from the request that prompted this research):
  > "It is indeed better and working faster, but I feel there this still
  > needs polishing and optimization. It would be nice if you could just
  > have access to the Obsidian logs, the developer console. Obsidian has
  > created a CLI. I think next steps here would be to go with explorer
  > agents on the online with perplexity and try to look for the best
  > ways of having access to Obsidian logs and even testing things out by
  > yourself. But if testing is not possible, accessing the logs while I
  > test and telling me what to test is nice. Operating the developer
  > console has been a hustle and it has been very difficult for you to
  > diagnose things and sometimes we're over-engineering over things that
  > are actually not needed instead of choosing the simplest, reliable
  > approach for what we actually require."
- User asked specifically: "Sponsor some web explorer agents and try to
  find out how to properly do this, and then make sure to create a
  findings document on the work unit, and also update a status document
  on the repo or the work unit."
- Project conventions in `@AGENTS.md` (CLAUDE.md is a symlink).
- Memory note (persistent): user prefers the **simplest reliable
  approach**; clean breaks over backwards-compat shims; agent-driven
  verification over manual test steps.

## Work product
- Findings document: `@_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md`
- Status document (newly created at this location since none existed
  previously): `@_work_units/STATUS.md`

## Supporting references
- Three parallel Perplexity research agents were run on 2026-05-15
  covering: (a) does Obsidian have an official CLI, (b) how to access
  Obsidian's developer console logs from outside the app, (c) is
  autonomous E2E testing of an Obsidian plugin feasible. Findings document
  consolidates and deduplicates their outputs.
- Plan 005 (`@_work_units/improvements/plans/005_status_slowness_fix.md`)
  and Plan 006 (`@_work_units/improvements/plans/006_popover_path_alignment.md`)
  are the immediate context — both shipped 2026-05-15. The recurring
  diagnosis-via-DevTools friction during their development is what
  prompted this research.
- Plan 006 codex review (same review pipeline, prior iteration):
  `@_work_units/0_llm/reviews/006_popover_path_alignment-review_prompt.md`,
  `@_work_units/0_llm/reviews/006_popover_path_alignment-review.md`.
- Current working tree: branch `main`, last commit `e49a454` (Plan 006).
  No code changes proposed in this work product — research + docs only.
- Sources cited inline in the findings document; URLs listed in its
  final section.
