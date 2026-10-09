'use strict';
const { execFile } = require('child_process');

// achado @security: `tmux new-session` sobe um shell que herda o env de quem chamou (o painel) —
// sem filtrar, PANEL_PASSWORD/GH_TOKEN iam pra dentro de TODA sessao tmux (e de qualquer Claude
// rodando nela, visivel via `env`). So o caso de tmux: outros comandos (git, npm, bash de backup)
// continuam herdando o env normal, alguns dependem dele de proposito (ex.: GH_TOKEN no backup).
const TMUX_STRIP_ENV = ['PANEL_PASSWORD', 'GH_TOKEN'];

// roda um comando sem shell (args separados) e nunca rejeita: {ok, stdout, stderr}
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

// le o corpo JSON de uma request (limite 1MB). Corpo invalido -> null (a rota responde 400).
// req.destroy() dispara 'close'/'aborted', NUNCA 'end' — resolver so no 'end' deixava a promise
// pendurada pra sempre (handler nunca responde, socket nunca fecha, conexao vaza) quando o corpo
// passava do limite. Ao passar do limite so paramos de ACUMULAR (sem crescer memoria): o stream
// continua drenando (sem destroy) ate o 'end' natural, pra rota ainda poder responder 400 de
// verdade — destruir o socket aqui impediria QUALQUER resposta (o cliente so veria a conexao cair).
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

// le o corpo bruto (upload) ate `limit` bytes -> Buffer | null (estourou)
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
// nome da sessao tmux do projeto (mesma sanitizacao do claude-session.sh: tr -c 'A-Za-z0-9_-' '_')
const sessionName = (name) => 'claude-' + String(name).replace(/[^A-Za-z0-9_-]/g, '_');
// alvo EXATO de pane do tmux ("=sessao:"). Sem o "=" o tmux casa por PREFIXO: com "claude-api"
// fora do ar, um send-keys iria parar em "claude-api2".
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

module.exports = { sh, readJson, readRaw, sendJson, truthy, validName, sessionName, paneOf, clampInt, log };
