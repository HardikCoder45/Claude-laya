'use strict';
// scout (research) -> vet (static security scan) -> install (claude plugin / npx skills / claude mcp add).
// Auto-installing third-party code is a supply-chain risk, so every install passes policy + vet first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const inventory = require('./inventory');
const lexical = require('./lexical');
const memory = require('./memory');
const state = require('./state');
const { tokenize, sanitize, trunc, log } = require('./util');

const sh = (cmd, args, { timeout = 25000, cwd } = {}) => new Promise((res) => {
  execFile(cmd, args, { timeout, cwd, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => res({ ok: !err, code: err ? err.code : 0, out: String(stdout || ''), err: String(stderr || '') }));
});
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const toNum = (s) => { const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KkMm]?)/); return m ? parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1) : 0; };
const OFFICIAL = /^(claude-plugins-official|anthropic-agent-skills|anthropics|modelcontextprotocol|vercel-labs)$/;

const NOISE = new Set('best tools tool find install installing research plugin plugins skill skills agent agents mcp mcps connectors automatically great better want like give'.split(' '));
// external search wants real words (not the stemmed tokens used for matching)
function queryOf(task) { return [...new Set(String(task).toLowerCase().split(/[^a-z0-9.#+-]+/).filter((w) => w.length > 2 && !NOISE.has(w) && tokenize(w).length))].slice(0, 6).join(' '); }

async function fromLocal(task) {
  const reg = inventory.load(process.cwd());
  const idx = lexical.index(reg.items.filter((i) => i.kind === 'plugin'));
  return lexical.rank(idx, task, { filter: (i) => !i.installed, limit: 6 }).filter((r) => r.score >= 0.2).map((r) => ({
    source: 'marketplace', kind: 'plugin', name: r.item.name, desc: r.item.desc, rel: r.score,
    install: { type: 'plugin', target: r.item.install }, trust: OFFICIAL.test(r.item.marketplace || '') ? 'high' : 'med', signals: { tok: r.item.tok },
  }));
}

async function fromSkills(q) {
  const r = await sh('npx', ['-y', 'skills', 'find', q], { timeout: 30000 });
  const out = [];
  for (const m of stripAnsi(r.out).matchAll(/^([\w.-]+\/[\w.-]+)@([\w.:-]+)\s+([\d.,]+[KkMm]?)\s+installs/gm)) {
    const owner = m[1].split('/')[0];
    out.push({ source: 'skills.sh', kind: 'skill', name: m[2], desc: `skill ${m[2]} from ${m[1]}`, install: { type: 'skill', target: `${m[1]}@${m[2]}` }, trust: OFFICIAL.test(owner) ? 'high' : toNum(m[3]) >= 5e4 ? 'med' : 'low', signals: { installs: toNum(m[3]), repo: m[1] } });
  }
  return out.slice(0, 8);
}

async function fromGithub(q) {
  const core = q.split(' ').slice(0, 2).join(' '); // gh ANDs every word, so keep it short
  const runs = await Promise.all([`${core} claude skills`, `${core} mcp server`].map((s) => sh('gh', ['search', 'repos', s, '--sort', 'stars', '--limit', '6', '--json', 'fullName,description,stargazersCount,pushedAt,license,url'], { timeout: 25000 })));
  const arr = [];
  for (const r of runs) { try { arr.push(...JSON.parse(r.out)); } catch { /* gh missing or unauthenticated */ } }
  return arr.map((x) => {
    const fresh = Date.now() - Date.parse(x.pushedAt) < 180 * 864e5;
    return { source: 'github', kind: 'repo', name: x.fullName, desc: sanitize(x.description, 160), install: { type: 'github', target: x.fullName },
      trust: x.stargazersCount >= 200 && fresh && x.license ? 'med' : 'low', signals: { stars: x.stargazersCount, fresh, license: x.license && x.license.spdx_id || null } };
  });
}

async function fromMcpRegistry(q) {
  try {
    // the registry matches substrings of one term, so query the top terms separately and merge
    const pages = await Promise.all(q.split(' ').slice(0, 3).map(async (t) => (await fetch(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(t)}&limit=6`, { signal: AbortSignal.timeout(15000) })).json()));
    const j = { servers: pages.flatMap((p) => p.servers || []) };
    return j.servers.map(({ server: s }) => {
      const remote = (s.remotes || [])[0], pkg = (s.packages || [])[0];
      const short = s.name.split('/').pop().replace(/[^\w-]/g, '-');
      let target = null;
      if (remote) target = { transport: remote.type === 'sse' ? 'sse' : 'http', url: remote.url, name: short };
      else if (pkg && pkg.registryType === 'npm') target = { npm: pkg.identifier, name: short };
      else if (pkg && pkg.registryType === 'pypi') target = { pypi: pkg.identifier, name: short };
      if (!target) return null;
      return { source: 'mcp-registry', kind: 'mcp', name: s.name, desc: sanitize(s.description, 160), install: { type: 'mcp', target }, trust: /^io\.github\.modelcontextprotocol|^com\.(github|microsoft|google|cloudflare|stripe)/.test(s.name) ? 'med' : 'low', signals: { remote: !!remote, repo: s.repository && s.repository.url } };
    }).filter(Boolean);
  } catch { return []; }
}

async function scout(task, { limit = 10 } = {}) {
  const q = queryOf(task);
  const settled = await Promise.allSettled([fromLocal(task), fromSkills(q), fromGithub(q), fromMcpRegistry(q)]);
  const all = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  const qt = new Set(tokenize(task, { expand: true }));
  const seen = new Set(), out = [];
  for (const c of all) {
    const key = `${c.kind}:${c.name}`.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    const dt = tokenize(`${c.name} ${c.desc}`);
    const rel = c.rel != null ? c.rel : dt.length ? Math.min(1, dt.filter((t) => qt.has(t)).length / Math.max(3, Math.min(8, qt.size))) : 0;
    const pop = Math.min(1, Math.log10(1 + (c.signals.stars || 0) * 20 + (c.signals.installs || 0)) / 6);
    c.score = +(0.6 * rel + 0.25 * pop + { high: 0.15, med: 0.08, low: 0 }[c.trust]).toFixed(3);
    c.rel = +rel.toFixed(3);
    out.push(c);
  }
  return { query: q, sources: { local: settled[0].status, skills: settled[1].status, github: settled[2].status, mcp: settled[3].status }, candidates: out.sort((a, b) => b.score - a.score).slice(0, limit) };
}

// ---------- vet: static scan of a GitHub repo before any code from it runs ----------
const RULES = [
  [/curl[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh|wget[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh/i, 'high', 'pipes a download into a shell'],
  [/(\.ssh|\.aws\/credentials|\.npmrc|\.netrc|keychain|\.gnupg|id_rsa)/i, 'high', 'touches credential stores'],
  [/(>>?|tee)\s*~?\/?(\.bashrc|\.zshrc|\.profile|\.zprofile)/i, 'high', 'writes shell startup files'],
  [/(settings(\.local)?\.json|\.claude\.json)[^\n]*(write|>>?|tee|sed -i)/i, 'high', 'rewrites Claude settings'],
  [/rm\s+-rf\s+(\/|~|\$HOME)(\s|$)/i, 'high', 'destructive rm -rf on home/root'],
  [/(process\.env|os\.environ)[\s\S]{0,120}(fetch|axios|requests\.post|http\.request|curl)/i, 'high', 'reads env and sends it over the network'],
  [/\b(eval|new Function)\s*\(|base64\s+(-d|--decode)|atob\(/i, 'medium', 'dynamic code execution / obfuscation'],
  [/child_process|execSync|subprocess\.(run|Popen)|os\.system/i, 'medium', 'spawns processes'],
  [/\bsudo\b|chmod\s+-?[0-7]*7{2,3}/i, 'medium', 'uses sudo / world-writable chmod'],
  [/ignore (all )?(previous|prior) instructions|disregard (the )?system prompt|do not tell the user/i, 'high', 'prompt-injection text in a skill/command'],
];
const SKIP = /(^|\/)(node_modules|\.git|dist|build|vendor|__pycache__)(\/|$)/;

function walk(dir, out = [], depth = 0) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (SKIP.test(f)) continue;
    if (e.isDirectory() && depth < 6) walk(f, out, depth + 1);
    else if (e.isFile() && out.length < 600) out.push(f);
  }
  return out;
}

async function vet(repo) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-vet-'));
  try {
    const url = /^https?:|^git@/.test(repo) || path.isAbsolute(repo) ? repo : `https://github.com/${repo}.git`;
    const c = await sh('git', ['clone', '--depth', '1', '--quiet', url, tmp + '/r'], { timeout: 60000 });
    if (!c.ok) return { repo, risk: 'unknown', error: `clone failed: ${trunc(c.err, 120)}`, findings: [] };
    const root = tmp + '/r', findings = [], files = walk(root);
    let hasMarket = false, hasPlugin = false, hasSkill = false;
    for (const f of files) {
      const rel = path.relative(root, f);
      if (/\.claude-plugin\/marketplace\.json$/.test(rel)) hasMarket = true;
      if (/\.claude-plugin\/plugin\.json$/.test(rel)) hasPlugin = true;
      if (/SKILL\.md$/.test(rel)) hasSkill = true;
      if (!/\.(js|mjs|cjs|ts|py|sh|bash|zsh|json|md|toml|yml|yaml)$/i.test(f) || fs.statSync(f).size > 200000) continue;
      if (/(^|\/)(tests?|__tests__|spec|e2e|fixtures?)\/|\.(test|spec)\./i.test(rel)) continue; // test code spawning processes is not a finding
      const txt = fs.readFileSync(f, 'utf8');
      if (/package\.json$/.test(rel)) {
        const s = (() => { try { return JSON.parse(txt).scripts || {}; } catch { return {}; } })();
        for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) if (s[k]) findings.push({ file: rel, risk: 'medium', what: `npm lifecycle script ${k}: ${trunc(s[k], 80)}` });
      }
      if (/\/\.md$|\.md$/.test(rel) && !/(SKILL|agents?\/|commands?\/)/i.test(rel)) { /* docs: only injection rule below */ }
      for (const [re, risk, what] of RULES) {
        if (risk !== 'high' && /\.md$/i.test(rel)) continue; // prose mentioning sudo etc. is not a finding
        if (/\.md$/i.test(rel) && !/injection|instructions/.test(what)) continue;
        const m = re.exec(txt);
        if (m) findings.push({ file: rel, line: txt.slice(0, m.index).split('\n').length, risk, what });
      }
      if (/hooks\.json$/.test(rel)) { try { const j = JSON.parse(txt); findings.push({ file: rel, risk: 'medium', what: `declares hooks that run commands (${Object.keys(j.hooks || j).join(', ')})` }); } catch { /* not json */ } }
    }
    const rank = { high: 3, medium: 2, low: 1 };
    const risk = findings.some((x) => x.risk === 'high') ? 'high' : findings.some((x) => x.risk === 'medium') ? 'medium' : 'low';
    return { repo, risk, kind: hasMarket ? 'marketplace' : hasPlugin ? 'plugin' : hasSkill ? 'skills' : 'other', files: files.length, findings: findings.sort((a, b) => rank[b.risk] - rank[a.risk]).slice(0, 25) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- install ----------
async function knownMarketplaces() {
  const r = await sh('claude', ['plugin', 'marketplace', 'list'], { timeout: 20000 });
  return r.out;
}
const OFFICIAL_SRC = { 'claude-plugins-official': 'anthropics/claude-plugins-official', 'anthropic-agent-skills': 'anthropics/skills' };

function trustOf({ type, target }) {
  if (type === 'plugin') return OFFICIAL.test(String(target).split('@')[1] || '') ? 'high' : 'low';
  if (type === 'skill') return OFFICIAL.test(String(target).split('/')[0]) ? 'high' : 'low';
  return 'low'; // github repos and MCP servers always need approval
}

function policyAllows(st, trust, approve) {
  if (st.install_policy === 'off') return 'install_policy is off (laya-conductor policy ask|trusted)';
  if (approve) return null;
  if (st.install_policy === 'trusted' && trust === 'high') return null;
  return 'needs user approval: re-run with --approve after the user confirms';
}

async function install(spec, { approve = false, cwd } = {}) {
  const st = state.get();
  const { type, target } = spec;
  const trust = trustOf(spec); // never believe a caller-supplied trust label
  const deny = policyAllows(st, trust, approve);
  if (deny) return { ok: false, refused: deny };
  const steps = [];
  const run = async (cmd, args, opts) => { const r = await sh(cmd, args, { timeout: 180000, ...opts }); steps.push({ cmd: `${cmd} ${args.join(' ')}`, ok: r.ok, out: trunc((r.out + r.err).trim(), 300) }); return r.ok; };
  let id = null;

  if (type === 'plugin') {
    const [pname, mp] = String(target).split('@');
    id = `plugin:${pname}`;
    const known = await knownMarketplaces();
    if (mp && !known.includes(mp) && OFFICIAL_SRC[mp]) await run('claude', ['plugin', 'marketplace', 'add', OFFICIAL_SRC[mp]]);
    await run('claude', ['plugin', 'install', target, '--scope', 'user']);
  } else if (type === 'skill') {
    id = `skill:${String(target).split('@')[1] || target}`;
    await run('npx', ['-y', 'skills', 'add', target, '-g', '-y', '-a', 'claude-code']);
  } else if (type === 'mcp') {
    const t = target; id = `mcp:${t.name}`;
    if (t.url) await run('claude', ['mcp', 'add', '--scope', 'user', '--transport', t.transport, t.name, t.url]);
    else if (t.npm) await run('claude', ['mcp', 'add', '--scope', 'user', t.name, '--', 'npx', '-y', t.npm]);
    else if (t.pypi) await run('claude', ['mcp', 'add', '--scope', 'user', t.name, '--', 'uvx', t.pypi]);
  } else if (type === 'github') {
    const v = await vet(target);
    steps.push({ cmd: `vet ${target}`, ok: v.risk !== 'high', out: `risk=${v.risk} kind=${v.kind} findings=${v.findings.length}` });
    if (v.risk === 'high' || v.risk === 'unknown') return { ok: false, refused: `vet risk=${v.risk}: install manually if you trust it`, vet: v, steps };
    id = `repo:${target}`;
    if (v.kind === 'marketplace') { await run('claude', ['plugin', 'marketplace', 'add', target]); steps.push({ cmd: 'next', ok: true, out: `pick a plugin: claude plugin install <plugin>@${target.split('/').pop()}` }); }
    else if (v.kind === 'skills' || v.kind === 'plugin') await run('npx', ['-y', 'skills', 'add', target, '-g', '-y', '-a', 'claude-code']);
    else return { ok: false, refused: 'repo has no plugin/skills/marketplace layout', vet: v, steps };
  } else return { ok: false, refused: `unknown install type ${type}` };

  const ok = steps.length > 0 && steps.every((s) => s.ok || /^vet |^next/.test(s.cmd));
  inventory.load(cwd || process.cwd(), { force: true });
  if (id) memory.record(id, 'note', ok ? `installed by laya (${type})` : `install failed (${type})`, { cwd });
  if (!ok && id) memory.record(id, 'fail', 'install failed', { cwd });
  log(`install ${type} ${JSON.stringify(target)} ok=${ok}`);
  return { ok, id, steps, next: ok ? 'Run /reload-plugins (or restart) so new skills, agents, hooks and MCP servers load. MCP servers that need OAuth must be authorized by you.' : 'see steps' };
}

module.exports = { scout, vet, install };
