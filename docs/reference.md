# AtPath reference

For the visual introduction, see [README.md](/README.md). This document describes the 1.11.0 implementation on main; it does not imply a tagged release.

## Repository links

The note's innermost Git checkout defines `/`. Cross-repository GitHub links match normalized Git origins, not local folder names. Opening, copying and counting use local working files regardless of the URL revision or checkout branch. Missing or ambiguous targets produce diagnostics; AtPath never switches branches or substitutes downloaded content.

File navigation preserves heading/block fragments. Files outside Obsidian's index offer path copying and desktop external-app opening. Generated labels leave intraword underscores literal; existing escaped labels highlight as one link in Live Preview. Entering a link exposes its Markdown source. Blank-line/below-document drops create one bullet per distinct target; existing text, code and frontmatter retain inline insertion.

Legacy `@path` and AtPath wikilink references remain readable. **Preview legacy links for migration** identifies candidates without automatic vault-wide rewriting.

### Discovery and mobile

Desktop discovery writes `repository-map.json` with vault-relative checkout roots, normalized GitHub identities, local branches/tags and all remotes' branches; remote HEAD pointers are omitted. Exclude this personal map from Git. It contains no publishing credentials. Mobile consumes the synchronized map without `.git`; configure Sync coverage separately, and remember excluded files remain unavailable there.

Discovery skips dot-directories and `data`, `node_modules`, `venv`, `dist`, `build`, `__pycache__` at every depth, and does not follow directory symlinks. Opening a note in a skipped tree verifies and adds only that exact checkout, without scanning its excluded descendants or siblings. Unverified desktop sources and unmapped mobile sources report diagnostics rather than inheriting an incorrect root.

Run **Refresh repository map** after changes outside Obsidian. Desktop GitHub rename lookup uses authenticated `gh` for unresolved names within known workspace organizations, without downloading file content. Ambiguous slash-containing URL revisions need a known ref boundary or explicit encoding; AtPath does not guess.

AtPath retains verified opened checkouts. AgentKit's fresh discovery adds only its current prompt source, so its inventory can differ from AtPath's retained hidden-checkout history. Shared fixtures cover normal discovery and the explicit source, not that history. AgentKit's Python formatter still escapes underscores; the links resolve compatibly.

### Backlinks, graph and moves

An isolated compatibility layer supplies repository-aware references to Obsidian's native metadata index, leaves note text unchanged, and restores native resolution on unload. It uses internal APIs checked at runtime. Desktop Obsidian 1.15 tests cover backlink source passages, local/global graph inputs, Outgoing Links and heading navigation, including identical filenames in nested repositories. Real-device mobile/Sync acceptance remains untested.

Outgoing Links normally shows canonical destinations. If a repository link and a native wikilink/embed use identical destination text, the repository row may show an internal key; native resolution is preserved in that ambiguous case.

File/folder moves through Obsidian update links, including notes moved between repositories. Intentional commit-SHA destinations stay unchanged. Moving an entire checkout updates its map location instead of rewriting canonical references, and requires a freshly verified map before any rewrite.

Queued moves, chained moves, swaps and legacy repair share one chronological vault pass. Each note is parsed once unless it changes before the atomic update; concurrent edits are preserved. Failed notes do not stop others, and a persistent notice identifies incomplete updates. Only destinations change: labels, titles, reference definitions, autolink syntax and non-main refs are preserved.

## GitHub links for other apps

A link used outside its note, such as in a chat, a prompt or another repository, cannot rely on `/` meaning the note's checkout. AtPath therefore offers the full form for any file or folder inside a checkout with a GitHub origin:

`[{repo}/{path}](https://github.com/{owner}/{repo}/blob/main/{path})`; folders use `tree` and end in `/`.

- **Explorer and tab menus:** right-click a file or folder and choose **Copy path → as GitHub link**, beside **from vault folder**. A multi-selection shows **Copy GitHub links** and copies one link per line.
- **Command palette:** **Copy GitHub link for current file**; assign a hotkey if you use it often.
- **Dragging out of Obsidian:** a file, folder or multi-selection dragged from the explorer into another app drops the same links as text. Drops inside Obsidian are unchanged: the editor still receives the shorter repository link and the explorer still moves files.

The revision is always `main`, matching authored links, even before the target is pushed. Items outside a GitHub checkout have no such link: the menu entry and command are not offered, a mixed selection reports how many were skipped, and their drags keep Obsidian's own payload. While dragging, AtPath replaces Obsidian's `obsidian://` text and URL payload with the Markdown link so every app receives the same text; Obsidian's **Copy Obsidian URL** command still provides that URL. The submenu placement uses a guarded internal menu API and falls back to a top-level **Copy GitHub link** item.

**Compact copy path menu**, default on, removes **as Obsidian URL** and **from system root** from that submenu, leaving the two formats worth pasting elsewhere. Turn it off to show all of Obsidian's formats. The entries are recognized by icon through a guarded internal menu API; if Obsidian changes them, they simply remain visible.

## Tables in Live Preview

