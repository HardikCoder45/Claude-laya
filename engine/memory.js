'use strict';
// laya.md: the universal, human-readable learning ledger (global ~/.laya/laya.md, optional per-project overlay).
// A markdown table is the machine-readable part; the Notes section is free text for people and for Claude.
const fs = require('fs');
const path = require('path');
const { P, ensureHome, withLock, redact, trunc } = require('./util');

const BEGIN = '<!-- laya:ledger -->';
const END = '<!-- /laya:ledger -->';
const COLS = '| item | wins | fails | last | verdict | until | note |\n|---|---|---|---|---|---|---|';
const DAY = 86400000;
const MAX_NOTES = 300;

const TEMPLATE = `# laya.md — Laya's learned memory (universal)

Laya reads this file before **every** decision. Items that keep failing are penalized or banned;
items that keep working are boosted. Claude and the hooks write here; you may edit it by hand.

- verdict: \`ok\` · \`warn\` (penalized) · \`ban\` (never picked until \`until\`) · \`pin\` (always picked when relevant)
- Record a problem: \`laya-conductor learn --item mcp:supabase --outcome fail --note "401 on every call"\`
- Never put secrets here. Anything that looks like one is redacted on write.

${BEGIN}
${COLS}
${END}

## Notes
`;

const safe = (s) => String(s ?? '').replace(/[|\r\n]+/g, ' ').trim();
const today = () => new Date().toISOString().slice(0, 10);

function parse(text) {
  const rows = new Map();
  const m = text.match(new RegExp(`${BEGIN}([\\s\\S]*?)${END}`));
  if (m) {
    for (const line of m[1].split('\n')) {
      const c = line.split('|').slice(1, -1).map((x) => x.trim());
      if (c.length < 7 || c[0] === 'item' || /^-+$/.test(c[0])) continue;
      rows.set(c[0], { wins: +c[1] || 0, fails: +c[2] || 0, last: c[3], verdict: c[4] || 'ok', until: c[5], note: c[6] });
    }
  }
  const notes = text.includes('## Notes') ? text.split('## Notes')[1].split('\n').filter((l) => l.startsWith('- ')) : [];
  return { rows, notes };
}

function render(rows, notes) {
  const body = [...rows.entries()].map(([k, r]) => `| ${k} | ${r.wins} | ${r.fails} | ${r.last || ''} | ${r.verdict} | ${r.until || ''} | ${trunc(safe(r.note), 160)} |`).join('\n');
  return TEMPLATE.replace(`${COLS}\n${END}`, `${COLS}${body ? '\n' + body : ''}\n${END}`).trimEnd() + '\n' + notes.slice(-MAX_NOTES).join('\n') + (notes.length ? '\n' : '');
}

function readFile(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

// Effective verdict: an expired ban decays to warn so one bad week does not exile an item forever.
function effective(r) {
  if (r.verdict === 'ban' && r.until && r.until < today()) return 'warn';
  return r.verdict;
}

function load(cwd) {
  const g = parse(readFile(P.md));
  const proj = cwd ? parse(readFile(path.join(cwd, '.laya', 'laya.md'))) : { rows: new Map(), notes: [] };
  const rows = new Map(g.rows);
  for (const [k, v] of proj.rows) rows.set(k, v); // project overlay wins
  return { rows, notes: [...g.notes, ...proj.notes] };
}

function writeRows(file, mut) {
  withLock('md', () => {
    ensureHome();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cur = parse(readFile(file) || TEMPLATE);
    mut(cur);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, render(cur.rows, cur.notes));
    fs.renameSync(tmp, file);
  });
}

// outcome: win | fail | note
function record(item, outcome, note, { cwd, project = false } = {}) {
  const id = safe(item);
  const n = trunc(redact(safe(note)), 160);
  const file = project && cwd ? path.join(cwd, '.laya', 'laya.md') : P.md;
  let changed = false;
  writeRows(file, (cur) => {
    const r = cur.rows.get(id) || { wins: 0, fails: 0, last: '', verdict: 'ok', until: '', note: '' };
    if (outcome === 'win') r.wins++;
    else if (outcome === 'fail') r.fails++;
    r.last = today();
    if (n) r.note = n;
    if (outcome === 'fail' && r.verdict === 'ok' && r.fails >= 2 && r.fails > r.wins) r.verdict = 'warn';
    if (outcome === 'fail' && r.verdict !== 'pin' && r.fails >= 5 && r.fails > 2 * r.wins) { r.verdict = 'ban'; r.until = new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10); }
    if (outcome === 'win' && r.verdict === 'warn' && r.wins >= r.fails) r.verdict = 'ok';
    cur.rows.set(id, r);
    if (outcome !== 'win' || n) {
      const line = `- ${today()} \`${id}\` ${outcome.toUpperCase()}${n ? ': ' + n : ''}`;
      if (!cur.notes.slice(-12).includes(line)) { cur.notes.push(line); changed = true; }
    }
  });
  return changed;
}

function setVerdict(item, verdict, note, { cwd, project = false } = {}) {
  const id = safe(item);
  const file = project && cwd ? path.join(cwd, '.laya', 'laya.md') : P.md;
  writeRows(file, (cur) => {
    const r = cur.rows.get(id) || { wins: 0, fails: 0, last: '', verdict: 'ok', until: '', note: '' };
    r.verdict = verdict; r.last = today();
    r.until = ''; // manual bans do not expire
    if (note) r.note = trunc(redact(safe(note)), 160);
    cur.rows.set(id, r);
    cur.notes.push(`- ${today()} \`${id}\` ${verdict.toUpperCase()}${note ? ': ' + trunc(redact(safe(note)), 160) : ''}`);
  });
}

// Score adjustment for one item from the ledger.
function adjust(mem, id) {
  const r = mem.rows.get(id);
  if (!r) return { boost: 0, penalty: 0, banned: false, pinned: false, why: '' };
  const v = effective(r);
  const net = r.fails - r.wins * 0.5;
  return {
    boost: Math.min(0.08, r.wins * 0.01),
    penalty: v === 'ok' ? Math.min(0.15, Math.max(0, net) * 0.04) : v === 'warn' ? Math.min(0.4, 0.15 + Math.max(0, net) * 0.05) : 0,
    banned: v === 'ban', pinned: v === 'pin',
    why: r.fails ? `${r.fails} fail${r.fails > 1 ? 's' : ''}${r.note ? ': ' + r.note : ''}` : '',
  };
}

module.exports = { load, record, setVerdict, adjust, effective, parse, render, TEMPLATE };
