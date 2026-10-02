---
description: Show Laya's live stack badge in your Claude Code status line
allowed-tools: Bash(node:*), Read, Edit
---
Wire Laya's badge into the status line.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/laya-conductor.js" status` once so the stable launcher `~/.laya/bin/laya-conductor` exists.
2. Read `~/.claude/settings.json`. If it already has a `statusLine`, show it to the user and ask before replacing it (offer to chain the commands instead).
3. Otherwise add: `"statusLine": { "type": "command", "command": "~/.laya/bin/laya-conductor statusline" }` and tell the user it shows e.g. `[LAYA code·d3 4⚙ auto]` after the next prompt.
