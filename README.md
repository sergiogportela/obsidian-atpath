# AtPath

Autocomplete and click `@path/to/file` references -- the syntax AI coding tools already use.

## Features

- **@ autocomplete**: type `@` in the editor to open a file picker; inserts an `@path/to/file` reference
- **Clickable links**: `@path/to/file` references become clickable in Live Preview and Reading mode, opening the target file
- **Repo-aware paths**: inside a `_repos/REPO_NAME/` folder, paths are automatically scoped to the repo root (e.g. `@src/main.py` instead of `@_repos/my-project/src/main.py`)
- **Vault-relative fallback**: outside `_repos/`, paths are relative to the vault root
- **Lightweight**: pure JS, no build step, ~180 lines

## How it works

Type `@` in the editor to trigger a file picker. Selecting a file inserts an `@path/to/file` reference at the cursor. In Live Preview and Reading mode, these references are rendered as clickable links that open the target file.

## Repo-aware mode

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

AtPath detects the repo boundary and produces repo-relative paths. Editing `docs/notes.md` and selecting `src/main.py` inserts `@src/main.py` -- matching the paths that tools like Claude Code, Cursor, and Codex expect.

This is entirely optional. Outside `_repos/`, paths are vault-relative as usual.

## Install

**Community Plugins**: search for "AtPath" in Settings > Community Plugins > Browse.

**Manual install**: copy `main.js` and `manifest.json` into your vault at `.obsidian/plugins/atpath/`, then enable "AtPath" in Settings > Community Plugins.

## License

MIT
