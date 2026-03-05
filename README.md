# AtPath

Autocomplete and click `@path/to/file` references -- the syntax AI coding tools already use.

## Features

### @ Autocomplete
Type `@` in the editor to open a file picker. Selecting a file inserts an `@path/to/file` reference at the cursor.

### Clickable Links
`@path/to/file` references become clickable in both Live Preview and Reading mode, opening the target file inside Obsidian. Right-click any link to open it in your system's default app instead.

### Token Counts
See at a glance how large each referenced file is in LLM tokens:

- **Inline badges**: each `@path` renders with a dimmed token count, e.g. `@src/main.py (1.2k)`
- **Status bar total**: the bottom bar shows `Tokens: 16.4k` -- the combined count of the current note plus all its `@path` references
- **Hover breakdown**: hover the status bar to see a tooltip with the split: `Note: 2.1k / @paths (7): 14.3k / Total: 16.4k`
- Works in both Live Preview and Reading mode
- Counts update automatically when files are edited

Token counts use GPT-4o's tokenizer as a proxy (works as a reasonable estimate for Claude and other models too).

### Repo-Aware Paths
Inside a `_repos/REPO_NAME/` folder, paths are automatically scoped to the repo root. Editing `docs/notes.md` and selecting `src/main.py` inserts `@src/main.py` -- matching the paths that tools like Claude Code, Cursor, and Codex expect.

### Automatic Reference Updates
When you rename or move a file, all `@path` references pointing to it are updated across the vault.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Show token counts | On | Toggle inline badges and the status bar total |
| Max file size (MB) | 5 | Skip token counting for files larger than this |

## Repo-Aware Mode

If you symlink code repositories into a `_repos/` folder in your vault:

```
vault/
  _repos/
    my-project/     <-- symlinked repo
      src/
        main.py
      docs/
        notes.md
```

AtPath detects the repo boundary and produces repo-relative paths. This is entirely optional. Outside `_repos/`, paths are vault-relative as usual.

## Install

**Community Plugins**: search for "AtPath" in Settings > Community Plugins > Browse.

**Manual install**: copy `main.js`, `manifest.json`, and `styles.css` into your vault at `.obsidian/plugins/atpath/`, then enable "AtPath" in Settings > Community Plugins.

## License

MIT
