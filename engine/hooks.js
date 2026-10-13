'use strict';
// Hook handlers. Contract: always print valid JSON, always exit 0 (fail-open) so Laya can never block a prompt.
const fs = require('fs');
const state = require('./state');
const memory = require('./memory');
const emit = require('./emit');
const setup = require('./setup');
const inventory = require('./inventory');
const lexical = require('./lexical');
const loadout = require('./loadout');
const agents = require('./agents');
const trace = require('./trace');
const models = require('./models');
const { decide } = require('./decide');
const { P, log, redact, trunc, appendLine, tokenize, sha } = require('./util');

const standing = (agent) => `laya is active: it picks skills/agents/MCP per prompt and learns from failures in ~/.laya/laya.md. If a skill, plugin, MCP server or agent fails or misbehaves, record it with \`${P.launcher} learn --item <kind:name> --outcome fail --note "<why>"\`.${agents.native(agent) ? '' : ' Laya MCP tools (laya_decide, laya_learn) are available if this agent has the laya server connected.'}`;

async function sessionStart(inp) {
  const st = state.get();
  const bg = setup.ensureBackground();
  try { require('./adapters').shim({ onlyIfStale: true }); } catch (e) { log(`shim refresh: ${e.message}`); }
  const reg = inventory.load(inp.cwd, { transcript: inp.transcript_path });
  const live = inp.model && (inp.model.id || inp.model);
  if (live && typeof live === 'string') state.setSession(inp.session_id, { model: live });
  let msg = '';
  if (bg.action === 'setup-start') msg = 'laya ▸ first run: installing Laya in the background (one-time, ~1-2 GB). Lexical mode until ready — check with /laya:status';
  else if (bg.action === 'setup-running') msg = `laya ▸ setup still running (${bg.step || '…'}) — lexical mode meanwhile`;
  else if (bg.action === 'setup-failed') msg = `laya ▸ setup failed: ${bg.error || 'see ~/.laya/laya.log'} — run /laya:doctor`;
  else if (bg.action === 'daemon-start') msg = `laya ▸ warming Laya · ${reg.count} items indexed`;
  else if (st.verbose !== 'quiet') msg = `laya ▸ ready · ${reg.count} items indexed · mode ${st.mode}${st.auto ? ' · auto-laya on' : ''}`;
  const ctx = st.auto ? `${standing(inp.agent)}\n${emit.capabilityMap(reg.items)}` : standing(inp.agent);
  if (st.auto) state.setSession(inp.session_id, { mapSent: true });
  const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } };
  if (msg) out.systemMessage = msg;
  return out;
}

const CONFIRM_TTL = 5 * 60 * 1000;
const AUTO_EVERY = 8;
const UNATTENDED = new Set(['auto', 'bypassPermissions', 'dontAsk']);
// auto-laya is on when the user turned it on, or (by default) while Claude Code works unattended
const autoOn = (st, inp) => !!st.auto || (st.auto_follows_mode !== false && UNATTENDED.has(inp.permission_mode));
// what the agent is doing right now, in words: the tool and the salient bits of its input (file names, queries, commands)
const recentWork = (inp) => `${String(inp.tool_name || '').replace(/^mcp__|__/g, ' ')} ${JSON.stringify(inp.tool_input || {}).replace(/[{}"\[\]]/g, ' ').slice(0, 300)}`;

