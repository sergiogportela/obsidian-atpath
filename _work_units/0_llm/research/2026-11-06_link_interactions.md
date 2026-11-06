# Link interaction acceptance — 2026-11-06

Sergio requested moving the task branch into the normal checkout and pushing it without merging main, fixing escaped link labels and partial hover highlighting, adding wikilink-like context-menu navigation, and making explorer drops onto empty note space create bullets.

## Implementation

- `codex/repository-link-migration` now occupies `/Users/sergio/Documents/code/obsidian_plugin_atpath`. The previous task worktree was removed with ordinary `git worktree remove`, without force. Its only ignored content was `node_modules`, transferred to the checkout; the checkout's previous dependencies were preserved under task evidence. Existing ignored settings, logs and test artifacts were retained.
- The formatter leaves intraword underscores literal while continuing to escape characters that could introduce Markdown formatting. Destinations are unchanged. AgentKit's Python formatter still emits escaped underscores; both forms resolve identically.
- Repository navigation marks use CodeMirror's outer-decoration facet, wrapping native label fragments without replacing native Markdown rendering. Hover styles apply across that wrapper. Existing notes are not rewritten; raw source remains visible when editing a link.
- The file menu offers Open link, Open in new tab, Open to the right, Open in new window, Reveal in file explorer, Copy path and Open in default app. Desktop-only actions are omitted on mobile; unindexed local files offer only applicable actions. All navigation reuses the resolved file and fragment. Editor capture listeners also register for existing/new pop-out documents.
- Blank-line drops replace whitespace with one bullet per deduplicated target. Drops below the last paragraph start a new bullet block instead of using the old cursor. Existing prose, empty bullets and fenced code retain inline insertion. Source resolution still belongs to the receiving editor.

## Verification

- 188 Node tests pass. New coverage exercises readable labels and literal Markdown punctuation; registered drops into blank/indented lines, prose, existing bullets, fences/frontmatter and below-document space; multiple targets; menu modes, fragments, mobile action filtering, local-only targets, errors and pop-out document registration.
- Built and installed into the running Obsidian 1.15 vault. Compared the actual native wikilink menu before implementing navigation choices.
- Actual UI right-click menus were checked in Live Preview and Reading view. Selecting new tab opened the local PRD in an additional leaf; right split created a separate tab group; new window opened the cross-repository `colm-it-infra/MATRIZ_GERAL.md` locally.
- Actual pointer hover over `git` in an old escaped label highlighted all five label fragments with the same hover color (`rgb(197, 182, 252)`); adjacent links remained at the normal color (`rgb(166, 138, 249)`). Rendered labels contained no backslashes with the cursor elsewhere.
- Six installed-handler tests dispatched real DOM dragover/drop events with DataTransfer payloads and measured editor text: blank line, multiple files/deduplication, prose, existing bullet, unfinished fence and below final paragraph. All passed, with both events handled.
- OS drag automation produced a drag ghost but no delivered drop again. These DOM checks establish installed handler behavior, not successful physical drag completion. A manual drag remains the acceptance limitation.
- No new developer errors appeared; the retained error is the previous day's deliberately injected token-worker acceptance failure. Token counting and the 75% explorer opacity are unchanged.

Evidence is under the workspace's `data/0_llm/ai_dev/atpath_link_interactions_2026_11_06/`, including the test log, hover colors, layout snapshots and installed drop results. The temporary acceptance note is archived there after testing. Sergio's untracked `008_test_new_atpath.md` is preserved byte-for-byte.

API references: [CodeMirror outer decorations](https://codemirror.net/docs/ref/#view.EditorView.outerDecorations), [Obsidian workspace API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts), [Obsidian pop-out windows](https://help.obsidian.md/User%20interface/Pop-out%20windows).
