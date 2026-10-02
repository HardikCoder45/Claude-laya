'use strict';
// Cross-agent adapters. One brain (decide), many front doors:
//   hooks      codex, gemini, hermes   -> the agent calls `laya-conductor hook prompt` before each turn
//   extension  pi                      -> a tiny TypeScript extension does the same from inside Pi
//   mcp+rules  cursor, windsurf, opencode, copilot, generic -> MCP tools plus a rules file telling the agent to call them
//   remote     chatgpt                 -> HTTP MCP behind a secret URL (ChatGPT cannot spawn local processes)
// Every installer is idempotent, edits only what it owns (JSON keys / marker blocks / one file), and refuses to
// rewrite a config it cannot parse (comments, trailing commas) - it prints the snippet instead.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, P, readJson, writeJson } = require('./util');
const agents = require('./agents');

const BIN = P.launcher; // stable launcher written at SessionStart, survives plugin updates
const MARK = 'laya-conductor';
const sh = (s) => (/\s/.test(s) ? `'${s}'` : s);
const CMD = `${sh(BIN)} hook prompt`;
const MCP_ENTRY = { command: BIN, args: ['mcp'] };
const RULE = `## Laya
Before a non-trivial task call the \`laya_decide\` MCP tool (server \`laya\`, started with \`${sh(BIN)} mcp\`) with the user's request and follow its picks (which skills fit the task).
If a tool, skill or MCP server fails, call \`laya_learn\` so ~/.laya/laya.md remembers.`;

// ---------- small, safe file helpers
const slurp = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const tilde = (f) => f.replace(os.homedir(), '~');

// JSON config we may edit: absent -> {}, parseable -> object, anything else -> refuse (never clobber a user's JSONC)
function strictJson(f) {
  if (!fs.existsSync(f)) return {};
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch { /* fall through */ }
  const e = new Error(`${tilde(f)} is not plain JSON (comments or trailing commas?)`); e.refuse = true; throw e;
}
function editJson(f, edit) {
  const j = strictJson(f), before = JSON.stringify(j);
  edit(j);
  if (JSON.stringify(j) === before) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  writeJson(f, j);
  return true;
}

// Text between markers, replaced in place or appended. `style` picks the comment syntax for the file type,
// `tag` keeps several blocks in one file apart (laya:hooks vs laya:mcp_servers).
const marks = (style, tag) => { const t = tag ? `:${tag}` : ''; return style === 'hash' ? [`# laya${t}:begin`, `# laya${t}:end`] : [`<!-- laya${t}:begin -->`, `<!-- laya${t}:end -->`]; };
function block(f, body, style = 'md', tag = '') {
  const [open, close] = marks(style, tag);
  const cur = slurp(f), i = cur.indexOf(open), j = cur.indexOf(close);
  const text = `${open}\n${body.trim()}\n${close}`;
  const next = i >= 0 && j > i ? cur.slice(0, i) + text + cur.slice(j + close.length)
    : cur + (cur && !cur.endsWith('\n') ? '\n' : '') + (cur ? '\n' : '') + text + '\n';
  if (next === cur) return false;
  put(f, next);
  return true;
}
const hasOwnBlock = (f, tag, style = 'md') => slurp(f).includes(marks(style, tag)[0]);

// YAML without a parser: only ever append a whole top-level key inside our markers. If the user already has that
// key, merging is theirs to do, so hand back the snippet.
function yamlKey(f, key, body) {
  if (!hasOwnBlock(f, key, 'hash') && new RegExp(`^${key}\\s*:`, 'm').test(slurp(f))) return { changed: false, manual: body };
  return { changed: block(f, body, 'hash', key) };
}

// JSON hook groups share one dedupe rule: our launcher name appears in the command
function addCommandHook(hooksObj, event, entry) {
  const arr = (hooksObj[event] = hooksObj[event] || []);
  const has = arr.some((g) => [g, ...(g.hooks || [])].some((h) => String(h.command || '').includes(MARK)));
  if (!has) arr.push(entry);
  return !has;
}

// result builder: a list of {file, changed, manual?} plus notes
const R = (agent, files, notes = []) => ({
  agent, label: agents.PROFILES[agent].label, mode: agents.PROFILES[agent].mode,
  file: files[0] && files[0].file, changed: files.some((x) => x.changed), files, notes,
  manual: files.filter((x) => x.manual).map((x) => `${tilde(x.file)}:\n${x.manual}`).join('\n\n') || undefined,
});
const F = (file, changed, manual) => ({ file, changed: !!changed, ...(manual ? { manual } : {}) });
const safe = (file, fn, snippet) => { try { return F(file, fn()); } catch (e) { if (!e.refuse) throw e; return F(file, false, `${e.message}. Add this yourself:\n${snippet}`); } };

