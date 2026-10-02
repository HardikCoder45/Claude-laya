'use strict';
// Builds registry.json: every skill, agent, command, MCP server and plugin Laya may choose from,
// installed or not. One flat list of {id, kind, name, desc, installed, tok, ...}.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { P, readJson, writeJson, sanitize, mtime, ensureHome } = require('./util');

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

function scanSkills(dir, prefix, source, out) {
  for (const e of ls(dir)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const f = path.join(dir, e.name, 'SKILL.md');
    const fm = frontmatter(f);
    if (!fm) continue;
    const name = fm.name || e.name;
    out.push(item('skill', prefix ? `${prefix}:${name}` : name, fm.description, source, f));
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
  const d = sanitize(desc || '', 260);
  return { id: `${kind}:${name}`, kind, name, desc: d, source, file, installed: true, tok: tokOf(name, d), ...extra };
}

const norm = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

function scanMcpFile(file, source, plugin, out) {
  const j = readJson(file, null);
  if (!j) return;
  const servers = j.mcpServers || j;
  if (typeof servers !== 'object') return;
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object' || !(cfg.command || cfg.url || cfg.type)) continue;
    const label = plugin ? `${plugin}:${name}` : name;
    const prefix = plugin ? `mcp__plugin_${norm(plugin)}_${norm(name)}__` : `mcp__${norm(name)}__`;
    const hint = cfg.url ? `remote MCP server ${new URL(cfg.url, 'http://x').host}` : `MCP server ${path.basename(String(cfg.command || ''))} ${(cfg.args || []).slice(0, 2).join(' ')}`;
    out.push(item('mcp', label, `${name.replace(/[-_]/g, ' ')} ${hint}`, source, file, { toolPrefix: prefix, tok: 900 }));
  }
}

function build(cwd) {
  const items = [];
  const seen = new Set();
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
  const cj = readJson(path.join(os.homedir(), '.claude.json'), {});
  const userMcp = path.join(os.homedir(), '.claude.json');
  if (cj.mcpServers) scanMcpFile(userMcp, 'user', '', tmp);
  push(tmp);

  // installed plugins
  const installed = readJson(path.join(P.claude, 'plugins', 'installed_plugins.json'), { plugins: {} }).plugins || {};
  const installedNames = new Set();
  for (const [id, arr] of Object.entries(installed)) {
    const ent = Array.isArray(arr) ? arr[0] : arr;
    const root = ent && ent.installPath;
    const pname = id.split('@')[0];
    installedNames.add(pname);
    if (!root) continue;
    const pj = readJson(path.join(root, '.claude-plugin', 'plugin.json'), {});
    const t = [];
    t.push(item('plugin', pname, pj.description || '', `plugin:${id}`, root, { marketplace: id.split('@')[1] }));
    scanSkills(path.join(root, 'skills'), pname, `plugin:${id}`, t);
    scanMd(path.join(root, 'agents'), 'agent', pname, `plugin:${id}`, t);
    scanMd(path.join(root, 'commands'), 'command', pname, `plugin:${id}`, t);
    scanMcpFile(path.join(root, '.mcp.json'), `plugin:${id}`, pname, t);
    push(t);
  }

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

  return { version: 1, builtAt: Date.now(), cwd: cwd || null, count: items.length, items };
}

function load(cwd, { force = false } = {}) {
  const cur = readJson(P.registry, null);
  const stale = !cur || force || Date.now() - cur.builtAt > REG_TTL_MS || (cwd && cur.cwd !== cwd) ||
    mtime(path.join(P.claude, 'plugins', 'installed_plugins.json')) > cur.builtAt;
  if (!stale) return cur;
  ensureHome();
  const reg = build(cwd);
  writeJson(P.registry, reg);
  return reg;
}

module.exports = { load, build, frontmatter };
