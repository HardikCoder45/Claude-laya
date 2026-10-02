---
description: Install bare slash commands (/stack /install /auto-laya ...) into ~/.claude/commands
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" shim`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools. Then tell the user the bare commands are available after the next session start.