async function userPrompt(inp) {
  const st = state.get(), sid = inp.session_id, prompt = inp.prompt || '';
  const sess = state.getSession(sid);
  // a prompt held by confirm mode and sent again runs with exactly the plan the user saw (no re-decide, no drift)
  const held = sess.pending && sess.pending.hash === sha(prompt, 12) && Date.now() - sess.pending.ts < CONFIRM_TTL ? sess.pending.decision : null;
  if (sess.pending) state.setSession(sid, { pending: null, ...(held ? { lastDecision: sess.pending.last } : {}) });
  const d = held || await decide({ prompt, cwd: inp.cwd, sessionId: sid, agent: inp.agent || 'claude-code', transcript: inp.transcript_path });
  if (d.skipped === 'system-event') return {}; // a background agent finishing etc.: the turn it belongs to keeps its plan
  const out = {};
  const live = !d.skipped && st.mode === 'on';

  // verification at Stop only makes sense for a turn Laya actually planned and injected into
  state.setSession(sid, { armed: !!live && !d.skipped });

  // exclusive=hard: remember what this turn may load, the PreToolUse hook enforces it
  if (!d.skipped) state.setSession(sid, { allowSkills: live && st.exclusive === 'hard' && d.picks.skills.length ? d.picks.skills.map((p) => p.id) : null });

  const wantsHold = st.confirm && !held && live && (!inp.agent || inp.agent === 'claude-code') && (d.model || d.picks.skills.length || d.picks.agents.length || d.picks.mcp.length);
  if (wantsHold) {
    // park the decision and un-arm the follow-up gate, so an edited resend is decided afresh instead of skipped
    state.setSession(sid, { pending: { hash: sha(prompt, 12), ts: Date.now(), decision: d, last: state.getSession(sid).lastDecision }, lastDecision: null });
    return { decision: 'block', reason: `${emit.message(d, { ...st, verbose: 'normal' })}\n\nHeld for your OK. Send the same prompt again to run it with this plan.\nChange it first: /laya:pin <item> · /laya:ban <item> · /laya:models force <alias> · /laya:loadout confirm off` };
  }

  const msg = emit.message(d, st);
  if (msg) out.systemMessage = held ? msg.replace('plan ·', 'confirmed ·') : msg;
  const auto = autoOn(st, inp);
  if (live) {
    let ctx = emit.context(d, { ...st, auto });
    // unattended sessions get the toolbox map once, with the first plan (SessionStart cannot see the permission mode)
    if (auto && !state.getSession(sid).mapSent) { ctx = `${emit.capabilityMap(inventory.load(inp.cwd).items)}\n${ctx}`; state.setSession(sid, { mapSent: true }); }
    out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: ctx };
  }
  return out;
}

// exclusive=hard: refuse Skill calls outside the set Laya selected for this turn (fail-open on any doubt)
async function preTool(inp) {
  const st = state.get();
  if (st.exclusive !== 'hard' || inp.tool_name !== 'Skill') return {};
  const s = state.getSession(inp.session_id);
  if (!s.allowSkills || !s.allowSkills.length) return {};
  const want = inp.tool_input && (inp.tool_input.skill || inp.tool_input.name);
  if (loadout.allowed(want, s.allowSkills)) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `laya: exclusive mode. This turn is limited to ${s.allowSkills.map((i) => i.replace(/^skill:/, '')).join(', ')}. Use those, or ask the user to name "${want}" / run /laya:loadout exclusive soft.` } };
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
  if (autoOn(st, inp) && tools % AUTO_EVERY === 0 && s.prompt) {
    const alt = await redecide(inp.cwd, s, `${s.prompt} ${recentWork(inp)}`);
    if (alt) return alt;
  }
  return {};
}

async function redecide(cwd, sess, query, exclude = []) {
  const reg = inventory.load(cwd);
  const mem = memory.load(cwd);
  const idx = lexical.index(reg.items);
  const have = new Set(sess.lastDecision ? sess.lastDecision.picks : []);
  const found = lexical.rank(idx, query, { filter: (i) => ['skill', 'agent', 'mcp', 'plugin'].includes(i.kind) && !exclude.includes(i.id) && !memory.adjust(mem, i.id).banned && !/(^|[:_-])laya([:_-]|$)/i.test(i.id), limit: 8 })
    .filter((r) => r.score >= 0.3 && !have.has(r.item.id)).slice(0, 4);
  if (!found.length) return null;
  const inst = found.filter((r) => r.item.installed).map((r) => r.item), miss = found.filter((r) => !r.item.installed).map((r) => r.item);
  const parts = [];
  if (inst.length) parts.push(`use now (installed): ${emit.useLines(inst).join(' | ')}`);
  if (miss.length) parts.push(`not installed: ${miss.map((i) => i.install || i.name).join(', ')} → offer /laya:install`);
  return { systemMessage: `laya ▸ auto: ${[...inst.map((i) => i.name), ...miss.map((i) => (i.install || i.name) + ' (not installed)')].join(', ')}`, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `<laya-auto> the work has moved on; laya re-planned from what you are doing now. ${parts.join('. ')}.</laya-auto>` } };
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
  if (autoOn(st, inp) && fails >= 2) {
    const alt = await redecide(inp.cwd, { ...s, id: sid }, `${s.prompt || ''} ${inp.tool_name} ${err}`, failedItems);
    if (alt) return { systemMessage: [out.systemMessage, alt.systemMessage].filter(Boolean).join('\n'), hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: alt.hookSpecificOutput.additionalContext } };
  }
  return out;
}

