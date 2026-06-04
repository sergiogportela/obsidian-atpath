**Findings**

P1: The null-cache safety check is wrong. The plan says `{ tokens: null }` is safe, but several cache readers only check `if (cached)` and then call `formatTokens(cached.tokens)`: [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:911), [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:1050), [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:1281), [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:1440). A sniffed binary file can later render a `"null"` token badge. Either avoid null-caching or update every token-cache consumer to treat `cached.tokens == null` as “no count”.

P1: The expanded denylist is not only a fast path. Because the extension check runs before sniffing, every added extension becomes an unconditional behavior change. In particular, adding generic `raw` in [002_binary_sniff_fix.md](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/atpath_codeblock_freeze/plans/002_binary_sniff_fix.md:133) can drop token counts for a real text `*.raw` file, violating the WU rule that real text files stay byte-identical. Keep denylist additions to unambiguous formats such as `heic`/`heif`, or let ambiguous extensions pass through the content sniff.

P2: Part B should not reuse the existing over-cap sentinel unchanged. A byte-budget trip is not a max-files trip, but current UI titles say “Skipped: over the configured max-files limit” at [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2865) and [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2925), while the count renderer shows `> N files`. If Part B ships, the sentinel needs a reason field or a distinct shape, plus renderer/title copy updates.

P2: The new `maxFolderBytes` setting needs explicit memo invalidation. Changing it alters `getFolderTokens` results, so its settings handler must clear folder memo, mark token cache dirty, and schedule refresh like `maxFolderFiles` does at [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:1521). The plan only says to register the setting.

P2: The sniff guarantee is overstated. `looksBinary()` can false-positive real text with NUL-heavy encodings such as UTF-16/UTF-32, ANSI/control-heavy logs, or very small files with one control char; it can also false-negative a binary with an ASCII preamble longer than 4096 chars. That does not invalidate the HEIC fix, but the plan should narrow the “real text byte-identical” claim or add fixtures/logic for these cases.

**Recommendation**

Ship Part A only after fixing the null-cache and denylist issues. Defer Part B unless the byte-budget UI semantics, setting invalidation, and default are resolved; it is not required for the measured HEIC freeze.

Tests run: `node --test --require ./tests/_setup.js tests/*.test.js` passed, 57/57.