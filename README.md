# AtPath

Autocomplete and click `@path/to/file` references in Obsidian — the same `@path` syntax used by AI coding tools (Claude Code, Cursor, Codex).

![image|500](https://storage.googleapis.com/obsidian-images-sergio-public/a251878152226958e89f39bb30a14ab0.png)
auto complete:
![image|300](https://storage.googleapis.com/obsidian-images-sergio-public/abc481cbe93ecb4462307fdde82adb76.png)

status bar: 
![image|400](https://storage.googleapis.com/obsidian-images-sergio-public/67468e0340d947daba90bb5798134dc5.png)
## Features

- **@ autocomplete**: type `@` → pick a file → inserts `@path/to/file`
- **Clickable links**: click `@path` in Live Preview/Reading to open the file (right-click → open externally)
- **Token counts**:
	- inline: `@src/main.py (1.2k)`
	- status bar total: `Tokens: 16.4k` (note + all `@paths`)
	- hover breakdown: `Note / @paths / Total`
	- updates automatically as files change  
	- _Uses GPT-4o tokenizer as an estimate._
- **Copy note + @path contents** (ready to paste into any web LLM):
	- command: **Copy note with @path contents to clipboard** (bind a hotkey)
	- or click the status bar token total
	- appends each file under `## @path` in fenced code blocks
	- dedupes repeated refs, skips binaries
	- shows a notice for any unresolved paths (still copies the rest)
- **Publish to Vercel**: deploy any note as a styled dark-themed web page
	- command: **Publish current note to Vercel** (or click "Publish" in status bar)
	- `@path` references become linked sub-pages with back-navigation
	- collapsible sections (h2–h4) and foldable bold list items
	- local images inlined as base64 (fully self-contained)
	- "Baixar .md" download button + configurable contact button on every page
	- one Vercel project per note (domain = slugified title, e.g. `my-note.vercel.app`)
- **Repo-aware paths (optional)**: inside `_repos/REPO/`, inserts repo-relative paths (e.g. `@src/main.py`)
- **Auto-update refs**: renames/moves update all `@path` references across the vault

## Settings

| Setting | Default | Description |
|--------|---------|-------------|
| Show token counts | On | Inline + status bar |
| Max file size (MB) | 5 | Skip counting above this |
| Vercel API token | — | Personal access token for publishing |
| Contact URL | — | Link for contact button (e.g. WhatsApp) |
| Contact button label | Entre em contato | Text on the contact button |

## Repo-aware mode (optional)

Symlink repos under `_repos/`:

```text
vault/_repos/my-project/...
````

Inside a repo, AtPath emits repo-relative paths; elsewhere it uses vault-relative paths.

## Install

- **Community Plugins**: search “AtPath”
    
- **Manual**: copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/atpath/`, then enable
    

## License

MIT