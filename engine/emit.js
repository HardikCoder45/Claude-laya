'use strict';
// What the user sees (systemMessage / confirm preview) vs what the model gets (additionalContext).
const state = require('./state');
const loadout = require('./loadout');
const agents = require('./agents');
const { P } = require('./util');
const names = (arr) => arr.map((p) => p.name).join(', ');
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function modelLine(m) {
  const eff = m.effort ? '/' + m.effort : '';
  const base = `${m.alias}${eff}${m.savings_pct ? ` (−${m.savings_pct}% tokens)` : ''}${m.forced ? ' [forced]' : ''}`;
  if (m.current && m.current === m.alias) return `${base} · already on ${m.current} ✓`;
  const how = m.apply === 'delegate' && m.current ? `work runs via Agent(model=${m.alias})`
    : m.apply === 'auto' ? 'Claude switches it itself, else /model'
    : `switch with /model ${m.alias}${m.effort ? ' + /effort ' + m.effort : ''}`;
  return `${base}${m.current ? ` · now ${m.current}` : ''} → ${how}`;
}

function skillLine(d) {
  const lo = d.loadout || {}, inl = new Map((lo.inline || []).map((s) => [s.id, s]));
  return d.picks.skills.map((s) => {
    const i = inl.get(s.id);
    return `${s.mentioned ? '★' : '✔'} ${s.name} (${s.mentioned ? 'you named it' : s.score}${i ? `, ${k(i.tok)} tok loaded` : ', Skill tool loads it'})`;
  }).join(' · ');
}

// The plan block. First line stays one scannable line; details hang under it.
function plan(d, st) {
  const p = d.picks, rows = [];
  if (d.model) rows.push(['model', modelLine(d.model)]);
  if (p.skills.length) rows.push(['skills', skillLine(d)]);
  if (p.agents.length) rows.push(['agents', names(p.agents)]);
  if (p.mcp.length) rows.push(['mcp', names(p.mcp)]);
  if (p.plugins.length) rows.push(['plugins', names(p.plugins)]);
  const lo = d.loadout;
  if (lo && p.skills.length && lo.exclusive !== 'off') rows.push(['rule', lo.exclusive === 'hard' ? 'Claude may use ONLY these skills — other Skill calls are blocked' : `${agents.native(d.agent) ? 'Claude' : 'the agent'} is told to use ONLY these skills`]);
  if (d.install_queue.length) rows.push(['install', `＋ ${d.install_queue.map((q) => q.id.replace(/^plugin:/, '')).join(', ')} → /laya:install`]);
  else if (d.task.needs_install) rows.push(['install', '＋ want new tools? → /laya:install <task>']);
  if (d.avoid.length) rows.push(['avoid', `⚠ ${d.avoid.map((a) => a.id).join(', ')}`]);
  return rows.map(([a, b]) => `  ${a.padEnd(8)} ${b}`).join('\n');
}

function engineTag(d) {
  return d.engine.mode === 'laya' ? `laya${d.engine.device ? '·' + d.engine.device.replace('cuda:0', 'cuda') : ''} ${d.engine.latency_ms}ms` : `lexical${d.engine.fallback_reason ? ' (' + d.engine.fallback_reason + ')' : ''} ${d.engine.latency_ms}ms`;
}

function message(d, st) {
  if (d.skipped) return st.verbose === 'full' ? `laya ▸ skipped (${d.skipped})` : '';
  const quiet = st.verbose === 'quiet';
  const notable = d.avoid.length || d.install_queue.length || d.engine.fallback_reason.includes('failed');
  if (quiet && !notable) return '';
  const body = plan(d, st);
  let out = `laya ▸ ${st.mode === 'shadow' ? '(shadow) ' : ''}plan · ${d.task.domain}·d${d.task.difficulty} │ ${engineTag(d)}${body ? '\n' + body : ' │ no extras needed'}`;
  if (st.verbose === 'full') {
    out += '\n  ' + d.explain.top_k.map((r) => `${r.name} ${r.score}${r.laya_p != null ? ` (p=${r.laya_p})` : ''}${r.installed ? '' : ' [not installed]'}`).join('  ·  ');
    out += `\n  model-hint: ${d.model_hint.tier}/${d.model_hint.effort}${d.swarm.use ? ' · swarm: ' + d.swarm.topology : ''} · flags: ${Object.entries(d.task).filter(([a, v]) => v === true).map(([a]) => a).join(',') || 'none'}`;
  }
  return out;
}

