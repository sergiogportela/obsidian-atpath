**Findings**

1. [P2] [README.md](/Users/sergio/Documents/code/obsidian_plugin_atpath/README.md:100) still says AtPath is “not yet listed” and “submission pending,” but the official Obsidian registry now contains `id: "atpath"` for `sergiogportela/obsidian-atpath`: https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json. This keeps the refreshed install docs stale and hides the normal Community Plugins install path.

2. [P2] [README.md](/Users/sergio/Documents/code/obsidian_plugin_atpath/README.md:85) lists `Max files per folder reference` and `Folder encode batch size` defaults as `—`, but [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:220) defines them as `500` and `1`. Since this table is meant to make settings current, those defaults should match the plugin.

3. [P3] [STATUS.md](/Users/sergio/Documents/code/obsidian_plugin_atpath/STATUS.md:5) says the repo head is `d8e71a8`, but the committed status relocation is itself `7ddd818`. That violates the new “current reality from Git” contract and makes the root status stale immediately after landing.