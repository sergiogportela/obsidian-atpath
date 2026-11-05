Updated at 2026-11-05 19:05

Repository-link migration is implemented as an unreleased 1.9.0 build on `codex/repository-link-migration`; `main` and the installed plugin are unchanged. A clean task-local dependency install builds successfully with 140 passing Node tests. Independent Claude review is in progress. No tag, release, deployment or Sync upload occurred.

## Implemented

- Canonical Markdown authoring through `[[` and drag/drop; innermost Git-root resolution and GitHub-origin mapping use current local files regardless of URL ref. Missing or ambiguous targets remain explicit.
- Shared JavaScript/Python conformance fixtures accompany AgentKit migration in its own task branch.
- An isolated native metadata bridge supplies repository-aware backlinks and graph references without changing note text. Detached Obsidian 1.15 probes pass 12 lifecycle checks, actual Backlinks/Graph/Outgoing view pipelines and heading navigation. Identical native/repository destination text retains a documented Outgoing-label limitation.
- Approximate counts use characters / 4 with incremental folder aggregation, prioritized background reads and a device-local IndexedDB cache. Actual detached native File Explorer and Chromium storage/DOM probes pass. Copy caps and linked-folder status use the same candidate scope; explicit unindexed files count separately.
- Copy/publish resolve destinations and deduplicate overlapping targets. Publishing rewrites included links by local path while preserving the Markdown download. SHA destinations remain unchanged during automatic rename.
- Desktop writes a separate personal repository map; mobile consumes it. Explicit unindexed file handling and authenticated desktop rename lookup are included.

## Acceptance remaining

- Independent review and final fixes. Actual EditorSuggest/CodeMirror authoring probes pass, including paired closing brackets and encoded cross-repository output.
- Installed-plugin desktop UI, real native File Explorer, mobile device, full app restart and Sync acceptance. Detached native views and browser DOM tests do not establish these outcomes.
- User approval before installing into the working vault, changing its configuration or uploading/publishing content. Keep migration changes off `main` until authorized.

Prior released state and shelved explorer implementation are documented in Git history at `d636fe5`. Legacy references remain readable; the migration preview makes no automatic vault-wide changes. See [README.md](/README.md) for the new contract and limitations.