// Compact on purpose: names + one rule. Descriptions stay out (token cost, and they are untrusted text).
// Selected skills are the exception: their SKILL.md goes in whole (budgeted), because the user asked for them to be used.
function context(d, st = state.get(), items = null) {
  const p = d.picks, L = ['<laya-decision v1>'];
  L.push(`task: ${d.task.domain}, difficulty ${d.task.difficulty}/4 · engine: ${d.engine.mode}`);
  const m = d.model;
  if (m) {
    L.push(`model plan (saves ~${m.savings_pct}% vs always-top): main work on ${m.alias}${m.effort ? ' at effort ' + m.effort : ''} [${m.reason}]. Delegate trivial subtasks to Agent model="${m.delegate.trivial}"${m.delegate.review !== m.alias ? `, hard reviews to model="${m.delegate.review}"` : ''}.`);
    if (m.apply === 'delegate' && m.switch) L.push(`apply now: the selected model (${m.alias}) differs from the current one (${m.current}). Do the substantive work by calling the Agent tool with model="${m.alias}" and a self-contained prompt (the user's request${p.skills.length ? ' + the skill instructions below' : ''}), then relay its result. Answer trivial follow-ups directly.`);
    else if (m.apply === 'auto' && m.current !== m.alias) L.push(`apply now: if session tools set_session_model / set_session_effort are available, switch to ${m.alias}${m.effort ? '/' + m.effort : ''}; otherwise tell the user to run /model ${m.alias}${m.effort ? ' and /effort ' + m.effort : ''}.`);
    else if (m.current && m.current !== m.alias) L.push(`current model is ${m.current}; suggest /model ${m.alias}${m.effort ? ' + /effort ' + m.effort : ''} only if the user cares about cost.`);
  }
  let blocks = '';
  if (p.skills.length) {
    const r = loadout.render(d, items || require('./inventory').load(d.cwd).items);
    if (r.directive) L.push(r.directive);
    blocks = r.blocks;
  }
  const nat = agents.native(d.agent);
  if (p.agents.length) L.push(nat ? `use agents (Agent tool subagent_type): ${p.agents.map((s) => s.name).join(', ')}` : `useful specialist roles for this task: ${p.agents.map((s) => s.name).join(', ')}`);
  if (p.mcp.length) L.push(`use MCP servers: ${p.mcp.map((s) => s.name).join(', ')}`);
  if (p.plugins.length) L.push(`relevant plugins: ${p.plugins.map((s) => s.name).join(', ')}`);
  if (d.swarm.use) L.push(`task is large: consider a ${d.swarm.topology} agent swarm${d.swarm.agents.length ? ' using ' + d.swarm.agents.join(', ') : ''}`);
  if (d.avoid.length) L.push(`avoid (failed before, see laya.md): ${d.avoid.map((a) => `${a.id}${a.reason ? ' [' + a.reason + ']' : ''}`).join('; ')}`);
  if (d.install_queue.length) L.push(`better tools exist but are not installed: ${d.install_queue.map((q) => q.install || q.id).join(', ')} — offer \`/laya:install\` if the user wants them`);
  else if (d.task.needs_install) L.push('the user wants new tools: run the /laya:install flow (laya-conductor scout "<task>") instead of guessing');
  L.push(`rule: if any skill/plugin/MCP/agent fails or misbehaves, run \`${nat ? 'laya-conductor' : P.launcher} learn --item <kind:name> --outcome fail --note "<why>"\` so laya.md remembers. Picks are advisory except where marked EXCLUSIVE/ONLY.`);
  L.push('</laya-decision>');
  return L.join('\n') + (blocks ? '\n' + blocks : '');
}

module.exports = { message, context, plan };
