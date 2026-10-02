'use strict';
// Loadout: the skills Laya selected for a prompt, turned into what the agent actually receives.
//  - mentioned(): skills the user named outright are always in
//  - plan():      which selected skills fit the inline token budget (rest are loaded via the Skill tool)
//  - render():    the exclusive-use directive + the SKILL.md bodies, injected as additionalContext
//  - allowed():   hard-mode check used by the PreToolUse hook
// Only INSTALLED skills are ever inlined (same trust level as the Skill tool loading them), never marketplace text.
const fs = require('fs');
const path = require('path');

const MAX_FILE = 256 * 1024;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokOf = (s) => Math.ceil(s.length / 4);
const bare = (id) => String(id).replace(/^skill:/, '').toLowerCase();

// "use the pdf skill", "pdf skill", "skill: pdf", "$pdf", "@pdf": explicit asks beat any ranking
function mentioned(prompt, items) {
  const out = [];
  for (const it of items) {
    if (it.kind !== 'skill' || !it.installed || /^skill:(laya|plugin_laya)(:|$)/i.test(it.id)) continue;
    const full = it.name, short = it.name.includes(':') ? it.name.split(':').pop() : null;
    for (const n of [full, short].filter(Boolean)) {
      const e = esc(n);
      const rx = new RegExp(`(?:[$@]|\\bskill[:\\s]+|\\b(?:use|using|with|load|run|apply)\\s+(?:the\\s+)?)${e}(?![\\w-])|(?<![\\w-])${e}\\s+skill\\b`, 'i');
      if (rx.test(prompt)) { out.push(it); break; }
    }
  }
  return out;
}

// MCP servers the user named: "use supabase", "from github", "check my linear tickets", "playwright mcp", "$sentry".
// Short names ("time", "fetch") only count after an explicit trigger word, so ordinary prose never forces a server in.
function mentionedServers(prompt, items) {
  const out = [];
  for (const it of items) {
    if (it.kind !== 'mcp' || !it.installed || /(^|[:_-])laya([:_-]|$)/i.test(it.id)) continue;
    const base = it.name.split(':').pop().replace(/^(claude_ai_|plugin_)/i, '').replace(/([-_ ]?mcp|[-_ ]server)$/i, '').replace(/^mcp[-_ ]?(server[-_ ])?/i, '');
    const forms = [...new Set([base, base.replace(/[-_]+/g, ' ')])].filter((n) => n.length >= 3);
    for (const n of forms) {
      const e = esc(n);
      const rx = new RegExp(`(?:[$@]|\\bmcp[:\\s]+|\\b(?:use|using|via|through|with|from|ask|call|query|check|in|on)\\s+(?:the\\s+|my\\s+|our\\s+)?)${e}(?![\\w-])|(?<![\\w-])${e}\\s+(?:mcp|server|connector|tools?)\\b`, 'i');
      if (rx.test(prompt)) { out.push(it); break; }
    }
  }
  return out;
}

function body(file) {
  try {
    if (!file || fs.statSync(file).size > MAX_FILE) return null;
    return fs.readFileSync(file, 'utf8')
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
      .replace(/<\/?laya-skills?[^>]*>/gi, '')
      .replace(/\n{3,}/g, '\n\n').trim();
  } catch { return null; }
}

// Walk the picks in rank order; inline while the budget lasts. A skill that does not fit whole is deferred
// (truncated instructions are worse than none): Claude loads it with the Skill tool instead.
function plan(skills, items, { inline = true, budget = 2200 } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const inl = [], deferred = [];
  let left = budget;
  for (const s of skills) {
    const it = byId.get(s.id);
    const b = inline && it && it.installed ? body(it.file) : null;
    const tok = b ? tokOf(b) : 0;
    if (b && tok <= left) { inl.push({ id: s.id, name: s.name, tok, file: it.file }); left -= tok; }
    else deferred.push({ id: s.id, name: s.name });
  }
  return { inline: inl, deferred, inline_tokens: budget - left, budget };
}

// Text for the agent. `lo` is d.loadout from the decision.
function render(d, items) {
  const lo = d.loadout, skills = d.picks.skills;
  if (!skills.length || !lo) return { directive: '', blocks: '' };
  const inl = lo.inline || [], def = lo.deferred || [];
  const names = skills.map((s) => s.name);
  const byId = new Map(items.map((i) => [i.id, i]));
  const tool = require('./agents').native(d.agent); // only Claude Code has a Skill tool; elsewhere skills load by reading the file
  const L = [];
  const why = (s) => { const it = byId.get(s.id); return it && it.desc ? `${s.name} (${it.desc.slice(0, 80).replace(/\s+\S*$/, '')})` : s.name; };
  if (lo.exclusive === 'off') L.push(`skills selected by laya (${tool ? 'Skill tool' : 'SKILL.md'}): ${skills.map(why).join('; ')}.`);
  else L.push(`skills selected by laya for THIS task: ${skills.map(why).join('; ')}. Use ONLY these skills — do not invoke any other skill unless the user names it or these fail.${lo.exclusive === 'hard' ? ' (laya blocks Skill calls outside this set.)' : ''}`);
  if (skills.length > 1) L.push('They were chosen to work together: apply EVERY one that is relevant, do not stop after the first.');
  if (inl.length) L.push(`Instructions for ${inl.map((s) => s.name).join(', ')} are loaded below in <laya-skill>: follow them now${tool ? ', do not call the Skill tool for them again' : ''}.`);
  if (def.length) L.push(tool ? `Load before starting (Skill tool): ${def.map((s) => s.name).join(', ')}.` : `Read these skill files before starting: ${def.map((s) => (byId.get(s.id) || {}).file || s.name).join(', ')}.`);
  if (lo.ack !== false) L.push(`In your first message this turn write one line: "laya ▸ using: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}" listing the skills you actually apply, and "· skipped: <skill> (<reason>)" for any you leave out.`);
  if (lo.exclusive !== 'off') L.push('If you delegate to a subagent, hand it these skill instructions (or tell it to load the same skills) and keep the same restriction.');
  const blocks = inl.map((s) => {
    const it = byId.get(s.id), b = it && body(it.file);
    if (!b) return '';
    return `<laya-skill name="${s.name}" base="${path.dirname(it.file)}">\n${b}\n</laya-skill>`;
  }).filter(Boolean).join('\n');
  return { directive: L.join('\n'), blocks };
}

// Hard mode: may this Skill tool call proceed? `allow` = ids selected for the turn.
function allowed(skillName, allow) {
  const n = String(skillName || '').toLowerCase();
  if (!n) return true;
  if (/^(laya|plugin_laya)(:|$)|^laya-/.test(n)) return true; // laya's own skills stay available
  return allow.some((id) => { const a = bare(id); return a === n || a.endsWith(`:${n}`) || n.endsWith(`:${a}`); });
}

module.exports = { mentioned, mentionedServers, plan, render, allowed, body };
