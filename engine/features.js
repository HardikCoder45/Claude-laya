'use strict';
// Task features. Heuristic version used when Laya is not warm; Laya answers the same questions when it is.
const { tokenize } = require('./util');

const DOMAINS = {
  code: { d: 'software engineering, programming, debugging, refactoring, tests, APIs', kw: 'code function bug refactor implement test typescript python javascript api class compile repo cli script library module' },
  frontend_ui: { d: 'web frontend, UI/UX design, CSS, React, landing pages, dashboards', kw: 'ui ux react css html component page design landing dashboard tailwind frontend layout animation responsive' },
  data_db: { d: 'databases, SQL, analytics, data pipelines, storage', kw: 'sql database postgres query schema migration data analytics supabase table rows etl' },
  devops_infra: { d: 'deployment, CI/CD, cloud, containers, infrastructure, releases', kw: 'deploy docker kubernetes ci pipeline infra vercel aws cloud release workflow github-actions hosting' },
  security: { d: 'security review, vulnerabilities, authentication, secrets, hardening', kw: 'security vulnerability auth secret exploit cve audit harden injection xss permission' },
  research: { d: 'researching, finding tools or papers, comparing options, reading docs', kw: 'research find compare best latest search investigate survey options alternatives discover' },
  writing_docs: { d: 'writing, documentation, emails, content, editing prose', kw: 'write essay email blog documentation readme article copy draft edit summary' },
  media_3d_video: { d: 'images, video, 3D, animation, audio, CAD, creative assets', kw: 'video 3d blender animation render image audio cad model scene motion webgl three' },
  office_files: { d: 'office documents, PDFs, spreadsheets, slide decks', kw: 'pdf docx xlsx pptx spreadsheet slides presentation excel word deck' },
  agents_meta: { d: 'agent orchestration, plugins, skills, MCP, hooks, automation workflows', kw: 'plugin skill mcp agent swarm hook automation claude laya orchestrate workflow connector' },
  chat: { d: 'casual conversation, greetings, trivial questions', kw: 'hello hi thanks ok yes no why what who' },
};

const RX = {
  needs_research: /\b(research|find (the )?best|compare|latest|state of the art|investigate|survey|look ?up|search (for|the web)|alternatives?)\b/i,
  needs_install: /\b(install|set ?up|add (a |the )?(plugin|skill|mcp|connector|agent)s?|best (skills?|plugins?|agents?|tools?|mcps?)|which (plugin|skill|mcp))\b/i,
  multi_file: /\b(refactor|implement|build|create|migrate|across|entire|whole|project|app|feature|plugin|system|architecture|phases?)\b/i,
  sensitive: /\b(prod(uction)?|delete|drop|payments?|credentials?|secrets?|passwords?|force.?push|rm -rf|billing|migrat\w+ (the )?database)\b/i,
  tools: /\b(file|repo|run|test|browser|api|database|deploy|install|search|fetch|scrape)\b/i,
};

function heuristic(prompt) {
  const toks = new Set(tokenize(prompt));
  const scores = {};
  for (const [k, v] of Object.entries(DOMAINS)) {
    const kws = tokenize(v.kw);
    scores[k] = kws.reduce((s, w) => s + (toks.has(w) ? 1 : 0), 0) / Math.sqrt(kws.length);
  }
  let domain = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  domain = domain[1] > 0 ? domain[0] : (prompt.split(/\s+/).length < 8 ? 'chat' : 'code');
  const n = prompt.split(/\s+/).length;
  let difficulty = n < 8 ? 1 : n < 30 ? 2 : n < 90 ? 3 : 4;
  if (/\b(architect\w*|comprehensive|god.?tier|end.to.end|entire|migrat\w+|all phases|from scratch)\b/i.test(prompt)) difficulty = Math.min(4, difficulty + 1);
  // length alone misjudges: a short "debug this race condition" is hard, a long pasted log with "summarize" is not
  if (/\b(debug\w*|race condition|deadlock|concurren\w+|root cause|optimi[sz]\w*|algorithm|distributed|security (audit|review)|design (a|the)|why (is|does|are)|refactor\w*|rewrite|overhaul|whole|implement\w*)\b|```|\bat \S+:\d+/i.test(prompt)) difficulty = Math.min(4, difficulty + 1);
  else if (n < 40 && /\b(rename|typo|format|lint|comment|summari[sz]e|translate|what is|explain)\b/i.test(prompt)) difficulty = Math.max(1, difficulty - 1);
  const flags = {
    needs_research: RX.needs_research.test(prompt), needs_install: RX.needs_install.test(prompt),
    multi_file: RX.multi_file.test(prompt) && n > 12, sensitive: RX.sensitive.test(prompt), needs_tools: RX.tools.test(prompt),
  };
  flags.needs_tools = flags.needs_tools || flags.needs_research || flags.needs_install;
  return { domain, domain_scores: scores, difficulty, flags };
}

module.exports = { DOMAINS, heuristic };
