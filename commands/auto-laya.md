---
description: Turn auto-laya on/off: Laya re-checks the stack mid-task when tools fail or work drifts
argument-hint: [on|off]
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" auto $ARGUMENTS`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools.
