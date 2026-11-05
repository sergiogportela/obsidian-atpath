"use strict";

// Matches AgentKit's generated-directory and sensitive-file exclusions.
// Hidden files are normally absent from Obsidian's index; an explicit link to
// a non-sensitive hidden file (for example .gitignore) remains eligible.
const GENERATED_DIRECTORIES = new Set(["__pycache__", "build", "dist", "node_modules", "target", "venv"]);
const PRIVATE_FILENAMES = new Set([
  "credentials.json", "id_ed25519", "id_rsa", "secrets.json", "secrets.yaml", "secrets.yml",
  "service-account.json", "token.json", "tokens.json",
]);

function f_isEligibleLinkedPath(path, configDir) {
  const parts = path.split("/");
  const name = parts[parts.length - 1].toLowerCase();
  return !name.startsWith(".env") && !PRIVATE_FILENAMES.has(name)
    && !/\.(?:key|p12|pem|pfx)$/.test(name)
    && !parts.includes(".git")
    && !parts.slice(0, -1).some(part => GENERATED_DIRECTORIES.has(part))
    && !(configDir && (path === configDir || path.startsWith(configDir + "/")));
}

module.exports = { f_isEligibleLinkedPath };