// ---------- hook agents
function codex({ home }) {
  const hooks = path.join(home, '.codex', 'hooks.json'), toml = path.join(home, '.codex', 'config.toml');
  const files = [safe(hooks, () => editJson(hooks, (j) => { j.hooks = j.hooks || {}; addCommandHook(j.hooks, 'UserPromptSubmit', { hooks: [{ type: 'command', command: CMD, timeout: 10 }] }); }), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: CMD, timeout: 10 }] }] } }, null, 2))];
  const body = `[mcp_servers.laya]\ncommand = ${JSON.stringify(BIN)}\nargs = ["mcp"]`;
  if (!hasOwnBlock(toml, '', 'hash') && /^\[mcp_servers\.laya\]/m.test(slurp(toml))) files.push(F(toml, false, body));
  else files.push(F(toml, block(toml, body, 'hash')));
  return R('codex', files, ['Codex hooks are experimental: enable them in ~/.codex/config.toml if your build gates them behind a feature flag.']);
}

function gemini({ home }) {
  const f = path.join(home, '.gemini', 'settings.json');
  const hook = { name: 'laya', type: 'command', command: `${CMD} --agent gemini`, timeout: 10000 };
  const snippet = JSON.stringify({ hooks: { BeforeAgent: [{ hooks: [hook] }] }, mcpServers: { laya: MCP_ENTRY } }, null, 2);
  return R('gemini', [safe(f, () => editJson(f, (j) => {
    j.hooks = j.hooks || {};
    addCommandHook(j.hooks, 'BeforeAgent', { hooks: [hook] });
    j.mcpServers = { ...j.mcpServers, laya: MCP_ENTRY };
  }), snippet)], ['Gemini CLI reads hooks from settings.json (BeforeAgent); timeout is in ms.']);
}

function hermes({ home }) {
  const dir = process.env.HERMES_HOME && home === os.homedir() ? process.env.HERMES_HOME : path.join(home, '.hermes');
  const f = path.join(dir, 'config.yaml');
  const hooks = yamlKey(f, 'hooks', `hooks:\n  pre_llm_call:\n    - command: ${JSON.stringify(`${CMD} --agent hermes`)}\n      timeout: 10`);
  const mcp = yamlKey(f, 'mcp_servers', `mcp_servers:\n  laya:\n    command: ${JSON.stringify(BIN)}\n    args: ["mcp"]`);
  return R('hermes', [F(f, hooks.changed || mcp.changed, [hooks.manual, mcp.manual].filter(Boolean).join('\n'))], [
    'Hermes asks once to approve a new shell hook (or start it with --accept-hooks / HERMES_ACCEPT_HOOKS=1). `hermes hooks list` shows it.',
    'Hermes injects the hook output into the turn\'s user message, capped at 10,000 characters.',
  ]);
}

// ---------- extension agent
const PI_FILE = (home) => path.join(home, '.pi', 'agent', 'extensions', 'laya.ts');
const PI_MARK = '// laya-conductor extension';
const PI_SRC = `${PI_MARK} (managed by /laya:adapt pi: edits are overwritten)
// Pi has no hooks file or built-in MCP: it loads TypeScript extensions. Before each agent run this asks the local
// Laya engine what fits the prompt and appends the answer to the system prompt. Fail-open: any error changes nothing.
import { spawnSync } from "node:child_process";

const BIN = ${JSON.stringify(BIN)};
const SID = "pi-" + process.pid;

export default function (pi: any) {
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const prompt = String(event?.prompt ?? "");
      if (!prompt.trim()) return;
      const r = spawnSync(BIN, ["hook", "prompt", "--agent", "pi"], {
        input: JSON.stringify({ prompt, cwd: ctx?.cwd ?? process.cwd(), session_id: SID }),
        encoding: "utf8",
        timeout: 10000,
      });
      const add = JSON.parse(r.stdout || "{}")?.hookSpecificOutput?.additionalContext;
      if (add) return { systemPrompt: String(event.systemPrompt ?? "") + "\\n\\n" + add };
    } catch {}
  });
}
`;
function pi({ home }) {
  const f = PI_FILE(home), cur = slurp(f);
  if (cur && !cur.startsWith(PI_MARK)) return R('pi', [F(f, false, `${f} already exists and is not Laya's. Merge this into it:\n${PI_SRC}`)]);
  const changed = cur !== PI_SRC;
  if (changed) put(f, PI_SRC);
  return R('pi', [F(f, changed)], ['Pi loads extensions at start (or /reload). It has no built-in MCP, so Laya runs as an extension and the model sees its pick in the system prompt.']);
}

