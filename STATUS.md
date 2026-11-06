Updated at 2026-11-06 11:59

AtPath 1.9.0's repository-link migration and exact token counting are integrated into main. The installed Obsidian 1.15.0 build includes readable labels, whole-link hover, expanded link menus and bullet drops into empty space. The README is a visual quick-start; detailed contracts and limitations live in [docs/reference.md](/docs/reference.md). No 1.9.0 tag or release has been created.

## Verified

- The file-symlink follow-up is installed and integrated into main. Arrow-marked virtual rows open indexed in-vault targets; aliases share target counts without changing folder totals. Eight installed checks cover discovery, identity, search, retargeting, target changes, deletion-key protection and disposal.

- 191 Node tests pass. Desktop checks cover autocomplete, navigation, native backlinks/graph, counts, copy, rename and preview dialogs.
- Exact counts match Python tiktoken for 4,423 files; 968 folder totals match an independent calculation. Content-verified caching detects offline same-size/same-timestamp edits. Three exact-token Claude reviews completed without a blocker.
- Folder exclusions default to `90_archive`; direct targets remain available. Explorer badges retain the approved 75% opacity.
- The previous task worktree was removed. User-deleted nested work-unit files are removed from the current tree; historical evidence remains in Git history.

## Verification limits

- Physical drag/drop was not established by automation; registered-handler tests and six injected DOM drop cases pass.
- Real-device mobile/Sync and live publication remain untested. Native metadata compatibility uses internal Obsidian APIs; see the reference for the mixed-link Outgoing label limitation.
