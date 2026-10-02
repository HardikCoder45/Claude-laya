'use strict';
// Did the turn actually do what Laya selected? Reads the finished turn from the Claude Code transcript
// (tool calls, text, model) and checks it against what the decision expected.
//   skill  called (Skill tool) | applied (named in Claude's "laya ▸ using:" line) | skipped (with a reason)
//          | delivered (SKILL.md was in context but Claude never confirmed) | missed (not loaded, not called)
//   mcp    count of calls to mcp__<server>__* tools
//   model  the model that answered vs the one planned (or an Agent call that delegated to it)
const fs = require('fs');
const models = require('./models');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bare = (id) => String(id).replace(/^(skill|agent|mcp):/, '').toLowerCase();
const sameName = (called, id) => { const a = bare(id), n = String(called || '').toLowerCase(); return !!n && (a === n || a.endsWith(`:${n}`) || n.endsWith(`:${a}`)); };

// The last real user prompt starts the turn; everything after it is the turn. Tool results are "user" rows too, skip those.
function lastTurn(file, maxBytes = 3 * 1024 * 1024) {
  if (!file) return null;
  let raw = '';
  try {
    const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, len = Math.min(size, maxBytes), b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd);
    raw = b.toString('utf8');
  } catch { return null; }
  const rows = [];
  for (const l of raw.split('\n')) { if (!l.startsWith('{')) continue; try { rows.push(JSON.parse(l)); } catch { /* cut first line of the tail */ } }
  const isPrompt = (r) => r.type === 'user' && !r.isSidechain && r.message && (typeof r.message.content === 'string' || (Array.isArray(r.message.content) && r.message.content.some((c) => c.type === 'text') && !r.message.content.some((c) => c.type === 'tool_result')));
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i--) if (isPrompt(rows[i])) { start = i + 1; break; }
  const turn = { text: '', calls: [], model: null };
  for (const r of rows.slice(start)) {
    if (r.type !== 'assistant' || !r.message) continue;
    if (!r.isSidechain && r.message.model && r.message.model !== '<synthetic>') turn.model = r.message.model;
    for (const c of Array.isArray(r.message.content) ? r.message.content : []) {
      if (c.type === 'text' && !r.isSidechain) turn.text += `${c.text}\n`;
      if (c.type === 'tool_use') turn.calls.push({ name: c.name, input: c.input || {}, side: !!r.isSidechain });
    }
  }
  return turn;
}

// "laya ▸ using: pdf, xlsx · skipped: docx (not a docx task)"
function ack(text) {
  const out = { using: '', skipped: '' };
  for (const m of String(text || '').matchAll(/laya\s*[▸>:-]+\s*using\s*:\s*([^\n]*)/gi)) {
    const [u, s = ''] = m[1].split(/skipped\s*:/i);
    out.using += ` ${u}`; out.skipped += ` ${s}`;
  }
  return out;
}
const mentions = (seg, name) => new RegExp(`(^|[^\\w-])${esc(name)}([^\\w-]|$)`, 'i').test(seg) || new RegExp(`(^|[^\\w-])${esc(String(name).split(':').pop())}([^\\w-]|$)`, 'i').test(seg);

