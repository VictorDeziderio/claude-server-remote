'use strict';
const { execFile } = require('child_process');

// roda um comando sem shell (args separados) e nunca rejeita: {ok, stdout, stderr}
function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err && err.message) || '' }));
  });
}

// le o corpo JSON de uma request (limite 1MB). Corpo invalido -> null (a rota responde 400).
function readJson(req, limit = 1e6) {
  return new Promise((resolve) => {
    let data = '';
    let over = false;
    req.on('data', (c) => { data += c; if (data.length > limit) { over = true; req.destroy(); } });
    req.on('end', () => {
      if (over) return resolve(null);
      if (!data) return resolve({});
      try { const v = JSON.parse(data); resolve(v && typeof v === 'object' ? v : null); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// le o corpo bruto (upload) ate `limit` bytes -> Buffer | null (estourou)
function readRaw(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => { size += c.length; if (size > limit) { over = true; req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const truthy = (v) => v === true || v === 'true' || v === 'on' || v === '1';
const validName = (n) => typeof n === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(n) && n !== '.' && n !== '..';
// nome da sessao tmux do projeto (mesma sanitizacao do claude-session.sh: tr -c 'A-Za-z0-9_-' '_')
const sessionName = (name) => 'claude-' + String(name).replace(/[^A-Za-z0-9_-]/g, '_');
const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, service: 'claude-panel', msg, ...(extra || {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

module.exports = { sh, readJson, readRaw, sendJson, truthy, validName, sessionName, clampInt, log };
