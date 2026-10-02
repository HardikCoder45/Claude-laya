'use strict';
// What the user sees (systemMessage) vs what the model gets (additionalContext).
const names = (arr) => arr.map((p) => p.name).join(', ');

function message(d, st) {
  if (d.skipped) return st.verbose === 'full' ? `laya ▸ skipped (${d.skipped})` : '';
  const p = d.picks, parts = [];
  parts.push(`${d.task.domain}·d${d.task.difficulty}`);
  if (p.skills.length) parts.push(`skills: ${names(p.skills)}`);
  if (p.agents.length) parts.push(`agents: ${names(p.agents)}`);
  if (p.mcp.length) parts.push(`mcp: ${names(p.mcp)}`);
  if (p.plugins.length) parts.push(`plugins: ${names(p.plugins)}`);
  if (parts.length === 1) parts.push('no extras needed');
  if (d.avoid.length) parts.push(`⚠ avoid: ${d.avoid.map((a) => a.id).join(', ')}`);
  if (d.install_queue.length) parts.push(`＋install: ${d.install_queue.map((q) => q.id.replace(/^plugin:/, '')).join(', ')} → /laya:install`);
  else if (d.task.needs_install) parts.push('＋ want new tools? → /laya:install <task>');
  if (d.model) parts.push(`model: ${d.model.alias}${d.model.effort ? '/' + d.model.effort : ''}${d.model.savings_pct ? ` (−${d.model.savings_pct}% tokens)` : ''}${d.model.current && d.model.current !== d.model.alias ? ` ⇄ now ${d.model.current}` : ''}`);
  const eng = d.engine.mode === 'laya' ? `laya${d.engine.device ? '·' + d.engine.device.replace('cuda:0', 'cuda') : ''} ${d.engine.latency_ms}ms` : `lexical${d.engine.fallback_reason ? ' (' + d.engine.fallback_reason + ')' : ''} ${d.engine.latency_ms}ms`;
  parts.push(eng);
  const quiet = st.verbose === 'quiet';
  const notable = d.avoid.length || d.install_queue.length || d.engine.fallback_reason.includes('failed');
  if (quiet && !notable) return '';
  let out = `laya ▸ ${st.mode === 'shadow' ? '(shadow) ' : ''}${parts.join(' │ ')}`;
  if (st.verbose === 'full') {
    out += '\n  ' + d.explain.top_k.map((r) => `${r.name} ${r.score}${r.laya_p != null ? ` (p=${r.laya_p})` : ''}${r.installed ? '' : ' [not installed]'}`).join('  ·  ');
    out += `\n  model-hint: ${d.model_hint.tier}/${d.model_hint.effort}${d.swarm.use ? ' · swarm: ' + d.swarm.topology : ''} · flags: ${Object.entries(d.task).filter(([k, v]) => v === true).map(([k]) => k).join(',') || 'none'}`;
  }
  return out;
}

// Compact on purpose: names + one rule. Descriptions stay out (token cost, and they are untrusted text).
function context(d) {
  const p = d.picks, L = ['<laya-decision v1>'];
  L.push(`task: ${d.task.domain}, difficulty ${d.task.difficulty}/4 · engine: ${d.engine.mode}`);
  const m = d.model;
  if (m) {
    L.push(`model plan (saves ~${m.savings_pct}% vs always-top): main work on ${m.alias}${m.effort ? ' at effort ' + m.effort : ''} [${m.reason}]. Delegate trivial subtasks to Agent model="${m.delegate.trivial}"${m.delegate.review !== m.alias ? `, hard reviews to model="${m.delegate.review}"` : ''}.`);
    if (m.apply === 'auto' && m.current !== m.alias) L.push(`apply now: if session tools set_session_model / set_session_effort are available, switch to ${m.alias}${m.effort ? '/' + m.effort : ''}; otherwise tell the user to run /model ${m.alias}${m.effort ? ' and /effort ' + m.effort : ''}.`);
    else if (m.current && m.current !== m.alias) L.push(`current model is ${m.current}; suggest /model ${m.alias}${m.effort ? ' + /effort ' + m.effort : ''} only if the user cares about cost.`);
  }
  if (p.skills.length) L.push(`use skills (Skill tool): ${p.skills.map((s) => s.name).join(', ')}`);
  if (p.agents.length) L.push(`use agents (Agent tool subagent_type): ${p.agents.map((s) => s.name).join(', ')}`);
  if (p.mcp.length) L.push(`use MCP servers: ${p.mcp.map((s) => s.name).join(', ')}`);
  if (p.plugins.length) L.push(`relevant plugins: ${p.plugins.map((s) => s.name).join(', ')}`);
  if (d.swarm.use) L.push(`task is large: consider a ${d.swarm.topology} agent swarm${d.swarm.agents.length ? ' using ' + d.swarm.agents.join(', ') : ''}`);
  if (d.avoid.length) L.push(`avoid (failed before, see laya.md): ${d.avoid.map((a) => `${a.id}${a.reason ? ' [' + a.reason + ']' : ''}`).join('; ')}`);
  if (d.install_queue.length) L.push(`better tools exist but are not installed: ${d.install_queue.map((q) => q.install || q.id).join(', ')} — offer \`/laya:install\` if the user wants them`);
  else if (d.task.needs_install) L.push('the user wants new tools: run the /laya:install flow (laya-conductor scout "<task>") instead of guessing');
  L.push('rule: if any skill/plugin/MCP/agent fails or misbehaves, run `laya-conductor learn --item <kind:name> --outcome fail --note "<why>"` so laya.md remembers. Picks are advisory; ignore ones that do not fit.');
  L.push('</laya-decision>');
  return L.join('\n');
}

module.exports = { message, context };
