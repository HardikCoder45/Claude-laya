# Claude's Laya — the meta-plugin that chooses (and installs) your Claude Code stack

<div align="center">
  <img src="assets/logo.webp" alt="Laya Logo" width="300" />
</div>

Before **every prompt**, Laya's decision engine picks the best skills, agents, MCP servers and plugins from everything you have (and everything you *could* have), tells you what it picked, and hands Claude a compact decision. It researches and installs better tools on request, and learns from failures in a universal `~/.laya/laya.md`.

<div align="center">
  <img src="assets/screenshot.webp" alt="Laya in Action" width="900" />
</div>

```
you ▸ build a react dashboard with supabase auth
laya ▸ frontend_ui·d3 │ skills: ui-ux-pro-max, web-design-guidelines │ agents: UI-UX-DESIGNER │ ＋install: supabase → /laya:install │ laya·mps 640ms
```

## Install (that is all)

```bash
claude plugin marketplace add <path-or-github-url-of-this-repo>
claude plugin install laya@laya-marketplace
```

On the next session start Laya sets itself up in the background — no commands to run:

1. private Python venv in `~/.laya/venv` (uses `uv` if present, else `python3 -m venv`)
2. `pip install laya` + downloads the English checkpoint into the shared Hugging Face cache (**one time, ~1–2 GB**, reused if you already have it)
3. starts a warm daemon (unix socket, user-only) and indexes your registry
4. installs the bare slash commands `/stack`, `/install`, `/auto-laya` into `~/.claude/commands`

