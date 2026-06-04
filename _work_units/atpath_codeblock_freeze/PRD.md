# PRD — AtPath @path-in-codeblock 100% CPU freeze

## WHY (real-world incident)

While writing `@_work_units/ai_dev/agent_orchestrator/findings/v2_cli_design_ideas.md` **inside a fenced code block** (colm-as-kedro vault), typing the `@path` char-by-char drove Obsidian to ~100% CPU and froze. Code-block content should be inert for AtPath — a user reasonably expects `@path` inside ` ``` ` to do nothing. Today it triggers the full per-keystroke machinery.

## WHAT

Eliminate the freeze with the **most minimal, surgical** change: make AtPath's per-keystroke hot paths code-block aware, matching the exclusion the status-bar scanner (`scanAtPathRefs`) already applies. Confirm empirically which hot path dominated, then apply the minimal-sufficient subset (or the coherent superset if confirmation is skipped).

## Root cause (one line)

The editor hot paths — CM6 decoration builder (`buildDecorations`), autocomplete trigger (`onTrigger`), and whole-doc tokenizer (`scheduleDocRetoken`) — lack the code-block exclusion that `scanAtPathRefs` has, so `@path` inside a fence is fully processed every keystroke; the sustained 100% CPU is synchronous `gpt-tokenizer` `encode()` + full-vault fuzzy compute running where they should be inert. **Not** a regex/ReDoS problem (empirically disproven).

## Non-goals

- No regex rewrite (ReDoS disproven; would fix nothing, risks match semantics).
- Not the broad shelved Plan 003 (approximate tokenizer / persistent cache).
- Wikilink ViewPlugin + reading-mode post-processor fence-unawareness: documented asymmetries, deferred.

## Source of truth

Findings: @_work_units/atpath_codeblock_freeze/findings/001_freeze_root_cause_map.md.
Plan: @_work_units/atpath_codeblock_freeze/plans/001_surgical_fix_workflow.md.
Current state: @_work_units/atpath_codeblock_freeze/STATUS.md.
After implementation, durable WHY/WHAT moves to source docstrings + repo STATUS.md; this PRD becomes a pointer.
