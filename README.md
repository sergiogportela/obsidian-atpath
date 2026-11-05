<div align="center">

# AtPath

**Write repository-aware Markdown links, open the local checkout, and see approximate context sizes beside links and files.**

Autocomplete, click-to-open, token counting, one-click publish to the web, and cross-repo support.

[![GitHub release](https://img.shields.io/github/v/release/sergiogportela/obsidian-atpath?style=flat-square)](https://github.com/sergiogportela/obsidian-atpath/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

<p align="center">
  <img src="screenshots/atpath-links.png" width="600" alt="@path references rendered as clickable links with token counts" />
</p>

## Features

### Markdown autocomplete

Disable **Use Wikilinks**, type `[[`, and pick a file or folder. Files in the current repository rank first. AtPath inserts the destination and full path label together:

```markdown
[src/example.py](/src/example.py)
[other_repo/src/example.py](https://github.com/owner/other_repo/blob/main/src/example.py)
[other_repo/docs/](https://github.com/owner/other_repo/tree/main/docs/)
```

The containing note's innermost Git checkout defines `/`. Cross-repository links match Git origins, not local folder names. Opening, copying and counting always use local working files, regardless of the URL revision or checkout branch. A missing or ambiguous target produces a diagnostic; AtPath never switches branches or substitutes downloaded content.

<p align="center">
  <img src="screenshots/autocomplete.png" width="350" alt="Autocomplete dropdown showing file suggestions" />
</p>

### Native backlinks and graph

An isolated compatibility layer supplies repository-aware references to Obsidian's native metadata index. It leaves note text unchanged and restores native resolution on unload. Desktop tests against Obsidian 1.15 verified backlink source passages and local/global graph inputs, including identical filenames in nested repositories. This uses internal APIs and checks their availability at runtime; mobile and full installed-plugin UI acceptance remain pending on this task branch.

Existing `@path` and AtPath wikilink references remain readable during migration. New authoring uses Markdown. The legacy-link preview identifies candidates without rewriting the vault automatically.

### Clickable Links

Click a repository link in Live Preview or Reading mode to open the local file, or reveal a folder. The desktop context menu can open the target in the default external application.

### Token Counts

Approximate counts appear beside links, visible File Explorer rows, and in the desktop status bar. Folder totals update incrementally; pending or skipped content is identified. Click the status bar to copy the note and its linked content.

The estimate is `ceil(character count / 4)`, marked `~`. A 62-file Markdown/Python/JavaScript calibration against the GPT-4o tokenizer observed per-file errors from −20.5% to +17.8%; this is a sample, not an error guarantee for other text or models. Counts exclude model instructions and message history. Content reads run through a yielding queue, and validated file snapshots persist in device-local IndexedDB rather than synced settings.

<p align="center">
  <img src="screenshots/status-bar.png" width="500" alt="Status bar showing total token count with tooltip breakdown" />
</p>

### Copy note and linked contents

Copy the current editor buffer with referenced text files appended in fenced blocks. Folder references expand recursively, with file-size/count limits and skipped-file reporting. Overlapping file and folder references are deduplicated by local target path.

### Publish to Vercel

Deploy notes and standalone HTML apps to Vercel with one click. Notes can publish linked local content, while `.html` files in the File Explorer can publish either as a single-file app or as a whole folder-based static site. Included repository links are rewritten to their published pages by resolved target, independently of their display labels; the downloadable Markdown remains the original source.

Private publishing is supported through Clerk, and the publish flow also stores a reusable site icon so your deployed pages can show a favicon in browser tabs without asking every time.

Before publishing, the confirmation modal shows the target domain, current publish state, linked notes when relevant, and the main publish options for that content type.

<p align="center">
  <img src="screenshots/publish-confirm.png" width="500" alt="Publish confirmation modal showing domain, linked notes, and compact toggle" />
</p>

After deploying, a result modal gives you the URL with **Copy** and **Open in browser** buttons.

<p align="center">
  <img src="screenshots/publish-result.png" width="500" alt="Publish result modal with URL, Copy and Open buttons" />
</p>

Published pages include collapsible sections, foldable bold list items, inlined local images, a download button, and a configurable contact button.

### Cross-Repo References

Desktop discovery builds `repository-map.json` with vault-relative checkout roots and normalized GitHub identities. A mobile device consumes the synchronized map without needing `.git`. Configure the map's Sync coverage separately; excluded content remains unavailable on that device. The map contains no publishing credentials and describes one person's checkout layout.

Use **Refresh repository map** after changes made outside Obsidian. Authenticated desktop GitHub rename lookup uses `gh` for unresolved names within known workspace organizations; it never downloads file content. URLs with an ambiguous slash-containing revision require a known ref boundary or explicit encoding and produce a diagnostic rather than a guessed path.

### Auto-Update References

AtPath updates repository links for file/folder moves performed through Obsidian, including source notes moved between repositories. Intentional commit-SHA destinations remain unchanged. Moving an entire checkout updates its map location instead of rewriting canonical references.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Show token counts | On | Approximate inline, explorer and status-bar counts |
| Max file size (MB) | 5 | Skip token counting above this |
| Max files per folder reference | 500 | Limit recursive folder expansion for copying |
| Folder encode batch size | 1 | Lower = smoother UI but slower folder counts |
| Show selection tokens in status bar | On | When text is selected, status bar shows `Sel: <selected> / <total>` |
| Suggest folders in autocomplete | On | Include folders in `[[` suggestions |
| Drag-and-drop link inserts | On | Insert a canonical Markdown link when dragging a file/folder |
| Vercel API token | — | For one-click publishing |
| Contact URL | — | Button link on published pages |
| Contact button label | Entre em contato | Button text |
| Site icon | — | Reusable favicon for published notes and HTML apps |
| Clerk publishable key | — | Required for private publishing |
| Clerk secret key | — | Required for private publishing |
| Publisher email | — | Used in private access requests |

## Install

- **Community Plugins** — in Obsidian, open `Settings` -> `Community plugins` -> `Browse`, search for `AtPath`, install, then enable
- **BRAT** — install `BRAT` from Obsidian Community Plugins, open `Settings` -> `BRAT`, choose `Add beta plugin`, enter `https://github.com/sergiogportela/obsidian-atpath`, then enable `AtPath`
- **Release zip** — download `atpath-x.y.z.zip` from the latest release, extract it into `.obsidian/plugins/` so it creates `.obsidian/plugins/atpath/`, then enable or reload the plugin
- **Manual** — copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/atpath/`, then enable or reload the plugin

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

## License

MIT
