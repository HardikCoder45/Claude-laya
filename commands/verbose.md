---
description: Set how much Laya prints per prompt: quiet, normal or full
argument-hint: [quiet|normal|full]
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" verbose $ARGUMENTS`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools.