function verify(expect, turn) {
  if (!expect || !turn) return null;
  const a = ack(turn.text), calls = turn.calls;
  const skills = (expect.skills || []).map((s) => {
    let state;
    if (calls.some((c) => c.name === 'Skill' && sameName(c.input.skill || c.input.name, s.id))) state = 'called';
    else if (mentions(a.using, s.name)) state = 'applied';
    else if (mentions(a.skipped, s.name)) state = 'skipped';
    else state = s.inlined ? 'delivered' : 'missed';
    return { ...s, state };
  });
  const mcp = (expect.mcp || []).map((m) => ({ ...m, calls: calls.filter((c) => String(c.name).startsWith(m.prefix)).length }));
  const agents = (expect.agents || []).map((g) => ({ ...g, calls: calls.filter((c) => (c.name === 'Task' || c.name === 'Agent') && sameName(c.input.subagent_type, g.id)).length }));
  let model = null;
  if (expect.model) {
    const actual = turn.model ? models.idToAlias(turn.model) || turn.model : null;
    const delegated = calls.some((c) => (c.name === 'Task' || c.name === 'Agent') && String(c.input.model || '').toLowerCase() === expect.model.alias);
    model = { planned: expect.model.alias, effort: expect.model.effort, actual, delegated, ok: actual == null ? null : actual === expect.model.alias || delegated };
  }
  const usedIds = [...skills.filter((s) => s.state === 'called' || s.state === 'applied').map((s) => s.id), ...mcp.filter((m) => m.calls).map((m) => m.id), ...agents.filter((g) => g.calls).map((g) => g.id)];
  // "ignored" for enforcement: named by the user (or any pick, in enforce=all) and neither used nor consciously skipped
  const unused = (all) => [
    ...skills.filter((s) => (all || s.named) && ['delivered', 'missed'].includes(s.state)).map((s) => ({ kind: 'skill', ...s })),
    ...mcp.filter((m) => (all || m.named) && !m.calls).map((m) => ({ kind: 'mcp', ...m })),
  ];
  return { skills, mcp, agents, model, usedIds, unused, ack: a };
}

const MARK = { called: '✔ called', applied: '✔ applied', skipped: '– skipped', delivered: '◐ loaded, not confirmed', missed: '✘ not used' };

// One compact line when all is well, a short table when something was ignored
function summary(v) {
  if (!v) return '';
  const rows = [];
  const good = (v.skills.every((s) => s.state === 'called' || s.state === 'applied' || s.state === 'skipped')) && v.mcp.every((m) => m.calls) && (!v.model || v.model.ok !== false);
  if (v.skills.length) rows.push(['skills', v.skills.map((s) => `${s.name} ${MARK[s.state]}`).join(' · ')]);
  if (v.mcp.length) rows.push(['mcp', v.mcp.map((m) => `${m.name} ${m.calls ? `✔ ${m.calls} call${m.calls > 1 ? 's' : ''}` : '✘ not used'}`).join(' · ')]);
  if (v.agents.length) rows.push(['agents', v.agents.map((g) => `${g.name} ${g.calls ? '✔ used' : '✘ not used'}`).join(' · ')]);
  if (v.model) {
    const m = v.model, plan = `${m.planned}${m.effort ? '/' + m.effort : ''}`;
    rows.push(['model', m.ok === null ? `planned ${plan} (running model unknown)` : m.ok ? `${m.delegated && m.actual !== m.planned ? `${m.planned} via Agent` : `ran ${m.actual}`} ✔ (planned ${plan})` : `ran ${m.actual}, planned ${plan} ✘ → /model ${m.planned}`]);
  }
  if (!rows.length) return '';
  if (good) {
    const n = (arr, f) => `${arr.filter(f).length}/${arr.length}`;
    const bits = [];
    if (v.skills.length) bits.push(`skills ${n(v.skills, (s) => s.state !== 'delivered' && s.state !== 'missed')}`);
    if (v.mcp.length) bits.push(`mcp ${n(v.mcp, (m) => m.calls)}`);
    if (v.agents.length) bits.push(`agents ${n(v.agents, (g) => g.calls)}`);
    if (v.model) bits.push(`model ${v.model.actual || v.model.planned}`);
    return `laya ▸ turn ✔ ${bits.join(' · ')}`;
  }
  return `laya ▸ turn check\n${rows.map(([a, b]) => `  ${a.padEnd(8)} ${b}`).join('\n')}`;
}

// Message sent back to Claude when something the user asked for was ignored
function nudge(list) {
  const lines = list.map((u) => u.kind === 'skill'
    ? `skill ${u.name}: ${u.inlined ? 'its instructions are already in your context above, follow them' : `load it with the Skill tool (skill "${u.name}")`}`
    : `MCP ${u.name}: call its tools (${u.prefix}*); load them with ToolSearch first if they are not in your tool list`);
  return `laya: this turn was meant to use ${list.map((u) => u.name).join(', ')} but did not. Do it now:\n- ${lines.join('\n- ')}\nIf one genuinely does not apply, say so in a line starting "laya ▸ using: ... skipped: <name> (<reason>)".`;
}

module.exports = { lastTurn, verify, summary, nudge, ack };
