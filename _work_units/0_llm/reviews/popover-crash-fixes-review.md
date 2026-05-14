Findings:

- Low: [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2651) reuses the popover DOM when `_popoverBuiltSig === _linkedSig`, but `_linkedSig` is sorted at [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2500). That makes it a set identity, not a render identity. If the user reorders the same `@path` references, or switches to another note with the same target set, the fast path updates counts/checkboxes but leaves rows in the old DOM order. It also keeps the old `sourcePath` captured by the hover listener from the previous slow build at [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2682). Use a separate order-sensitive popover build signature, ideally including the active file path, while keeping the sorted signature for checkbox-selection preservation.

No other in-scope issues found in the three crash-fix changes.

Tests run: `npm test` passed.