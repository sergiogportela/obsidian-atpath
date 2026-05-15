# Research — Accessing Obsidian logs / dev console for agent-driven diagnosis

**Date:** 2026-05-15
**Triggered by:** Plan 005/006 post-mortem feedback. Manually pasting DevTools
console output has been slow and error-prone; the user asked us to find the
simplest reliable way for the agent to read Obsidian's runtime state
(logs, errors, DOM, plugin state) without DevTools hand-driving.
**Method:** three parallel Perplexity-grounded research agents (CLI question,
log access question, automated testing question), 2024–2026 recency filter.

## TL;DR — what to actually do

Adopt the **official Obsidian CLI** (shipped Feb 2026, generally available
in 1.12.4+; current docs require 1.12.7+ installer). It is exactly the
workflow Obsidian designed for AI agents and it removes every pain point
the user named.

User-side one-time setup (~2 min):

1. Upgrade Obsidian to **1.12.7 or newer**.
2. `Settings → General → Command line interface` → enable + register
   (places `/usr/local/bin/obsidian` on macOS).

After that, the agent can run from its own shell:

| Command | Purpose |
|---|---|
| `obsidian plugin:reload id=atpath` | Hot-reload plugin after `npm run build` — no app restart |
| `obsidian dev:errors` | Read any plugin/runtime errors since launch |
| `obsidian dev:console level=error` | Stream/read recent console output (filterable by level) |
| `obsidian eval code="app.plugins.plugins.atpath.foo"` | Introspect live plugin state, run probes |
| `obsidian dev:screenshot path=/tmp/x.png` | Visual confirmation of UI state |
| `obsidian dev:dom selector=".atpath-…"` | DOM inspection for layout/CSS bugs (e.g. Plan 006 popover alignment) |

**Two operational constraints** (per `https://obsidian.md/help/cli`):

1. **Obsidian must be running** for the CLI to do anything — the CLI is a
   remote control over IPC, not a headless server. If the app isn't open,
   it auto-launches (slow on a cold start).
2. **Vault targeting matters.** Vault-scoped commands (everything except
   pure app-level commands) operate on the *currently active vault* by
   default. Since the agent runs from the plugin repo, not from the vault
   directory, the agent should pass `vault=<name-or-id>` explicitly for
   any vault-scoped command — otherwise the first diagnosis session may
   silently target the wrong vault or fail. Example:
   `obsidian plugin:reload id=atpath vault=my-vault-name`.

Zero plugin-code changes. Native to Obsidian. Survives Obsidian updates
because it is first-party.

If the user cannot or will not upgrade, the fallbacks are below.

## Fallback ranking (if the official CLI is unavailable)

1. **Logstravaganza** community plugin (`czottmann/obsidian-logstravaganza`,
   v2.3.0 Nov 2025). Three-click install. Writes NDJSON / md to the vault,
   `tail -F` from agent side. Captures all of Obsidian's console (not just
   AtPath) — filter by message prefix if needed.
2. **DIY in-plugin logger** (~15 LOC; pattern from
   `liamcain` gist). Writes only AtPath's own log statements to a path
   under the plugin's data directory, scoped to our plugin. Best
   filtering. Two constraints if we pick this route:
   - **No hardcoded `.obsidian`** (community-plugin rule, enforced by
     `eslint-plugin-obsidianmd` and called out in `AGENTS.md`). Derive
     the directory from `this.app.vault.configDir` —
     e.g. ``${this.app.vault.configDir}/plugins/atpath/dev-logs.txt``.
   - **Dev-only.** Gate behind a build flag so we don't ship console
     monkey-patching to community-plugins reviewers.
3. **`--remote-debugging-port=9222` + CDP**. Launch Obsidian with
   `open -a Obsidian --args --remote-debugging-port=9222`, attach via
   Playwright `chromium.connectOverCDP` or
   [`obsidian-cdp-mcp` npm package, v1.9.2 Dec 2025]. Works on any version,
   gives live console / DOM / screenshots. Heavier setup; app must be
   relaunched with the flag.

Not viable: **native log files** — Obsidian writes no general console log
to disk by default. Forum feature requests for this have been open since
2022.

