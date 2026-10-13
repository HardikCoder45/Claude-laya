'use strict';
// What Claude Code itself exposes to the model, read from the session transcript: the exact skill names the Skill
// tool accepts (skill_listing), the subagent types (agent_listing_delta), every MCP tool and server instructions
// (deferred_tools_delta, mcp_instructions_delta) and the running model (model). This is ground truth: names here are
// the ones Claude can call, whatever folder layout or sync mechanism put them on disk.
const fs = require('fs');
const path = require('path');
const { P, mtime } = require('./util');

const TYPES = /"type":"(skill_listing|agent_listing_delta|deferred_tools_delta|mcp_instructions_delta|model)"/;
const LIMIT = 24 * 1024 * 1024;

function readLines(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  const chunks = [];
  const grab = (pos, len) => { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); fs.closeSync(fd); chunks.push(b.toString('utf8')); };
  try { if (size <= LIMIT) grab(0, size); else { grab(0, LIMIT / 2); grab(size - LIMIT / 2, LIMIT / 2); } } catch { return []; }
  return chunks.join('\n').split('\n');
}

// "- marketing:brand-review: Review content…" / "- session-start-hook (startup-hook-skill): Creating…"
function parseSkills(text, out) {
  for (const line of String(text).split('\n')) {
    const m = line.match(/^- ([\w.@/-]+(?::[\w.@/-]+)*)(?: \(([^)]{1,80})\))?: (.*)$/);
    if (m) out.set(m[1], { name: m[1], alias: m[2] || null, desc: m[3] });
  }
}

function parse(file) {
  const out = { file, skills: new Map(), agents: new Map(), mcp: new Map(), model: null };
  if (!file) return out;
  for (const l of readLines(file)) {
    if (!l.includes('"attachment"') || !TYPES.test(l)) continue;
    let a;
    try { a = JSON.parse(l).attachment; } catch { continue; }
    if (!a) continue;
    if (a.type === 'skill_listing') parseSkills(a.content, out.skills);
    else if (a.type === 'agent_listing_delta') {
      const lines = a.addedLines || [];
      for (const t of a.addedTypes || []) {
        const ln = lines.find((x) => x.startsWith(`- ${t}:`)) || '';
        out.agents.set(t, { name: t, desc: ln.replace(/^- [^:]+:\s*/, '').replace(/\s*\(Tools:[^)]*\)\s*$/, '') });
      }
      for (const t of a.removedTypes || []) out.agents.delete(t);
    } else if (a.type === 'deferred_tools_delta') {
      for (const n of a.addedNames || []) {
        const m = n.match(/^mcp__(.+?)__(.+)$/);
        if (!m) continue;
        const s = out.mcp.get(m[1]) || { server: m[1], tools: new Set(), desc: '' };
        s.tools.add(m[2]); out.mcp.set(m[1], s);
      }
      for (const n of a.removedNames || []) { const m = n.match(/^mcp__(.+?)__(.+)$/); if (m && out.mcp.has(m[1])) out.mcp.get(m[1]).tools.delete(m[2]); }
    } else if (a.type === 'mcp_instructions_delta') {
      (a.addedNames || []).forEach((n, i) => {
        const key = String(n).replace(/[^A-Za-z0-9_-]/g, '_');
        const s = out.mcp.get(key) || { server: key, tools: new Set(), desc: '' };
        s.desc = String((a.addedBlocks || [])[i] || '').replace(/^##[^\n]*\n/, '').slice(0, 400);
        out.mcp.set(key, s);
      });
    } else if (a.type === 'model' && a.identity && a.identity.modelId) out.model = a.identity.modelId;
  }
  for (const [k, s] of out.mcp) if (!s.tools.size && !s.desc) out.mcp.delete(k);
  return out;
}

// The transcript to trust: the one the hook was handed, else the newest one for this project that has a listing.
function find(transcript, cwd) {
  if (transcript && fs.existsSync(transcript)) return transcript;
  const dirs = [];
  if (cwd) dirs.push(path.join(P.claude, 'projects', path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-')));
  dirs.push(...(() => { try { return fs.readdirSync(path.join(P.claude, 'projects')).map((d) => path.join(P.claude, 'projects', d)); } catch { return []; } })());
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)); } catch { continue; }
    files.sort((a, b) => mtime(b) - mtime(a));
    for (const f of files.slice(0, 5)) {
      const head = readHead(f);
      if (head.includes('"skill_listing"')) return f;
    }
  }
  return null;
}
function readHead(f, n = 4 * 1024 * 1024) {
  try { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(Math.min(n, fs.fstatSync(fd).size)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); return b.toString('utf8'); } catch { return ''; }
}

module.exports = { parse, find, parseSkills };
