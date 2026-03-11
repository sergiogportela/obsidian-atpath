# Obsidian Community Plugin — Submission & Compliance Guide

This document exists so that coding agents can quickly find what they need to keep this plugin compliant with Obsidian's community plugin requirements. It covers the automated review bot rules, the submission process, and common rejection reasons.

## Current status

- **Plugin ID**: `atpath`
- **Repo**: `sergiogportela/obsidian-atpath`
- **Fork for submissions**: `sergiogportela/obsidian-releases`
- **Submission PR**: https://github.com/obsidianmd/obsidian-releases/pull/10925
- **Previous (closed) PR**: #10391 — auto-closed because it did not use the required PR template

## Known review risks

| Issue | Location | Notes |
|-------|----------|-------|
| Regex lookbehinds | `src/main.js` (`AT_PATH_RE`, live preview regexes) | Not supported on some iOS Safari versions. May be flagged. Refactoring is non-trivial. |
| Bundle size ~2.9 MB | `main.js` (bundles `gpt-tokenizer`) | May draw reviewer attention. The dependency is essential for token counting. |

---

## Automated review bot rules

The bot runs `eslint-plugin-obsidianmd` (28 rules). Issues are **Required** (blocks merge) or **Optional**.

### Required — will fail review

| Rule | What it means |
|------|---------------|
| No `console.log` | Use `console.warn`, `console.error`, or `console.debug` only |
| No `innerHTML` / `outerHTML` | Use DOM API (`createEl`, `setText`, `appendChild`, etc.) — XSS risk |
| No hardcoded `.obsidian` | Use `this.app.vault.configDir` |
| All promises handled | Must `await`, `.catch()`, `.then(_, onRejected)`, or prefix with `void` |
| Async functions must `await` | If a function is `async`, it must contain at least one `await` |
| No `var` | Use `const` or `let` |
| Sentence case for UI text | "Open file" not "Open File" — enforced in JS, TS, JSON locales |
| No default hotkeys | Never assign default keyboard shortcuts to commands |
| No "command" in command ID/name | Don't include "command" in `addCommand()` id or name |
| No plugin ID/name in command ID/name | Don't include plugin ID in command IDs or plugin name in command names |
| Settings headings | Use `new Setting(containerEl).setName(...).setHeading()` not HTML `<h1>`–`<h6>` |
| No `<style>` or `<link>` elements | Use `styles.css` for all styling |
| No inline styles | Use CSS classes instead of `el.style.x = ...` or `style="..."` |

### Optional — reviewer may flag

| Rule | What it means |
|------|---------------|
| Avoid `any` type | Specify proper types |
| Use `instanceof` checks | Instead of type casting (`as TFile`) |
| Avoid regex lookbehinds | Not supported on some iOS versions |
| Use `requestUrl()` | Instead of `fetch()` |
| Use `Vault.process()` | For atomic background file edits (not read+modify+write) |
| Use `normalizePath()` | For user-provided paths |
| Use `FileManager.trashFile()` | Instead of `Vault.trash()` or `Vault.delete()` |
| Use `Platform` API | Instead of `navigator.userAgent` for OS detection |
| No `Object.assign()` with 2 args | Use spread syntax |

---

## Manifest rules

These are enforced by the bot on `manifest.json`:

- `id`: unique, lowercase alphanumeric + dashes, **cannot contain "obsidian"**, **cannot end with "plugin"**
- `name`: **cannot contain "Obsidian"**, cannot end with "Plugin", cannot start with "Obsi" or end with "dian"
- `description`: **cannot contain "Obsidian"** or "This plugin"; **must end with punctuation** (`.` `?` `!` `)`)
- `version`: exact semver `x.y.z` — no `v` prefix
- `minAppVersion`: required
- `author`: required

---

## Release requirements

- GitHub release **tag must match `manifest.json` version** exactly (no `v` prefix)
- Release must contain **individual file assets** (not inside source archives):
  - `main.js` (required)
  - `manifest.json` (required)
  - `styles.css` (optional, but include if it exists)