async function stop(inp) {
  const sid = inp.session_id;
  const s = state.getSession(sid);
  if (!s.lastDecision) return {};
  const st = state.get();
  const picks = s.lastDecision.picks || [];

  // Did the turn really use what was selected? (transcript = the evidence; hooks only see tool calls, not inlined skills)
  let v = null;
  if (s.armed && s.lastDecision.expect) {
    try { v = trace.verify(s.lastDecision.expect, trace.lastTurn(inp.transcript_path)); } catch (e) { log(`trace: ${e.message}`); }
  }
  // enforce: ask once for what the user named (or everything, enforce=all) before letting the turn end
  if (v && st.enforce !== 'off' && !inp.stop_hook_active) {
    const missed = v.unused(st.enforce === 'all');
    if (missed.length) return { decision: 'block', reason: trace.nudge(missed), systemMessage: `laya \u25b8 ${missed.map((m) => m.name).join(', ')} not used yet: asking Claude to apply ${missed.length > 1 ? 'them' : 'it'}` };
  }

  const usedAll = [...new Set([...s.used, ...(v ? v.usedIds : [])])];
  const hit = picks.filter((p) => usedAll.includes(p));
  const ignored = picks.filter((p) => !usedAll.includes(p));
  const wins = usedAll.filter((u) => !s.failedItems.includes(u)).slice(0, 8);
  for (const w of wins) memory.record(w, 'win', '', { cwd: inp.cwd });
  appendLine(P.decisions, JSON.stringify({ type: 'outcome', decision_id: s.lastDecision.id, ts: new Date().toISOString(), used: usedAll, picked_used: hit, picked_ignored: ignored, failed: s.failedItems, tools: s.tools,
    verify: v ? { skills: v.skills.map((x) => [x.id, x.state]), mcp: v.mcp.map((x) => [x.id, x.calls]), agents: v.agents.map((x) => [x.id, x.calls]), model: v.model } : undefined }));
  state.setSession(sid, { used: [], failedItems: [], tools: 0, fails: 0, allowSkills: null, armed: false, lastTrace: v ? trace.summary(v) : s.lastTrace });
  const line = v ? trace.summary(v) : '';
  const bad = line.includes('\n');
  if (line && (st.verbose === 'full' || (st.verbose === 'normal') || bad)) return { systemMessage: line + (st.verbose === 'full' ? `${wins.length ? ` \u00b7 +${wins.length} win(s) in laya.md` : ''}${s.failedItems.length ? ` \u00b7 failed: ${s.failedItems.join(', ')}` : ''}` : '') };
  if (st.verbose === 'full') return { systemMessage: `laya \u25b8 turn done: used ${hit.length}/${picks.length} picks${s.failedItems.length ? ` \u00b7 failed: ${s.failedItems.join(', ')}` : ''}${wins.length ? ` \u00b7 +${wins.length} win(s) in laya.md` : ''}` };
  return {};
}

const MAP = { 'session-start': sessionStart, prompt: userPrompt, 'pre-tool': preTool, 'post-tool': postTool, 'tool-failure': toolFailure, stop };

async function run(event, agent) {
  let out = {}, ag = agents.canon(agent) || 'claude-code';
  try {
    let inp = {};
    try { inp = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* empty stdin */ }
    if (process.env.LAYA_DEBUG_HOOKS === '1') appendLine(`${P.home}/hook-io.jsonl`, JSON.stringify({ event, in: inp }));
    if (!agent && agents.canon(inp.agent)) ag = agents.canon(inp.agent);
    inp = agents.normalize(ag, inp);
    inp.agent = ag;
    out = (await (MAP[event] || (async () => ({})))(inp)) || {};
  } catch (e) { log(`hook ${event} error: ${e.stack || e.message}`); out = {}; }
  let shaped = {};
  try { shaped = agents.render(ag, event, out) || {}; } catch (e) { log(`render ${ag}: ${e.message}`); }
  if (process.env.LAYA_DEBUG_HOOKS === '1') try { appendLine(`${P.home}/hook-io.jsonl`, JSON.stringify({ event, out: shaped })); } catch { /* debug only */ }
  process.stdout.write(JSON.stringify(shaped));
}

module.exports = { run, redecide, itemFor };
