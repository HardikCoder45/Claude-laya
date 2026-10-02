---
description: Show what Laya selected for the last prompt and what the turn actually did (skills called/applied, MCP calls, model planned vs ran)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" trace`

Show the output above verbatim in a code block. Add at most one short line.
