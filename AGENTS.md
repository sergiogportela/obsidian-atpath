# AtPath — Obsidian Plugin

## Project structure

- `main.js` — built plugin (committed directly, no build step)
- `manifest.json` — plugin metadata and version
- `package.json` — npm metadata and version
- `versions.json` — Obsidian min-app-version mapping per release
- `styles.css` — plugin styles
- `.github/workflows/release.yml` — automated release workflow

## Releasing a new version

1. Bump `version` in **both** `manifest.json` and `package.json`
2. Add the new version entry to `versions.json`
3. Commit and push to `main`
4. Create and push a tag matching the version:
   ```
   git tag X.Y.Z && git push origin X.Y.Z
   ```
5. The workflow creates a GitHub release and uploads `main.js`, `manifest.json`, and `styles.css` as assets

**Do NOT** create the release via the GitHub UI — the workflow handles it. If a release already exists for the tag, the workflow deletes and recreates it.

## Versioning

- `manifest.json` and `package.json` must have the **same** version
- `versions.json` maps each plugin version to its minimum Obsidian app version
- Tags must match the version string exactly (e.g. `1.2.0`, not `v1.2.0`)
