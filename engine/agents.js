'use strict';
// One profile per supported agent: what it can do, and how Laya's answer must be shaped for it.
// The decision engine is agent-neutral; only the edges (input normalising, output shape, Claude-only features) live here.
//   native  = Claude Code: Skill tool, model aliases, PreToolUse, confirm-hold all exist
//   mode    = how Laya reaches the agent: hooks | extension | mcp (tools + a rules file) | remote-mcp
const PROFILES = {
  'claude-code': { label: 'Claude Code', mode: 'hooks', native: true },
  codex: { label: 'OpenAI Codex CLI', mode: 'hooks' },
  gemini: { label: 'Gemini CLI', mode: 'hooks' },
  hermes: { label: 'Hermes Agent (Nous Research)', mode: 'hooks' },
  pi: { label: 'Pi coding agent', mode: 'extension' },
  cursor: { label: 'Cursor', mode: 'mcp' },
  windsurf: { label: 'Windsurf', mode: 'mcp' },
  opencode: { label: 'opencode', mode: 'mcp' },
  copilot: { label: 'GitHub Copilot (VS Code)', mode: 'mcp' },
  chatgpt: { label: 'ChatGPT (developer mode connector)', mode: 'remote-mcp' },
  generic: { label: 'Any agent that reads AGENTS.md', mode: 'mcp' },
  mcp: { label: 'Any MCP client (snippet only)', mode: 'mcp' },
};

const ALIAS = {
  claude: 'claude-code', 'claude code': 'claude-code', claudecode: 'claude-code',
  'openai-codex': 'codex', 'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'hermes-agent': 'hermes', nous: 'hermes',
  'pi-agent': 'pi', 'pi-coding-agent': 'pi', 'pi.dev': 'pi',
  'cursor-agent': 'cursor',
  'vscode': 'copilot', 'github-copilot': 'copilot', 'vs-code': 'copilot',
  'open-code': 'opencode',
  'chatgpt-desktop': 'chatgpt', openai: 'chatgpt',
  'agents-md': 'generic', agentsmd: 'generic',
  'mcp-config': 'mcp', cline: 'mcp', roo: 'mcp', zed: 'mcp', continue: 'mcp', goose: 'mcp', 'claude-desktop': 'mcp',
};

const canon = (a) => { const k = String(a || '').trim().toLowerCase(); return PROFILES[k] ? k : ALIAS[k] || null; };
const profile = (a) => PROFILES[canon(a) || 'claude-code'] || PROFILES['claude-code'];
const native = (a) => !a || canon(a) === 'claude-code';

// Agents send different payloads. Reduce them to the Claude-style shape the engine reads.
function normalize(agent, inp) {
  const x = { ...inp };
  if (agent === 'hermes') {
    const e = x.extra || x.payload || {};
    x.prompt = x.prompt ?? x.user_message ?? e.user_message ?? '';
    x.session_id = x.session_id ?? x.sessionId ?? e.session_id ?? 'hermes';
  }
  x.prompt = x.prompt ?? x.user_prompt ?? x.message ?? '';
  x.session_id = x.session_id ?? x.sessionId ?? x.conversation_id ?? `${agent}`;
  x.cwd = x.cwd || (Array.isArray(x.workspace_roots) && x.workspace_roots[0]) || process.cwd();
  return x;
}

// Engine output is Claude-shaped ({systemMessage, hookSpecificOutput}). Re-shape it for agents that differ.
function render(agent, event, out) {
  const ctx = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
  if (agent === 'hermes') return event === 'prompt' && ctx ? { context: ctx } : {};
  if (agent === 'cursor') return event === 'session-start' && ctx ? { additional_context: ctx } : {};
  return out;
}

module.exports = { PROFILES, canon, profile, native, normalize, render };
