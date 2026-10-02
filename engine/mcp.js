'use strict';
// Minimal MCP stdio server (newline-delimited JSON-RPC). Lets agents without hooks use Laya.
const readline = require('readline');
const inventory = require('./inventory');
const memory = require('./memory');
const lexical = require('./lexical');
const installer = require('./installer');
const { decide } = require('./decide');
const { trunc } = require('./util');

const TOOLS = [
  { name: 'laya_decide', description: 'Pick the best skills, agents, MCP servers and plugins for a task. Returns a laya.decision/1 JSON.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, cwd: { type: 'string' } }, required: ['prompt'] } },
  { name: 'laya_learn', description: 'Record that a skill/plugin/MCP/agent worked or failed (writes ~/.laya/laya.md).', inputSchema: { type: 'object', properties: { item: { type: 'string', description: 'kind:name, e.g. mcp:supabase' }, outcome: { type: 'string', enum: ['win', 'fail', 'note'] }, note: { type: 'string' } }, required: ['item', 'outcome'] } },
  { name: 'laya_search', description: 'Search the local registry (installed + available) by keyword.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, installed: { type: 'boolean' } }, required: ['query'] } },
  { name: 'laya_scout', description: 'Research best installable skills/plugins/MCP servers for a task (read-only; installing is a separate approved step).', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
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

function serve() {
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id == null) return; // notification
    try {
      if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'laya', version: '1.0.0' } } });
      else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
      else if (m.method === 'tools/call') {
        const r = await call(m.params.name, m.params.arguments || {});
        send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 1) }] } });
      } else if (m.method === 'ping') send({ jsonrpc: '2.0', id: m.id, result: {} });
      else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
    } catch (e) { send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: String(e.message) }] } }); }
  });
}

module.exports = { serve, TOOLS };
