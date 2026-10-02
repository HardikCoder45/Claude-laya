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
  model_apply: 'hint',      // hint (suggest) | auto (Claude switches model/effort itself where it can)
  current_model: null,      // optional alias you are running now, so Laya only speaks up when it differs
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
