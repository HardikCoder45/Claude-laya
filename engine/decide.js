'use strict';
// The decision pipeline: gate -> hybrid shortlist (BM25 + Laya embeddings) -> Laya typed decisions
// -> blend with laya.md history/pins/bans/token cost -> decision JSON (schema laya.decision/1).
const crypto = require('crypto');
const inventory = require('./inventory');
const lexical = require('./lexical');
const features = require('./features');
const memory = require('./memory');
const state = require('./state');
const models = require('./models');
const loadout = require('./loadout');
const agents = require('./agents');
const setup = require('./setup');
const { P, redact, tokenize, appendLine, log, trunc } = require('./util');
const fs = require('fs');

const KINDS = ['skill', 'agent', 'mcp', 'plugin', 'command'];
const LIMIT = { skill: 3, agent: 2, mcp: 2, plugin: 2, command: 2 };
const TAU = { lexical: 0.25, laya: 0.35 };
const SELF = /^(skill|agent|command|plugin|mcp):(laya|plugin_laya)(:|$)/i;
const META = /\b(research|install(ing|ed)?|find|best|top|plugins?|skills?|agents?|mcps?|tools?|connectors?|set ?up|add|use|using|better|great|automatically)\b/gi;
const FOLLOWUP_MS = 15 * 60 * 1000;

const clamp = (x) => Math.max(0, Math.min(1, x));
const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); };

function gate(prompt, sess, st) {
  if (st.mode === 'off') return 'off';
  const p = prompt.trim();
  if (!p) return 'empty';
  if (p.startsWith('/')) return 'slash-command';
  const toks = tokenize(p);
  if (toks.length < 2) return 'trivial';
  const last = sess.lastDecision;
  if (last && Date.now() - last.ts < FOLLOWUP_MS && jaccard(toks, last.tokens || []) >= 0.55) return 'followup';
  return null;
}

function blend({ cands, lexMap, daemon, mem, tau }) {
  const out = [];
  for (const [kind, list] of Object.entries(cands)) {
    const d = daemon && daemon.kinds && daemon.kinds[kind];
    const byId = new Map(list.map((it) => [it.id, it]));
    const dmap = new Map(((d && d.cands) || []).map((c) => [c.id, c]));
    const embs = [...dmap.values()].map((c) => c.emb);
    const eMin = Math.min(...embs, 1), eMax = Math.max(...embs, 0);
    const topP = Math.max(0, ...[...dmap.values()].map((c) => c.p));
    const noneWins = !!d && d.none_p >= topP; // laya says nothing here fits: only strong lexical evidence may still pick
    for (const [id, it] of byId) {
      const lex = lexMap.get(id) || 0;
      const dc = dmap.get(id);
      let score = lex;
      let src = 'lexical';
      if (daemon && daemon.ready) {
        const emb = dc && eMax > eMin ? (dc.emb - eMin) / (eMax - eMin) : 0;
        const lp = dc ? dc.p / (dc.p + d.none_p + 1e-6) : 0;
        score = noneWins ? lex : 0.3 * lex + 0.2 * emb + 0.5 * lp;
        src = 'laya';
      }
      const adj = memory.adjust(mem, id);
      if (adj.banned) { out.push({ it, kind, score: 0, lex, banned: true, why: adj.why, src }); continue; }
      const tokPen = Math.min(0.08, (it.tok || 0) / 30000);
      score = score + adj.boost - adj.penalty - tokPen + (adj.pinned ? 0.5 : 0);
      out.push({ it, kind, score, lex, emb: dc && dc.emb, p: dc && dc.p, adj, src, pinned: adj.pinned });
    }
  }
  return out;
}