// ---------- MCP + rules agents
function cursor({ home, cwd, project }) {
  const mcp = path.join(home, '.cursor', 'mcp.json'), hooks = path.join(home, '.cursor', 'hooks.json');
  const files = [
    safe(mcp, () => editJson(mcp, (j) => { j.mcpServers = { ...j.mcpServers, laya: MCP_ENTRY }; }), JSON.stringify({ mcpServers: { laya: MCP_ENTRY } }, null, 2)),
    safe(hooks, () => editJson(hooks, (j) => { j.version = j.version || 1; j.hooks = j.hooks || {}; addCommandHook(j.hooks, 'sessionStart', { command: `${sh(BIN)} hook session-start --agent cursor` }); }), JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: `${sh(BIN)} hook session-start --agent cursor` }] } }, null, 2)),
  ];
  if (project) {
    const rule = path.join(cwd, '.cursor', 'rules', 'laya.mdc');
    if (!fs.existsSync(rule)) put(rule, '---\ndescription: Pick skills and model effort with Laya before non-trivial tasks\nalwaysApply: true\n---\n');
    files.push(F(rule, block(rule, RULE)));
  }
  return R('cursor', files, ['Cursor hooks cannot add context to a prompt (beforeSubmitPrompt only allows/denies), so the per-prompt path is the MCP tool plus the always-on rule; the sessionStart hook adds a standing note.', 'Restart Cursor (or reload MCP servers) after the first install.']);
}

function windsurf({ home }) {
  const mcp = path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), rules = path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md');
  return R('windsurf', [
    safe(mcp, () => editJson(mcp, (j) => { j.mcpServers = { ...j.mcpServers, laya: MCP_ENTRY }; }), JSON.stringify({ mcpServers: { laya: MCP_ENTRY } }, null, 2)),
    F(rules, block(rules, RULE)),
  ], ['Refresh MCP servers in Cascade (or restart Windsurf) to pick up laya.']);
}

function opencode({ home }) {
  const dir = path.join(home, '.config', 'opencode'), f = path.join(dir, 'opencode.json'), rules = path.join(dir, 'AGENTS.md');
  const entry = { type: 'local', command: [BIN, 'mcp'], enabled: true };
  const files = fs.existsSync(path.join(dir, 'opencode.jsonc')) && !fs.existsSync(f)
    ? [F(path.join(dir, 'opencode.jsonc'), false, JSON.stringify({ mcp: { laya: entry } }, null, 2))]
    : [safe(f, () => editJson(f, (j) => { j.$schema = j.$schema || 'https://opencode.ai/config.json'; j.mcp = { ...j.mcp, laya: entry }; }), JSON.stringify({ mcp: { laya: entry } }, null, 2))];
  files.push(F(rules, block(rules, RULE)));
  return R('opencode', files);
}

function copilot({ cwd, project }) {
  if (!project) return R('copilot', [], ['GitHub Copilot config is per-workspace: run `/laya:adapt copilot` inside the repo.']);
  const mcp = path.join(cwd, '.vscode', 'mcp.json'), rules = path.join(cwd, '.github', 'copilot-instructions.md');
  const entry = { type: 'stdio', command: BIN, args: ['mcp'] };
  return R('copilot', [
    safe(mcp, () => editJson(mcp, (j) => { j.servers = { ...j.servers, laya: entry }; }), JSON.stringify({ servers: { laya: entry } }, null, 2)),
    F(rules, block(rules, RULE)),
  ], ['Start the laya server from the MCP list in VS Code (agent mode) the first time.']);
}

// Any agent that reads AGENTS.md (and can be pointed at the MCP server by hand)
function generic({ cwd }) {
  const f = path.join(cwd, 'AGENTS.md');
  return R('generic', [F(f, block(f, RULE))], [`Connect the MCP server in your agent: command ${BIN}, args ["mcp"].`]);
}

