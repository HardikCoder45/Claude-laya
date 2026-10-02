'use strict';
// Shared paths + tiny helpers. Zero dependencies on purpose (ponytail: stdlib only).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.LAYA_HOME || path.join(os.homedir(), '.laya');
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const sha = (s, n = 10) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);

const P = {
  home: HOME, claude: CLAUDE, root: ROOT,
  md: path.join(HOME, 'laya.md'),
  registry: path.join(HOME, 'registry.json'),
  state: path.join(HOME, 'state.json'),
  decisions: path.join(HOME, 'decisions.jsonl'),
  setup: path.join(HOME, 'setup.json'),
  log: path.join(HOME, 'laya.log'),
  venv: path.join(HOME, 'venv'),
  // unix sockets are capped at ~104 bytes on macOS: keep it short and unique per LAYA_HOME
  sock: path.join(os.tmpdir(), `laya-${process.getuid ? process.getuid() : 0}-${sha(HOME, 8)}.sock`),
  pid: path.join(HOME, 'daemon.pid'),
  launcher: path.join(HOME, 'bin', 'laya-conductor'), // stable path: plugin cache dirs change on every update
};

const ensureHome = () => fs.mkdirSync(HOME, { recursive: true });
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

function writeJson(f, obj) { // atomic: temp + rename
  ensureHome();
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

function appendLine(f, line) { ensureHome(); fs.appendFileSync(f, line + '\n'); }

function log(msg) { try { appendLine(P.log, `${new Date().toISOString()} ${msg}`); } catch { /* never throw from logging */ } }

// mkdir-based lock with stale takeover; fn runs while held.
function withLock(name, fn, { waitMs = 2000, staleMs = 30000 } = {}) {
  ensureHome();
  const dir = path.join(HOME, `.${name}.lock`);
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - mtime(dir) > staleMs) { try { fs.rmdirSync(dir); } catch { /* raced */ } continue; }
      if (Date.now() - t0 > waitMs) throw new Error(`lock ${name} busy`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(dir); } catch { /* gone */ } }
}

// ---- secrets never reach laya.md / decisions.jsonl ----
const SECRET = [
  /sk-[A-Za-z0-9_-]{16,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, /AKIA[0-9A-Z]{16}/g, /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
  /((?:api[_-]?key|token|secret|passw(?:or)?d|authorization)["']?\s*[=:]\s*["']?)[^\s"',;]{6,}/gi,
  /\b[a-f0-9]{40,}\b/gi,
];
function redact(s) {
  let out = String(s ?? '');
  for (const re of SECRET) out = out.replace(re, (m, p1) => (p1 ? `${p1}[redacted]` : '[redacted]'));
  return out;
}

// Registry text comes from third-party marketplaces: treat as untrusted data (prompt-injection hygiene).
const INJECTION = /(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|system)|system\s+prompt|you\s+(must|should)\s+now|\bact\s+as\b|new\s+instructions?|do\s+not\s+tell\s+the\s+user|<\/?[a-z][\w-]*[^>]*>/gi;
function sanitize(s, max = 240) {
  let t = String(s ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ');
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(INJECTION, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const STOP = new Set('a an and are as at be by for from has have how i in is it its of on or that the this to was we with you your can do does my me our should would will not no yes use using want need please get make just also into than then them they what when where which who why'.split(' '));
const SYN = {
  ui: 'frontend design interface', ux: 'design usability', frontend: 'react component css ui', backend: 'api server service',
  bug: 'debug fix error', fix: 'debug bug', error: 'debug failure', db: 'database sql postgres', sql: 'database postgres query',
  test: 'testing tdd qa', tests: 'testing tdd', deploy: 'deployment release hosting vercel', pr: 'pull request review github',
  doc: 'documentation docs', docs: 'documentation', perf: 'performance optimize speed', slow: 'performance optimize',
  auth: 'authentication login security', vuln: 'security vulnerability', k8s: 'kubernetes devops', ci: 'pipeline github workflow',
  llm: 'ai model agent prompt', agent: 'swarm orchestration', swarm: 'agent orchestration coordination', ppt: 'slides presentation', slides: 'presentation deck',
  video: 'animation render motion', '3d': 'webgl three render', pdf: 'document', sheet: 'spreadsheet xlsx', excel: 'spreadsheet xlsx',
};
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s|ly)$/, '') : w);
function tokenize(text, { expand = false } = {}) {
  const raw = String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
  const out = [];
  for (const w of raw) {
    out.push(stem(w));
    if (expand && SYN[w]) for (const x of SYN[w].split(' ')) out.push(stem(x));
  }
  return out;
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

module.exports = { P, HOME, CLAUDE, ROOT, sha, ensureHome, readJson, writeJson, appendLine, log, withLock, mtime, redact, sanitize, tokenize, trunc };
