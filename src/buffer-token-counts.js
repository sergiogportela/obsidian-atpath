"use strict";

// Keep just the current editor snapshot, with independent generations for
// document and selection. Selection changes must not retokenize the document.
function f_createBufferTokenCounts({ count, onChange, onError, delay = 80 }) {
  const doc = { generation: 0, tokens: null };
  const selection = { generation: 0, tokens: 0 };
  let disposed = false;

  function f_update(part, texts, key) {
    if (part.texts?.length === texts.length && texts.every((text, index) => text === part.texts[index])) return;
    part.texts = texts;
    const generation = ++part.generation;
    clearTimeout(part.timer);
    part.tokens = texts.length ? null : 0;
    if (!texts.length) return;
    part.timer = setTimeout(async () => {
      try {
        // Selections are independent ranges, so count each range separately.
        let total = 0;
        for (const text of texts) {
          const tokens = await count(text, { priority: true, key });
          if (disposed || generation !== part.generation || tokens == null) return;
          total += tokens;
        }
        part.tokens = total;
      } catch (error) {
        if (disposed || generation !== part.generation) return;
        part.tokens = NaN;
        onError(error);
      }
      if (!disposed && generation === part.generation) onChange(doc.tokens, selection.tokens);
    }, delay);
  }

  return {
    invalidate(documentChanged, hasSelection = true) {
      for (const part of documentChanged ? [doc, selection] : [selection]) {
        part.generation++;
        clearTimeout(part.timer);
        part.texts = null;
        part.tokens = null;
      }
      // Empty ranges are known immediately; they need no tokenizer job.
      if (!hasSelection) {
        selection.texts = [];
        selection.tokens = 0;
      }
      onChange(doc.tokens, selection.tokens);
    },
    update(text, selections = []) {
      if (disposed) return;
      f_update(doc, [text], "document");
      f_update(selection, selections, "selection");
      onChange(doc.tokens, selection.tokens);
    },
    dispose() {
      disposed = true;
      clearTimeout(doc.timer);
      clearTimeout(selection.timer);
    },
  };
}

module.exports = { f_createBufferTokenCounts };
