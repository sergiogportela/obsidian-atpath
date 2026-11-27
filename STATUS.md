Updated at 2026-11-27 14:41

AtPath 1.11.1 fixes unnecessary destination rewrites when repositories move: links that still resolve to their intended target retain their exact authored text, and unchanged notes are not written. The build is installed in the colm-workspace vault; release notes: [1.11.1](/docs/releases/1.11.1.md). The previous table protections and other features remain described in [1.11.0](/docs/releases/1.11.0.md) and the [reference](/docs/reference.md).

## Verified

- All 250 Node tests pass. Six new regressions cover whole-checkout moves, incoming GitHub links and aliases, nested repositories, cross-repository moves, same-name targets in different repositories, and zero writes for unchanged notes.
- The production change reuses the existing resolver to compare the current destination with the intended moved target before formatting a replacement. Genuine renames, chronological move batches, concurrent edits and historical SHA behavior retain their coverage.
- Build passes and the generated bundle is installed as 1.11.1 in Obsidian 1.15.1 on macOS.
- Live FileManager archive move: all seven fixture files kept their exact bytes and modification times; zero modify events; all nine links resolved. A nested repository and an external incoming link were included.
- Live source move between repositories followed by an accented target rename: required destinations changed, all nine links resolved, and labels, titles and suffixes were preserved. A same-path file in the destination repository did not replace the intended target.
- Read-only replay of the reported move preserves the original contents of all five affected files. All 97 Markdown files in the user's archived work unit remain unchanged by this task. Temporary runtime fixtures were removed; no runtime errors were captured.
- Release workflow verifies version consistency, tests, builds and checks the committed bundle before publishing the three plugin files and installable ZIP.

## Verification limits

- This fix was tested on macOS desktop; mobile and other operating systems were not tested. Native integration uses internal Obsidian APIs.
- Existing encoded destinations are not automatically restored. Native wikilinks and embeds remain subject to Obsidian's own automatic link updates.
- Table guard gaps and compatibility limits remain documented in [the reference](/docs/reference.md#tables-in-live-preview).
