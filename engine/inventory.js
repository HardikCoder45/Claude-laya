'use strict';
// Builds registry.json: every skill, agent, command, MCP server and plugin Laya may choose from,
// installed or not. One flat list of {id, kind, name, desc, installed, tok, ...}.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { P, readJson, writeJson, sanitize, mtime, ensureHome } = require('./util');
const listing = require('./listing');

const REG_TTL_MS = 15 * 60 * 1000;

function frontmatter(file) {
  let txt;
  try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(4096); const n = fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd); txt = b.toString('utf8', 0, n); } catch { return null; }
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (/^[>|][+-]?$/.test(v)) { v = ''; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) v += ' ' + lines[++i].trim(); }
      fm[kv[1]] = v.replace(/^["']|["']$/g, '');
    }
  }
  if (!fm.description) { // fall back to first prose line
    const body = txt.replace(/^---[\s\S]*?---\s*/, '').split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
    if (body) fm.description = body;
  }
  return fm;
}

const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const tokOf = (...parts) => Math.ceil(parts.join(' ').length / 4);

// Claude Code calls a skill by its folder name (frontmatter `name` is only a label), namespaced by plugin.
// Synced and nested layouts (skills/synced/<bucket>/<skill>/SKILL.md) are walked a few levels down.
function scanSkills(dir, prefix, source, out, depth = 0) {
  for (const e of ls(dir)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const f = path.join(dir, e.name, 'SKILL.md');
    const fm = fs.existsSync(f) ? frontmatter(f) : null;
    if (!fm) { if (depth < 3) scanSkills(path.join(dir, e.name), prefix, source, out, depth + 1); continue; }
    const alias = fm.name && fm.name !== e.name ? fm.name : null;
    out.push(item('skill', prefix ? `${prefix}:${e.name}` : e.name, `${alias ? alias.replace(/[-_]/g, ' ') + ' ' : ''}${fm.description || ''}`, source, f, alias ? { alias } : {}));
  }
}
function scanMd(dir, kind, prefix, source, out, depth = 0) {
  for (const e of ls(dir)) {
    const f = path.join(dir, e.name);
    if (e.isDirectory() && depth < 2) { scanMd(f, kind, prefix, source, out, depth + 1); continue; }
    if (!e.name.endsWith('.md') || /^readme/i.test(e.name)) continue;
    const fm = frontmatter(f);
    if (!fm) continue;
    const base = fm.name || e.name.replace(/\.md$/, '');
    out.push(item(kind, prefix ? `${prefix}:${base}` : base, fm.description, source, f));
  }
}

function item(kind, name, desc, source, file, extra = {}) {
  const d = sanitize(desc || '', 1200);
  return { id: `${kind}:${name}`, kind, name, desc: d, source, file, installed: true, tok: tokOf(name, d), ...extra };
}

const norm = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

