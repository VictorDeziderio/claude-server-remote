#!/usr/bin/env node
'use strict';
/*
 * Claude Remote — servidor do painel do dev-box (Node puro, sem dependencias de runtime).
 * - Serve a SPA (React/Vite) buildada em ./dist
 * - Expoe a API JSON em /api/*: state, create, rename, config, restart, remote
 * - Acoes na sessao tmux "claude" + leitura do panel.json + status/consumo do Claude
 * Auth: o gateway (Caddy) ja autentica o painel; aqui nao ha auth propria.
 * Roda como ubuntu (HOME=/root).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = process.env.HOME || '/root';
const PORT = parseInt(process.env.PANEL_PORT || '7000', 10);
const BIND = process.env.PANEL_BIND || '0.0.0.0';
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(HOME, 'projects');
const ACTIVE_FILE = path.join(HOME, '.claude', 'active-project');
const CONFIG_FILE = process.env.PANEL_CONFIG || path.join(HOME, '.claude', 'panel.json');
const IDE_PATH = (process.env.IDE_PATH || '/ide').replace(/\/+$/, '');
const SESSION_SCRIPT = '/usr/local/bin/claude-session.sh';
const SESSION = 'claude';
const FULL_AUTOCMD = process.env.FULL_AUTOCMD || '';
const DIST = path.join(__dirname, 'dist');

// Auth do painel: pagina de login propria (cookie assinado), em vez do basic_auth do gateway.
const PANEL_LOGIN = process.env.PANEL_LOGIN || 'admin';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
// token estavel derivado da senha (sobrevive a restart do painel; nao da p/ forjar sem a senha)
const AUTH_TOKEN = crypto.createHmac('sha256', PANEL_PASSWORD || 'claude-remote')
  .update('claude-remote-auth-v1').digest('hex');
const COOKIE = 'cr_auth';

fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// ---------- helpers ----------
function activeProject() {
  try { return fs.readFileSync(ACTIVE_FILE, 'utf8').split('\n')[0].trim(); } catch { return ''; }
}
function listProjects() {
  try {
    return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name).sort();
  } catch { return []; }
}
const validName = (n) => typeof n === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(n) && n !== '.' && n !== '..';

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err && err.message) || '' }));
  });
}
function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
const truthy = (v) => v === true || v === 'true' || v === 'on' || v === '1';

function cookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
const isAuthed = (req) => cookie(req, COOKIE) === AUTH_TOKEN;
function doLogin(body, res) {
  const okUser = String(body.login || '') === PANEL_LOGIN;
  const okPass = !!PANEL_PASSWORD && String(body.password || '') === PANEL_PASSWORD;
  if (okUser && okPass) {
    res.setHeader('Set-Cookie', `${COOKIE}=${AUTH_TOKEN}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
    return { ok: true, msg: 'autenticado' };
  }
  return { ok: false, msg: 'login ou senha incorretos' };
}

// ---------- config (panel.json) ----------
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c && typeof c === 'object') { c.defaults = c.defaults || {}; c.projects = c.projects || {}; return c; }
  } catch { /* ausente/invalido -> defaults */ }
  return { defaults: { autoStartClaude: true, autoRemote: true }, projects: {} };
}
function saveConfig(c) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + '\n');
    return true;
  } catch (e) { console.error('[painel] erro salvando panel.json:', e.message); return false; }
}
function projConfig(name) {
  const c = loadConfig();
  const d = c.defaults || {};
  const p = (c.projects && c.projects[name]) || {};
  const pick = (k) => (k in p ? !!p[k] : (k in d ? !!d[k] : true));
  return { autoStartClaude: pick('autoStartClaude'), autoRemote: pick('autoRemote') };
}
function setProjConfig(name, patch) {
  const c = loadConfig();
  c.projects = c.projects || {};
  c.projects[name] = Object.assign({}, c.projects[name], patch);
  return saveConfig(c);
}

