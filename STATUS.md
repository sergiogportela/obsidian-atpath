Updated at 2026-11-06 12:25

AtPath 1.9.0 includes repository Markdown links, exact local token counts, context copying and desktop file-symlink shortcuts. The installed build is verified in Obsidian 1.15.0. The [README](/README.md) provides ZIP installation and a visual quick-start; [release notes](/docs/releases/1.9.0.md) describe the complete release.

## Verified

- 193 Node tests and build pass. Installed acceptance independently checks 948 folder totals and exclusion breakdowns against 4,886 indexed files, plus 28 visible explorer badges.
- Explorer `*` means excluded folders only. Tooltips show full counts and omitted counts grouped by rule, without the tokenizer disclaimer or duplicate tooltip. Defaults are `90_archive` and `00_llm`; both are enabled in the test vault. Other settings are preserved.
- Exclusion breakdowns update on edits, moves, deletions, settings changes and cache verification. Nested exclusions count once. The existing exact-count cache format and text-tokenization semantics are unchanged.
- Exact counts previously matched Python tiktoken for 4,423 files; offline same-size/same-timestamp edits invalidate the cache. Three exact-token Claude reviews completed without a blocker.
- File-symlink shortcuts open original indexed files without duplicating totals; eight installed symlink checks passed. Explorer badges retain the approved 75% opacity.
- Desktop checks cover autocomplete, navigation, native backlinks/graph, whole-link hover, new-tab/split/window menus, copy, rename and preview dialogs.
- The tag-triggered release workflow tests and builds, checks version consistency and committed bundle identity, and packages only main.js, manifest.json and styles.css in an atpath folder. It does not overwrite existing releases.

## Verification limits

- Physical OS drag/drop was not established by automation; registered-handler tests and six injected DOM drop cases pass.
- Real-device mobile/Sync and live publication remain untested. Native integration uses internal Obsidian APIs; see [docs/reference.md](/docs/reference.md).
