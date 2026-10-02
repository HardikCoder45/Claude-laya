'use strict';
// Cross-agent adapters. Codex and Gemini CLI speak the same hookSpecificOutput.additionalContext protocol
// as Claude Code, so one core serves all three: we only wire their hook config to `laya-conductor hook prompt`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, readJson, writeJson } = require('./util');

const { P } = require('./util');
const BIN = P.launcher; // stable launcher written at SessionStart, survives plugin updates
const CMD = `"${BIN}" hook prompt`;
const MARK = 'laya-conductor';

function addCommandHook(hooksObj, event, matcherEntry) {
  const arr = (hooksObj[event] = hooksObj[event] || []);
  const has = arr.some((g) => (g.hooks || []).some((h) => String(h.command || '').includes(MARK)));
  if (!has) arr.push(matcherEntry);
  return !has;
}

function codex(home = os.homedir()) {
  const f = path.join(home, '.codex', 'hooks.json');
  const j = readJson(f, {});
  j.hooks = j.hooks || {};
  const added = addCommandHook(j.hooks, 'UserPromptSubmit', { hooks: [{ type: 'command', command: CMD, timeout: 10 }] });
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (added) writeJson(f, j);
  return { agent: 'codex', file: f, changed: added, note: 'Codex hooks are experimental: enable them in ~/.codex/config.toml if your build gates them behind a feature flag.' };
}

function gemini(home = os.homedir()) {
  const f = path.join(home, '.gemini', 'settings.json');
  const j = readJson(f, {});
  j.hooks = j.hooks || {};
  const added = addCommandHook(j.hooks, 'BeforeAgent', { hooks: [{ name: 'laya', type: 'command', command: `${CMD} --agent gemini`, timeout: 10000 }] });
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (added) writeJson(f, j);
  return { agent: 'gemini', file: f, changed: added, note: 'Gemini CLI reads hooks from settings.json (BeforeAgent); timeout is in ms.' };
}

// Agents without hooks get the same brain through MCP + an AGENTS.md rule.
function generic(cwd = process.cwd()) {
  const f = path.join(cwd, 'AGENTS.md');
  const block = `\n<!-- laya:begin -->\n## Laya\nBefore a non-trivial task call the \`laya_decide\` MCP tool (server: \`${BIN} mcp\`) with the user's request and follow its picks.\nIf a tool/skill/MCP fails, call \`laya_learn\` so ~/.laya/laya.md remembers.\n<!-- laya:end -->\n`;
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (cur.includes('<!-- laya:begin -->')) return { agent: 'generic', file: f, changed: false };
  fs.writeFileSync(f, cur + block);
  return { agent: 'generic', file: f, changed: true };
}

// Bare slash commands (/stack, /install, ...). Files record the plugin root; refreshed at SessionStart when it moves.
const SHIM_SET = ['install', 'stack', 'auto-laya'];
const MARKER = (root) => `<!-- laya-shim ${root} -->`;
function shim({ onlyIfStale = false } = {}) {
  const dir = path.join(P.claude, 'commands');
  const src = path.join(ROOT, 'commands');
  const probe = path.join(dir, 'stack.md');
  const done = path.join(P.home, '.shim-done'); // first run installs the bare commands once; deleting them later is respected
  if (onlyIfStale) {
    const stale = fs.existsSync(probe) && fs.readFileSync(probe, 'utf8').includes('<!-- laya-shim ') && !fs.readFileSync(probe, 'utf8').includes(MARKER(ROOT));
    if (!stale && (fs.existsSync(done) || fs.existsSync(probe))) return '';
    fs.mkdirSync(P.home, { recursive: true }); fs.writeFileSync(done, new Date().toISOString());
  }
  fs.mkdirSync(dir, { recursive: true });
  const made = [], skipped = [];
  // only the bare names you asked for; generic ones (/status, /mode, /export, /doctor...) would shadow built-ins
  for (const f of fs.readdirSync(src).filter((x) => SHIM_SET.includes(x.replace(/\.md$/, '') ) )) {
    const name = f.replace(/\.md$/, '');
    const dest = path.join(dir, `${name}.md`);
    if (fs.existsSync(dest) && !fs.readFileSync(dest, 'utf8').includes('<!-- laya-shim ')) { skipped.push(name); continue; }
    const body = fs.readFileSync(path.join(src, f), 'utf8').replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, ROOT);
    fs.writeFileSync(dest, body.replace(/^(---\n[\s\S]*?\n---\n)/, `$1${MARKER(ROOT)}\n`));
    made.push(name);
  }
  return `bare slash commands installed in ${dir}: ${made.map((m) => '/' + m).join(' ')}${skipped.length ? `\nskipped (yours already exists): ${skipped.join(' ')}` : ''}\nThey are active from the next session start.`;
}

function adapt(agent, opts = {}) {
  require('./setup').ensureBackground(); // makes sure the launcher exists
  if (agent === 'codex') return codex(opts.home);
  if (agent === 'gemini') return gemini(opts.home);
  if (agent === 'generic' || agent === 'agents-md') return generic(opts.cwd);
  throw new Error(`unknown agent "${agent}" (codex | gemini | generic)`);
}

module.exports = { adapt, shim };
