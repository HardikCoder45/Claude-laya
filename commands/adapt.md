---
description: Wire Laya into another agent (codex, gemini, hermes, pi, cursor, windsurf, opencode, copilot, chatgpt, generic) or list what is supported
argument-hint: <list | all | codex | gemini | hermes | pi | cursor | windsurf | opencode | copilot | chatgpt | generic | mcp>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" adapt $ARGUMENTS`

Show the output above to the user verbatim in a code block. Add at most one short line of commentary. Do not call other tools.
