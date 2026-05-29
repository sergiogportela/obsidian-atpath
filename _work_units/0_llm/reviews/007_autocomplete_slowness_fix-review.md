**Findings**

- **P2** [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:540): the debounce timer is only cleared by the next `getSuggestions()` call. If the trigger disappears before the 100ms fires, for example the user types a space after `@path` so `onTrigger()` returns `null` at [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:528), the pending timer still runs `_computeSuggestions(context)` against the large vault. That preserves one expensive autocomplete scan after the suggest UI has already been dismissed, causing the same kind of editor jank this change is meant to remove. It can also feed stale results into Obsidian’s async suggestion continuation because the promise still resolves while the editor remains focused. Clear/cancel the timer when the suggest closes or when `onTrigger()` returns `null`, ideally resolving superseded work with `null` plus a generation check rather than leaving stale work alive.

- **P3** [STATUS.md](/Users/sergio/Documents/code/obsidian_plugin_atpath/STATUS.md:18): the status snapshot still says Plan 007 is “working tree” and “not yet committed”, and [STATUS.md](/Users/sergio/Documents/code/obsidian_plugin_atpath/STATUS.md:30) still lists “Commit Plan 007” as open. That is false for commit `2d23bd1` and violates the repo’s STATUS.md contract to keep shipped-plan state factual.

**Open Questions**

- None.

**Verification**

- Ran `node --test --require ./tests/_setup.js tests/*.test.js`: 57/57 passing.