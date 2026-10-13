---
description: Turn auto-laya on/off: toolbox map at session start, runners-up per prompt, re-plans mid-task (also on by itself in auto/bypass permission mode)
argument-hint: [on|off]
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" auto $ARGUMENTS`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools.
