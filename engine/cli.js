'use strict';
// laya-conductor CLI: hooks, management commands, installer, adapters. Dispatch table at the bottom.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { P, ROOT, readJson, trunc, redact } = require('./util');
const state = require('./state');
const memory = require('./memory');
const inventory = require('./inventory');
const setup = require('./setup');

const flag = (argv, name, def = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def; };
const positional = (argv) => { const out = []; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++; } else out.push(argv[i]); } return out; };
const print = (s) => process.stdout.write(s + '\n');

function lastDecision() {
  try {
    const txt = fs.readFileSync(P.decisions, 'utf8').trimEnd().split('\n').slice(-200).reverse();
    for (const l of txt) { const j = JSON.parse(l); if (j.schema && !j.skipped) return j; }
  } catch { /* none yet */ }
  return null;
}

async function ping() { return setup.daemonLikelyAlive() ? setup.request({ op: 'ping' }, 800) : null; }

function fmtPicks(arr) { return arr.length ? arr.map((p) => `${p.name} (${p.score})`).join(' · ') : '—'; }

async function stack(argv) {
  const d = lastDecision(), st = state.get(), su = setup.status(), pg = await ping();
  if (flag(argv, 'json')) return print(JSON.stringify(d || {}, null, 2));
  const L = [];
  if (!d) L.push('LAYA STACK — no decision yet. Send a prompt and Laya will pick one.');
  else {
    L.push(`LAYA STACK  (${d.ts.replace('T', ' ').slice(0, 19)} · ${d.engine.mode}${d.engine.device ? '·' + d.engine.device : ''} · ${d.engine.latency_ms}ms${d.engine.fallback_reason ? ' · ' + d.engine.fallback_reason : ''})`);
    L.push(`task     ${d.task.domain} · difficulty ${d.task.difficulty}/4 · model-hint ${d.model_hint.tier}/${d.model_hint.effort} · swarm ${d.swarm.use ? d.swarm.topology : 'no'}`);
    if (d.model) L.push(`model    ${d.model.alias}${d.model.effort ? '/' + d.model.effort : ''}${d.model.forced ? ' [forced]' : ''} · now ${d.model.current || 'unknown'} · apply ${d.model.apply} · ${d.model.reason}`);
    if (d.loadout && d.picks.skills.length) L.push(`loadout  exclusive ${d.loadout.exclusive} · inlined ${d.loadout.inline.map((s) => s.name).join(', ') || 'none'} (${d.loadout.inline_tokens}/${d.loadout.budget} tok)${d.loadout.deferred.length ? ' · via Skill tool: ' + d.loadout.deferred.map((s) => s.name).join(', ') : ''}`);
    for (const [k, v] of [['skills', d.picks.skills], ['agents', d.picks.agents], ['mcp', d.picks.mcp], ['plugins', d.picks.plugins]]) L.push(`${k.padEnd(8)} ${fmtPicks(v)}`);
    if (d.install_queue.length) L.push(`install+ ${d.install_queue.map((q) => `${q.install || q.id} [${q.trust}]`).join(' · ')}   → /laya:install`);
    if (d.avoid.length) L.push(`avoid    ${d.avoid.map((a) => `${a.id}${a.banned ? ' (banned)' : ''} — ${a.reason}`).join(' · ')}`);
  }
  L.push('');
  L.push(`engine   setup ${su.state}${su.step && su.state === 'running' ? ' (' + su.step + ')' : ''} · daemon ${pg && pg.ok ? `${pg.warm} on ${pg.device}` : 'off (lexical fallback)'} · mode ${st.mode} · verbose ${st.verbose} · auto-laya ${st.auto ? 'on' : 'off'} · install ${st.install_policy}`);
  const reg = readJson(P.registry, null);
  if (reg) { const c = {}; for (const i of reg.items) c[`${i.kind}${i.installed ? '' : '*'}`] = (c[`${i.kind}${i.installed ? '' : '*'}`] || 0) + 1; L.push(`registry ${reg.count} items · ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(' · ')}  (* = not installed)`); }
  print(L.join('\n'));
}

