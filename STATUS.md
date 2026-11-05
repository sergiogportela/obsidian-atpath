Updated at 2026-11-05 20:28

Repository-link migration is installed as an unreleased 1.9.0 in Sergio's `colm-workspace` Obsidian 1.15.0 vault, following explicit installation and desktop-test authorization. Code remains on `codex/repository-link-migration`; `main` is unchanged. All 167 Node tests pass. Two independent Claude reviews are complete; accepted findings and the subsequent code-principles review fixes are addressed. No tag, release, deployment or Sync upload occurred.

## Implemented

- Canonical Markdown authoring through `[[` and drag/drop; innermost Git-root resolution and GitHub-origin mapping use current local files regardless of URL ref. Missing or ambiguous targets remain explicit.
- Shared JavaScript/Python resolver and discovery fixtures accompany AgentKit migration in its task branch. Both inventories currently match all 96 roots, identities and refs; retained hidden-source map history can differ, as documented in README.md.
- Actual EditorSuggest/CodeMirror authoring probes pass, including paired closing brackets and encoded cross-repository output. Clean dependency installation, build and archive verification are complete.
- An isolated native metadata bridge supplies repository-aware backlinks and graph references without changing note text. Detached Obsidian 1.15 probes pass 12 lifecycle checks, actual Backlinks/Graph/Outgoing view pipelines and heading navigation. Identical native/repository destination text retains a documented Outgoing-label limitation.
- Approximate counts retain characters / 4, incremental folders, prioritized reads and a device-local cache. UI/README disclose the expanded sample: −65.7% to +95.8% per-file error, total 19% low; JSON/CSV can need nearly 3× the estimate. Observations are not guaranteed bounds.
- Copy/publish resolve destinations, deduplicate targets and exclude sensitive/generated content. Rename processes chronological moves and legacy repair in one vault pass, preserving authored syntax and SHA links, retaining concurrent edits and reporting failures. Checkout-root moves require a freshly verified map.
- Desktop writes a separate personal repository map; mobile consumes it. Opened task-data sources get on-demand Git verification. Invalid Git markers and missing machine-absolute migrations have diagnostics; GitHub rename lookup supports Homebrew paths.

## Installed desktop acceptance

- Real keyboard/click checks pass for same-repository and GitHub links, headings, folder reveal, native relative-link fallback, paired-bracket autocomplete, cross-repository/folder suggestions and rapid Enter. Acceptance fixed the stale suggestion popup/cursor transaction.
- Native Backlinks, Outgoing Links and Local Graph show the correct distinct targets. Latest live acceptance: ten renames, a swap/folder batch, and a source/target cross-repository batch each parsed 2,251 notes once in 1.34–1.51 seconds. Exact text checks and local link clicks passed; native wikilinks coexisted.
- Copy includes four unique eligible files despite overlap and excludes fake secret/generated/binary fixtures. Publish and migration previews were inspected and cancelled. No bulk conversion occurred.
- Explorer and Reading counts update live, hide/restore on settings changes and recover after map discovery, missing-target creation/removal, plugin reload and full app restart. Acceptance fixed Reading lifecycle/map-readiness refresh and inactive-split drag source ownership.
- The registered drag/drop handler regression passes, including an inactive receiving editor. Actual OS drop remains unverified: computer automation emitted dragstart/dragend but no dragover/drop, also with AtPath's handler disabled.
- Latest acceptance preserved all 2,239 pre-existing Markdown files byte-for-byte before documentation updates. Original tabs/recents and clipboard are restored, plugin settings remain byte-identical, and all 12 own fixture files are archived. Live map: 96 real repositories; no test identities or captured errors.

## Acceptance remaining

- Real-device mobile and Sync acceptance require that environment; desktop is not equivalent evidence. OS-level drag/drop still needs a manual check. Live publication was not exercised.
- Keep migration changes off `main` until authorized. AgentKit remains separately implemented and tested in its task worktree; its active environment was not changed.

Prior released state and shelved explorer implementation are documented in Git history at `d636fe5`. Legacy references remain readable; the migration preview makes no automatic vault-wide changes. See [README.md](/README.md) for the new contract and limitations.
