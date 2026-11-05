"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { f_isEligibleLinkedPath } = require("../src/linked-file-policy");

test("copy, publish and count path policy excludes sensitive and generated content", () => {
  for (const path of [
    "repo/.env", "repo/.env.local", "repo/credentials.json", "repo/Secrets.YAML",
    "repo/id_ed25519", "repo/certificate.PEM", "repo/node_modules/a/index.js",
    "repo/build/output.txt", "repo/.git", "repo/.git/config", "custom/config/plugins/settings.json",
  ]) assert.equal(f_isEligibleLinkedPath(path, "custom/config"), false, path);
  for (const path of ["repo/.gitignore", "repo/docs/target.md", "repo/src/build.py", "repo/docs/config.md"]) {
    assert.equal(f_isEligibleLinkedPath(path, "custom/config"), true, path);
  }
});
