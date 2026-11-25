Updated at 2026-11-25 15:25

AtPath 1.10.0 adds GitHub links for use outside a note: **Copy path → as GitHub link** in explorer and tab menus, **Copy GitHub links** for multi-selections, a command for the current file, and the same links as the text payload when dragging explorer items into other apps. It keeps the 1.9.0 repository links, exact local token counts, context copying and desktop file-symlink shortcuts. The [README](/README.md) provides ZIP installation and a visual quick-start; [release notes](/docs/releases/1.10.0.md) describe the release.

## Verified

- 195 Node tests and build pass. GitHub link tests cover files, folders, checkout roots, encoded names, duplicate checkouts, targets without a GitHub origin, and resolution back to the same local target.
- Installed in Obsidian 1.15.1 on macOS with native menus: the real explorer menu shows **as GitHub link** inside **Copy path** for files and folders; clipboard contents matched for file, folder, two-item selection and the command.
- Physical mouse drags: a file and a folder dropped into TextEdit produced their GitHub links; a file dropped into a note still inserted the bullet repository link. With **Drag-and-drop repository links** off, Obsidian's `obsidian://` payload is unchanged.
- From 1.9.0, installed acceptance checked 948 folder totals and exclusion breakdowns against 4,886 indexed files, plus 28 visible explorer badges. Exact counts matched Python tiktoken for 4,423 files; offline same-size/same-timestamp edits invalidate the cache.
- Explorer `*` means excluded folders only; defaults are `90_archive` and `00_llm`. File-symlink shortcuts open original indexed files without duplicating totals.
- Desktop checks cover autocomplete, navigation, native backlinks/graph, whole-link hover, new-tab/split/window menus, copy, rename and preview dialogs.
- The tag-triggered release workflow tests and builds, checks version consistency and committed bundle identity, and packages only main.js, manifest.json and styles.css in an atpath folder. It does not overwrite existing releases.

## Verification limits

- Drag-out was tested only on macOS with TextEdit as the target; multi-selection drags were checked through dispatched events, not a physical drag. Popout windows are not covered by the drag listeners.
- Real-device mobile/Sync and live publication remain untested. Native integration and the **Copy path** submenu placement use internal Obsidian APIs; see [docs/reference.md](/docs/reference.md).
