'use strict';
// First-run auto-setup + daemon lifecycle. Installing the plugin is the only manual step:
// the first SessionStart spawns bootstrap() in the background, which builds a private venv,
// installs Laya, prefetches the checkpoint, and starts the warm daemon.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { P, ROOT, ensureHome, readJson, writeJson, log, withLock, mtime } = require('./util');

const RETRY_AFTER_FAIL_MS = 6 * 3600 * 1000;
const pyBin = () => path.join(P.venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const have = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

// Stable launcher so statuslines, Codex/Gemini hooks and your shell survive plugin updates.
function writeLauncher() {
  try {
    const body = `#!/bin/sh\nexec node "${path.join(ROOT, 'bin', 'laya-conductor.js')}" "$@"\n`;
    if (!fs.existsSync(P.launcher) || fs.readFileSync(P.launcher, 'utf8') !== body) {
      fs.mkdirSync(path.dirname(P.launcher), { recursive: true });
      fs.writeFileSync(P.launcher, body, { mode: 0o755 });
    }
  } catch (e) { log(`launcher: ${e.message}`); }
}

function status() {
  const s = readJson(P.setup, { state: 'new' });
  if (s.state === 'ready' && !fs.existsSync(pyBin())) return { state: 'new' }; // venv deleted -> redo
  return s;
}
const setStatus = (patch) => writeJson(P.setup, { ...readJson(P.setup, {}), ...patch, ts: Date.now() });

function logFd() { ensureHome(); return fs.openSync(P.log, 'a'); }

function detached(cmd, args, env = {}) {
  const fd = logFd();
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
  child.unref();
  return child.pid;
}

// Called from hooks: returns immediately. Decides whether to kick off setup or the daemon.
function ensureBackground() {
  writeLauncher();
  if (process.env.LAYA_NO_AUTOSETUP === '1') return { action: 'disabled' };
  const s = status();
  if (s.state === 'ready') {
    if (!daemonLikelyAlive()) { detached(process.execPath, [path.join(ROOT, 'bin', 'laya-conductor.js'), 'daemon-run']); return { action: 'daemon-start' }; }
    return { action: 'none' };
  }
  if (s.state === 'running' && Date.now() - (s.ts || 0) < 30 * 60 * 1000) return { action: 'setup-running', step: s.step };
  if (s.state === 'failed' && Date.now() - (s.ts || 0) < RETRY_AFTER_FAIL_MS) return { action: 'setup-failed', error: s.error };
  setStatus({ state: 'running', step: 'starting', error: '' });
  detached(process.execPath, [path.join(ROOT, 'bin', 'laya-conductor.js'), 'bootstrap']);
  return { action: 'setup-start' };
}

function run(cmd, args, step) {
  setStatus({ step });
  log(`setup: ${step}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: ['ignore', logFd(), logFd()], env: process.env });
  if (r.status !== 0) throw new Error(`${step} failed (exit ${r.status})`);
}

// The heavy lifting. Idempotent; safe to re-run. ~1-2 GB first time (torch + checkpoint), cached afterwards.
function bootstrap() {
  try {
    withLock('bootstrap', () => {
      setStatus({ state: 'running', step: 'venv', error: '' });
      if (!fs.existsSync(pyBin())) {
        if (have('uv')) {
          try { run('uv', ['venv', P.venv, '--python', '3.12'], 'venv'); } catch { run('uv', ['venv', P.venv], 'venv'); } // 3.12 has the safest torch wheels
        } else run(process.env.LAYA_PYTHON || 'python3', ['-m', 'venv', P.venv], 'venv');
      }
      const pin = process.env.LAYA_PIP_SPEC || 'laya>=0.3.23';
      if (have('uv')) run('uv', ['pip', 'install', '--python', pyBin(), pin], 'install-laya');
      else run(pyBin(), ['-m', 'pip', 'install', '--quiet', pin], 'install-laya');
      // pull the checkpoint into the shared Hugging Face cache now so the first prompt is not the slow one
      run(pyBin(), ['-c', 'from laya import Router; Router(preload=False).load("english")'], 'download-checkpoint');
      setStatus({ state: 'ready', step: 'done', error: '' });
    }, { waitMs: 1000, staleMs: 3600 * 1000 });
    log('setup: ready');
    detached(process.execPath, [path.join(ROOT, 'bin', 'laya-conductor.js'), 'daemon-run']);
  } catch (e) {
    log(`setup failed: ${e.message}`);
    setStatus({ state: 'failed', error: String(e.message).slice(0, 200) });
  }
}

function daemonLikelyAlive() {
  const pid = Number(readJson(P.pid, {}).pid || (() => { try { return fs.readFileSync(P.pid, 'utf8').trim(); } catch { return 0; } })());
  if (!pid) return false;
  try { process.kill(pid, 0); return fs.existsSync(P.sock); } catch { return false; }
}

// foreground wrapper used by `daemon-run`: starts python daemon, inherits log
function runDaemon() {
  if (daemonLikelyAlive()) return;
  const child = spawn(pyBin(), [path.join(ROOT, 'py', 'daemon.py')], { detached: true, stdio: ['ignore', logFd(), logFd()], env: { ...process.env, LAYA_HOME: P.home, LAYA_SOCK: P.sock, LAYA_ROOT: ROOT } });
  child.unref();
}

function request(payload, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection(P.sock);
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done(null); } } });
    sock.on('error', () => done(null));
  });
}

function stopDaemon() {
  try { const pid = Number(fs.readFileSync(P.pid, 'utf8').trim()); if (pid) process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

module.exports = { status, ensureBackground, bootstrap, runDaemon, request, stopDaemon, daemonLikelyAlive, pyBin };
