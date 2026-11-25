const assert = require("node:assert/strict");
const { test } = require("node:test");
const { f_compactCopyPathItems } = require("../src/copy-path-menu");

function f_item(title, section, icon) {
  const svg = icon ? { classList: { contains: name => ["svg-icon", icon].includes(name) } } : null;
  return { title, section, iconEl: { querySelector: () => svg } };
}

test("compact Copy path keeps the vault path and GitHub link and leaves other sections alone", () => {
  const menu = { items: [
    f_item("Open in new tab", "open", "lucide-file-plus"),
    f_item("as Obsidian URL", "info.copy", "lucide-link"),
    f_item("from vault folder", "info.copy", "vault"),
    f_item("from system root", "info.copy", "lucide-hard-drive"),
    f_item("as GitHub link", "info.copy", "github"),
    f_item("Copy link elsewhere", "action", "lucide-link"),
    f_item("Another plugin's format", "info.copy", null),
    { separator: true },
  ] };
  f_compactCopyPathItems(menu);
  assert.deepEqual(menu.items.map(item => item.title ?? "separator"), [
    "Open in new tab", "from vault folder", "as GitHub link", "Copy link elsewhere",
    "Another plugin's format", "separator",
  ]);
});

test("compact Copy path ignores menus without an item list", () => {
  for (const menu of [null, {}, { items: "native" }]) assert.doesNotThrow(() => f_compactCopyPathItems(menu));
});