// An MCP server's name is all we know offline, so give well-known ones the words people actually use in prompts.
const MCP_HINTS = [
  [/git(hub)?(?!lab)/, 'github repository repo pull request pr issue commit branch code review'], [/gitlab/, 'gitlab merge request pipeline repository issue'],
  [/linear/, 'linear issue ticket project sprint backlog'], [/jira|atlassian|confluence/, 'jira ticket issue confluence wiki atlassian'],
  [/slack/, 'slack message channel thread team chat'], [/notion/, 'notion page database docs wiki notes'], [/asana|trello|clickup/, 'task board project ticket'],
  [/supabase/, 'supabase postgres database sql table migration auth storage row policy'], [/postgres|pg$|mysql|sqlite|mariadb|database|db$/, 'database sql query table schema'],
  [/mongo/, 'mongodb database collection document query'], [/redis/, 'redis cache key value'], [/firebase|firestore/, 'firebase firestore database auth hosting'],
  [/playwright|puppeteer|browser|chrome|selenium/, 'browser automation web page testing screenshot scrape click end to end e2e'],
  [/context7|documentation|devdocs/, 'library documentation docs api reference framework version'], [/fetch|web-?reader|firecrawl|scrape/, 'fetch web page url scrape crawl'],
  [/brave|exa|tavily|perplexity|search|serp/, 'web search research find latest'], [/filesystem|fs$/, 'files filesystem read write directory'],
  [/memory|knowledge/, 'memory remember knowledge graph notes'], [/sequential|thinking/, 'reasoning step by step plan analysis'],
  [/figma/, 'figma design ui mockup component frame'], [/stripe/, 'stripe payments billing subscription invoice customer checkout'],
  [/sentry|datadog|grafana|newrelic|honeycomb/, 'errors monitoring crash stack trace logs metrics alert observability'],
  [/vercel|netlify|cloudflare|render|railway|heroku|fly/, 'deploy hosting production domain preview'], [/docker|kubernetes|k8s|terraform|helm/, 'container deploy cluster infrastructure devops'],
  [/aws|gcp|google-?cloud|azure|s3/, 'cloud aws gcp azure bucket infrastructure'], [/gmail|mail|outlook/, 'email inbox message draft send mail'],
  [/calendar|gcal/, 'calendar meeting event schedule availability'], [/drive|gdrive|dropbox|sheets|google docs?/, 'drive documents spreadsheet files share'],
  [/youtube|video/, 'youtube video transcript'], [/twilio|sms/, 'sms phone text message'], [/shopify|woocommerce/, 'shop store product order ecommerce'],
  [/hubspot|salesforce|crm/, 'crm contact deal lead customer'], [/airtable|sheet/, 'airtable spreadsheet table records'], [/openai|anthropic|llm|huggingface/, 'llm model ai embeddings'],
  [/amplitude|mixpanel|posthog|segment|heap/, 'product analytics events funnel retention signups users metrics dashboard'], [/ahrefs|semrush|moz/, 'seo keywords backlinks rankings organic traffic competitor'],
  [/similarweb/, 'website traffic competitor market share benchmark visits'], [/klaviyo|mailchimp|sendgrid|brevo/, 'email marketing campaign newsletter list subscribers flows'],
  [/supermetrics/, 'marketing data ads report google analytics facebook ads metrics'], [/canva/, 'design graphics social post poster presentation template image'],
  [/elevenlabs/, 'voice speech text to speech voiceover audio narration sound'], [/krea|higgsfield|midjourney|replicate|fal/, 'generate image video ai art picture render visual'],
  [/weather|forecast|meteo/, 'weather forecast temperature rain umbrella wind climate'], [/maps?|geo|places/, 'map location directions address places geocode'],
  [/time|clock/, 'time timezone date now'], [/everything/, 'demo test tools'], [/n8n|zapier|make/, 'automation workflow integration'],
];
const HINT_RX = MCP_HINTS.map(([rx, w]) => [new RegExp(`\\b(?:${rx.source})\\b`), w]); // whole words only: 'time' must not hit 'sometimes'
const mcpHint = (name) => { const n = String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return HINT_RX.filter(([rx]) => rx.test(n)).map(([, w]) => w).join(' '); };
const words = (s) => String(s).replace(/^plugin_/, '').replace(/^claude_ai_/, '').replace(/[-_]+/g, ' ');

function addMcp(servers, file, source, plugin, out) {
  if (!servers || typeof servers !== 'object') return;
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object' || !(cfg.command || cfg.url || cfg.type)) continue;
    const label = plugin ? `${plugin}:${name}` : name;
    const prefix = plugin ? `mcp__plugin_${norm(plugin)}_${norm(name)}__` : `mcp__${norm(name)}__`;
    const what = cfg.url ? `remote MCP server ${new URL(cfg.url, 'http://x').host}` : `MCP server ${path.basename(String(cfg.command || ''))} ${(cfg.args || []).slice(0, 2).join(' ')}`;
    out.push(item('mcp', label, `${words(name)} ${mcpHint(name)} ${what}`, source, file, { toolPrefix: prefix, tok: 900 }));
  }
}
function scanMcpFile(file, source, plugin, out) {
  const j = readJson(file, null);
  if (j) addMcp(j.mcpServers || j, file, source, plugin, out);
}

