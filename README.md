<div align="center">

# AtPath

**Write repository-aware Markdown links, open the local checkout, and see approximate context sizes beside links and files.**

Autocomplete, click-to-open, token counting, one-click publish to the web, and cross-repo support.

[![GitHub release](https://img.shields.io/github/v/release/sergiogportela/obsidian-atpath?style=flat-square)](https://github.com/sergiogportela/obsidian-atpath/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

The repository-link migration is an unreleased 1.9.0 task-branch build for Obsidian 1.15 or newer. Screenshots below show the previous released UI.

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

Native Outgoing Links shows canonical destinations and navigates local files, including headings. If a note mixes a repository Markdown link with a native wikilink/embed using identical destination text, the repository row can display an internal key; the bridge preserves the native reference's original resolution in that ambiguous case.

Existing `@path` and AtPath wikilink references remain readable during migration. New authoring uses Markdown. The legacy-link preview identifies candidates without rewriting the vault automatically.

### Clickable Links

Click a repository link in Live Preview or Reading mode to open the local file, or reveal a folder. The desktop context menu can open the target in the default external application.

### Token Counts

Approximate counts appear beside links, visible File Explorer rows, and in the desktop status bar. Folder totals update incrementally; pending or skipped content is identified. Click the status bar to copy the note and its linked content.

The estimate is `ceil(character count / 4)`, marked `~`. **JSON and CSV can require nearly three times the displayed count.** An independent 482-file workspace calibration against `o200k_base` found per-file errors from **−65.7% to +95.8%**, with the combined estimate **19% too low**. Negative errors mean an underestimate:

| Content | Files | Minimum error | Median error | Maximum error |
| --- | ---: | ---: | ---: | ---: |
| Markdown | 120 | −40.6% | −9.3% | +95.8% |
| Python | 120 | −28.3% | −3.8% | +35.2% |
| JSON | 120 | −55.6% | −25.8% | +50.2% |
| SQL | 50 | −35.0% | −10.0% | +59.3% |
| YML | 20 | −42.5% | −18.5% | +57.7% |
| YAML | 1 | −26.7% | −26.7% | −26.7% |
| CSV | 30 | −65.7% | −47.1% | +7.8% |
| JavaScript | 21 | −35.9% | −4.5% | +9.1% |

These are observed samples, not guaranteed bounds for other files or models; Claude tokenizers were not tested. At the −65.7% extreme, the actual count is about 2.9 times the estimate. The estimate formula remains unchanged: this sample does not establish a correction that works for every content mix. Use a model's actual tokenizer for hard context limits. Counts exclude model instructions and message history. Content reads run through a yielding queue, and validated file snapshots persist in device-local IndexedDB rather than synced settings.

<p align="center">
  <img src="screenshots/status-bar.png" width="500" alt="Status bar showing total token count with tooltip breakdown" />
</p>

### Copy note and linked contents

Copy the current editor buffer with referenced text files appended in fenced blocks. Folder references expand recursively, with file-size/count limits and skipped-file reporting. Overlapping file and folder references are deduplicated by local target path.

Counting, copy and linked-page collection exclude generated directories, Git/plugin metadata, binary content and sensitive filenames such as `.env`, private keys and `credentials.json`. Native indexed descendants define folder scope; explicitly linked eligible files outside the index are handled individually. AtPath's configurable defaults are 5 MB per file and 500 candidates per folder. AgentKit uses stricter dispatch limits of 1 MB per file, 100 files and 10 MB total; an AtPath estimate does not override those limits.

### Publish to Vercel

Deploy notes and standalone HTML apps to Vercel with one click. Notes can publish linked local content, while `.html` files in the File Explorer can publish either as a single-file app or as a whole folder-based static site. Included repository links are rewritten to their published pages by resolved target, independently of their display labels; the downloadable Markdown remains the original source.

The linked-page preview includes every eligible resolved local file linked from the main note, including ordinary Markdown links. Review that list before confirming publication. Links to local content excluded from the publication become inert text in the generated page.

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

The map also records local branches, tags and every remote's branches to disambiguate GitHub URL paths; remote HEAD pointers are omitted. It should be excluded from Git. Discovery skips every dot-directory and `data`, `node_modules`, `venv`, `dist`, `build`, `__pycache__` at every depth, and does not follow directory symlinks. Opening a note in such a tree verifies and adds only that exact checkout, without scanning its excluded descendants or siblings. Unverified desktop sources or unmapped mobile sources report a diagnostic instead of inheriting the wrong repository root.

AtPath retains verified opened checkouts in its personal map. AgentKit's fresh discovery adds only its current prompt source, so previously opened hidden checkouts can make AtPath's map differ from a fresh AgentKit inventory. Shared discovery fixtures cover the normal scan and current explicit source, not this retained history.

Use **Refresh repository map** after changes made outside Obsidian. Authenticated desktop GitHub rename lookup uses `gh` for unresolved names within known workspace organizations; it never downloads file content. URLs with an ambiguous slash-containing revision require a known ref boundary or explicit encoding and produce a diagnostic rather than a guessed path.

### Auto-Update References

AtPath updates repository links for file/folder moves performed through Obsidian, including source notes moved between repositories. Intentional commit-SHA destinations remain unchanged. Moving an entire checkout updates its map location instead of rewriting canonical references.

Pending moves are processed in order in one vault pass, including chained moves and swaps. Each note is parsed once unless it changes before the atomic update; concurrent edits are preserved. Legacy reference repair shares that pass. A failed note does not prevent other notes from updating, and a persistent notice identifies notes with incomplete updates. Checkout-root moves require a freshly verified repository map before any rewrite.

Only destinations change: existing labels, link titles, reference definitions, autolink syntax and non-main refs are preserved.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Show token counts | On | Approximate inline, explorer and status-bar counts |
| Max file size (MB) | 5 | Skip larger linked files when counting, copying or publishing |
| Max files per folder reference | 500 | Limit recursive folder expansion and its estimate by the number of indexed candidates before reading content |
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
