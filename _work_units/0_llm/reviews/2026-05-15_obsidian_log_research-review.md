**Findings**

1. **Medium:** [_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md:24) omits two operational constraints for the recommended CLI workflow: Obsidian must be running, and vault targeting matters. The official CLI docs say the CLI connects to the running Obsidian instance, and vault-scoped commands use the current vault unless `vault=<name/id>` is provided first. Since agents will run from the plugin repo, not necessarily the vault, the future runbook should include `vault=...` guidance or the first real diagnosis session can hit the wrong vault or fail.

2. **Low:** [_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md:48) recommends a fallback path under `.obsidian/plugins/atpath/dev-logs.txt`. If implemented literally, that conflicts with this repo’s Obsidian review rule against hardcoded `.obsidian`. Add a note that any DIY logger must derive the directory from `this.app.vault.configDir` and remain dev-only.

3. **Low:** [_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md](/Users/sergio/Documents/code/obsidian_plugin_atpath/_work_units/0_llm/research/2026-05-15_obsidian_log_and_cli_access.md:74) cites `wdio-obsidian-service` as `v2.0.0 Mar 2025`, but npm metadata reports latest `3.0.2` published 2026-03-29, and `2.0.0` was published 2025-08-03. This does not change the “skip full E2E for now” recommendation, but the research doc should be corrected because it is intended as a current reference.

**Verification**

Reviewed the research and status docs. Cross-checked the core CLI claims against the official Obsidian CLI docs and Obsidian 1.12/1.12.7 changelog pages:
https://obsidian.md/help/cli  
https://obsidian.md/changelog/2026-02-27-desktop-v1.12.4/  
https://obsidian.md/changelog

**Verdict**

Direction is sound: the official Obsidian CLI is the right primary diagnosis channel, and the status doc captures the next steps. Fix the three documentation issues above before treating this as the standing agent runbook.