async function status() {
  const su = setup.status(), st = state.get(), pg = await ping(), mem = memory.load(process.cwd());
  const rows = [...mem.rows.entries()];
  const bad = rows.filter(([, r]) => memory.effective(r) !== 'ok' && memory.effective(r) !== 'pin');
  const L = [
    `setup    ${su.state}${su.step ? ' · ' + su.step : ''}${su.error ? ' · ' + su.error : ''}`,
    `daemon   ${pg && pg.ok ? `${pg.warm} · ${pg.device} · ${pg.items} items embedded · pid ${pg.pid}` : 'not running (hooks use lexical fallback; it restarts on the next session)'}`,
    `settings mode=${st.mode} verbose=${st.verbose} auto=${st.auto} install=${st.install_policy} budget=${st.budget_ms}ms`,
    `laya.md  ${P.md} · ${rows.length} tracked · ${bad.length} penalized/banned${bad.length ? ': ' + bad.map(([k, r]) => `${k}[${memory.effective(r)}]`).join(', ') : ''}`,
    `home     ${P.home}`,
  ];
  print(L.join('\n'));
}

function explain() {
  const d = lastDecision();
  if (!d) return print('no decision yet');
  print(`why laya chose this (${d.engine.mode}, ${d.engine.latency_ms}ms)\n` +
    d.explain.top_k.map((r, i) => `${String(i + 1).padStart(2)}. ${r.name.padEnd(36)} score ${r.score}  lex ${r.lex}${r.laya_p != null ? `  laya_p ${r.laya_p}  emb ${r.emb}` : ''}${r.installed ? '' : '  [not installed]'}${r.pinned ? '  [pinned]' : ''}`).join('\n') +
    `\n\nhistory applied: ${JSON.stringify(d.history_applied)}\nrejected (below threshold ${d.engine.min_confidence}): ${d.explain.rejected.map((r) => `${r.name} ${r.score}`).join(', ') || '—'}`);
}

