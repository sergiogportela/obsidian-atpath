"use strict";

// Obsidian's "Copy path" submenu lists an Obsidian URL and an absolute system
// path beside the vault path. With AtPath's GitHub link added, the two formats
// that only work on this device crowd out the two that are worth pasting
// elsewhere, so the compact menu keeps the vault path and the GitHub link.
//
// Obsidian offers no way to decline its own entries; they are dropped from the
// menu's item list before it is shown. Titles are localized, so the entries are
// recognized by their icons. An unrecognized menu is left as Obsidian built it.
const COPY_PATH_SECTION = "info.copy";
const HIDDEN_COPY_PATH_ICONS = ["lucide-link", "lucide-hard-drive"];

function f_compactCopyPathItems(menu) {
  if (!Array.isArray(menu?.items)) return;
  menu.items = menu.items.filter(item => {
    if (item?.section !== COPY_PATH_SECTION) return true;
    const icon = item.iconEl?.querySelector?.("svg");
    return !icon || !HIDDEN_COPY_PATH_ICONS.some(name => icon.classList.contains(name));
  });
}

module.exports = { COPY_PATH_SECTION, f_compactCopyPathItems };