Until that finishes Laya runs in **lexical mode** (BM25) so nothing ever blocks. Opt out of the download with `LAYA_NO_AUTOSETUP=1`. Needs `node` ≥ 18 (you have it if you have Claude Code's npm tooling); `uv` or `python3` ≥ 3.10.

## What you see

Before the model sees your prompt, Laya prints the plan: the model + effort, every selected skill (★ = you named it, with how it will be loaded), agents, MCP servers, what to avoid, what to install, engine + latency:

```
laya ▸ plan · frontend_ui·d3 │ laya·mps 210ms
  model    sonnet/high (−50% tokens) · now opus → switch with /model sonnet + /effort high
  skills   ✔ frontend-design (0.63, 1.2k tok loaded) · ✔ webapp-testing (0.42, 0.9k tok loaded)
  rule     Claude is told to use ONLY these skills
```

`/laya:verbose quiet|normal|full` changes it; `full` adds scores and flags. SessionStart, failures (`recorded failure: mcp:x → laya.md`), auto-laya re-picks and turn outcomes print too.

## Commands

| command | what it does |
|---|---|
| `/install <task>` (`/laya:install`) | scout → vet → install the best skills/agents/plugins/MCP for a task |
| `/stack` (`/laya:stack`) | the stack Laya picked + engine state |
| `/auto-laya on\|off` | mid-task re-checks: tools failing twice, every 12 tool calls |
| `/laya:status` · `doctor` · `explain` · `ledger` | health, diagnostics, why-this-pick, laya.md summary |
| `/laya:learn` · `pin` · `ban` | teach laya.md by hand |
| `/laya:mode on\|shadow\|off` | shadow = show picks, inject nothing (calibrate first) |
| `/laya:models` | model + effort routing: list, `policy save\|balanced\|quality`, `apply hint\|auto\|delegate`, `force <alias\|off>`, `current <alias>` |
| `/laya:loadout` | skill loadout: `exclusive off\|soft\|hard`, `inline on\|off`, `max <1-8>`, `budget <tokens>`, `confirm on\|off` |
| `/laya:verbose` · `policy` · `refresh` · `statusline` | knobs |
| `/laya:adapt list\|all\|<agent>` | use Laya in Codex, Gemini, Hermes, Pi, Cursor, Windsurf, opencode, Copilot, ChatGPT, ... |
| `/laya:export` | decisions + outcomes → Laya fine-tune dataset |

`/stack`, `/install`, `/auto-laya` are also installed bare. Other bare names (`/status`, `/mode`…) are deliberately not, they would shadow built-ins.

## How a decision is made

```
prompt ─▶ gate (skip slash-commands, trivial, follow-ups)
       ─▶ registry (skills, agents, commands, MCP, plugins; installed + marketplaces + official catalog)
       ─▶ hybrid shortlist: BM25  ∪  Laya-encoder embeddings (≤9 per kind)
       ─▶ Laya, one forward pass: domain · difficulty · needs_install/research · sensitive · pick_skill/agent/mcp/plugin
       ─▶ blend: 0.3·lexical + 0.2·embedding + 0.5·Laya  (Laya says "none fits" ⇒ lexical evidence only)
          + laya.md history (wins ↑, fails ↓, bans, pins) − token cost
       ─▶ decision JSON (templates/decision.schema.json) ─▶ systemMessage (you) + additionalContext (Claude, ≤300 tokens)
```

Laya answers in ~0.6 s warm (Apple GPU), 10 options per question because the checkpoint's temperature is uncalibrated beyond that. It is zero-shot, so its picks are *blended* with lexical evidence and your history; the more you use it, the more `decisions.jsonl` you can fine-tune on (`docs/FINETUNE.md`).

## laya.md — the universal memory

`~/.laya/laya.md` (override `$LAYA_HOME`; per-project overlay `./.laya/laya.md`). A markdown ledger — `item | wins | fails | last | verdict | until | note` — plus free-text notes. Failures are logged automatically by a hook (MCP/skill/agent) and by Claude via the always-on `laya-memory` skill. 2 fails ⇒ `warn`, 5 fails ⇒ 14-day `ban`; wins heal. Secrets are redacted on write. Edit it by hand any time.

## Model + effort routing

Each decision picks the **cheapest model that is capable enough** from `~/.laya/models.json` (defaults: haiku, sonnet, opus, fable) and an effort level. Tiers and costs are **relative guesses, not prices**: edit the file to match your plan. A model with failures in laya.md (`model:<alias>`) is skipped; `pin model:<alias>` in laya.md or `/laya:models force <alias>` overrides the routing.

Laya reads the model your session is actually running (last assistant turn in the transcript, or SessionStart), so it only speaks up when the pick differs. A hook cannot switch the live model, so there are three ways to *apply* the pick (`/laya:models apply …`):

| apply | what happens |
|---|---|
| `hint` (default) | shows `switch with /model sonnet + /effort high`; you decide |
| `auto` | Claude switches itself when session tools (`set_session_model`) exist, otherwise suggests `/model` |
| `delegate` | when the pick differs from the running model, Claude runs the substantive work through the Agent tool with `model=<pick>` and relays the result. Works in every client. |

Independent of `apply`, Claude is told to send trivial subtasks to the cheapest model and hard reviews to the strongest via the Agent tool's `model` param.

## Skill loadout

Laya selects up to `max` skills (default 4, `/laya:loadout max N`) and the agent is told to use **those and only those**:

- **Inlined**: the selected skills' `SKILL.md` text is injected with your prompt (frontmatter stripped, `base=` path included so relative references resolve), so Claude starts with the instructions already loaded. Only *installed* skills are ever inlined. A skill that does not fit whole in the token budget (`/laya:loadout budget`, default 2200 tokens ≈ 9k chars, Claude Code caps hook context near 10k chars) is not truncated: Claude is told to load it with the Skill tool first.
- **Exclusive**: `soft` (default) tells Claude to use only the selected skills; `hard` also denies any other `Skill` tool call for that turn via a PreToolUse hook (Laya's own skills stay allowed; ends at Stop). `off` goes back to plain suggestions.
- **Named skills win**: "use the pdf skill", "$pdf", "pdf skill" always select that skill, whatever the ranking says.
- **Confirm first**: `/laya:loadout confirm on` holds your prompt and shows the plan; send the same prompt again within 5 minutes to run it with exactly that plan (change it first with `/laya:pin`, `/laya:ban`, `/laya:models force`). Editing the prompt re-decides. Claude Code only: other agents ignore it.
- Subagents are told to receive the same skill instructions and keep the same restriction.

Changes take effect from the next turn.

## Research & install

`laya-conductor scout "<task>"` searches **local marketplaces + Anthropic's catalog, `npx skills find`, GitHub (`gh`), the MCP registry**. `vet` statically scans a repo (hooks, install scripts, `curl | sh`, credential access, prompt-injection text) before any code runs. Policy (`/laya:policy`): `trusted` (default) installs official/vendor sources automatically and asks for everything else; `ask` always asks; `off` never. Trust is computed by the CLI, never from what the model claims; high-risk repos are refused outright. After installing: `/reload-plugins`; OAuth/API keys are yours to provide.

## Other agents

One engine, several front doors. `/laya:adapt list` shows what is supported and what it found on your machine; `/laya:adapt <agent>` wires one; `/laya:adapt all` wires every detected agent (home-level config only).

| Agent | How Laya reaches it | What `adapt` writes |
|---|---|---|
| **Codex** | `UserPromptSubmit` hook (same `additionalContext` protocol) + MCP | `~/.codex/hooks.json`, `[mcp_servers.laya]` in `config.toml` |
| **Gemini CLI** | `BeforeAgent` hook + MCP | `~/.gemini/settings.json` |
| **Hermes Agent** | `pre_llm_call` shell hook (returns `{"context": …}`) + MCP | `~/.hermes/config.yaml` (marker blocks) |
| **Pi** | TypeScript extension on `before_agent_start` (Pi has no hooks file or built-in MCP) | `~/.pi/agent/extensions/laya.ts` |
| **Cursor** | MCP + always-on rule (its prompt hook cannot add context) + `sessionStart` note | `~/.cursor/mcp.json`, `hooks.json`, `.cursor/rules/laya.mdc` |
| **Windsurf** | MCP + global rule | `mcp_config.json`, `memories/global_rules.md` |
| **opencode** | MCP + global `AGENTS.md` | `~/.config/opencode/opencode.json`, `AGENTS.md` |
| **GitHub Copilot (VS Code)** | MCP + instructions, per workspace | `.vscode/mcp.json`, `.github/copilot-instructions.md` |
| **ChatGPT** | Remote MCP over HTTP behind a secret URL (ChatGPT cannot start local programs) | nothing; prints the steps. Run `laya-conductor mcp --http`, tunnel it, add it under Developer mode |
| **Anything else** | `adapt generic` (AGENTS.md rule) or `adapt mcp` (snippet for Cline, Roo, Zed, Continue, Goose, Claude Desktop, ...) | |

Every adapter is idempotent and edits only what it owns (JSON keys, marker blocks, one file). A config it cannot parse (comments, trailing commas) or a YAML key you already have is never rewritten: Laya prints the snippet to add by hand instead.

What other agents get: the picked skills (SKILL.md inlined, within the token budget; the rest as file paths to read), the "use only these" rule, the specialist roles and the avoid list, plus failure learning into the same `laya.md`. What stays Claude Code only: model/effort routing (the aliases are Claude models), the Skill tool, `exclusive hard` (it needs a PreToolUse hook, so other agents fall back to `soft`) and confirm-before-send. Agents that cannot run hooks (Cursor, Windsurf, opencode, Copilot, ChatGPT) only get Laya when the model calls `laya_decide`, so it is advisory by design.

Laya reads installed skills from Claude's directories; picks for other agents come from that inventory. Codex hooks are experimental upstream, Gemini timeouts are in ms, and Hermes asks once to approve the new hook.

## Privacy & safety

Everything runs locally; prompts never leave your machine (the only network use is the one-time checkpoint download and explicit scout/install). The daemon socket is `chmod 600`. Registry text from third-party marketplaces is treated as untrusted: length-capped, injection phrases stripped, and never injected into Claude's context (only names are). Every hook is fail-open (always exits 0 with valid JSON) so Laya can never block a prompt.

## Files

`~/.laya/`: `laya.md` · `registry.json` · `decisions.jsonl` · `state.json` · `emb.npz` · `venv/` · `bin/laya-conductor` · `laya.log` · `setup.json`

## Develop

```bash
node tests/selfcheck.js            # 14 checks, offline, isolated temp dirs (golden prompts in evals/golden.json)
claude plugin validate .
claude --plugin-dir . ...           # try it without installing
```
Uninstall: `claude plugin uninstall laya`, `laya-conductor daemon-stop`, `rm -rf ~/.laya` (and the 3 files marked `<!-- laya-shim -->` in `~/.claude/commands`).

## License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE) for details.

---

Built on [Laya](https://github.com/NandhaKishorM/laya) (Apache-2.0) by Nandha Kishor M. This plugin is an independent integration.