// Servers that only exist at runtime (claude.ai connectors, anything added by a path we do not parse) still leave
// tool names in past transcripts. Read the newest few: that is also real evidence the user has the server.
function observedMcp() {
  const root = path.join(P.claude, 'projects'), found = new Map();
  const files = [];
  for (const d of ls(root)) if (d.isDirectory()) for (const f of ls(path.join(root, d.name))) if (f.name.endsWith('.jsonl')) { const fp = path.join(root, d.name, f.name); files.push([fp, mtime(fp)]); }
  const cutoff = Date.now() - 45 * 86400000;
  for (const [fp] of files.filter(([, t]) => t > cutoff).sort((x, y) => y[1] - x[1]).slice(0, 30)) {
    let txt = '';
    try { const fd = fs.openSync(fp, 'r'), size = fs.fstatSync(fd).size, len = Math.min(size, 600000), b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd); txt = b.toString('utf8'); } catch { continue; }
    for (const m of txt.matchAll(/"name":"(mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+))"/g)) {
      if (/laya/i.test(m[2])) continue;
      const e = found.get(m[2]) || { server: m[2], tools: new Set() };
      e.tools.add(m[3]); found.set(m[2], e);
    }
  }
  return [...found.values()];
}

function build(cwd, { transcript = null } = {}) {
  const items = [];
  const seen = new Set();
  const disabled = new Set();
  const push = (arr) => { for (const it of arr) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); } };

  // user + project scope
  const tmp = [];
  scanSkills(path.join(P.claude, 'skills'), '', 'user', tmp);
  scanMd(path.join(P.claude, 'agents'), 'agent', '', 'user', tmp);
  scanMd(path.join(P.claude, 'commands'), 'command', '', 'user', tmp);
  if (cwd) {
    scanSkills(path.join(cwd, '.claude', 'skills'), '', 'project', tmp);
    scanMd(path.join(cwd, '.claude', 'agents'), 'agent', '', 'project', tmp);
    scanMd(path.join(cwd, '.claude', 'commands'), 'command', '', 'project', tmp);
    scanMcpFile(path.join(cwd, '.mcp.json'), 'project', '', tmp);
  }
  // ~/.claude.json holds user-scope servers and, per project path, local-scope ones (and which are switched off)
  const cfgFiles = [...new Set([path.join(P.claude, '.claude.json'), path.join(os.homedir(), '.claude.json')])];
  for (const cf of cfgFiles) {
    const cj = readJson(cf, null);
    if (!cj) continue;
    addMcp(cj.mcpServers, cf, 'user', '', tmp);
    if (cwd && cj.projects) {
      let dir = path.resolve(cwd);
      for (let i = 0; i < 6; i++) { // the project entry may be the repo root above cwd
        const pr = cj.projects[dir];
        if (pr) { addMcp(pr.mcpServers, cf, 'project', '', tmp); for (const off of pr.disabledMcpServers || []) disabled.add(`mcp:${off}`); }
        const up = path.dirname(dir); if (up === dir) break; dir = up;
      }
    }
  }
  push(tmp.filter((it) => !disabled.has(it.id)));

  // installed plugins: the registry file, plus plugin folders synced or unpacked elsewhere under ~/.claude/plugins
  const installed = readJson(path.join(P.claude, 'plugins', 'installed_plugins.json'), { plugins: {} }).plugins || {};
  const installedNames = new Set(), roots = new Set();
  const loadPlugin = (root, pname, source, mp) => {
    if (!root || roots.has(path.resolve(root))) return;
    roots.add(path.resolve(root));
    const pj = readJson(path.join(root, '.claude-plugin', 'plugin.json'), {});
    pname = pj.name || pname;
    installedNames.add(pname);
    const t = [];
    t.push(item('plugin', pname, `${pj.description || ''} ${(pj.keywords || []).join(' ')}`, source, root, mp ? { marketplace: mp } : {}));
    scanSkills(path.join(root, 'skills'), pname, source, t);
    scanMd(path.join(root, 'agents'), 'agent', pname, source, t);
    scanMd(path.join(root, 'commands'), 'command', pname, source, t);
    scanMcpFile(path.join(root, '.mcp.json'), source, pname, t);
    if (pj.mcpServers && typeof pj.mcpServers === 'object') addMcp(pj.mcpServers, path.join(root, '.claude-plugin', 'plugin.json'), source, pname, t);
    // plugin components point at the plugin; the plugin row lists what it brings, so "use the marketing plugin" has substance
    const comps = t.filter((x) => x.kind !== 'plugin');
    if (comps.length) { t[0].components = comps.map((x) => x.id); t[0].desc = sanitize(`${t[0].desc} ${comps.map((x) => x.name.split(':').pop().replace(/[-_]/g, ' ')).join(' ')}`, 1200); t[0].tok = tokOf(t[0].name, t[0].desc); }
    for (const x of comps) x.plugin = pname;
    push(t);
  };
  for (const [id, arr] of Object.entries(installed)) {
    const ent = Array.isArray(arr) ? arr[0] : arr;
    installedNames.add(id.split('@')[0]);
    loadPlugin(ent && ent.installPath, id.split('@')[0], `plugin:${id}`, id.split('@')[1]);
  }
  const looksLikePlugin = (d) => fs.existsSync(path.join(d, '.claude-plugin', 'plugin.json')) || fs.existsSync(path.join(d, 'skills')) || fs.existsSync(path.join(d, 'agents')) || fs.existsSync(path.join(d, 'commands'));
  const walkPlugins = (d, depth) => {
    for (const e of ls(d)) {
      if (!e.isDirectory() || e.name.startsWith('.') || ['marketplaces', 'node_modules', 'skills', 'agents', 'commands'].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (looksLikePlugin(full)) loadPlugin(full, e.name, 'plugin:local');
      else if (depth < 4) walkPlugins(full, depth + 1);
    }
  };
  walkPlugins(path.join(P.claude, 'plugins'), 0);

  // not-installed plugins from marketplaces the user already added (offline, free)
  const mpRoot = path.join(P.claude, 'plugins', 'marketplaces');
  for (const e of ls(mpRoot)) {
    const mp = readJson(path.join(mpRoot, e.name, '.claude-plugin', 'marketplace.json'), null);
    if (!mp || !Array.isArray(mp.plugins)) continue;
    for (const p of mp.plugins) {
      if (!p.name || installedNames.has(p.name)) continue;
      const kw = Array.isArray(p.keywords) ? p.keywords.join(' ') : '';
      push([item('plugin', p.name, `${p.description || ''} ${kw}`, `marketplace:${mp.name || e.name}`, null,
        { installed: false, marketplace: mp.name || e.name, install: `${p.name}@${mp.name || e.name}` })]);
    }
  }

  // Anthropic's official plugin catalog cache (names + real always-on token costs)
  const cat = readJson(path.join(P.claude, 'plugins', 'plugin-catalog-cache.json'), {}).catalog;
  if (cat && cat.plugins) {
    for (const [id, c] of Object.entries(cat.plugins)) {
      const [pname, mp] = id.split('@');
      if (installedNames.has(pname) || seen.has(`plugin:${pname}`)) continue;
      const comps = c.components || {};
      const names = ['skills', 'commands', 'agents'].flatMap((k) => (comps[k] || []).map((x) => x.name)).slice(0, 12).join(' ');
      const tokens = c.tokens ? Object.values(c.tokens)[0] : null;
      push([item('plugin', pname, `${pname.replace(/-/g, ' ')} ${names}`, `catalog:${mp}`, null,
        { installed: false, thin: true, marketplace: mp, install: id, tok: tokens ? tokens.always_on : 600 })]);
    }
  }

  // runtime-only servers + the tool names we have actually seen (they make the match text far richer than a server name)
  try {
    const byPrefix = new Map(items.filter((i) => i.toolPrefix).map((i) => [i.toolPrefix, i]));
    for (const o of observedMcp()) {
      const tools = [...o.tools].slice(0, 12), tw = tools.map(words).join(' ');
      const known = byPrefix.get(`mcp__${o.server}__`);
      if (known) { known.tools = tools; known.desc = sanitize(`${known.desc} ${tw}`, 1200); known.tok = tokOf(known.name, known.desc) + 800; continue; }
      const it = item('mcp', o.server, `${words(o.server)} ${mcpHint(o.server)} ${tw}`, 'seen', null, { toolPrefix: `mcp__${o.server}__`, tools, tok: 900 });
      if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    }
  } catch { /* transcripts are a bonus, never required */ }

  // ground truth from the transcript: rename to the exact invocable names, add what only exists at runtime
  const lst = listing.parse(listing.find(transcript, cwd));
  mergeListing(items, seen, lst);

  return { version: 3, builtAt: Date.now(), cwd: cwd || null, transcript: lst.file || null, model: lst.model, listed: { skills: lst.skills.size, agents: lst.agents.size, mcp: lst.mcp.size }, count: items.length, items };
}

