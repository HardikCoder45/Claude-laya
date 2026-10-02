---
description: Laya's skill loadout: exclusive use (off/soft/hard), inline SKILL.md, max skills, token budget, confirm-before-send, enforce, ack
argument-hint: [exclusive off|soft|hard | inline on|off | max <1-8> | budget <tokens> | confirm on|off | enforce off|named|all | ack on|off]
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" loadout $ARGUMENTS`

Show the output above verbatim in a code block. Add at most one short line.
