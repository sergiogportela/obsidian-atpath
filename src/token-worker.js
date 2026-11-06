"use strict";

const { countTokens, setMergeCacheSize } = require("gpt-tokenizer/encoding/o200k_base");
setMergeCacheSize(10000);
const ordinaryText = { disallowedSpecial: new Set() };

self.onmessage = ({ data: { id, text } }) => {
  try {
    self.postMessage({ id, tokens: countTokens(text, ordinaryText) });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
