'use strict';
const { execFile } = require('child_process');

// found by @security: `tmux new-session` starts a shell that inherits the caller's env (the panel) —
// without filtering, PANEL_PASSWORD/GH_TOKEN went into EVERY tmux session (and into any Claude
// running in it, visible via `env`). Only the tmux case: other commands (git, npm, backup bash)
// keep inheriting the normal env, some depend on it on purpose (e.g. GH_TOKEN in the backup).
const TMUX_STRIP_ENV = ['PANEL_PASSWORD', 'GH_TOKEN', 'ANTHROPIC_ADMIN_KEY', 'DEPLOY_WEBHOOK_URL'];

// runs a command without a shell (separate args) and never rejects: {ok, stdout, stderr}
function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const finalOpts = { timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...opts };
    if (cmd === 'tmux') {
      const env = { ...(opts.env || process.env) };
      for (const k of TMUX_STRIP_ENV) delete env[k];
      finalOpts.env = env;
    }
    execFile(cmd, args, finalOpts, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err && err.message) || '' }));
  });
}

// reads the JSON body of a request (1MB limit). Invalid body -> null (the route answers 400).
// req.destroy() fires 'close'/'aborted', NEVER 'end' — resolving only on 'end' left the promise
// hanging forever (handler never answers, socket never closes, the connection leaks) when the body
// went over the limit. Over the limit we only stop ACCUMULATING (no memory growth): the stream
// keeps draining (no destroy) until the natural 'end', so the route can still really answer 400
// — destroying the socket here would prevent ANY answer (the client would only see the connection drop).
function readJson(req, limit = 1e6) {
  return new Promise((resolve) => {
    let data = '';
    let over = false;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => { if (over) return; data += c; if (data.length > limit) { over = true; data = ''; } });
    req.on('end', () => {
      if (over || !data) return finish(over ? null : {});
      try { const v = JSON.parse(data); finish(v && typeof v === 'object' ? v : null); }
      catch { finish(null); }
    });
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

// reads the raw body (upload) up to `limit` bytes -> Buffer | null (over the limit)
function readRaw(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => { if (over) return; size += c.length; if (size > limit) { over = true; chunks.length = 0; return; } chunks.push(c); });
    req.on('end', () => finish(over ? null : Buffer.concat(chunks)));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const truthy = (v) => v === true || v === 'true' || v === 'on' || v === '1';
const validName = (n) => typeof n === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(n) && n !== '.' && n !== '..';
// tmux session name of the project (same sanitizing as claude-session.sh: tr -c 'A-Za-z0-9_-' '_')
const sessionName = (name) => 'claude-' + String(name).replace(/[^A-Za-z0-9_-]/g, '_');
// EXACT tmux pane target ("=session:"). Without the "=" tmux matches by PREFIX: with "claude-api"
// down, a send-keys would end up in "claude-api2".
const paneOf = (sess) => '=' + sess + ':';
const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, service: 'claude-panel', msg, ...(extra || {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

// types a line into a tmux session like a person: literal text, a pause for Claude's TUI to
// process it (without it the Enter arrives first and the line stays in the prompt), then Enter. Same method
// as claude-loop.sh.
async function typeLine(sess, text) {
  if (!(await sh('tmux', ['send-keys', '-t', paneOf(sess), '-l', text])).ok) return false;
  await new Promise((r) => setTimeout(r, 800));
  return (await sh('tmux', ['send-keys', '-t', paneOf(sess), 'C-m'])).ok;
}

module.exports = { sh, readJson, readRaw, sendJson, truthy, validName, sessionName, paneOf, clampInt, log, typeLine };
