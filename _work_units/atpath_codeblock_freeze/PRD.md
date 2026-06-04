# PRD — AtPath @path-in-codeblock 100% CPU freeze

## WHY (real-world incident)

While writing `@_work_units/ai_dev/agent_orchestrator/findings/v2_cli_design_ideas.md` **inside a fenced code block** (colm-as-kedro vault), typing the `@path` char-by-char drove Obsidian to ~100% CPU and froze. **Measured root cause:** the referenced folder contains 13 `.heic` photos that the plugin's binary denylist forgot, so each is read as text and tokenized (~9s each, ~83s total). The code block turned out to be **incidental** — the same freeze fires in prose.

## WHAT

Eliminate the freeze by **not tokenizing non-text content**, at the single decision point `getTokenCount` (@src/main.js:2484) that both the folder walk and single-file `@`-refs flow through. Measured effect on the affected folder: ~83,000ms → ~400ms (~200×). Secondary: make code-block content inert for AtPath (the original UX expectation).

## Root cause (one line)

`BINARY_EXTENSIONS` (@src/main.js:140-149) denylists `jpg/png/...` but **omits `heic`/`heif`**, so `getTokenCount` feeds HEIC photo bytes (decoded to a ~2M-char string by `cachedRead`) to synchronous `gpt-tokenizer encode()`; a folder of 13 HEICs = ~83s of pinned main-thread CPU. **Not** a regex/ReDoS problem (disproven) and **not** code-block-specific (the fence is incidental). Full evidence: findings/002.

## Non-goals

- No regex rewrite (ReDoS disproven; would fix nothing, risks match semantics).
- Not the broad shelved Plan 003 (approximate tokenizer / persistent cache).
- Wikilink ViewPlugin + reading-mode post-processor fence-unawareness: documented asymmetries, deferred.

## Source of truth

Measured root cause + fix options: @_work_units/atpath_codeblock_freeze/findings/002_measured_binary_encode.md.
Structural map (ReDoS disproven, hot-path inventory): @_work_units/atpath_codeblock_freeze/findings/001_freeze_root_cause_map.md.
Plan: @_work_units/atpath_codeblock_freeze/plans/001_surgical_fix_workflow.md.
Current state: @_work_units/atpath_codeblock_freeze/STATUS.md.
After implementation, durable WHY/WHAT moves to source docstrings + repo STATUS.md; this PRD becomes a pointer.
