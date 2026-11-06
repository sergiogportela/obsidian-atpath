Updated at 2026-11-05 21:26

Repository-link migration is installed as an unreleased 1.9.0 in Sergio's `colm-workspace` Obsidian 1.15.0 vault, following explicit installation and desktop-test authorization. Code remains on `codex/repository-link-migration`; `main` is unchanged. All 178 Node tests pass. Exact-token changes are installed and tested; the requested independent Claude review is pending. Two independent Claude reviews are complete; accepted findings and the subsequent code-principles review fixes are addressed. No tag, release, deployment or Sync upload occurred.

## Implemented

- Canonical Markdown authoring through `[[` and drag/drop; innermost Git-root resolution and GitHub-origin mapping use current local files regardless of URL ref. Missing or ambiguous targets remain explicit.
- Shared JavaScript/Python resolver and discovery fixtures accompany AgentKit migration, now merged/pushed to `arbi_utils/sergio` at `754304f5`. Both inventories currently match all 96 roots, identities and refs; retained hidden-source map history can differ, as documented in README.md.
- Actual EditorSuggest/CodeMirror authoring probes pass, including paired closing brackets and encoded cross-repository output. Clean dependency installation, build and archive verification are complete.
- An isolated native metadata bridge supplies repository-aware backlinks and graph references without changing note text. Detached Obsidian 1.15 probes pass 12 lifecycle checks, actual Backlinks/Graph/Outgoing view pipelines and heading navigation. Identical native/repository destination text retains a documented Outgoing-label limitation.
- Exact local `o200k_base` counts use pinned `gpt-tokenizer 4.1.0` in one lazy browser worker. Versioned SHA-256-verified IndexedDB snapshots replace the heuristic cache; stale async results are discarded and failed checkpoints retry. Folder boundaries default to `90_archive`, are configured one name/path per line, and apply to ancestor totals and folder copying while retaining direct targets. Explorer numbers use faint text at 50% opacity.
- Copy/publish resolve destinations, deduplicate targets and exclude sensitive/generated content. Rename processes chronological moves and legacy repair in one vault pass, preserving authored syntax and SHA links, retaining concurrent edits and reporting failures. Checkout-root moves require a freshly verified map.
- Desktop writes a separate personal repository map; mobile consumes it. Opened task-data sources get on-demand Git verification. Invalid Git markers and missing machine-absolute migrations have diagnostics; GitHub rename lookup supports Homebrew paths.

## Installed desktop acceptance

- Real keyboard/click checks pass for same-repository and GitHub links, headings, folder reveal, native relative-link fallback, paired-bracket autocomplete, cross-repository/folder suggestions and rapid Enter. Acceptance fixed the stale suggestion popup/cursor transaction.
- Native Backlinks, Outgoing Links and Local Graph show the correct distinct targets. Latest live acceptance: ten renames, a swap/folder batch, and a source/target cross-repository batch each parsed 2,251 notes once in 1.34–1.51 seconds. Exact text checks and local link clicks passed; native wikilinks coexisted.
- Copy includes four unique eligible files despite overlap and excludes fake secret/generated/binary fixtures. Publish and migration previews were inspected and cancelled. No bulk conversion occurred.
- Explorer and Reading counts update live, hide/restore on settings changes and recover after map discovery, missing-target creation/removal, plugin reload and full app restart. Acceptance fixed Reading lifecycle/map-readiness refresh and inactive-split drag source ownership.
- The registered drag/drop handler regression passes, including an inactive receiving editor. Actual OS drop remains unverified: computer automation emitted dragstart/dragend but no dragover/drop, also with AtPath's handler disabled.
- Earlier migration acceptance preserved 2,239 notes and archived its 12 fixtures. Exact-token acceptance matches all 4,419 installed file counts to Python tiktoken and all 967 folder totals to an independent calculation. UI checks cover editor selections, live edits, Reading view, boundary settings, copy deduplication, moves and deletion; offline same-size/same-mtime edits invalidate correctly on reload.

## Acceptance remaining

- Real-device mobile and Sync acceptance require that environment; desktop is not equivalent evidence. OS-level drag/drop still needs a manual check. Live publication was not exercised.
- Keep migration changes off `main` until authorized. The merged AgentKit checkout passes 124 focused tests, approved parser dependencies are installed, and its task worktree was removed. Exact-token implementation is installed on the task branch; independent Claude review is pending. Real-device mobile remains untested.

Prior released state and shelved explorer implementation are documented in Git history at `d636fe5`. Legacy references remain readable; the migration preview makes no automatic vault-wide changes. See [README.md](/README.md) for the new contract and limitations.
