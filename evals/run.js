#!/usr/bin/env node
'use strict';
// Decision-quality eval on a real inventory snapshot. Prints per-prompt picks and recall/precision.
//   node evals/run.js [--verbose] [--min-recall 0.9] [--min-precision 0.8]
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const verbose = args.includes('--verbose');

if (!process.env.LAYA_HOME) process.env.LAYA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-eval-'));
process.env.LAYA_NO_AUTOSETUP = '1';
process.env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.LAYA_HOME, 'claude');
const { P, writeJson } = require('../engine/util');
const { decide } = require('../engine/decide');

const inv = JSON.parse(fs.readFileSync(path.join(__dirname, 'inventory.realworld.json'), 'utf8'));
const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'realworld.cases.json'), 'utf8'));
const cwd = path.join(process.env.LAYA_HOME, 'proj');
fs.mkdirSync(cwd, { recursive: true });
const items = inv.items.map((i) => ({ file: null, source: 'snapshot', ...i }));

(async () => {
  let need = 0, got = 0, picked = 0, wrong = 0, modelOk = 0, modelN = 0;
  const fails = [];
  for (const [n, c] of cases.entries()) {
    writeJson(P.registry, { version: 3, builtAt: Date.now(), cwd, transcript: null, count: items.length, items });
    const d = await decide({ prompt: c.prompt, cwd, sessionId: `eval-${n}` });
    const picks = d.skipped ? [] : [...d.picks.skills, ...d.picks.mcp, ...d.picks.agents, ...d.picks.plugins].map((p) => p.id);
    const okSet = new Set([...(c.ok || []), ...c.expect.flat()]);
    const miss = c.expect.filter((e) => (Array.isArray(e) ? !e.some((x) => picks.includes(x)) : !picks.includes(e)));
    const extra = picks.filter((p) => !okSet.has(p));
    need += c.expect.length; got += c.expect.length - miss.length; picked += picks.length; wrong += extra.length;
    let mOk = null;
    if (c.model && d.model) { modelN++; mOk = c.model.includes(d.model.alias); if (mOk) modelOk++; }
    const bad = miss.length || extra.length || mOk === false;
    if (bad) fails.push(n);
    if (bad || verbose) {
      console.log(`${bad ? '✘' : '✔'} ${c.prompt}`);
      console.log(`    picks: ${picks.join(', ') || '(none)'}${d.skipped ? ` [skipped: ${d.skipped}]` : ''}  model ${d.model ? d.model.alias + '/' + d.model.effort : '-'} d${d.task ? d.task.difficulty : '-'}`);
      if (miss.length) console.log(`    missing: ${miss.map((m) => [].concat(m).join('|')).join(', ')}`);
      if (extra.length) console.log(`    extra:   ${extra.join(', ')}`);
      if (mOk === false) console.log(`    model:   wanted ${c.model.join('|')}`);
    }
  }
  const recall = got / (need || 1), precision = picked ? (picked - wrong) / picked : 1;
  console.log(`\n${cases.length - fails.length}/${cases.length} prompts exact · recall ${(recall * 100).toFixed(1)}% · precision ${(precision * 100).toFixed(1)}% · model ${modelOk}/${modelN}`);
  const minR = flag('--min-recall', 0), minP = flag('--min-precision', 0);
  if (recall < minR || precision < minP) process.exit(1);
})();
