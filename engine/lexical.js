'use strict';
// BM25 shortlist. Offline, ~ms, and the fallback whenever the Laya daemon is cold or late.
const { tokenize } = require('./util');
const K1 = 1.2, B = 0.4; // low b: long, keyword-rich skill descriptions must not lose to one-line stubs

function index(items) {
  const df = new Map();
  const docs = items.map((it) => {
    const toks = [...tokenize(it.name.replace(/[:_-]/g, ' ')), ...tokenize(it.name.replace(/[:_-]/g, ' ')), ...tokenize(it.name.replace(/[:_-]/g, ' ')), ...tokenize(it.desc)];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { it, tf, len: toks.length };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1) || 1;
  return { docs, df, avg, N: docs.length };
}

// Score is coverage-style (0..1): share of the query's most informative terms the doc mentions.
// Calibrated enough for absolute thresholds, which a raw BM25 score is not.
function rank(idx, query, { filter, limit = 20 } = {}) {
  const idf = (t) => Math.log(1 + (idx.N - (idx.df.get(t) || 0) + 0.5) / ((idx.df.get(t) || 0) + 0.5));
  const qs = [...new Set(tokenize(query, { expand: true }))].filter((t) => idx.df.has(t));
  const terms = qs.map((t) => [t, idf(t)]).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const denom = terms.reduce((s, [, w]) => s + w, 0);
  if (!denom) return [];
  const out = [];
  for (const d of idx.docs) {
    if (filter && !filter(d.it)) continue;
    let s = 0;
    for (const [t, w] of terms) {
      const f = d.tf.get(t);
      if (f) s += w * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / idx.avg))); // tf=1 at avg length -> 1.0
    }
    s = Math.min(1, s / denom) * (d.it.thin ? 0.6 : 1); // name-only catalog stubs carry little evidence
    if (s > 0) out.push({ item: d.it, score: s });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { index, rank };
