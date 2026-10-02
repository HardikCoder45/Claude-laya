---
description: Never pick an item, e.g. /laya:ban mcp:supabase flaky auth
argument-hint: <kind:name> [note]
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" ban $ARGUMENTS`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools.
