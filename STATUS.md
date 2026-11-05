Updated at 2026-11-05 19:50

Repository-link migration is installed as an unreleased 1.9.0 in Sergio's `colm-workspace` Obsidian 1.15.0 vault, following explicit installation and desktop-test authorization. Code remains on `codex/repository-link-migration`; `main` is unchanged. The suite has 155 passing Node tests. Independent Claude review completed before desktop acceptance; its six blocking findings were addressed. The reviewer did not run Obsidian or re-review later fixes. No tag, release, deployment or Sync upload occurred.

## Implemented

- Canonical Markdown authoring through `[[` and drag/drop; innermost Git-root resolution and GitHub-origin mapping use current local files regardless of URL ref. Missing or ambiguous targets remain explicit.
- Shared JavaScript/Python conformance fixtures accompany AgentKit migration in its own task branch.
- Actual EditorSuggest/CodeMirror authoring probes pass, including paired closing brackets and encoded cross-repository output. Clean dependency installation, build and archive verification are complete.
- An isolated native metadata bridge supplies repository-aware backlinks and graph references without changing note text. Detached Obsidian 1.15 probes pass 12 lifecycle checks, actual Backlinks/Graph/Outgoing view pipelines and heading navigation. Identical native/repository destination text retains a documented Outgoing-label limitation.
- Approximate counts use characters / 4 with incremental folder aggregation, prioritized background reads and a device-local IndexedDB cache. Actual detached native File Explorer and Chromium storage/DOM probes pass. Copy caps and linked-folder status use the same candidate scope; explicit unindexed files count separately.
- Copy/publish resolve destinations, deduplicate targets and exclude sensitive/generated content. Rename changes only destinations, preserving labels, titles, reference definitions, autolinks, refs and suffixes; SHA URLs remain unchanged. A 2,239-note corpus check verified 10,574 destination spans without mismatches.
- Desktop writes a separate personal repository map; mobile consumes it. Opened task-data sources get on-demand Git verification. Invalid Git markers and missing machine-absolute migrations have diagnostics; GitHub rename lookup supports Homebrew paths.

## Installed desktop acceptance

- Real keyboard/click checks pass for same-repository and GitHub links, headings, folder reveal, native relative-link fallback, paired-bracket autocomplete, cross-repository/folder suggestions and rapid Enter. Acceptance fixed the stale suggestion popup/cursor transaction.
- Native Backlinks, Outgoing Links and Local Graph show the correct distinct targets. File and folder renames and source moves preserve labels, titles, definitions, URL suffixes and intentional SHA links.
- Copy includes four unique eligible files despite overlap and excludes fake secret/generated/binary fixtures. Publish and migration previews were inspected and cancelled. No bulk conversion occurred.
- Explorer and Reading counts update live, hide/restore on settings changes and recover after map discovery, missing-target creation/removal, plugin reload and full app restart. Acceptance fixed Reading lifecycle/map-readiness refresh and inactive-split drag source ownership.
- The registered drag/drop handler regression passes, including an inactive receiving editor. Actual OS drop remains unverified: computer automation emitted dragstart/dragend but no dragover/drop, also with AtPath's handler disabled.
- All 2,235 pre-existing Markdown files were hash-identical before documentation updates. Original tabs and clipboard were restored, plugin settings remained byte-identical, and own fixtures were archived with matching hashes. The live map contains 96 real repositories and no test identities.

## Acceptance remaining

- Real-device mobile and Sync acceptance require that environment; desktop is not equivalent evidence. OS-level drag/drop still needs a manual check. Live publication was not exercised.
- Keep migration changes off `main` until authorized. AgentKit remains separately implemented and tested in its task worktree; its active environment was not changed.

Prior released state and shelved explorer implementation are documented in Git history at `d636fe5`. Legacy references remain readable; the migration preview makes no automatic vault-wide changes. See [README.md](/README.md) for the new contract and limitations.
