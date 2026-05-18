# Verify Plan A execution + diagnose broken drag-and-drop

Verify Plan A (002) executed cleanly and diagnose why drag-and-drop @path inserts from the file explorer are broken.
Drive an interactive Obsidian CLI session with the user: build, reload, capture errors/DOM/console, then propose and verify a fix.
Do not write code until the failure mode is observed and confirmed with the user.

## context

- **What "plan execution" refers to:** Master "Plan A" — @_work_units/improvements/plans/002_plan_statusbar_and_folder_autocomplete.md (status bar overhaul + folder autocomplete + DnD). Drag-and-drop was §3.5 step 12, landed in commit `534e9e1`. The original DnD seed prompt is @_work_units/improvements/prompts/002_include_drag_and_drop.md. Subsequent shipped plans 003-006 are in @_work_units/improvements/plans/; latest is @_work_units/improvements/plans/006_popover_path_alignment.md (commit `e49a454`).

- **The reported bug:** Drag-and-drop @path inserts from the file explorer are *not* inserting. Default is on. The setting toggle "Drag-and-drop @path inserts" lives at @src/main.js:1589 (settings tab UI), default `enableDragDropAtPath: true` at @src/main.js:224. Confirm with the user mid-session: is the toggle on, is the drop into an editor pane (not a non-CM6 surface), is it single-file or multi-select, source = file-explorer leaf (not search/bookmarks/etc.)?

- **DnD architecture — where to look:**
  - CM6 extension factory: @src/main.js:1248 `buildDragDropExtension` (dragover/drop handlers).
  - Path extraction tiers: @src/main.js:1096 `extractDraggedVaultPaths` — Tier 0 reads from `plugin._currentDragRefs` (captured at dragstart) because Obsidian does not expose a stable DataTransfer MIME for internal vault drags.
  - Dragstart DOM sniff: @src/main.js:2269 `dragstart` listener + @src/main.js:1192 `captureDragRefsFromExplorerDom`. Multi-select uses `.is-selected` in the same file-explorer leaf, with `.is-active` as the dragged item — verify these selectors still match in Obsidian 1.12.x.
  - Live re-registration: @src/main.js:2256-2272 — DnD is wrapped in a CM6 `Compartment` so the toggle reconfigures without reload; the compartment is `plugin.dragDropCompartment`.
  - Insertion path: @src/main.js:1244-1273 `drop` handler → `insertAtPathRefs` (50-path cap, Notice on overflow).

- **Diagnosis runbook (canonical):** @AGENTS.md "Testing → Agent diagnosis runbook". Obsidian CLI ≥ 1.12.7, installer ≥ 1.12.x. Per-session attach: `obsidian dev:debug on`. Standard loop: `obsidian dev:errors` → `obsidian dev:console level=error` → `obsidian dev:dom selector='.workspace-leaf-content[data-type=file-explorer] .nav-file.is-active'` → `obsidian eval code='…'` for state probes → after patch, `npm run build && obsidian plugin:reload id=atpath`. Pass `vault=<name-or-id>` since the working dir is the plugin repo, not a vault. Full fallbacks (Logstravaganza, in-plugin dev logger, CDP via `--remote-debugging-port=9222`) listed in @AGENTS.md "Fallbacks". Research backing this: @_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md.

- **DnD-specific probes to use:**
  - Plugin loaded at expected version: `obsidian eval code='app.plugins.plugins.atpath?.manifest?.version'` (expect `1.8.3`).
  - Toggle state: `obsidian eval code='app.plugins.plugins.atpath?.settings?.enableDragDropAtPath'`.
  - Compartment live: `obsidian eval code='!!app.plugins.plugins.atpath?.dragDropCompartment'`.
  - Dragstart capture mid-drag (user must hold drag during eval): `obsidian eval code='JSON.stringify(app.plugins.plugins.atpath?._currentDragRefs)'`.
  - Confirm explorer DOM matches selectors: `obsidian dev:dom selector='.workspace-leaf-content[data-type=file-explorer] .nav-file-title.is-selected' mode=attr`.

- **State of the tree:** Plugin at v1.8.3, branch `main` clean, head `af4fd28` (push at 2026-05-15 12:19). Built `main.js` is committed alongside `src/main.js` — rebuild before reload. 41 unit tests pass via `node --test --require ./tests/_setup.js tests/*.test.js`. DnD is **not** covered by unit tests; landing a regression test is in scope after the fix. STATUS snapshot: @STATUS.md.

- **Repo conventions (must follow):** @CLAUDE.md is a symlink — edit only @AGENTS.md. Compliance rules in @COMMUNITY_PLUGINS.md (no `console.log`, no `innerHTML`/`outerHTML`, never hardcode `.obsidian` — use `this.app.vault.configDir`, all promises awaited/voided, no `var`, sentence-case UI text).

- **User collaboration preferences:** Prefer the simplest reliable fix (clean break, no backwards-compat shims). Verify through the CLI/agent loop with the user live in Obsidian — do not hand back a "manual test plan." When checking Obsidian version, use the running app version, not Info.plist (which reports installer).
