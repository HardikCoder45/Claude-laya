---
description: Wire Laya into another agent: codex, gemini, or generic (AGENTS.md + MCP)
argument-hint: <codex|gemini|generic>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" adapt $ARGUMENTS`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools.
