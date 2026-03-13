---
date: 2026-03-13
status: abandoned (will retry)
branch: feat/chatgpt-import (deleted)
---

# Lessons learned: importing ChatGPT conversations from clipboard

## What we tried

Clipboard-based import: user copies ChatGPT conversation in browser → Obsidian command parses it → creates markdown note. Used `turndown` (HTML→markdown) + `DOMParser` to read the rich clipboard.

## What worked

- `[ATPATH:BEGIN/END]` markers on copy — trivial, worked perfectly
- Regex stripping of those markers on import — worked
- Modal UI (preview, filename, strip toggle) — worked
- `navigator.clipboard.read()` for HTML, `.readText()` fallback — worked
- Merging consecutive same-role messages — fixed the repeated `## Assistant` headings

## What didn't work

### 1. Turndown produces "loose" markdown lists

ChatGPT wraps each `<li>` content in `<p>`, so turndown outputs blank lines between every list item:

```
*   item one

*   item two
```

We tried regex tightening (`/^([*\-+] .+)\n\n(?=[*\-+] )/gm`) but turndown also leaves trailing whitespace on "blank" lines, so `\n\n` doesn't match `\n   \n`. Reordering the cleanup (strip trailing spaces first) fixed it in unit tests but still didn't produce clean output in practice.

### 2. User messages lose structure

ChatGPT's HTML for user messages doesn't preserve the original line breaks / bullet formatting the user typed. A message with markdown bullet points comes through as a single paragraph. No fix possible on our side — this is a ChatGPT clipboard limitation.

### 3. Turndown escaping

Turndown escapes `_` as `\_`, `*` as `\*` etc. We disabled it with `td.escape = (str) => str`, which fixed it but may break edge cases where escaping is actually needed.

### 4. ChatGPT streaming creates duplicate DOM nodes

ChatGPT's `data-message-author-role` attributes appear on nested elements. Initial approach of converting `div.parentElement` caused 4x duplication. Switching to outermost-only + dedup `Set` fixed it, but the DOM structure varies across ChatGPT UI versions — fragile.

## Key takeaway

The core problem is that ChatGPT's clipboard HTML is not a stable API. The DOM structure, whitespace handling, and user-message representation all vary. A turndown-based approach fights too many formatting battles. Consider instead:

- **Plain text only** — skip HTML entirely, split on "You said:" / "ChatGPT said:" markers. Loses code formatting but is robust.
- **ChatGPT export JSON** — ChatGPT has a data export feature (Settings → Export). The JSON is structured and stable. Much better source than clipboard scraping.
- **Hybrid** — use plain text for structure/roles, then re-wrap obvious code blocks with fences as a post-processing step.
