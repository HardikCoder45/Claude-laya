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
  const now = m.current ? ` · session on ${m.current}` : '';
  const sw = `/model ${m.alias}${m.effort ? ' + /effort ' + m.effort : ''}`;
  switch (m.plan) {
    case 'same': return `${base} · already on ${m.current} ✓`;
    case 'delegate': return `${base}${now} → main work runs on ${m.alias} via Agent(model=${m.alias}) · ${sw} to switch the whole session`;
    case 'offload': return `${base}${now} → self-contained chunks run on ${m.alias} via Agent · ${sw} to switch for good`;
    case 'check': return `${base} → Claude hands the work to Agent(model=${m.alias}) unless it already is ${m.alias}`;
    case 'direct': return `${base}${now} → small task, answered directly · ${sw} to switch`;
    default: return `${base}${now} → switch with ${sw}`;
  }
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
  if (p.mcp.length) rows.push(['mcp', p.mcp.map((m) => `${m.mentioned ? '\u2605 ' : ''}${m.name}${m.mentioned ? ' (you named it)' : ''}`).join(', ') + ' \u2192 tools loaded via ToolSearch']);
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
  const inv = () => items || (items = require('./inventory').load(d.cwd).items);
  L.push(`task: ${d.task.domain}, difficulty ${d.task.difficulty}/4 · engine: ${d.engine.mode}`);
  const m = d.model;
  if (m) {
    const brief = `a self-contained prompt (request + needed context${p.skills.length ? ' + the skill instructions below' : ''}; it cannot see this chat)`;
    const who = p.agents[0] ? `, subagent_type "${p.agents[0].name}"` : '';
    L.push(`model: ${m.alias}${m.effort ? '/' + m.effort : ''} [${m.reason}]${m.current ? `; session runs ${m.current}` : ''}.`);
    if (m.plan === 'delegate') L.splice(1, 0, `MODEL ROUTING — do this BEFORE answering: this task is routed to ${m.alias}. Your first action is the Agent tool with model: "${m.alias}"${who} and ${brief}. Then check its result and give the user the answer. Do not answer it yourself on ${m.current}.`);
    else if (m.plan === 'offload') L.push(`MODEL ROUTING: ${m.alias} suffices and is cheaper: give self-contained chunks (searches, reading many files, boilerplate, summaries) to the Agent tool with model: "${m.alias}"; keep decisions and the final answer here.`);
    else if (m.plan === 'check' && m.weaker && m.weaker.length) L.splice(1, 0, `MODEL ROUTING — check BEFORE answering: this task is routed to ${m.alias}. If you are ${m.weaker.join(' or ')} (your system prompt says which model you are), your first action is the Agent tool with model: "${m.alias}"${who} and ${brief}; then relay its result. If you are ${m.alias} or stronger, just do the work.`);
  }
  let blocks = '';
  if (p.skills.length) {
    const r = loadout.render(d, inv());
    if (r.directive) L.push(r.directive);
    blocks = r.blocks;
  }
  const nat = agents.native(d.agent);
  if (p.agents.length) L.push(nat ? `use agents (Agent tool subagent_type): ${p.agents.map((s) => s.name).join(', ')}` : `useful specialist roles for this task: ${p.agents.map((s) => s.name).join(', ')}`);
  if (p.mcp.length) {
    const byId = new Map(inv().map((i) => [i.id, i]));
    const rows = p.mcp.map((s) => {
      const it = byId.get(s.id) || {}, pre = it.toolPrefix || `mcp__${String(s.name).replace(/[^\w-]/g, '_')}__`;
      const seen = (it.tools || []).length ? `; known tools: ${it.tools.slice(0, 6).join(', ')}` : '';
      return `${s.name}${s.mentioned ? ' (user named it: you MUST use it)' : ''} [tools ${pre}*${seen}]`;
    });
    L.push(`MCP servers selected by laya: ${rows.join(' | ')}. Use their tools for the data and actions they own instead of guessing, scraping or shell workarounds. If those tools are not in your tool list yet, load them first with ToolSearch (query "select:<tool name>" or the server name) and then call them.`);
  }
  if (p.plugins.length) L.push(`relevant plugins: ${p.plugins.map((s) => s.name).join(', ')}`);
  if (st.auto && d.explain) { // auto-laya: name the runners-up too, so the agent can switch without asking
    const have = new Set([...p.skills, ...p.mcp, ...p.agents, ...p.plugins].map((x) => x.id));
    const byId = new Map(inv().map((i) => [i.id, i]));
    const extra = d.explain.top_k.filter((r) => r.installed && !have.has(r.id) && r.score >= (d.engine.min_confidence || 0.25) * 0.8 && byId.has(r.id) && byId.get(r.id).kind !== 'plugin').slice(0, 4).map((r) => byId.get(r.id));
    if (extra.length) L.push(`auto-laya · also on hand if the task grows: ${useLines(extra, nat).join(' | ')}`);
  }
  if (d.swarm.use && d.swarm.agents.length) L.push(`task is large: consider a ${d.swarm.topology} agent swarm${d.swarm.agents.length ? ' using ' + d.swarm.agents.join(', ') : ''}`);
  if (d.avoid.length) L.push(`avoid (failed before, see laya.md): ${d.avoid.map((a) => `${a.id}${a.reason ? ' [' + a.reason + ']' : ''}`).join('; ')}`);
  if (d.install_queue.length) L.push(`better tools exist but are not installed: ${d.install_queue.map((q) => q.install || q.id).join(', ')} — offer \`/laya:install\` if the user wants them`);
  else if (d.task.needs_install) L.push('the user wants new tools: run the /laya:install flow (laya-conductor scout "<task>") instead of guessing');
  L.push(`if a pick fails or misbehaves: \`${P.launcher} learn --item <kind:name> --outcome fail --note "<why>"\`.`);
  L.push('</laya-decision>');
  return L.join('\n') + (blocks ? '\n' + blocks : '');
}

