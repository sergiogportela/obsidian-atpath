Updated at 2026-11-05 18:50

Repository-link migration is implemented on `codex/repository-link-migration`; `main` and the installed plugin are unchanged. The branch builds successfully with 137 passing Node tests. Independent Claude review and native editor acceptance are in progress. No version bump, tag, release, deployment or Sync upload occurred.

## Implemented

- Canonical Markdown authoring through `[[` and drag/drop; innermost Git-root resolution and GitHub-origin mapping use current local files regardless of URL ref. Missing or ambiguous targets remain explicit.
- Shared JavaScript/Python conformance fixtures accompany AgentKit migration in its own task branch.
- An isolated native metadata bridge supplies repository-aware backlinks and graph references without changing note text. The detached Obsidian 1.15 desktop probe passed 12 lifecycle checks, including exact native Backlinks snippets, local/global graph input, source/target moves, shared hash-cache isolation and unload/reload.
- Approximate counts use characters / 4 with incremental folder aggregation, prioritized background reads and a device-local IndexedDB cache. Explorer badge DOM tests cover visibility, scroll priority, refresh and cleanup.
- Copy/publish resolve destinations and deduplicate overlapping targets. Publishing rewrites included links by local path while preserving the Markdown download. SHA destinations remain unchanged during automatic rename.
- Desktop writes a separate personal repository map; mobile consumes it. Explicit unindexed file handling and authenticated desktop rename lookup are included.

## Acceptance remaining

- Independent review, native editor runtime smoke and final fixes.
- Installed-plugin desktop UI, real native File Explorer, mobile device, full app restart and Sync acceptance. Detached native views and browser DOM tests do not establish these outcomes.
- User approval before installing into the working vault, changing its configuration or uploading/publishing content. Keep migration changes off `main` until authorized.

Prior released state and shelved explorer implementation are documented in Git history at `d636fe5`. Legacy references remain readable; the migration preview makes no automatic vault-wide changes. See [README.md](/README.md) for the new contract and limitations.
