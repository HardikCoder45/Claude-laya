---
name: laya-memory
description: Use whenever a skill, plugin, MCP server, connector or agent fails, errors, times out, returns wrong or low-quality results, or behaves surprisingly — and when one works notably well. Records it in the universal ~/.laya/laya.md so Laya stops choosing broken tools and learns over time.
---

# laya-memory — always remember what failed

`~/.laya/laya.md` (override with `$LAYA_HOME`) is Laya's universal memory. It is **not tied to any directory**. Laya reads it before every decision: items with failures get penalized or banned, items that work get boosted.

## When to write
- A skill/plugin/MCP/agent/tool **fails**, errors, hangs, needs auth that is missing, or returns junk.
- A tool is **repeatedly unhelpful** for a task type (say so in the note).
- A tool worked **unusually well** (`--outcome win`).
- You installed something and it needed a workaround (`--outcome note`).

The `PostToolUseFailure` hook already records raw MCP/skill/agent failures automatically. Add the **why** it cannot know.

## How
```bash
laya-conductor learn --item <kind:name> --outcome fail|win|note --note "<short why>"
# kind is skill | agent | mcp | plugin | command, e.g. mcp:supabase, skill:ui-ux-pro-max
laya-conductor learn --item mcp:supabase --outcome fail --note "401 on every call; needs OAuth" --project   # this repo only
```
Other commands: `laya-conductor pin <item>`, `ban <item> "<why>"`, `ledger`, `stack`.

## Rules
- One short line (≤160 chars). State the cause, not the stack trace.
- **Never** write secrets, tokens, URLs with credentials or personal data. Anything secret-shaped is redacted anyway.
- Do not log user errors (typos, denied permissions) as tool failures.
- Picks in `<laya-decision>` are advisory; if one does not fit, skip it and say why only if it was *broken*.
