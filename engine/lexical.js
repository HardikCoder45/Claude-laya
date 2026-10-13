'use strict';
// BM25 shortlist. Offline, ~ms, and the fallback whenever the Laya daemon is cold or late.
const { tokenize } = require('./util');
const stemJoin = (a, b) => tokenize(a + b)[0] || '';
const K1 = 1.2, B = Number(process.env.LAYA_LEX_B || 0.9); // low b: long, keyword-rich skill descriptions must not lose to one-line stubs

// "Do NOT use for PDFs or spreadsheets" is evidence AGAINST pdf prompts: drop negated clauses before indexing
const NEG = /\b(do not|don't|not for|never|skip (it )?(only )?when|not (be )?used? (for|when)|is not for|avoid (using|this) for)\b[^.;\n]*[.;]?/gi;
const positive = (s) => String(s || '').replace(NEG, ' ');

function index(items) {
  const df = new Map();
  const docs = items.map((it) => {
    const nm = tokenize(it.name.replace(/[:_-]/g, ' '));
    const toks = [...nm, ...nm, ...nm, ...tokenize(positive(it.desc))];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { it, tf, len: toks.length, leaf: [...new Set(tokenize(it.name.split(':').pop().replace(/[_-]/g, ' ')))] };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1) || 1;
  return { docs, df, avg, N: docs.length };
}

// Score is coverage-style (0..1): share of the query's informative terms the doc mentions, weighted by idf.
// Query words no item mentions still count in the denominator (at a moderate weight): "rename foo to bar in utils"
// must not be a perfect match for whatever happens to mention "rename". Synonyms only add evidence, at half weight.
const UNKNOWN = Number(process.env.LAYA_LEX_UNKNOWN || 0.6);
const SINGLE = Number(process.env.LAYA_SINGLE || 0.6);
const NAME_BOOST = Number(process.env.LAYA_NAME_BOOST || 0.25);
function rank(idx, query, { filter, limit = 20 } = {}) {
  const idf = (t) => Math.log(1 + (idx.N - (idx.df.get(t) || 0) + 0.5) / ((idx.df.get(t) || 0) + 0.5));
  const base = [...new Set(tokenize(query))];
  // "status line" -> statusline, "key bindings" -> keybinding: compound names are written both ways
  const joined = base.slice(1).map((t, i) => stemJoin(base[i], t));
  const syn = [...new Set([...tokenize(query, { expand: true }), ...joined])].filter((t) => !base.includes(t) && idx.df.has(t));
  const known = base.filter((t) => idx.df.has(t));
  if (!known.length && !syn.length) return [];
  const maxIdf = idf('\u0000');
  const unk = base.length - known.length;
  const terms = [...known.map((t) => [t, idf(t)]), ...syn.map((t) => [t, idf(t) * 0.5])].sort((x, y) => y[1] - x[1]).slice(0, 14);
  const denom = known.reduce((s, t) => s + idf(t), 0) + Math.min(unk, 4) * maxIdf * UNKNOWN;
  if (!denom) return [];
  const out = [];
  for (const d of idx.docs) {
    if (filter && !filter(d.it)) continue;
    let s = 0, hits = 0;
    for (const [t, w] of terms) {
      const f = d.tf.get(t);
      if (f) { s += w * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / idx.avg))); hits++; } // tf=1 at avg length -> 1.0
    }
    s = Math.min(1, s / denom);
    // the item's own name in the prompt is the strongest evidence there is ("render", "seo audit", "pptx")
    let named = false;
    if (d.leaf.length) { const lw = d.leaf.reduce((a, t) => a + idf(t), 0), hw = d.leaf.filter((t) => base.includes(t) || syn.includes(t)).reduce((a, t) => a + idf(t), 0); named = hw > 0; if (lw) s = Math.min(1, s + NAME_BOOST * (hw / lw)); }
    if (hits === 1 && !named) s *= SINGLE; // one shared word is a coincidence more often than a match
    s *= d.it.thin ? 0.6 : 1; // name-only catalog stubs carry little evidence
    if (s > 0) out.push({ item: d.it, score: s, hits });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { index, rank };