async function decide({ prompt, cwd, sessionId, agent = 'claude-code', transcript = null }) {
  const t0 = Date.now();
  const st = state.get();
  const sess = state.getSession(sessionId);
  const skip = gate(prompt, sess, st);
  const base = { schema: 'laya.decision/1', id: crypto.randomUUID(), ts: new Date().toISOString(), agent, cwd: cwd || null, session: sessionId || null, prompt_hash: crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12) };
  if (skip) return { ...base, skipped: skip, engine: { mode: 'skipped' } };

  const reg = inventory.load(cwd);
  const mem = memory.load(cwd);
  const items = reg.items;
  const idx = lexical.index(items);
  const feat = features.heuristic(prompt);
  // "research and install the best plugins for X": the topic is X, not the words about tooling
  const topic = feat.flags.needs_install ? (prompt.replace(META, ' ').split(/\s+/).filter(Boolean).length >= 2 ? prompt.replace(META, ' ') : prompt) : prompt;

  // lexical shortlist per kind (installed and not)
  const lexMap = new Map();
  const lexTop = {};
  for (const kind of KINDS) {
    const ranked = lexical.rank(idx, topic, { filter: (it) => it.kind === kind, limit: 1e9 });
    for (const r of ranked) lexMap.set(r.item.id, r.score);
    lexTop[kind] = ranked.slice(0, 20).map((r) => r.item);
  }

  // Laya daemon (warm path). Falls back to lexical when cold, late or absent.
  let daemon = null, mode = 'lexical', why = '';
  const bg = setup.ensureBackground();
  if (bg.action === 'setup-start' || bg.action === 'setup-running') why = 'laya setting up';
  else if (bg.action === 'setup-failed') why = 'laya setup failed';
  if (setup.daemonLikelyAlive() && st.mode !== 'off') {
    const banned = [...mem.rows.entries()].filter(([, r]) => memory.effective(r) === 'ban').map(([k]) => k);
    daemon = await setup.request({
      op: 'decide', prompt, exclude: banned,
      lex: Object.fromEntries(['skill', 'agent', 'mcp', 'plugin'].map((k) => [k, lexTop[k].map((i) => i.id)])),
    }, st.budget_ms);
    if (daemon && daemon.ok && daemon.ready) mode = 'laya';
    else { why = daemon && daemon.warm ? `laya ${daemon.warm}` : 'laya busy'; daemon = null; }
  } else if (!why) why = 'laya starting';

  // candidate pool = lexical top + whatever Laya shortlisted
  const byId = new Map(items.map((i) => [i.id, i]));
  const cands = {};
  for (const kind of KINDS) {
    const set = new Map(lexTop[kind].map((i) => [i.id, i]));
    if (daemon) for (const c of (daemon.kinds[kind] || { cands: [] }).cands) if (byId.has(c.id)) set.set(c.id, byId.get(c.id));
    cands[kind] = [...set.values()].filter((i) => !SELF.test(i.id)); // never recommend Laya's own tooling
  }
  const scored = blend({ cands, lexMap, daemon, mem, tau: TAU[mode] });
  const tau = TAU[mode];

  // features: prefer Laya, keep heuristic as the floor
  let f = { domain: feat.domain, domain_p: null, difficulty: feat.difficulty, flags: { ...feat.flags }, source: 'heuristic' };
  if (daemon) {
    f = { domain: daemon.features.domain.choice, domain_p: daemon.features.domain.p, difficulty: Math.min(4, Math.max(1, Math.round(daemon.features.difficulty.score) + 1)),
      flags: { ...feat.flags, ...Object.fromEntries(Object.entries(daemon.features.flags).map(([k, v]) => [k, v >= 0.5 || (feat.flags[k] && v >= 0.35)])) }, source: 'laya' }; // laya answers the semantic flags; regex keeps multi_file/needs_tools
    if (feat.flags.needs_install) f.flags.needs_install = true; // explicit install words are never a coin flip
  }

  // overlapping items (same description under different names, e.g. mirrored skills) collapse to the best one
  const pick = (kind, installed) => {
    const seenDesc = new Set();
    return scored.filter((s) => s.kind === kind && !s.banned && s.it.installed === installed && (s.pinned || s.score >= tau))
      .sort((a, b) => b.score - a.score)
      .filter((s) => { const k = s.it.desc.slice(0, 80).toLowerCase(); if (k.length > 30 && seenDesc.has(k)) return false; seenDesc.add(k); return true; })
      .slice(0, kind === 'skill' ? Math.max(1, Math.min(8, st.max_skills || LIMIT.skill)) : LIMIT[kind]);
  };
  const row = (s) => ({ id: s.it.id, name: s.it.name, score: +s.score.toFixed(3), lex: +s.lex.toFixed(3), laya_p: s.p != null ? +s.p.toFixed(3) : null, emb: s.emb != null ? +s.emb.toFixed(3) : null, tok: s.it.tok, installed: s.it.installed, pinned: !!s.pinned });
  const picks = { skills: pick('skill', true).map(row), agents: pick('agent', true).map(row), mcp: pick('mcp', true).map(row), plugins: pick('plugin', true).map(row), commands: pick('command', true).map(row) };

  // skills the user named outright ("use the pdf skill") are always selected, ahead of any ranking
  const named = loadout.mentioned(prompt, items).filter((it) => !memory.adjust(mem, it.id).banned);
  for (const it of named.reverse()) {
    const have = picks.skills.find((p) => p.id === it.id);
    if (have) { have.mentioned = true; picks.skills.splice(picks.skills.indexOf(have), 1); picks.skills.unshift(have); }
    else picks.skills.unshift({ id: it.id, name: it.name, score: 1, lex: 1, laya_p: null, emb: null, tok: it.tok, installed: true, pinned: true, mentioned: true });
  }
  picks.skills = picks.skills.slice(0, Math.max(Math.min(8, st.max_skills || LIMIT.skill), named.length));

  // same for MCP servers named outright; they lead the list and are marked so Claude is told it must use them
  const namedMcp = loadout.mentionedServers(prompt, items).filter((it) => !memory.adjust(mem, it.id).banned);
  for (const it of namedMcp.reverse()) {
    const have = picks.mcp.find((p) => p.id === it.id);
    if (have) { have.mentioned = true; picks.mcp.splice(picks.mcp.indexOf(have), 1); picks.mcp.unshift(have); }
    else picks.mcp.unshift({ id: it.id, name: it.name, score: 1, lex: 1, laya_p: null, emb: null, tok: it.tok, installed: true, pinned: true, mentioned: true });
  }
  picks.mcp = picks.mcp.slice(0, Math.max(LIMIT.mcp, namedMcp.length));

  const haveInstalled = picks.skills.length + picks.agents.length > 0;
  const wantInstall = f.flags.needs_install || f.flags.needs_research && !haveInstalled || (!haveInstalled && f.domain !== 'chat' && f.difficulty >= 3);
  const queue = wantInstall ? scored.filter((s) => !s.it.installed && !s.banned && s.score >= tau + 0.1).sort((a, b) => b.score - a.score).slice(0, 2)
    .map((s) => ({ id: s.it.id, install: s.it.install, source: s.it.source, trust: /claude-plugins-official|anthropic/.test(s.it.source) ? 'high' : 'med', score: +s.score.toFixed(3), tok: s.it.tok, reason: trunc(s.it.desc, 90) })) : [];

  const avoid = scored.filter((s) => s.banned || (s.adj && s.adj.penalty >= 0.15 && s.lex > 0.2))
    .sort((a, b) => b.lex - a.lex).slice(0, 3).map((s) => ({ id: s.it.id, reason: s.why || (s.adj && s.adj.why) || 'laya.md', banned: !!s.banned }));

  // model aliases (opus/sonnet/haiku) and the hard exclusive hook only exist in Claude Code
  const native = agents.native(agent);
  const model = !native ? null : models.choose({ difficulty: f.difficulty, sensitive: f.flags.sensitive, multi_file: f.flags.multi_file, domain: f.domain }, { policy: st.model_policy, mem, force: st.model_force });
  const current = st.current_model || models.detectCurrent(transcript) || models.idToAlias(sess.model) || null;
  const lo = { exclusive: !native && st.exclusive === 'hard' ? 'soft' : st.exclusive, ack: st.ack !== false, inline_on: st.skills_inline, ...loadout.plan(picks.skills, items, { inline: st.skills_inline, budget: st.skill_budget }) };
  lo.inline = lo.inline.map(({ id, name, tok }) => ({ id, name, tok })); // bodies are re-read at injection time, never stored
  const tier = f.difficulty >= 4 || f.flags.sensitive ? { tier: 'deep', effort: 'high' } : f.difficulty <= 1 ? { tier: 'fast', effort: 'low' } : { tier: 'balanced', effort: 'med' };
  const swarm = { use: f.flags.multi_file && f.difficulty >= 4, topology: 'hierarchical', agents: picks.agents.map((a) => a.id) };

  const d = {
    ...base,
    engine: { mode, checkpoint: 'english', latency_ms: Date.now() - t0, device: daemon ? daemon.device : null, daemon_ms: daemon ? daemon.ms : null, fallback_reason: mode === 'lexical' ? why : '', registry_items: items.length, min_confidence: tau },
    task: { domain: f.domain, difficulty: f.difficulty, ...f.flags, confidence: f.domain_p, source: f.source, lang: 'en' },
    picks, swarm, install_queue: queue, avoid, model_hint: tier, model: model ? { ...model, apply: st.model_apply, current, switch: !!(current && current !== model.alias) } : null,
    loadout: lo,
    history_applied: {
      penalties: scored.filter((s) => s.adj && s.adj.penalty > 0 && picks.skills.concat(picks.agents, picks.mcp).some((p) => p.id === s.it.id)).map((s) => s.it.id),
      boosts: scored.filter((s) => s.adj && s.adj.boost > 0).slice(0, 5).map((s) => s.it.id),
      pins: scored.filter((s) => s.pinned).map((s) => s.it.id), bans: scored.filter((s) => s.banned).map((s) => s.it.id),
    },
    explain: { top_k: scored.filter((s) => !s.banned).sort((a, b) => b.score - a.score).slice(0, 8).map(row), rejected: scored.filter((s) => !s.banned && s.score < tau).sort((a, b) => b.score - a.score).slice(0, 3).map(row) },
    auto_laya: { enabled: st.auto, redecide_on: ['tool_fail_x2', 'every_12_tools', 'ctx>60%'] },
    context_budget: { max: 300 }, outcome: null,
  };
  record(d, prompt, st);
  const inlined = new Set(lo.inline.map((x) => x.id));
  const prefixOf = (p) => (byId.get(p.id) || {}).toolPrefix || `mcp__${String(p.name).replace(/[^\w-]/g, '_')}__`;
  // what the Stop hook will check the finished turn against
  const expect = { skills: picks.skills.map((p) => ({ id: p.id, name: p.name, named: !!p.mentioned, inlined: inlined.has(p.id) })), mcp: picks.mcp.map((p) => ({ id: p.id, name: p.name, named: !!p.mentioned, prefix: prefixOf(p) })), agents: picks.agents.map((p) => ({ id: p.id, name: p.name })), model: model ? { alias: model.alias, effort: model.effort, apply: st.model_apply } : null, ack: lo.ack };
  state.setSession(sessionId, { lastDecision: { ts: Date.now(), tokens: tokenize(prompt), id: d.id, expect, picks: [...picks.skills, ...picks.agents, ...picks.mcp, ...picks.plugins].map((p) => p.id) }, fails: 0, tools: 0, used: [], failedItems: [], prompt: trunc(redact(prompt), 400) });
  return d;
}

function record(d, prompt, st) {
  try {
    const line = { ...d, prompt: st.log_prompts ? trunc(redact(prompt), 500) : undefined };
    try { if (fs.statSync(P.decisions).size > 5 * 1024 * 1024) fs.renameSync(P.decisions, P.decisions + '.1'); } catch { /* no file yet */ }
    appendLine(P.decisions, JSON.stringify(line));
  } catch (e) { log(`record failed: ${e.message}`); }
}

module.exports = { decide, gate, blend, KINDS };