## Automated end-to-end testing — separate question, separate answer

The user asked whether the agent could "test things out by itself." Real
answer for AtPath today:

- **Unit tests on extracted logic** (parser, fuzzy match, link resolution)
  — already in place via `tests/*.test.js`, 41 passing. This is what every
  serious Obsidian plugin does and covers ~80% of bug surface with zero
  Obsidian dependency. **Keep investing here.**
- **Agent-driven CDP smoke tests** via Playwright + the official CLI
  `eval`/`dev:screenshot` — feasible *now* without new test infrastructure.
  Good for ~5–10 critical UI smoke checks; brittle past that.
- **Full E2E via `wdio-obsidian-service`** (jesse-r-s-hines, latest
  `3.0.2` published 2026-03-29; v2.0.0 with mobile support published
  2025-08-03; listed in WDIO docs as 3rd-party service). Mature. Real
  time investment — test vaults, page objects, CI tuning. **Not
  justified for AtPath today** given the unit-test coverage we have.
  Revisit if manual regressions become recurrent.

Per a Nov 2025 forum post by an active plugin author: even with
`wdio-obsidian-service` available, *"in reality there are still just a few
plugin repositories doing some sort of E2E-testing"*. Industry default is
unit + manual E2E. We match that.

## Recommendation, in one paragraph

**Adopt the official Obsidian CLI as the agent's diagnosis channel.** It
gives us console reads, error reads, plugin reload, eval, screenshots, and
DOM inspection — every pain point the user named — with zero plugin code,
no over-engineering, and a vendor-supported lifecycle. Keep the existing
unit-test suite as the regression backstop. Do **not** add an E2E test
framework until manual regressions justify it.

## Open follow-ups (for status doc)

- Confirm with user: is their Obsidian on 1.12.7+? If not, decide between
  (a) upgrade and use CLI, or (b) install Logstravaganza, or (c) DIY
  in-plugin logger for the AtPath dev build.
- Once channel is picked, draft a thin "agent diagnosis runbook" in
  `AGENTS.md` (e.g. "when a UI regression is reported, run
  `obsidian dev:errors` and `obsidian dev:console level=error` first").
- Decide whether to keep `gpt-tokenizer`-sized bundles when adding any
  dev-only logger (we already commit a ~2.9 MB `main.js`; the dev-only
  logger would not ship to the release build either way).

## Sources

Consolidated, deduplicated across the three research agents. Each was
verified to be 2024–2026 unless otherwise noted.

### Official Obsidian CLI
- https://obsidian.md/cli — landing page
- https://obsidian.md/help/cli — official docs
- https://dev.to/shimo4228/obsidians-official-cli-is-here-no-more-hacking-your-vault-from-the-back-door-3123 — release context (Feb 2026)
- https://github.com/kepano/obsidian-skills — kepano's published develop/test workflow using the CLI
- https://forum.obsidian.md/t/can-someone-tl-dr-the-new-cli-for-me/111973

### Log access (file-based)
- https://github.com/czottmann/obsidian-logstravaganza — primary recommendation (v2.3.0, Nov 2025)
- https://gist.github.com/liamcain/3f21f1ee820cb30f18050d2f3ad85f3f — DIY logger pattern
- https://forum.obsidian.md/t/persist-log-files-for-debugging/42286 — confirms no native log file

### Remote debugging (CDP)
- https://libraries.io/npm/obsidian-cdp-mcp — `obsidian-cdp-mcp` MCP server (v1.9.2 Dec 2025)
- https://skilld.dev/skills/zpankz/mcp-skillset/obsidian-devtools — agent skill (Jan 2026)
- https://github.com/electron/electron/issues/3331 — Electron remote-debugging-port reference

### E2E testing
- https://github.com/jesse-r-s-hines/wdio-obsidian-service — primary E2E option (mature, latest `3.0.2` 2026-03-29)
- https://webdriver.io/docs/wdio-obsidian-service/ — official WDIO docs entry
- https://forum.obsidian.md/t/e2e-testing-of-plugins-with-webdriverio/107493 — Nov 2025 community context
- https://www.npmjs.com/package/obsidian-testing-framework — Playwright-based alternative (Oct 2024)
