'use strict';
// Hook handlers. Contract: always print valid JSON, always exit 0 (fail-open) so Laya can never block a prompt.
const fs = require('fs');
const state = require('./state');
const memory = require('./memory');
const emit = require('./emit');
const setup = require('./setup');
const inventory = require('./inventory');
const lexical = require('./lexical');
const { decide } = require('./decide');
const { P, log, redact, trunc, appendLine, tokenize } = require('./util');

const STANDING = 'laya is active: it picks skills/agents/MCP per prompt and learns from failures in ~/.laya/laya.md. If a skill, plugin, MCP server or agent fails or misbehaves, record it with `laya-conductor learn --item <kind:name> --outcome fail --note "<why>"`.';

async function sessionStart(inp) {
  const st = state.get();
  const bg = setup.ensureBackground();
  try { require('./adapters').shim({ onlyIfStale: true }); } catch (e) { log(`shim refresh: ${e.message}`); }
  const reg = inventory.load(inp.cwd, { force: false });
  let msg = '';
  if (bg.action === 'setup-start') msg = 'laya ▸ first run: installing Laya in the background (one-time, ~1-2 GB). Lexical mode until ready — check with /laya:status';
  else if (bg.action === 'setup-running') msg = `laya ▸ setup still running (${bg.step || '…'}) — lexical mode meanwhile`;
  else if (bg.action === 'setup-failed') msg = `laya ▸ setup failed: ${bg.error || 'see ~/.laya/laya.log'} — run /laya:doctor`;
  else if (bg.action === 'daemon-start') msg = `laya ▸ warming Laya · ${reg.count} items indexed`;
  else if (st.verbose !== 'quiet') msg = `laya ▸ ready · ${reg.count} items indexed · mode ${st.mode}${st.auto ? ' · auto-laya on' : ''}`;
  const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: STANDING } };
  if (msg) out.systemMessage = msg;
  return out;
}

async function userPrompt(inp) {
  const st = state.get();
  const d = await decide({ prompt: inp.prompt || '', cwd: inp.cwd, sessionId: inp.session_id, agent: inp.agent || 'claude-code' });
  const out = {};
  const msg = emit.message(d, st);
  if (msg) out.systemMessage = msg;
  if (!d.skipped && st.mode === 'on') out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: emit.context(d) };
  return out;
}

// tool name -> ledger item id
function itemFor(tool, input, cwd) {
  if (/^mcp__/.test(tool)) {
    const reg = inventory.load(cwd);
    const hit = reg.items.find((i) => i.kind === 'mcp' && i.toolPrefix && tool.startsWith(i.toolPrefix));
    if (hit) return hit.id;
    const m = tool.match(/^mcp__(.+?)__/);
    return m ? `mcp:${m[1]}` : null;
  }
  if (tool === 'Skill' && input && (input.skill || input.name)) return `skill:${input.skill || input.name}`;
  if ((tool === 'Task' || tool === 'Agent') && input && input.subagent_type) return `agent:${input.subagent_type}`;
  return null;
}

async function postTool(inp) {
  const sid = inp.session_id;
  const s = state.getSession(sid);
  const id = itemFor(inp.tool_name, inp.tool_input, inp.cwd);
  const used = id && !s.used.includes(id) ? [...s.used, id] : s.used;
  const tools = s.tools + 1;
  state.setSession(sid, { used, tools, fails: 0 });
  const st = state.get();
  // auto-laya: periodically re-check whether a better stack exists for what we are actually doing now
  if (st.auto && tools % 12 === 0 && s.prompt) {
    const alt = await redecide(inp.cwd, s, `${s.prompt} ${inp.tool_name}`);
    if (alt) return alt;
  }
  return {};
}

