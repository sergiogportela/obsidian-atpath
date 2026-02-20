# obsidian-atpath

Autocomplete and navigate `@path/to/file` references in Obsidian.

Designed for prompts that use `@path` syntax (Claude Code, Codex, etc.) inside repos symlinked into the vault via `_repos/`.

## Features

- **Autocomplete**: type `@` to get a file picker scoped to the current repo
- **Repo-relative paths**: inserts `@src/main.py` not `@_repos/myrepo/src/main.py`
- **Clickable links**: `@path` references are clickable in Live Preview and Reading mode
- **Repo-aware**: detects repo root via `_repos/REPO_NAME/` pattern; falls back to vault-relative paths outside repos

## Path logic

```
File being edited:  vault/_repos/my-project/docs/prompt.md
Repo root:          vault/_repos/my-project/
Target file:        vault/_repos/my-project/src/main.py
Inserted text:      @src/main.py          (repo-relative)
Click resolves to:  _repos/my-project/src/main.py  (vault path)
```

## Install

Symlink into your vault's plugins directory:

```bash
ln -s /path/to/obsidian_plugin_atpath /path/to/vault/.obsidian/plugins/obsidian-atpath
```

Then enable "AtPath" in Obsidian Settings > Community Plugins.

## License

MIT
