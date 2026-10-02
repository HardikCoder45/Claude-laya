'use strict';
// Model registry + routing: pick the cheapest model that is capable enough, with the right effort.
// Costs are RELATIVE weights (not dollars) and tiers are capability guesses: edit ~/.laya/models.json to match your plan.
const path = require('path');
const { P, readJson } = require('./util');
const memory = require('./memory');

const DEFAULTS = {
  models: [
    { alias: 'haiku', id: 'claude-haiku-4-5-20251001', tier: 1, cost: 1, efforts: [], note: 'trivial lookups, small edits, summaries' },
    { alias: 'sonnet', id: 'claude-sonnet-5-5', tier: 3, cost: 3, efforts: ['low', 'medium', 'high'], note: 'everyday coding and analysis' },
    { alias: 'opus', id: 'claude-opus-5-5', tier: 4, cost: 5, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], note: 'hard multi-step engineering, reviews' },
    { alias: 'fable', id: 'claude-fable-5-1', tier: 4, cost: 6, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], note: 'top capability; long-horizon and ambiguous work' },
  ],
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_COST = { low: 0.5, medium: 0.75, high: 1, xhigh: 1.5, max: 2 };

function registry() {
  const user = readJson(path.join(P.home, 'models.json'), null);
  const list = user && Array.isArray(user.models) ? user.models : DEFAULTS.models;
  return list.filter((m) => m && m.alias && m.tier).sort((a, b) => a.cost - b.cost);
}

const cap = (arr, e) => { // highest supported effort <= wanted
  if (!arr.length) return null;
  for (let i = EFFORTS.indexOf(e); i >= 0; i--) if (arr.includes(EFFORTS[i])) return EFFORTS[i];
  return arr[0];
};

// task: {difficulty 1-4, sensitive, multi_file, domain}; policy: save | balanced | quality
function choose(task, { policy = 'balanced', mem = null } = {}) {
  const reg = registry();
  if (!reg.length) return null;
  let need = Math.max(1, Math.min(4, task.difficulty + (task.sensitive ? 1 : 0) - (task.domain === 'chat' ? 1 : 0)));
  if (policy === 'quality') need = Math.min(4, need + 1);
  const usable = reg.filter((m) => { const a = mem ? memory.adjust(mem, `model:${m.alias}`) : { banned: false }; return !a.banned; });
  const pool = usable.length ? usable : reg;
  const pickM = pool.find((m) => m.tier >= need) || pool[pool.length - 1];
  let ei = need === 1 ? 0 : need === 2 ? 1 : need === 3 ? 2 : (task.sensitive || task.multi_file ? 3 : 2);
  if (policy === 'save') ei = Math.max(0, ei - 1);
  if (policy === 'quality') ei = Math.min(4, ei + 1);
  const effort = cap(pickM.efforts || [], EFFORTS[ei]);
  const top = reg[reg.length - 1];
  const spend = pickM.cost * (effort ? EFFORT_COST[effort] : 0.75);
  const topSpend = top.cost * EFFORT_COST.high;
  const why = `need ${need}/4 (${task.sensitive ? 'sensitive, ' : ''}difficulty ${task.difficulty})${policy !== 'balanced' ? `, policy ${policy}` : ''}`;
  // delegate-cheap: subtasks that are trivial go to the cheapest model; reviews go one tier up
  const cheapest = reg[0], strongest = top;
  return {
    alias: pickM.alias, id: pickM.id, effort, tier: pickM.tier, rel_cost: +spend.toFixed(2),
    savings_pct: Math.max(0, Math.round((1 - spend / topSpend) * 100)), reason: why,
    delegate: { trivial: cheapest.alias, review: strongest.alias },
  };
}

module.exports = { choose, registry, DEFAULTS, EFFORTS };
