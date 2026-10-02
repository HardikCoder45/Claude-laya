---
description: Rebuild Laya's registry of installed and available skills, agents, MCP servers and plugins
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" refresh`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools.
