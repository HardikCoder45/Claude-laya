'use strict';
// state.json: user-tunable knobs. Env vars win so CI / one-off runs never touch the file.
const { P, readJson, writeJson } = require('./util');

const DEFAULTS = {
  mode: 'on',            // on | shadow (show picks, inject nothing) | off
  verbose: 'normal',     // quiet | normal | full
  auto: false,           // /laya:auto-laya
  install_policy: 'trusted', // ask (always confirm) | trusted (auto for official sources) | off
  trusted_sources: ['claude-plugins-official', 'anthropic-agent-skills', 'modelcontextprotocol', 'vercel-labs', 'anthropics'],
  model_policy: 'balanced', // save | balanced | quality: how aggressively to trade capability for tokens
  model_apply: 'hint',      // hint (suggest /model) | auto (Claude switches itself where it can) | delegate (work runs via Agent model=<alias>)
  model_force: null,        // alias to always use, whatever the task (/laya:models force <alias>)
  current_model: null,      // manual override; normally detected from the session transcript
  exclusive: 'soft',        // off | soft (tell Claude to use ONLY the selected skills) | hard (also block other Skill calls)
  skills_inline: true,      // inject the selected skills' SKILL.md into the turn so Claude does not have to load them
  max_skills: 4,            // how many skills one decision may select (1-8)
  skill_budget: 2200,       // tokens of SKILL.md text injected per turn (Claude Code caps hook context near 10k chars)
  confirm: false,           // show the plan first and hold the prompt until you send it again
  budget_ms: 1500,       // max wait for the Laya daemon before falling back to lexical
  log_prompts: true,     // store (redacted, truncated) prompt text in decisions.jsonl for fine-tuning
  statusline: true,
};

function get() {
  const s = { ...DEFAULTS, ...readJson(P.state, {}) };
  if (process.env.LAYA_MODE) s.mode = process.env.LAYA_MODE;
  if (process.env.LAYA_VERBOSE) s.verbose = process.env.LAYA_VERBOSE;
  if (process.env.LAYA_BUDGET_MS) s.budget_ms = Number(process.env.LAYA_BUDGET_MS);
  return s;
}
function set(patch) { const cur = readJson(P.state, {}); writeJson(P.state, { ...cur, ...patch }); return get(); }
// Session-scoped scratch (last decision, failure streaks, tool counters) lives apart from user knobs.
const sess = (id) => `${P.state}.${String(id || 'default').replace(/[^\w-]/g, '').slice(0, 40)}.json`;
function getSession(id) { return readJson(sess(id), { fails: 0, tools: 0, used: [], failedItems: [], lastDecision: null }); }
function setSession(id, patch) { const f = sess(id); writeJson(f, { ...getSession(id), ...patch }); }

module.exports = { get, set, getSession, setSession, DEFAULTS };