async function doctor() {
  const ok = (b) => (b ? '✓' : '✗');
  const L = [];
  const node = Number(process.versions.node.split('.')[0]);
  L.push(`${ok(node >= 18)} node ${process.versions.node}`);
  const has = (c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0;
  L.push(`${ok(has('uv') || has('python3'))} uv/python available (${has('uv') ? 'uv' : has('python3') ? 'python3' : 'none'})`);
  L.push(`${ok(has('claude'))} claude CLI   ${ok(has('git'))} git   ${ok(has('gh'))} gh (GitHub scout)   ${ok(has('npx'))} npx (skills scout)`);
  const su = setup.status();
  L.push(`${ok(su.state === 'ready')} setup: ${su.state}${su.error ? ' — ' + su.error : ''}  (log: ${P.log})`);
  if (fs.existsSync(setup.pyBin())) {
    const r = spawnSync(setup.pyBin(), ['-c', 'import laya,sys;print(getattr(laya,"__version__","?"))'], { encoding: 'utf8' });
    L.push(`${ok(r.status === 0)} laya python package ${r.status === 0 ? r.stdout.trim() : trunc(r.stderr, 100)}`);
  } else L.push('✗ venv missing — run: laya-conductor bootstrap');
  const pg = await ping();
  L.push(`${ok(pg && pg.ok)} daemon ${pg && pg.ok ? pg.warm + ' on ' + pg.device : 'not running'}`);
  const reg = readJson(P.registry, null);
  L.push(`${ok(reg && reg.count > 0)} registry ${reg ? reg.count + ' items' : 'empty — run laya-conductor refresh'}`);
  try { fs.accessSync(P.home, fs.constants.W_OK); L.push(`✓ ${P.home} writable`); } catch { L.push(`✗ ${P.home} not writable`); }
  // hook conflicts: other UserPromptSubmit hooks also injecting context
  const others = [];
  for (const f of [path.join(P.claude, 'settings.json'), path.join(process.cwd(), '.claude', 'settings.json')]) {
    const s = readJson(f, {}); for (const g of (s.hooks && s.hooks.UserPromptSubmit) || []) for (const h of g.hooks || []) if (h.command && !/laya-conductor/.test(h.command)) others.push(trunc(h.command, 70));
  }
  L.push(others.length ? `! ${others.length} other UserPromptSubmit hook(s) also run (they coexist; laya adds context, never blocks): ${others.join(' | ')}` : '✓ no conflicting UserPromptSubmit hooks in settings.json');
  print(L.join('\n'));
}

function exportTrain(argv) {
  // Weak labels from real outcomes: a pick the agent actually used (and that did not fail) is the gold answer;
  // if nothing from a kind was used, "none" is. Row shape matches Laya's fine-tune script: {state, questions, gold}.
  const out = flag(argv, 'out', path.join(P.home, 'train.jsonl'));
  const lines = fs.existsSync(P.decisions) ? fs.readFileSync(P.decisions, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const outcomes = new Map(lines.filter((l) => l.type === 'outcome').map((l) => [l.decision_id, l]));
  const rows = [];
  for (const d of lines.filter((l) => l.schema && !l.skipped && l.prompt && outcomes.has(l.id))) {
    const o = outcomes.get(d.id), good = new Set((o.used || []).filter((u) => !(o.failed || []).includes(u)));
    const questions = {}, gold = {};
    for (const kind of ['skill', 'agent', 'mcp']) {
      const cands = [...new Map((d.explain ? d.explain.top_k : []).filter((r) => r.id.startsWith(kind + ':')).map((r) => [r.name, r.id])).entries()].slice(0, 9);
      if (cands.length < 2) continue;
      const crit = Object.fromEntries(cands.map(([n]) => [n, n])); crit.none = 'none of these is a good fit for the request';
      questions[`pick_${kind}`] = { type: 'choice', instructions: `Which ${kind} would best help with \`request\`?`, criteria: crit };
      const hit = cands.filter(([, id]) => good.has(id));
      gold[`pick_${kind}`] = Object.fromEntries([...cands.map(([n, id]) => [n, hit.some(([, h]) => h === id) ? 0.9 / hit.length : 0.02]), ['none', hit.length ? 0.02 : 0.9]]);
    }
    if (Object.keys(questions).length) rows.push({ state: { request: d.prompt }, questions, gold });
  }
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  print(`wrote ${rows.length} weakly-labelled examples (from ${outcomes.size} outcomes) → ${out}\nSee docs/FINETUNE.md to turn this into a Laya fine-tune.`);
}

function ledger() {
  const mem = memory.load(process.cwd());
  const rows = [...mem.rows.entries()].sort((a, b) => b[1].fails - a[1].fails);
  print(rows.length ? rows.map(([k, r]) => `${k.padEnd(40)} wins ${String(r.wins).padStart(3)}  fails ${String(r.fails).padStart(3)}  ${memory.effective(r).padEnd(5)} ${r.note || ''}`).join('\n') : 'laya.md ledger is empty');
}

function statusline() {
  const d = lastDecision(), st = state.get();
  if (st.mode === 'off') return print('[LAYA:OFF]');
  if (!d) return print('[LAYA]');
  const n = d.picks.skills.length + d.picks.agents.length + d.picks.mcp.length;
  print(`[LAYA ${d.task.domain}·d${d.task.difficulty} ${n}⚙${d.avoid.length ? ' ⚠' + d.avoid.length : ''}${st.auto ? ' auto' : ''}]`);
}

const COMMANDS = {
  hook: (a) => require('./hooks').run(a[0], flag(a, 'agent', null)),
  decide: async (a) => print(JSON.stringify(await require('./decide').decide({ prompt: positional(a).join(' '), cwd: process.cwd(), sessionId: 'cli' }), null, 2)),
  stack, status, explain, doctor, statusline, shim: () => print(require('./adapters').shim()), ledger, 'export-train': exportTrain,
  learn: (a) => {
    const item = flag(a, 'item'), outcome = flag(a, 'outcome', 'fail');
    if (!item || item === true) throw new Error('usage: learn --item <kind:name> --outcome win|fail|note [--note "..."] [--project]');
    if (!['win', 'fail', 'note'].includes(outcome)) throw new Error('--outcome must be win|fail|note');
    memory.record(item, outcome, flag(a, 'note', '') === true ? '' : flag(a, 'note', ''), { cwd: process.cwd(), project: !!flag(a, 'project') });
    print(`laya ▸ recorded ${outcome} for ${item} → ${flag(a, 'project') ? '.laya/laya.md' : P.md}`);
  },
  pin: (a) => { const [i, ...n] = positional(a); memory.setVerdict(i, 'pin', n.join(' '), { cwd: process.cwd(), project: !!flag(a, 'project') }); print(`pinned ${i}`); },
  ban: (a) => { const [i, ...n] = positional(a); memory.setVerdict(i, 'ban', n.join(' '), { cwd: process.cwd(), project: !!flag(a, 'project') }); print(`banned ${i}`); },
  unpin: (a) => { const [i] = positional(a); memory.setVerdict(i, 'ok', 'cleared', { cwd: process.cwd() }); print(`cleared ${i}`); },
  unban: (a) => { const [i] = positional(a); memory.setVerdict(i, 'ok', 'cleared', { cwd: process.cwd() }); print(`cleared ${i}`); },
  models: (a) => {
    const M = require('./models'), st = state.get(), [sub, v] = a;
    if (sub === 'policy' && ['save', 'balanced', 'quality'].includes(v)) { state.set({ model_policy: v }); return print(`model policy → ${v}`); }
    if (sub === 'apply' && ['hint', 'auto', 'delegate'].includes(v)) {
      state.set({ model_apply: v });
      return print(`model apply → ${v}${v === 'auto' ? ' (Claude will switch model/effort itself where session tools exist)' : v === 'delegate' ? ' (when the pick differs from the running model, the work runs through the Agent tool with model=<pick>)' : ' (Laya suggests /model + /effort)'}`);
    }
    if (sub === 'force') {
      if (!v || v === 'off') { state.set({ model_force: null }); return print('model force → off (Laya routes by task again)'); }
      if (!M.registry().some((m) => m.alias === v)) return print(`unknown model "${v}". Known: ${M.registry().map((m) => m.alias).join(', ')}`);
      state.set({ model_force: v }); return print(`model force → ${v} (every prompt, until /laya:models force off)`);
    }
    if (sub === 'current') { state.set({ current_model: v && v !== 'none' ? v : null }); return print(`current model → ${v}`); }
    print(`policy ${st.model_policy} · apply ${st.model_apply} · force ${st.model_force || 'off'} · current ${st.current_model || 'auto-detected from the session'}   (edit ~/.laya/models.json to change tiers/costs)\n` +
      M.registry().map((m) => `${m.alias.padEnd(8)} tier ${m.tier}  cost ${m.cost}  efforts ${m.efforts.join('/') || 'n/a'}  ${m.id}  — ${m.note || ''}`).join('\n') +
      `\nusage: models policy save|balanced|quality · models apply hint|auto|delegate · models force <alias|off> · models current <alias|none>`);
  },
  loadout: (a) => {
    const [sub, v] = a, st = state.get();
    const num = (x, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : null; };
    if (sub === 'exclusive' && ['off', 'soft', 'hard'].includes(v)) { state.set({ exclusive: v }); return print(`exclusive → ${v}${v === 'hard' ? ' (Skill calls outside the selected set are blocked for that turn)' : v === 'soft' ? ' (Claude is told to use only the selected skills)' : ''}`); }
    if (sub === 'inline' && ['on', 'off'].includes(v)) { state.set({ skills_inline: v === 'on' }); return print(`inline → ${v}${v === 'on' ? ' (selected SKILL.md text is injected with the prompt)' : ' (names only; Claude loads skills itself)'}`); }
    if (sub === 'max' && num(v, 1, 8)) { state.set({ max_skills: num(v, 1, 8) }); return print(`max skills per prompt → ${num(v, 1, 8)}`); }
    if (sub === 'budget' && num(v, 200, 12000)) { state.set({ skill_budget: num(v, 200, 12000) }); return print(`inline budget → ${num(v, 200, 12000)} tokens (skills that do not fit whole are loaded via the Skill tool instead)`); }
    if (sub === 'enforce' && ['off', 'named', 'all'].includes(v)) { state.set({ enforce: v }); return print(`enforce → ${v}${v === 'named' ? ' (if a skill or MCP server you named is ignored, Claude is asked once to use it before the turn ends)' : v === 'all' ? ' (same for every selected skill and MCP server)' : ' (Laya only reports what was used)'}`); }
    if (sub === 'ack' && ['on', 'off'].includes(v)) { state.set({ ack: v === 'on' }); return print(`ack → ${v}${v === 'on' ? ' (Claude states which selected skills it applies, so use can be verified)' : ' (inlined skills can only be reported as loaded)'}`); }
    if (sub === 'confirm' && ['on', 'off'].includes(v)) { state.set({ confirm: v === 'on' }); return print(`confirm → ${v}${v === 'on' ? ' (Laya shows the plan and holds the prompt; send it again to run it)' : ''}`); }
    print(`exclusive ${st.exclusive} · inline ${st.skills_inline ? 'on' : 'off'} · max ${st.max_skills} skills · budget ${st.skill_budget} tok · confirm ${st.confirm ? 'on' : 'off'} · enforce ${st.enforce} · ack ${st.ack ? 'on' : 'off'}\n` +
      'usage: loadout exclusive off|soft|hard · loadout inline on|off · loadout max <1-8> · loadout budget <tokens> · loadout confirm on|off · loadout enforce off|named|all · loadout ack on|off');
  },
  trace: () => {
    // last planned turn: what Laya selected and what the turn actually did (from the Stop-hook outcome line)
    const rows = (() => { try { return fs.readFileSync(P.decisions, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } })();
    const d = [...rows].reverse().find((r) => r.schema && !r.skipped && r.picks);
    if (!d) return print('no decision yet: send a prompt first');
    const o = [...rows].reverse().find((r) => r.type === 'outcome' && r.decision_id === d.id);
    const emit = require('./emit');
    const L = [`last plan · ${d.task.domain}·d${d.task.difficulty}`, emit.plan(d, state.get())];
    if (!o) L.push('\nturn not finished yet (or Laya was off for it): no outcome recorded');
    else if (!o.verify) L.push(`\nused: ${o.used.join(', ') || 'nothing from the plan'} (no transcript check available)`);
    else {
      const v = o.verify;
      L.push('\nwhat actually happened');
      for (const [id, st] of v.skills) L.push(`  skill   ${id.replace(/^skill:/, '').padEnd(24)} ${st}`);
      for (const [id, n] of v.mcp) L.push(`  mcp     ${id.replace(/^mcp:/, '').padEnd(24)} ${n ? n + ' call(s)' : 'not used'}`);
      for (const [id, n] of v.agents) L.push(`  agent   ${id.replace(/^agent:/, '').padEnd(24)} ${n ? 'used' : 'not used'}`);
      if (v.model) L.push(`  model   planned ${v.model.planned}${v.model.effort ? '/' + v.model.effort : ''} · ran ${v.model.actual || '?'}${v.model.delegated ? ' (delegated via Agent)' : ''} · ${v.model.ok ? 'match' : v.model.ok === false ? 'DIFFERENT' : 'unknown'}`);
      L.push('\nskill states: called = Skill tool · applied = Claude named it in "laya ▸ using:" · skipped = left out with a reason · delivered = text was in context, not confirmed · missed = never loaded');
    }
    print(L.join('\n'));
  },
  mode: (a) => { const v = a[0]; if (!['on', 'shadow', 'off'].includes(v)) return print(`mode=${state.get().mode} (on|shadow|off)`); state.set({ mode: v }); print(`laya mode → ${v}`); },
  verbose: (a) => { const v = a[0]; if (!['quiet', 'normal', 'full'].includes(v)) return print(`verbose=${state.get().verbose} (quiet|normal|full)`); state.set({ verbose: v }); print(`laya verbosity → ${v}`); },
  auto: (a) => { const v = a[0]; if (!['on', 'off'].includes(v)) return print(`auto-laya is ${state.get().auto ? 'on' : 'off'}`); state.set({ auto: v === 'on' }); print(`auto-laya → ${v}. ${v === 'on' ? 'Laya will re-check the stack when tools fail twice and every 12 tool calls.' : ''}`); },
  policy: (a) => { const v = a[0]; if (!['ask', 'trusted', 'off'].includes(v)) return print(`install policy=${state.get().install_policy} (ask|trusted|off)`); state.set({ install_policy: v }); print(`install policy → ${v}`); },
  refresh: () => { const r = inventory.load(process.cwd(), { force: true }); print(`registry refreshed: ${r.count} items`); },
  scout: async (a) => { const r = await require('./installer').scout(positional(a).join(' ')); print(JSON.stringify(r, null, 2)); },
  vet: async (a) => print(JSON.stringify(await require('./installer').vet(positional(a)[0]), null, 2)),
  install: async (a) => {
    const spec = JSON.parse(flag(a, 'spec', '{}'));
    const r = await require('./installer').install(spec, { approve: !!flag(a, 'approve'), cwd: process.cwd() });
    print(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 1;
  },
  adapt: (a) => { const ad = require('./adapters'); print(ad.format(ad.adapt(positional(a)[0], { project: !flag(a, 'no-project') }))); },
  bootstrap: () => setup.bootstrap(),
  'daemon-run': () => setup.runDaemon(),
  'daemon-stop': () => print(setup.stopDaemon() ? 'daemon stopped' : 'daemon not running'),
  mcp: async (a) => {
    const srv = await require('./mcp').serve({ http: !!flag(a, 'http'), port: Number(flag(a, 'port', 8765)) || 8765 });
    if (srv) process.stderr.write(`laya mcp http listening on 127.0.0.1:${srv.address().port}\n`);
  },
};

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || !COMMANDS[cmd]) { print(`laya-conductor <${Object.keys(COMMANDS).join('|')}>`); return; }
  try { await COMMANDS[cmd](rest); } catch (e) { process.stderr.write(`laya: ${e.message}\n`); process.exitCode = 1; }
}

module.exports = { main, lastDecision };
