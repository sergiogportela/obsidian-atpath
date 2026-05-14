"use strict";

// Redirects `require("obsidian")` to the test fake, since the real
// `obsidian` package is not installed (it is marked external in the
// esbuild config and is only present at runtime inside the Obsidian app).

const Module = require("node:module");
const path = require("node:path");

const FAKE = path.resolve(__dirname, "_fakes/obsidian.js");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "obsidian") return FAKE;
  return originalResolve.call(this, request, parent, ...rest);
};
