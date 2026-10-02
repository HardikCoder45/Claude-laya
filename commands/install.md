---
description: Research the best skills, agents, plugins and MCP servers for a task, vet them, and install them automatically
argument-hint: <task you want the best tools for>
allowed-tools: Bash(node:*), Bash(claude:*), Bash(npx:*), Bash(gh:*), AskUserQuestion, WebSearch, WebFetch, Agent, Read
---
Task to equip Claude for: **$ARGUMENTS**

Run Laya's research → vet → install flow. Follow these steps exactly and keep your commentary short.

1. **Scout.** Run `node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" scout "$ARGUMENTS"` (JSON, searches local marketplaces, skills.sh, GitHub and the MCP registry). If fewer than 3 good candidates come back, also WebSearch for the best Claude Code plugins/skills/MCP servers for this task (use the `laya-research` skill's source list).
2. **Skip what is already installed.** Check `node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" stack` and the `laya_search` tool; never reinstall something present.
3. **Vet.** For every candidate whose `source` is `github` or whose `trust` is not `high`, delegate to the `laya-vetter` agent (or run `laya-conductor vet <owner/repo>`). Drop anything with `risk: high`. Read `laya.md` (`laya-conductor ledger`) and drop anything banned.
4. **Plan table.** Show: name · source · trust · vet risk · always-on token cost · why it fits. Keep at most 5 rows.
5. **Install.**
   - `trust: high` items (official marketplaces, vercel-labs, anthropics): install directly with `node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" install --spec '<candidate.install JSON>'`.
   - Everything else: ask the user once with AskUserQuestion (multi-select of the rows). Only after an explicit yes in this turn, run the same command with `--approve`. NEVER pass `--approve` on your own.
6. **Finish.** The CLI refreshes the registry. Tell the user to run `/reload-plugins` (or restart) so new skills, hooks and MCP servers load, and list anything they must authorize themselves (OAuth, API keys). If an install fails or a tool misbehaves, record it: `laya-conductor learn --item <kind:name> --outcome fail --note "<why>"`.
