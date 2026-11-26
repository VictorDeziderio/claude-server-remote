'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const { pipeline } = require('stream');

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

// streams a file into an HTTP response: the ONLY way server code sends a file (a repo check in
// test/unit.mjs fails on a bare `.pipe(res)`). `fs.createReadStream(x).pipe(res)` has no 'error'
// handler: a file that passed the caller's stat but could not be opened (deleted or swapped for a
// directory in between, no permission) raised an uncaught 'error' and took the WHOLE panel down.
// Here the file is opened and fstat'ed FIRST and the headers are written only after that, so a
// failure still gets a real answer (404 missing / 500 other); a failure in the middle of the body
// destroys the response (the client sees a cut download) instead of crashing.
// opts: { status=200, headers, start, end } (start/end inclusive, as in createReadStream).
// Resolves true when the whole file was sent, false otherwise; never rejects.
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP']);
function sendStream(res, file, opts = {}) {
  const { status = 200, headers = {}, start, end } = opts;
  return new Promise((resolve) => {
    const fail = (e) => {
      if (!res.headersSent && !res.destroyed) {
        const code = e && NOT_FOUND_CODES.has(e.code) ? 404 : 500;
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(code === 404 ? 'not found' : 'read error');
      } else if (!res.destroyed) res.destroy();
      // the client going away mid-download is normal, not worth an error line
      if (!e || e.code !== 'ERR_STREAM_PREMATURE_CLOSE') log('error', 'file stream failed', { err: e && e.message });
      resolve(false);
    };
    fs.open(file, 'r', (err, fd) => {
      if (err) return fail(err);
      fs.fstat(fd, (e2, st) => {
        if (e2 || !st.isFile()) {
          fs.close(fd, () => {});
          return fail(e2 || Object.assign(new Error('not a regular file'), { code: 'EISDIR' }));
        }
        if (res.destroyed) { fs.close(fd, () => {}); return resolve(false); }
        res.writeHead(status, headers);
        const rs = fs.createReadStream(null, { fd, start, end, autoClose: true });
        pipeline(rs, res, (e3) => (e3 ? fail(e3) : resolve(true)));
      });
    });
  });
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

// types a message of any shape: one short line goes through typeLine; several lines (or a long
// text) are PASTED with bracketed paste (tmux paste-buffer -p), so each newline stays inside the
// message instead of being an Enter that sends half of it. Then the same pause + Enter.
async function typeText(sess, text) {
  const s = String(text || '');
  if (!s.includes('\n') && s.length <= 2000) return typeLine(sess, s);
  const os = require('os');
  const path = require('path');
  const crypto = require('crypto');
  const buf = 'cr-' + crypto.randomBytes(6).toString('hex');
  const tmp = path.join(os.tmpdir(), buf + '.txt');
  try {
    fs.writeFileSync(tmp, s, { mode: 0o600 });
    if (!(await sh('tmux', ['load-buffer', '-b', buf, tmp])).ok) return false;
  } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* */ } }
  if (!(await sh('tmux', ['paste-buffer', '-p', '-r', '-d', '-b', buf, '-t', paneOf(sess)])).ok) return false;
  await new Promise((r) => setTimeout(r, 800));
  return (await sh('tmux', ['send-keys', '-t', paneOf(sess), 'C-m'])).ok;
}

module.exports = { TMUX_STRIP_ENV, sh, readJson, readRaw, sendJson, sendStream, truthy, validName, sessionName, paneOf, clampInt, log, typeLine, typeText };
