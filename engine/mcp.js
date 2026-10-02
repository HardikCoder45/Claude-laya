'use strict';
// Minimal MCP server. Lets agents without hooks use Laya.
//   stdio (default)  newline-delimited JSON-RPC: Cursor, Windsurf, opencode, Codex, Gemini, Hermes, ...
//   --http           streamable-HTTP style POST endpoint for connector-only clients (ChatGPT), behind a secret token
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const readline = require('readline');
const inventory = require('./inventory');
const memory = require('./memory');
const lexical = require('./lexical');
const installer = require('./installer');
const { decide } = require('./decide');
const { P, ensureHome, trunc } = require('./util');

const TOOLS = [
  { name: 'laya_decide', description: 'Pick the best skills, agents, MCP servers and plugins for a task. Returns a laya.decision/1 JSON.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, cwd: { type: 'string' } }, required: ['prompt'] }, annotations: { readOnlyHint: true } },
  { name: 'laya_learn', description: 'Record that a skill/plugin/MCP/agent worked or failed (writes ~/.laya/laya.md).', inputSchema: { type: 'object', properties: { item: { type: 'string', description: 'kind:name, e.g. mcp:supabase' }, outcome: { type: 'string', enum: ['win', 'fail', 'note'] }, note: { type: 'string' } }, required: ['item', 'outcome'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'laya_search', description: 'Search the local registry (installed + available) by keyword.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, installed: { type: 'boolean' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
  { name: 'laya_scout', description: 'Research best installable skills/plugins/MCP servers for a task (read-only; installing is a separate approved step).', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] }, annotations: { readOnlyHint: true } },
];

async function call(name, a) {
  if (name === 'laya_decide') return decide({ prompt: a.prompt, cwd: a.cwd || process.cwd(), sessionId: 'mcp', agent: 'mcp' });
  if (name === 'laya_learn') { memory.record(a.item, a.outcome, a.note || ''); return { ok: true }; }
  if (name === 'laya_search') {
    const reg = inventory.load(process.cwd());
    const idx = lexical.index(reg.items);
    return lexical.rank(idx, a.query, { filter: (i) => a.installed == null || i.installed === a.installed, limit: 10 }).map((r) => ({ id: r.item.id, score: +r.score.toFixed(3), installed: r.item.installed, desc: trunc(r.item.desc, 120) }));
  }
  if (name === 'laya_scout') return installer.scout(a.task);
  throw new Error(`unknown tool ${name}`);
}

// One JSON-RPC message in, one response out (null for notifications). Transport-neutral.
async function handle(m) {
  if (!m || typeof m !== 'object' || m.id == null) return null; // notification
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  try {
    if (m.method === 'initialize') return reply({ protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'laya', version: '1.0.0' } });
    if (m.method === 'tools/list') return reply({ tools: TOOLS });
    if (m.method === 'tools/call') {
      const r = await call(m.params.name, m.params.arguments || {});
      return reply({ content: [{ type: 'text', text: JSON.stringify(r, null, 1) }] });
    }
    if (m.method === 'ping') return reply({});
    return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } };
  } catch (e) { return reply({ isError: true, content: [{ type: 'text', text: String(e.message) }] }); }
}

function serveStdio() {
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const r = await handle(m);
    if (r) send(r);
  });
}

// Secret for the HTTP endpoint: random, created once, 0600. Whoever has the URL can query your local registry.
function token() {
  const f = path.join(P.home, 'mcp-token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* first use */ }
  ensureHome();
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  return t;
}

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Accepts the token as a path segment (/mcp/<token>, for connector UIs with no header field) or as a Bearer header on /mcp.
function serveHttp({ port = 8765, host = '127.0.0.1' } = {}) {
  const tok = token();
  const server = http.createServer((req, res) => {
    const url = String(req.url || '').split('?')[0];
    const authed = same(url, `/mcp/${tok}`) || (url === '/mcp' && same(req.headers.authorization || '', `Bearer ${tok}`));
    const end = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (!authed) return end(404, '');
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return end(405, ''); }
    let raw = '', big = false;
    req.on('data', (c) => { raw += c; if (raw.length > 1 << 20) { big = true; req.destroy(); } });
    req.on('end', async () => {
      if (big) return;
      let msg; try { msg = JSON.parse(raw); } catch { return end(400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); }
      const batch = Array.isArray(msg);
      const out = (await Promise.all((batch ? msg : [msg]).map(handle))).filter(Boolean);
      if (!out.length) return end(202, '');
      end(200, JSON.stringify(batch ? out : out[0]));
    });
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server)); });
}

function serve(opts = {}) { return opts.http ? serveHttp(opts) : serveStdio(); }

module.exports = { serve, serveHttp, handle, token, TOOLS };
