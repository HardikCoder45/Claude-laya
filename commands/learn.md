---
description: Record in laya.md that a tool worked or failed
argument-hint: --item <kind:name> --outcome win|fail|note --note "..."
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" learn $ARGUMENTS`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools.
