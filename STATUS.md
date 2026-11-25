Updated at 2026-11-25 15:45

AtPath 1.10.1 shortens the native **Copy path** submenu to **from vault folder** and **as GitHub link**, with a **Compact copy path menu** setting to restore Obsidian's other formats. It builds on 1.10.0's GitHub links for use outside a note (explorer and tab menus, multi-selection, a command, and drags into other apps) and the earlier repository links, exact local token counts, context copying and file-symlink shortcuts. The [README](/README.md) provides ZIP installation and a visual quick-start; release notes: [1.10.1](/docs/releases/1.10.1.md), [1.10.0](/docs/releases/1.10.0.md).

## Verified

- 197 Node tests and build pass. GitHub link tests cover files, folders, checkout roots, encoded names, duplicate checkouts, targets without a GitHub origin, and resolution back to the same local target.
- Installed in Obsidian 1.15.1 on macOS with native menus: the real explorer menu shows **as GitHub link** inside **Copy path** for files and folders; clipboard contents matched for file, folder, two-item selection and the command.
- Compact menu, checked on the installed build's real menu objects after Obsidian's own sorting: files and folders list only **from vault folder** and **as GitHub link**; turning the setting off restores all four entries.
- Physical mouse drags: a file and a folder dropped into TextEdit produced their GitHub links; a file dropped into a note still inserted the bullet repository link. With **Drag-and-drop repository links** off, Obsidian's `obsidian://` payload is unchanged.
- From 1.9.0, installed acceptance checked 948 folder totals and exclusion breakdowns against 4,886 indexed files, plus 28 visible explorer badges. Exact counts matched Python tiktoken for 4,423 files; offline same-size/same-timestamp edits invalidate the cache.
- Explorer `*` means excluded folders only; defaults are `90_archive` and `00_llm`. File-symlink shortcuts open original indexed files without duplicating totals.
- Desktop checks cover autocomplete, navigation, native backlinks/graph, whole-link hover, new-tab/split/window menus, copy, rename and preview dialogs.
- The tag-triggered release workflow tests and builds, checks version consistency and committed bundle identity, and packages only main.js, manifest.json and styles.css in an atpath folder. It does not overwrite existing releases.

## Verification limits

- Drag-out was tested only on macOS with TextEdit as the target; multi-selection drags were checked through dispatched events, not a physical drag. Popout windows are not covered by the drag listeners.
- Real-device mobile/Sync and live publication remain untested. Native integration and the **Copy path** submenu placement use internal Obsidian APIs; see [docs/reference.md](/docs/reference.md).