// ---------- status / consumo do Claude ----------
function isLoggedIn() {
  if (process.env.ANTHROPIC_API_KEY) return true;
  try { if (fs.statSync(path.join(HOME, '.claude', '.credentials.json')).size > 0) return true; } catch { /**/ }
  try {
    const j = fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8');
    if (/"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"/.test(j)) return true;
  } catch { /**/ }
  return false;
}
async function getStatus() {
  const up = (await sh('tmux', ['has-session', '-t', SESSION])).ok;
  let pane = '';
  if (up) {
    const r = await sh('tmux', ['display-message', '-p', '-t', SESSION, '#{pane_current_command}']);
    pane = (r.stdout || '').trim();
  }
  const ver = ((await sh('claude', ['--version'])).stdout || '').trim().split('\n')[0] || '?';
  return { up, pane, claudeRunning: up && /node|claude/.test(pane), ver, logged: isLoggedIn(), active: activeProject() };
}
function claudeUsage() {
  const base = path.join(HOME, '.claude', 'projects');
  const out = {
    sessions: 0, messages: 0,
    today: { in: 0, out: 0, cacheW: 0, cacheR: 0 },
    total: { in: 0, out: 0, cacheW: 0, cacheR: 0 },
  };
  const files = [];
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  })(base);
  out.sessions = files.length;
  const today = new Date().toISOString().slice(0, 10);
  for (const f of files) {
    let data;
    try { if (fs.statSync(f).size > 64 * 1024 * 1024) continue; data = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of data.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const usg = o && o.message && o.message.usage;
      if (!usg) continue;
      out.messages++;
      const iTok = usg.input_tokens || 0, oTok = usg.output_tokens || 0;
      const cw = usg.cache_creation_input_tokens || 0, cr = usg.cache_read_input_tokens || 0;
      out.total.in += iTok; out.total.out += oTok; out.total.cacheW += cw; out.total.cacheR += cr;
      if (String(o.timestamp || '').slice(0, 10) === today) {
        out.today.in += iTok; out.today.out += oTok; out.today.cacheW += cw; out.today.cacheR += cr;
      }
    }
  }
  return out;
}
// cache curto p/ nao reparsear os jsonl a cada request
let usageCache = { t: 0, v: null };
function usageCached() {
  const now = Date.now();
  if (usageCache.v && now - usageCache.t < 10000) return usageCache.v;
  usageCache = { t: now, v: claudeUsage() };
  return usageCache.v;
}

// ---------- acoes ----------
async function createProject(name, autoStartClaude, autoRemote) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido (use letras, numeros, . _ -)' };
  const dir = path.join(PROJECTS_DIR, name);
  if (fs.existsSync(dir)) return { ok: false, msg: 'ja existe' };
  fs.mkdirSync(dir, { recursive: true });
  await sh('git', ['-C', dir, 'init', '-q']);
  setProjConfig(name, { autoStartClaude: !!autoStartClaude, autoRemote: !!autoRemote });
  return { ok: true, msg: `projeto "${name}" criado (Claude ${autoStartClaude ? 'ON' : 'OFF'}, remote ${autoRemote ? 'ON' : 'OFF'})` };
}
async function restartOn(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  const dir = path.join(PROJECTS_DIR, name);
  if (!fs.existsSync(dir)) return { ok: false, msg: 'pasta inexistente' };
  fs.writeFileSync(ACTIVE_FILE, dir + '\n');
  await sh('tmux', ['kill-session', '-t', SESSION]);
  await sh('bash', [SESSION_SCRIPT]);
  const c = projConfig(name);
  return { ok: true, msg: `sessao reiniciada em "${name}" (Claude ${c.autoStartClaude ? 'ON' : 'OFF'}, remote ${c.autoRemote ? 'ON' : 'OFF'})` };
}
// Claude guarda o historico em ~/.claude/projects/<cwd codificado> (nao-alfanumerico -> "-").
function migrateClaudeHistory(oldDir, newDir) {
  try {
    const base = path.join(HOME, '.claude', 'projects');
    const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
    const from = path.join(base, enc(oldDir));
    const to = path.join(base, enc(newDir));
    if (fs.existsSync(from) && !fs.existsSync(to)) { fs.renameSync(from, to); return true; }
  } catch (e) { console.error('[painel] migrate hist:', e.message); }
  return false;
}
async function renameProject(oldName, newName) {
  if (!validName(oldName) || !validName(newName)) return { ok: false, msg: 'nome invalido' };
  if (oldName === newName) return { ok: false, msg: 'o nome e o mesmo' };
  const oldDir = path.join(PROJECTS_DIR, oldName);
  const newDir = path.join(PROJECTS_DIR, newName);
  if (!fs.existsSync(oldDir)) return { ok: false, msg: 'pasta inexistente' };
  if (fs.existsSync(newDir)) return { ok: false, msg: `ja existe um projeto "${newName}"` };
  const wasActive = (oldDir === activeProject());
  if (wasActive) await sh('tmux', ['kill-session', '-t', SESSION]);
  try { fs.renameSync(oldDir, newDir); }
  catch (e) { return { ok: false, msg: 'falha ao renomear: ' + e.message }; }
  const histMoved = migrateClaudeHistory(oldDir, newDir);
  const c = loadConfig();
  if (c.projects && c.projects[oldName]) {
    c.projects[newName] = c.projects[oldName];
    delete c.projects[oldName];
    saveConfig(c);
  }
  if (wasActive) { fs.writeFileSync(ACTIVE_FILE, newDir + '\n'); await sh('bash', [SESSION_SCRIPT]); }
  return {
    ok: true,
    msg: `"${oldName}" -> "${newName}"${histMoved ? ' (historico migrado)' : ''}${wasActive ? ' (sessao reiniciada)' : ''}`,
  };
}
async function setConfig(name, key, value) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  if (key !== 'autoStartClaude' && key !== 'autoRemote') return { ok: false, msg: 'chave invalida' };
  const val = truthy(value);
  if (!setProjConfig(name, { [key]: val })) return { ok: false, msg: 'falha ao salvar panel.json' };
  const label = key === 'autoStartClaude' ? 'auto-start do Claude' : 'auto religar remote-control';
  const tail = (path.join(PROJECTS_DIR, name) === activeProject()) ? ' — reinicie a sessao p/ aplicar' : '';
  return { ok: true, msg: `"${name}": ${label} = ${val ? 'ON' : 'OFF'}${tail}` };
}
async function sendRemote() {
  if (!(await sh('tmux', ['has-session', '-t', SESSION])).ok) return { ok: false, msg: 'sessao tmux nao esta de pe' };
  if (!FULL_AUTOCMD) return { ok: false, msg: 'remote-control desativado globalmente' };
  await sh('tmux', ['send-keys', '-t', SESSION, FULL_AUTOCMD]);
  await new Promise((r) => setTimeout(r, 1000));
  await sh('tmux', ['send-keys', '-t', SESSION, 'Enter']);
  return { ok: true, msg: `remote-control reenviado: ${FULL_AUTOCMD}` };
}