async function redecide(cwd, sess, query, exclude = []) {
  const reg = inventory.load(cwd);
  const mem = memory.load(cwd);
  const idx = lexical.index(reg.items);
  const have = new Set(sess.lastDecision ? sess.lastDecision.picks : []);
  const found = lexical.rank(idx, query, { filter: (i) => ['skill', 'agent', 'mcp', 'plugin'].includes(i.kind) && !exclude.includes(i.id) && !memory.adjust(mem, i.id).banned, limit: 6 })
    .filter((r) => r.score >= 0.3 && !have.has(r.item.id)).slice(0, 3);
  if (!found.length) return null;
  const inst = found.filter((r) => r.item.installed), miss = found.filter((r) => !r.item.installed);
  const parts = [];
  if (inst.length) parts.push(`consider (installed): ${inst.map((r) => r.item.name).join(', ')}`);
  if (miss.length) parts.push(`not installed: ${miss.map((r) => r.item.install || r.item.name).join(', ')} → /laya:install`);
  return { systemMessage: `laya ▸ auto: ${parts.join(' │ ')}`, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `<laya-auto>${parts.join('; ')}</laya-auto>` } };
}

async function toolFailure(inp) {
  const sid = inp.session_id;
  const err = String(inp.error || inp.tool_response || '');
  if (/interrupt|user (rejected|denied)|aborted by user/i.test(err)) return {};
  const s = state.getSession(sid);
  const id = itemFor(inp.tool_name, inp.tool_input, inp.cwd);
  const fails = s.fails + 1;
  const failedItems = id && !s.failedItems.includes(id) ? [...s.failedItems, id] : s.failedItems;
  state.setSession(sid, { fails, failedItems });
  const out = {};
  const st = state.get();
  if (id) {
    memory.record(id, 'fail', trunc(redact(err.replace(/\s+/g, ' ')), 140), { cwd: inp.cwd });
    if (st.verbose !== 'quiet') out.systemMessage = `laya ▸ recorded failure: ${id} → laya.md`;
  }
  if (st.auto && fails >= 2) {
    const alt = await redecide(inp.cwd, { ...s, id: sid }, `${s.prompt || ''} ${inp.tool_name} ${err}`, failedItems);
    if (alt) return { systemMessage: [out.systemMessage, alt.systemMessage].filter(Boolean).join('\n'), hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: alt.hookSpecificOutput.additionalContext } };
  }
  return out;
}

async function stop(inp) {
  const sid = inp.session_id;
  const s = state.getSession(sid);
  if (!s.lastDecision) return {};
  const picks = s.lastDecision.picks || [];
  const hit = picks.filter((p) => s.used.includes(p));
  const ignored = picks.filter((p) => !s.used.includes(p));
  const wins = s.used.filter((u) => !s.failedItems.includes(u)).slice(0, 8);
  for (const w of wins) memory.record(w, 'win', '', { cwd: inp.cwd });
  appendLine(P.decisions, JSON.stringify({ type: 'outcome', decision_id: s.lastDecision.id, ts: new Date().toISOString(), used: s.used, picked_used: hit, picked_ignored: ignored, failed: s.failedItems, tools: s.tools }));
  state.setSession(sid, { used: [], failedItems: [], tools: 0, fails: 0 });
  const st = state.get();
  if (st.verbose === 'full') return { systemMessage: `laya ▸ turn done: used ${hit.length}/${picks.length} picks${s.failedItems.length ? ` · failed: ${s.failedItems.join(', ')}` : ''}${wins.length ? ` · +${wins.length} win(s) in laya.md` : ''}` };
  return {};
}

const MAP = { 'session-start': sessionStart, prompt: userPrompt, 'post-tool': postTool, 'tool-failure': toolFailure, stop };

async function run(event, agent) {
  let out = {};
  try {
    let inp = {};
    try { inp = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* empty stdin */ }
    if (agent && !inp.agent) inp.agent = agent;
    out = (await (MAP[event] || (async () => ({})))(inp)) || {};
  } catch (e) { log(`hook ${event} error: ${e.stack || e.message}`); out = {}; }
  process.stdout.write(JSON.stringify(out));
}

module.exports = { run, redecide, itemFor };