// ---------- remote-only agent
function chatgpt() {
  const mcp = require('./mcp');
  const t = mcp.token();
  const url = `https://<your-tunnel-host>/mcp/${t}`;
  return { ...R('chatgpt', []), notes: [
    'ChatGPT cannot start local programs or run hooks: it only calls remote HTTPS MCP servers, and only when it decides to use a tool. Laya serves it over HTTP behind a secret URL.',
    `1. run:        ${sh(BIN)} mcp --http --port 8765        (binds 127.0.0.1 only)`,
    '2. tunnel it: cloudflared tunnel --url http://localhost:8765   (or ngrok http 8765) -> gives https://<host>',
    `3. ChatGPT -> Settings -> Connectors -> Advanced -> Developer mode -> Create. URL: ${url}   Authentication: none (the URL is the secret; or send "Authorization: Bearer <token>" to /mcp).`,
    '4. Paste into Custom instructions so it calls Laya: "Before any non-trivial task call the laya_decide tool with my request and follow its picks."',
    `Token: ${tilde(path.join(P.home, 'mcp-token'))}. Rotate by deleting that file. Treat the URL like a password and stop the server when you are done.`,
  ] };
}

// Snippets for every other MCP client (Cline, Roo, Zed, Continue, Goose, Claude Desktop, ...)
function mcpSnippet() {
  const std = JSON.stringify({ mcpServers: { laya: MCP_ENTRY } }, null, 2);
  return { ...R('mcp', []), snippet: std, notes: [
    'Add this to your client\'s MCP settings (the key is usually "mcpServers"; Zed uses "context_servers", VS Code uses "servers" with "type":"stdio"):',
    std,
    `Then add the rule to its instructions file:\n${RULE}`,
  ] };
}

const INSTALLERS = { codex, gemini, hermes, pi, cursor, windsurf, opencode, copilot, chatgpt, generic, mcp: mcpSnippet };

// Is the agent present on this machine? (cheap: a config dir exists)
const DETECT = {
  codex: (h) => path.join(h, '.codex'), gemini: (h) => path.join(h, '.gemini'), hermes: (h) => path.join(h, '.hermes'), pi: (h) => path.join(h, '.pi'),
  cursor: (h) => path.join(h, '.cursor'), windsurf: (h) => path.join(h, '.codeium', 'windsurf'), opencode: (h) => path.join(h, '.config', 'opencode'),
};
const detected = (home = os.homedir()) => Object.keys(DETECT).filter((a) => fs.existsSync(DETECT[a](home)));

function list(opts = {}) {
  const home = opts.home || os.homedir(), have = new Set(detected(home));
  return Object.entries(agents.PROFILES).filter(([id]) => id !== 'claude-code').map(([id, p]) => ({ agent: id, label: p.label, mode: p.mode, detected: have.has(id) }));
}

function adapt(agent, opts = {}) {
  if (agent === 'list') return { list: list(opts) };
  require('./setup').ensureBackground(); // makes sure the launcher exists
  const o = { home: opts.home || os.homedir(), cwd: opts.cwd || process.cwd(), project: opts.project !== false };
  if (agent === 'all') return { all: detected(o.home).map((a) => INSTALLERS[a]({ ...o, project: false })) };
  const id = agents.canon(agent);
  if (!id || id === 'claude-code' || !INSTALLERS[id]) throw new Error(`unknown agent "${agent || ''}". One of: ${Object.keys(INSTALLERS).join(' | ')} | list | all`);
  return INSTALLERS[id](o);
}

// Human-readable result for the CLI / slash command
function format(r) {
  if (r.list) return `agents Laya can serve (✓ = found on this machine)\n` + r.list.map((x) => `  ${x.detected ? '✓' : ' '} ${x.agent.padEnd(9)} ${x.mode.padEnd(10)} ${x.label}`).join('\n') + `\n\nusage: adapt <agent> | adapt all (every detected agent, home-level config only) | adapt mcp (snippet for any other client)`;
  if (r.all) return r.all.length ? r.all.map(format).join('\n\n') : 'no supported agents found in your home directory. See: adapt list';
  const L = [`${r.agent} ▸ ${r.label} (${r.mode})`];
  for (const x of r.files) L.push(`  ${x.manual ? '!' : x.changed ? '+' : '='} ${tilde(x.file)}  ${x.manual ? 'NOT edited, add by hand (below)' : x.changed ? 'written' : 'already set'}`);
  for (const n of r.notes) L.push(`  ${n.replace(/\n/g, '\n  ')}`);
  if (r.manual) L.push(`  --\n  ${r.manual.replace(/\n/g, '\n  ')}`);
  return L.join('\n');
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

module.exports = { adapt, format, list, detected, shim };