async function buildState() {
  const active = activeProject();
  const projects = listProjects().map((name) => {
    const dir = path.join(PROJECTS_DIR, name);
    const c = projConfig(name);
    return { name, dir, active: dir === active, autoStartClaude: c.autoStartClaude, autoRemote: c.autoRemote };
  });
  return {
    projectsDir: PROJECTS_DIR,
    activeProject: active,
    remoteCmd: FULL_AUTOCMD,
    idePath: IDE_PATH,
    status: await getStatus(),
    usage: usageCached(),
    projects,
  };
}

// ---------- http ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.ico': 'image/x-icon', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  let file = path.join(DIST, path.normalize(p));
  if (!file.startsWith(DIST)) { sendJson(res, 403, { ok: false, msg: 'forbidden' }); return; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(DIST, 'index.html'); // SPA fallback
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Claude Remote: build do painel ausente (rode "npm run build" em panel/).');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];

    // --- endpoints livres (sem auth) ---
    if (req.method === 'POST' && url === '/api/login') return sendJson(res, 200, doLogin(await readJson(req), res));
    if (req.method === 'POST' && url === '/api/logout') {
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }

    // --- API protegida (cookie de sessao) ---
    if (url.startsWith('/api/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { ok: false, msg: 'nao autenticado' });
      if (req.method === 'GET' && url === '/api/state') return sendJson(res, 200, await buildState());
      if (req.method === 'POST') {
        const body = await readJson(req);
        let r;
        if (url === '/api/create') r = await createProject(body.name, !!body.autoStartClaude, !!body.autoRemote);
        else if (url === '/api/rename') r = await renameProject(body.name, body.newName);
        else if (url === '/api/config') r = await setConfig(body.name, body.key, body.value);
        else if (url === '/api/restart') r = await restartOn(body.name);
        else if (url === '/api/remote') r = await sendRemote();
        else return sendJson(res, 404, { ok: false, msg: 'rota desconhecida' });
        return sendJson(res, 200, r);
      }
      return sendJson(res, 404, { ok: false, msg: 'rota desconhecida' });
    }

    // --- SPA estatica (a propria SPA mostra o login quando /api/state da 401) ---
    if (req.method === 'GET') return serveStatic(req, res);
    sendJson(res, 405, { ok: false, msg: 'method not allowed' });
  } catch (e) {
    sendJson(res, 500, { ok: false, msg: e.message });
  }
});

server.listen(PORT, BIND, () =>
  console.log(`[Claude Remote] ${BIND}:${PORT} | projetos: ${PROJECTS_DIR} | dist: ${DIST}`));
