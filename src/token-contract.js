"use strict";

// The dependency version is embedded by the build. Change the semantic suffix
// when encoding, normalization, special-token handling or binary sniff changes.
const TOKEN_CACHE_IDENTITY = `gpt-tokenizer@${require("gpt-tokenizer/package.json").version}/o200k_base/ordinary-text/binary-v1`;
const TOKEN_CACHE_VERSION = 3;
const TOKEN_COUNT_DISCLOSURE = "Exact o200k_base text tokens. Folder and linked totals sum individual files; message formatting and other model tokenizers can differ.";

async function f_hashTokenText(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

module.exports = { TOKEN_CACHE_IDENTITY, TOKEN_CACHE_VERSION, TOKEN_COUNT_DISCLOSURE, f_hashTokenText };
