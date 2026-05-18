**Finding**

- P2 [tests/drag-extract.test.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/tests/drag-extract.test.js:5): The added “regression” tests do not cover the actual regression fixed by commit `72e7424`. The bug was CM6 drop-handler ordering, fixed by wrapping the drag-drop extension in `Prec.highest` at [src/main.js](/Users/sergio/Documents/code/obsidian_plugin_atpath/src/main.js:2170), but the tests only exercise `extractDraggedVaultPaths`. If `Prec.highest(...)` is removed from initial registration or reconfiguration, all 48 tests still pass. Add a small guard for extension precedence/registration, or a CLI-backed DnD verification, so the original file-explorer drop regression fails in tests.

**Verification**

`npm test` passed: 48 tests.  
`npm run build` passed.