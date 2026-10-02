---
description: Laya's model + effort routing: list models, set policy (save/balanced/quality), apply (hint/auto/delegate), force a model
argument-hint: [policy save|balanced|quality | apply hint|auto|delegate | force <alias|off> | current <alias|none>]
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" models $ARGUMENTS`

Show the output above verbatim in a code block. Add at most one short line.