Obsidian's Live Preview table editor treats a table whose Markdown is not column-aligned as malformed. As soon as one of its cells is focused, by a click or by the cursor moving through the table, it rewrites the whole table with padded columns. Nothing was edited, yet every row changes in Git, and tables written compactly by scripts, agents or other plugins never stay compact. Obsidian has no setting for this.

**Protect tables from reformatting**, default on, keeps that editor from being entered, so tables in Live Preview are read-only:

- **Mouse:** a press inside a rendered table does not enter it. Links, buttons, checkboxes and other controls inside a cell still work, and so do other plugins' buttons on the table. A press on a table in another pane still makes that pane active and gives it the keyboard; its cursor stays where it was.
- **Drags:** a table does not accept drops. Dragging text or a file over a cell would otherwise open that cell for editing.
- **Cursor:** arrow keys, programmatic jumps (search results, backlinks) and closing in-note search land on the far side of the table instead of inside it. So does collapsing a selection that reaches into a table. A note that begins with a table opens with the cursor below it, and switching from Source mode to Live Preview moves a cursor that was inside a table to the line before it.
- **Reloads:** when a note that changed on disk is reloaded, Obsidian can leave the cursor on a row of a table that the change touched. AtPath then puts it on the line above the table. This keeps tables intact when a script or an agent rewrites a note you have open.
- **Controls:** the table editor's add-row, add-column and drag handles are hidden, because each rewrites the table. Clicks on the two add buttons are also stopped, in case a theme or snippet shows them again.

Edit tables in Source mode or in a table plugin's own editor. Turning the setting off restores Obsidian's table editor at once, in every open editor.

Left alone on purpose: selections that only pass through a table, the right-click menu and its explicit table commands, text typed or pasted as a table, and a table whose cell editor is already open. While you type a table, the cursor stays where your typing left it, so typing one in Live Preview behaves as it does with the setting off: Obsidian's table editor can take the table over midway and pad it. Type tables in Source mode to keep them as typed. **Insert table** still inserts its empty table, but the cursor lands below it. Text inside a table cannot be selected with the mouse in Live Preview; copy from Reading view or Source mode. Padded tables stay padded until something rewrites them.

Known gaps:

- **Undo and redo** bypass the mechanism the cursor rule uses. If one of them puts the cursor back into a table, which takes an edit made inside that table in Source mode, Obsidian's table editor opens on it.
- A table that ends the note, with no line after it, cannot be passed with the keyboard in Live Preview; add the line in Source mode.
- While in-note search highlights a match inside a table, Obsidian shows that table as source, and the cursor is still turned away from it.
- After a reload the table is recognized from its text (a row with a pipe above a delimiter row), because no syntax tree exists yet. The cursor can therefore also be moved out of such text inside a code block, when the reload changed it.
- In a note longer than about 100,000 characters, a jump to a far table may spend up to 100 ms finishing the parse; if that is not enough, that one jump is not turned away.

Tables are recognized by two internal Obsidian names, the `cm-table-widget` element and the `HyperMD-table-row` syntax node; the add buttons by `table-row-btn` and `table-col-btn`; an open cell editor by a `cm-editor` nested in the table; a reload by its `set` user event; and the switch into Live Preview by the internal effect that sets Obsidian's Live Preview field. If Obsidian changes any of them, that part of the protection stops silently and its table editor returns.

Separately, and regardless of this setting, AtPath cancels the press on one of its links inside a table cell. Without that, Obsidian's delayed cell focus ran after AtPath had opened the link and wrote the reformatted table into the linked note.

## File-symlink shortcuts

On desktop, AtPath shows file symlinks in the explorer as arrow-marked shortcuts when their resolved targets are already indexed inside the vault. Hover to see the alias and full target path. Click, Enter or Space opens the original file; Ctrl/Cmd-click and the context menu offer other opening modes. Explorer search matches the alias name. Dragging a shortcut references its original target. Rename/delete selection is disabled for these shortcut rows; manage the symlink itself in your filesystem tools.

Shortcuts are virtual explorer items, never extra vault files or metadata entries. Their badges reuse the target's count; ancestor totals do not count the alias again. Directory symlinks, broken/cyclic links, outside-vault targets and targets excluded from Obsidian's index do not get virtual shortcut rows. Native files that Obsidian already indexes are left to Obsidian.

The adapter checks the root and visible folders every three seconds and after explorer changes, reading directory metadata rather than file contents. Retargeting is resolved again when opening a shortcut. Nested shortcuts appear when their folder is expanded. Explorer virtualization, sorting, row identities and search use guarded internal APIs; disabling/reloading AtPath restores native behavior. This is a desktop display feature; it does not add symlink support to mobile or Sync.

## Counts, cache and exclusions

Counts use pinned `gpt-tokenizer 4.1.0`, **o200k_base ordinary text**, in a lazy local browser worker with a bounded 10,000-piece merge cache. They describe decoded text, not an exact Claude count or a full model request with messages, tools, instructions and history. Folder/linked totals sum individual file counts and deduplicate overlapping references; clipboard headings, fences and text boundaries are not included. Compact `k` labels are rounded; explorer/status tooltips show full counts. Explorer badges use faint text at 75% opacity.

