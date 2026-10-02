# laya.md — Laya's learned memory (universal)

Laya reads this file before **every** decision. Items that keep failing are penalized or banned;
items that keep working are boosted. Claude and the hooks write here; you may edit it by hand.

- verdict: `ok` · `warn` (penalized) · `ban` (never picked until `until`) · `pin` (always picked when relevant)
- Record a problem: `laya-conductor learn --item mcp:supabase --outcome fail --note "401 on every call"`
- Never put secrets here. Anything that looks like one is redacted on write.

<!-- laya:ledger -->
| item | wins | fails | last | verdict | until | note |
|---|---|---|---|---|---|---|
<!-- /laya:ledger -->

## Notes