- `versions.json` must map each version to its `minAppVersion`
- Repository must have **Issues enabled**
- Repository must contain `README.md` and `LICENSE`

---

## Submission process

### Prerequisites

1. A GitHub release that passes all rules above
2. Fork synced: `gh repo sync sergiogportela/obsidian-releases --source obsidianmd/obsidian-releases --branch master`

### Steps

```bash
# 1. Clone fork and create branch
cd /tmp && gh repo clone sergiogportela/obsidian-releases obsidian-releases-submission -- --depth=1
cd obsidian-releases-submission
git checkout -b add-plugin-atpath

# 2. Add entry to END of community-plugins.json:
#    {
#      "id": "atpath",
#      "name": "AtPath",
#      "author": "sergio",
#      "description": "Autocomplete and navigate @path/to/file references.",
#      "repo": "sergiogportela/obsidian-atpath"
#    }

# 3. Commit and push
git add community-plugins.json
git commit -m "Add plugin: AtPath"
git push -u origin add-plugin-atpath

# 4. Create PR using EXACT template (see below)
gh pr create \
  --repo obsidianmd/obsidian-releases \
  --head sergiogportela:add-plugin-atpath \
  --base master \
  --title "Add plugin: AtPath" \
  --body "$(cat <<'PREOF'
<paste the exact PR body template below>
PREOF
)"

# 5. Clean up
rm -rf /tmp/obsidian-releases-submission
```

### Required PR body (exact template)

The bot validates the PR body structurally. It **must** match this template exactly. Check/uncheck items with `[x]` / `[ ]`.

```markdown
# I am submitting a new Community Plugin

- [x] I attest that I have done my best to deliver a high-quality plugin, am proud of the code I have written, and would recommend it to others. I commit to maintaining the plugin and being responsive to bug reports. If I am no longer able to maintain it, I will make reasonable efforts to find a successor maintainer or withdraw the plugin from the directory.

## Repo URL

<!--- Paste a link to your repo here for easy access -->
Link to my plugin: https://github.com/sergiogportela/obsidian-atpath

## Release Checklist
- [x] I have tested the plugin on
  - [x]  Windows
  - [x]  macOS
  - [x]  Linux
  - [ ]  Android _(if applicable)_
  - [ ]  iOS _(if applicable)_
- [x] My GitHub release contains all required files (as individual files, not just in the source.zip / source.tar.gz)
  - [x] `main.js`
  - [x] `manifest.json`
  - [x] `styles.css` _(optional)_
- [x] GitHub release name matches the exact version number specified in my manifest.json (_**Note:** Use the exact version number, don't include a prefix `v`_)
- [x] The `id` in my `manifest.json` matches the `id` in the `community-plugins.json` file.
- [x] My README.md describes the plugin's purpose and provides clear usage instructions.
- [x] I have read the developer policies at https://docs.obsidian.md/Developer+policies, and have assessed my plugin's adherence to these policies.
- [x] I have read the tips in https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines and have self-reviewed my plugin to avoid these common pitfalls.
- [x] I have added a license in the LICENSE file.
- [x] My project respects and is compatible with the original license of any code from other plugins that I'm using.
      I have given proper attribution to these other projects in my `README.md`.
```

---

## After acceptance

1. Announce in [Share & showcase](https://forum.obsidian.md/c/share-showcase/9) on the Obsidian forum
2. Announce in `#updates` on [Obsidian Discord](https://discord.gg/veuWUTm) (requires `developer` role)

---

## Reference links

- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Developer policies](https://docs.obsidian.md/Developer+policies)
- [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- [PR template source](https://github.com/obsidianmd/obsidian-releases/blob/master/.github/PULL_REQUEST_TEMPLATE/plugin.md)
- [eslint-plugin-obsidianmd](https://github.com/obsidianmd/eslint-plugin)
- [obsidian-releases repo](https://github.com/obsidianmd/obsidian-releases)
