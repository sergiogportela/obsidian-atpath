Updated at 2026-11-05 19:20

Repository-link migration is built as an unreleased 1.9.0 on `codex/repository-link-migration`; `main` and the installed plugin are unchanged. The suite has 152 passing Node tests. Independent Claude review completed; its six blocking findings have implementation fixes or clearer estimate disclosures, with regression checks. The reviewer did not run Obsidian or re-review subsequent fixes. No tag, release, deployment or Sync upload occurred.

## Implemented

- Canonical Markdown authoring through `[[` and drag/drop; innermost Git-root resolution and GitHub-origin mapping use current local files regardless of URL ref. Missing or ambiguous targets remain explicit.
- Shared JavaScript/Python conformance fixtures accompany AgentKit migration in its own task branch.
- Actual EditorSuggest/CodeMirror authoring probes pass, including paired closing brackets and encoded cross-repository output. Clean dependency installation, build and archive verification are complete.
- An isolated native metadata bridge supplies repository-aware backlinks and graph references without changing note text. Detached Obsidian 1.15 probes pass 12 lifecycle checks, actual Backlinks/Graph/Outgoing view pipelines and heading navigation. Identical native/repository destination text retains a documented Outgoing-label limitation.
- Approximate counts use characters / 4 with incremental folder aggregation, prioritized background reads and a device-local IndexedDB cache. Actual detached native File Explorer and Chromium storage/DOM probes pass. Copy caps and linked-folder status use the same candidate scope; explicit unindexed files count separately.
- Copy/publish resolve destinations, deduplicate targets and exclude sensitive/generated content. Rename changes only destinations, preserving labels, titles, reference definitions, autolinks, refs and suffixes; SHA URLs remain unchanged. A 2,239-note corpus check verified 10,574 destination spans without mismatches.
- Desktop writes a separate personal repository map; mobile consumes it. Opened task-data sources get on-demand Git verification. Invalid Git markers and missing machine-absolute migrations have diagnostics; GitHub rename lookup supports Homebrew paths.

## Acceptance remaining

- Installed-plugin desktop UI and File Explorer layout, mobile device, full app restart and Sync acceptance. Detached native views and browser DOM tests do not establish these outcomes.
- User approval before installing into the working vault, changing its configuration or uploading/publishing content. Keep migration changes off `main` until authorized.

Prior released state and shelved explorer implementation are documented in Git history at `d636fe5`. Legacy references remain readable; the migration preview makes no automatic vault-wide changes. See [README.md](/README.md) for the new contract and limitations.
