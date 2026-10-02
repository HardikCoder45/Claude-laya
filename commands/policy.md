---
description: Install policy: ask (always confirm), trusted (auto-install official sources), off
argument-hint: [ask|trusted|off]
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" policy $ARGUMENTS`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools.
