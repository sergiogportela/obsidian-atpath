**Findings**

- P3: [src/atpath-core.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/atpath-core.js:127) says `>4096-char ASCII preambles` degrade safely to “no count”, but [tests/binary-sniff.test.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/tests/binary-sniff.test.js:57) documents the opposite: a binary with a clean first 4096 chars returns `false` and still reaches `encode()`. The implementation matches the plan’s accepted false-negative, so this is a comment bug. Narrow the comment so future changes do not assume that case is skipped.

No blocking implementation issues found. The Part A shape matches the plan: `getTokenCount` is the choke point, null skips are not cached, the denylist additions are limited, and regexes are untouched.

Tests run:
- `node --test --require ./tests/_setup.js tests/*.test.js` passed, 76/76.
- `npm run build` passed.