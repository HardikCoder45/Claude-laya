---
description: Always pick an item when relevant, e.g. /laya:pin skill:tdd
argument-hint: <kind:name> [note]
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" pin $ARGUMENTS`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools.