// auto-laya: the whole toolbox in one compact block at session start, so the agent knows what exists and what each is for
const purpose = (it, n = 9) => {
  const own = new Set(String(it.name).toLowerCase().split(/[^a-z0-9]+/));
  const seen = new Set();
  const w = String(it.desc || '').replace(/^(use (this skill )?(when|whenever|for)|this skill)\s*/i, '').split(/\s+/)
    .filter((x, i) => { const k = x.toLowerCase().replace(/[^a-z0-9]/g, ''); if (!k || (i < 4 && own.has(k)) || seen.has(k)) return false; seen.add(k); return true; });
  return w.slice(0, n).join(' ').replace(/[,.;:]+$/, '');
};
function capabilityMap(items, max = 3800) {
  const inst = items.filter((i) => i.installed && !/(^|[:_-])laya([:_-]|$)/i.test(i.id));
  const byPlugin = new Map();
  for (const it of inst) if (it.plugin && it.kind !== 'plugin') { if (!byPlugin.has(it.plugin)) byPlugin.set(it.plugin, []); byPlugin.get(it.plugin).push(it); }
  const L = ['<laya-toolbox> what is installed and when to use it (laya picks per prompt; this is the map):'];
  for (const [pl, comps] of byPlugin) {
    const sk = comps.filter((c) => c.kind === 'skill'), mc = comps.filter((c) => c.kind === 'mcp'), ag = comps.filter((c) => c.kind === 'agent');
    const parts = [];
    if (sk.length) parts.push(`skills ${sk.map((c) => c.name.split(':').pop()).join(', ')}`);
    if (mc.length) parts.push(`MCP ${mc.map((c) => c.name.split(':').pop()).join(', ')} [${mc[0].toolPrefix ? mc[0].toolPrefix.replace(/[^_]+__$/, '') + '*' : ''}]`);
    if (ag.length) parts.push(`agents ${ag.map((c) => c.name.split(':').pop()).join(', ')}`);
    L.push(`- plugin ${pl}: ${parts.join(' · ')}`);
  }
  const loose = inst.filter((i) => !i.plugin && ['mcp', 'agent', 'skill'].includes(i.kind));
  for (const it of loose.filter((i) => i.kind === 'mcp')) L.push(`- MCP ${it.name} [${it.toolPrefix || ''}*]: ${purpose(it, 12)}`);
  for (const it of loose.filter((i) => i.kind === 'agent')) L.push(`- agent ${it.name}: ${purpose(it)}`);
  const sk = loose.filter((i) => i.kind === 'skill');
  if (sk.length) L.push(`- skills: ${sk.map((i) => i.name).join(', ')}`);
  L.push('Prefer these over improvising: a skill for its domain, an MCP server for the data/actions it owns (ToolSearch "select:<tool>" loads deferred tools), an agent for its specialty. Each prompt\'s <laya-decision> says which ones to use now.');
  L.push('</laya-toolbox>');
  let out = L.join('\n');
  if (out.length > max) out = out.slice(0, max - 20).replace(/\n[^\n]*$/, '') + '\n…\n</laya-toolbox>';
  return out;
}

// directive lines for a set of registry items (mid-task re-plans use the same wording as the main plan)
function useLines(list, native = true) {
  const sk = list.filter((i) => i.kind === 'skill'), mc = list.filter((i) => i.kind === 'mcp'), ag = list.filter((i) => i.kind === 'agent'), pl = list.filter((i) => i.kind === 'plugin');
  const L = [];
  if (sk.length) L.push(`skills: ${sk.map((i) => `${i.name} (${purpose(i, 7)})`).join('; ')}${native ? ' — load with the Skill tool' : ''}`);
  if (mc.length) L.push(`MCP: ${mc.map((i) => `${i.name} [${i.toolPrefix || ''}*]`).join(', ')} — load with ToolSearch if not in your tool list, then call`);
  if (ag.length) L.push(`agents: ${ag.map((i) => i.name).join(', ')}${native ? ' (Agent tool subagent_type)' : ''}`);
  if (pl.length) L.push(`plugins: ${pl.map((i) => i.name).join(', ')}`);
  return L;
}

module.exports = { message, context, plan, capabilityMap, useLines, purpose };