const GENERIC_AGENTS = new Set(['claude', 'general-purpose', 'Explore', 'Plan']); // built-ins Claude already reaches for on its own: naming them adds noise, not information
const lead = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 48);
function rename(it, name, seen) { seen.delete(it.id); it.name = name; it.id = `${it.kind}:${name}`; seen.add(it.id); }

function mergeListing(items, seen, lst) {
  if (lst.skills.size) {
    const pool = items.filter((i) => i.kind === 'skill'), claimed = new Set();
    for (const [name, L] of lst.skills) {
      const short = name.split(':').pop(), ns = name.includes(':') ? name.split(':')[0] : null;
      const cand = pool.filter((i) => !claimed.has(i) && (i.name === name || i.name.split(':').pop() === short || (i.alias && (i.alias === short || i.alias === L.alias))));
      const best = cand.find((i) => i.name === name) || cand.find((i) => ns && i.plugin === ns) || cand.find((i) => lead(L.desc) && lead(i.desc).includes(lead(L.desc).slice(0, 30))) || (cand.length === 1 ? cand[0] : null);
      if (best) {
        claimed.add(best);
        if (best.name !== name) rename(best, name, seen);
        best.listed = true;
        if (L.desc && L.desc.length > best.desc.length) { best.desc = sanitize(L.desc, 1200); best.tok = tokOf(name, best.desc); }
      } else {
        const it = item('skill', name, L.desc, 'listed', null, { listed: true });
        if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
      }
    }
    for (const i of pool) if (!claimed.has(i) && i.installed) i.unlisted = true;
  }
  for (const [t, A] of lst.agents) {
    if (GENERIC_AGENTS.has(t)) continue;
    const have = items.find((i) => i.kind === 'agent' && (i.name === t || i.name.split(':').pop() === t));
    if (have) { if (have.name !== t) rename(have, t, seen); have.listed = true; continue; }
    const it = item('agent', t, A.desc, 'listed', null, { listed: true });
    if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
  }
  for (const [server, M] of lst.mcp) {
    if (/(^|_)laya(_|$)/i.test(server)) continue;
    const prefix = `mcp__${server}__`, tools = [...M.tools].slice(0, 40);
    const tw = tools.slice(0, 16).map(words).join(' ');
    const have = items.find((i) => i.kind === 'mcp' && i.toolPrefix === prefix);
    if (have) { have.tools = tools; have.listed = true; have.desc = sanitize(`${have.desc} ${M.desc} ${tw}`, 1500); have.tok = tokOf(have.name, have.desc) + 600; continue; }
    const it = item('mcp', server, `${words(server)} ${mcpHint(server)} ${M.desc} ${tw}`, 'listed', null, { toolPrefix: prefix, tools, listed: true });
    it.desc = sanitize(it.desc, 1500); it.tok = 900;
    if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
  }
}

function load(cwd, { force = false, transcript = null } = {}) {
  const cur = readJson(P.registry, null);
  const stale = !cur || cur.version !== 3 || force || Date.now() - cur.builtAt > REG_TTL_MS || (cwd && cur.cwd !== cwd) ||
    (transcript && cur.transcript !== transcript) ||
    mtime(path.join(P.claude, 'plugins', 'installed_plugins.json')) > cur.builtAt;
  if (!stale) return cur;
  ensureHome();
  const reg = build(cwd, { transcript });
  writeJson(P.registry, reg);
  return reg;
}

module.exports = { load, build, frontmatter };