| Display | Meaning |
|---|---|
| `…` | Counting is pending |
| `!` | Counting failed |
| Explorer `*` | Excluded folders; hover for their omitted token counts |
| Linked total `*` / skipped-file details | Some linked content is excluded or unavailable |

The device-local IndexedDB cache is separate from synced settings. Schema/identity includes the tokenizer version and a SHA-256 digest of decoded text. At startup every eligible file is read and hashed before its saved count is displayed; unchanged content avoids tokenization. Modification events invalidate even same-size/same-timestamp edits. Async results become invalid after edits, moves, deletion or unload. Old heuristic caches are discarded. Failed checkpoints retry with exponential backoff capped at five minutes, logging once per failure streak.

A worker failure affects its active job; queued work continues in a fresh worker. Two automatic restarts per session bound repeated startup failures and 30-second job timeouts. Reload the plugin if recovery is exhausted. Unreadable files are logged and marked failed without claiming the entire counter stopped; modification or reload retries them, repeated display requests do not. Some folder-renames and late unindexed files can cause harmless extra tokenization.

**Exclude folders from parent totals** accepts one folder name or vault-relative path per line, default `90_archive` and `00_llm`. A name matches anywhere; `project/scratch` matches only that path. No globs. **Apply** saves the complete list; drafts do not affect counts. Existing customized lists are preserved. Invalid stored settings fall back to the default with a notice. Blank settings include all otherwise eligible folders.

Matching folders are excluded from outside ancestor totals and copied folder expansions, but retain their own totals and direct-link count/copy behavior. Nested matching folders create another exclusion boundary. Changing this setting rebuilds totals without re-tokenizing files.

Explorer tooltips show full token counts and, only when applicable, omitted counts grouped by the matching exclusion rule. An outer excluded folder's omitted count includes its nested exclusions once; inside that folder, nested exclusions are reported separately. These breakdowns use the same verified file counts and update on edits, moves, deletions and setting changes. Normal policy skips do not add an explorer asterisk; pending and failed counts retain their indicators.

### File scope and limits

Counting, copy and linked-page collection exclude generated directories, Git/plugin metadata, binary content and sensitive filenames such as `.env`, private keys and `credentials.json`. Folder scope follows native indexed descendants; explicitly linked eligible unindexed files are handled individually. Copy uses the current editor buffer and appends text in fenced blocks, deduplicated by local target path, with skipped-file reporting.

**Max file size (MB)**, default 5, skips larger linked files when counting, copying or publishing. **Max files per folder reference**, default 500 indexed candidates, is checked before reading content; folder references above it show a file count and are skipped during copying.

The folder exclusion setting belongs to AtPath; AgentKit does not read it. AgentKit dispatch uses stricter limits: 1 MB/file, 100 files, 10 MB total. AtPath counts do not override those limits.

## Publishing

Add a **Vercel API token**, then use **Publish current note to Vercel**. The preview shows the target domain, existing publish state, linked local content and options. It includes eligible ordinary Markdown links as well as repository links. Review the included files before confirming. An HTML file's explorer menu can publish a single-file app or its whole static-site folder.

Included repository links are rewritten to published pages by resolved target, independent of their labels. Excluded local links become inert text. Downloadable Markdown preserves the original source. Published pages include collapsible sections, foldable bold list items, inlined local images, download and contact buttons. A result dialog provides the URL, **Copy** and **Open in browser** actions.

| Setting | Purpose |
|---|---|
| Vercel API token | Deployment authentication |
| Site icon | Reusable favicon for notes and HTML apps |
| Contact URL / Contact button label | Published contact button; default label `Entre em contato` |
| Clerk publishable key / Clerk secret key | Private-page authentication; keep the secret key private |
| Publisher email | Access-request recipient |

Enable **Require login to view** and configure Clerk plus approved emails for private publishing. No live deployment was performed during repository-link migration acceptance.

## Other preferences and verification

**Show token counts**, **Show selection tokens in status bar**, **Suggest folders in autocomplete**, **Drag-and-drop repository links**, **Compact copy path menu** and **Protect tables from reformatting** default on. Turning off drag/drop restores Obsidian's normal drag behavior, including the `obsidian://` payload for drags to other apps. Selection status displays `Sel: {selected} / {total}`; disabling it keeps the note total.

Automated coverage includes 244 Node tests. Desktop acceptance covers navigation, native backlinks/graph, counts, copy, rename and preview dialogs. Exact counts matched Python tiktoken for 4,423 files, and 968 folder totals matched an independent calculation. Offline same-size/same-timestamp changes invalidated correctly. Three exact-token Claude reviews finished with no blocker.

Registered drag/drop tests and six injected DOM drop cases pass. On macOS with Obsidian 1.15.1, physical mouse drags were verified for a file and a folder dropped into TextEdit and for a file dropped into a note, along with the native **Copy path** submenu entry. Other operating systems and drop targets were not tested. Mobile/Sync and live publication need their respective environments. Historical implementation and review documents remain available in Git history before this documentation cleanup.
