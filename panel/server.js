#!/usr/bin/env node
'use strict';
/*
 * Claude Remote — servidor do painel do dev-box (Node puro, sem dependencias de runtime).
 * Modelo multi-tmux: UMA sessao tmux por projeto (claude-<nome>), Claude em paralelo por projeto.
 * - Serve a SPA (React/Vite) buildada em ./dist
 * - Expoe a API JSON em /api/*: state, create, rename, config, restart, remote, login, logout
 * - Acoes nas sessoes tmux "claude-<projeto>" + leitura do panel.json + status/consumo do Claude
 * Auth: pagina de login propria (cookie de sessao assinado). Roda como ubuntu (HOME=/root).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = process.env.HOME || '/root';
// Defaults alinhados com o start.sh (gateway -> painel interno). Sempre atras do Caddy:
// loopback + porta interna 7001. Em producao o start.sh passa esses valores explicitos.
const PORT = parseInt(process.env.PANEL_PORT || '7001', 10);
const BIND = process.env.PANEL_BIND || '127.0.0.1';
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(HOME, 'projects');
const CONFIG_FILE = process.env.PANEL_CONFIG || path.join(HOME, '.claude', 'panel.json');
const RUN_DIR = path.join(HOME, '.claude', 'run');            // flags "<sessao>.running"
const IDE_PATH = (process.env.IDE_PATH || '/ide').replace(/\/+$/, '');
const SESSION_SCRIPT = '/usr/local/bin/claude-session.sh';
// nome do remote-control: por padrao = nome do projeto; REMOTE_CONTROL_NAME (se setado) forca um fixo.
const REMOTE_CONTROL_NAME = process.env.REMOTE_CONTROL_NAME || '';
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
function listProjects() {
  try {
    return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name).sort();
  } catch { return []; }
}
const validName = (n) => typeof n === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(n) && n !== '.' && n !== '..';
// nome da sessao tmux do projeto (mesma sanitizacao do claude-session.sh: tr -c 'A-Za-z0-9_-' '_')
const sessionName = (name) => 'claude-' + String(name).replace(/[^A-Za-z0-9_-]/g, '_');
const remoteCmdFor = (name) => '/remote-control ' + (REMOTE_CONTROL_NAME || name);

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
function doLogin(body, res, req) {
  const okUser = String(body.login || '') === PANEL_LOGIN;
  const okPass = !!PANEL_PASSWORD && String(body.password || '') === PANEL_PASSWORD;
  if (okUser && okPass) {
    // Secure so quando servido via HTTPS (EasyPanel/Caddy enviam X-Forwarded-Proto)
    // — protege o cookie sob TLS sem quebrar acesso http local.
    const https = String((req && req.headers['x-forwarded-proto']) || '').split(',')[0].trim() === 'https';
    res.setHeader('Set-Cookie',
      `${COOKIE}=${AUTH_TOKEN}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${https ? '; Secure' : ''}`);
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
// Login + conta: le oauthAccount.emailAddress de ~/.claude.json (ou API key via env).
function loginInfo() {
  if (process.env.ANTHROPIC_API_KEY) return { logged: true, account: 'API key (env)', org: '', method: 'apikey' };
  let account = '', org = '', raw = '';
  try { raw = fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'); } catch { /**/ }
  if (raw) {
    try {
      const oa = JSON.parse(raw).oauthAccount;
      if (oa) { account = oa.emailAddress || oa.email || ''; org = oa.organizationName || ''; }
    } catch { /**/ }
  }
  let logged = !!account;
  try { if (fs.statSync(path.join(HOME, '.claude', '.credentials.json')).size > 0) logged = true; } catch { /**/ }
  if (!logged && raw && /"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"/.test(raw)) logged = true;
  return { logged, account, org, method: logged ? 'oauth' : '' };
}
// desloga o Claude: remove o token OAuth (.credentials.json) e o cache de conta (oauthAccount)
function claudeLogout() {
  let did = false;
  try { fs.rmSync(path.join(HOME, '.claude', '.credentials.json'), { force: true }); did = true; } catch { /**/ }
  try {
    const p = path.join(HOME, '.claude.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && j.oauthAccount) { delete j.oauthAccount; fs.writeFileSync(p, JSON.stringify(j, null, 2)); did = true; }
  } catch { /**/ }
  return { ok: true, msg: did ? 'deslogado do Claude (credenciais removidas)' : 'nenhuma credencial encontrada' };
}

// versao do Claude e estavel em runtime -> resolve uma vez e cacheia (evita spawn por request)
let verCache = '';
async function claudeVersion() {
  if (verCache) return verCache;
  verCache = ((await sh('claude', ['--version'])).stdout || '').trim().split('\n')[0] || '?';
  return verCache;
}

// sessao tmux do projeto de pe? (match exato com "=")
async function sessionUp(name) {
  return (await sh('tmux', ['has-session', '-t', sessionName(name)])).ok;
}
// Claude de fato rodando nessa sessao? Le o flag file que o claude-loop.sh mantem
// (o pane_current_command mostra "bash"/o supervisor e dava falso-negativo de "parado").
function claudeRunningFlag(name) {
  try { return fs.existsSync(path.join(RUN_DIR, sessionName(name) + '.running')); } catch { return false; }
}

// percorre os .jsonl uma vez e agrega tokens POR DIA e por (dia, projeto). Base p/ qualquer
// recorte de periodo no relatorio. O Claude guarda o historico em ~/.claude/projects/<cwd
// codificado> (nao-alfanumerico -> "-").
function rawByDay() {
  const base = path.join(HOME, '.claude', 'projects');
  const encOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const projByEnc = {};
  for (const name of listProjects()) projByEnc[encOf(path.join(PROJECTS_DIR, name))] = name;

  const perDay = {}; // 'YYYY-MM-DD' -> {in,out,cacheW,cacheR,messages, byProject:{name:{...}}}
  let messages = 0;
  const files = [];
  (function walk(d, top) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, top || e.name);
      else if (e.name.endsWith('.jsonl')) files.push({ path: p, top: top || '' });
    }
  })(base, '');
  for (const f of files) {
    let data;
    try { if (fs.statSync(f.path).size > 64 * 1024 * 1024) continue; data = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    const pname = projByEnc[f.top] || null;
    for (const line of data.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const usg = o && o.message && o.message.usage;
      if (!usg) continue;
      const day = String(o.timestamp || '').slice(0, 10);
      if (!/^\d{4}-\d\d-\d\d$/.test(day)) continue;
      messages++;
      const iTok = usg.input_tokens || 0, oTok = usg.output_tokens || 0;
      const cw = usg.cache_creation_input_tokens || 0, cr = usg.cache_read_input_tokens || 0;
      const D = perDay[day] || (perDay[day] = { in: 0, out: 0, cacheW: 0, cacheR: 0, messages: 0, byProject: {} });
      D.in += iTok; D.out += oTok; D.cacheW += cw; D.cacheR += cr; D.messages++;
      if (pname) {
        const b = D.byProject[pname] || (D.byProject[pname] = { in: 0, out: 0, cacheW: 0, cacheR: 0, messages: 0 });
        b.in += iTok; b.out += oTok; b.cacheW += cw; b.cacheR += cr; b.messages++;
      }
    }
  }
  return { perDay, sessions: files.length, messages };
}
let rawCache = { t: 0, v: null };
function rawCached() {
  const now = Date.now();
  if (rawCache.v && now - rawCache.t < 10000) return rawCache.v;
  rawCache = { t: now, v: rawByDay() };
  return rawCache.v;
}
// agrega o periodo [from, to] (inclusivo, 'YYYY-MM-DD'; vazio = sem limite)
function aggregateRange(from, to) {
  const raw = rawCached();
  const out = {
    from: from || '', to: to || '', sessions: raw.sessions, messages: 0,
    total: { in: 0, out: 0, cacheW: 0, cacheR: 0 },
    byProject: {}, dailyArr: [],
  };
  for (const day of Object.keys(raw.perDay).sort()) {
    if (from && day < from) continue;
    if (to && day > to) continue;
    const D = raw.perDay[day];
    out.total.in += D.in; out.total.out += D.out; out.total.cacheW += D.cacheW; out.total.cacheR += D.cacheR;
    out.messages += D.messages;
    out.dailyArr.push({ date: day, in: D.in, out: D.out });
    for (const [name, b] of Object.entries(D.byProject)) {
      const t = out.byProject[name] || (out.byProject[name] = { in: 0, out: 0, cacheW: 0, cacheR: 0, messages: 0 });
      t.in += b.in; t.out += b.out; t.cacheW += b.cacheW; t.cacheR += b.cacheR; t.messages += b.messages;
    }
  }
  return out;
}
// usage do dashboard: total (tudo) + hoje + ultimos 30 dias
function usageCached() {
  const all = aggregateRange('', '');
  const today = new Date().toISOString().slice(0, 10);
  all.today = aggregateRange(today, today).total;
  all.dailyArr = all.dailyArr.slice(-30);
  return all;
}

// ---------- acoes (por projeto / sessao) ----------
async function createProject(name, autoStartClaude, autoRemote) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido (use letras, numeros, . _ -)' };
  const dir = path.join(PROJECTS_DIR, name);
  if (fs.existsSync(dir)) return { ok: false, msg: 'ja existe' };
  fs.mkdirSync(dir, { recursive: true });
  await sh('git', ['-C', dir, 'init', '-q']);
  setProjConfig(name, { autoStartClaude: !!autoStartClaude, autoRemote: !!autoRemote });
  await sh('bash', [SESSION_SCRIPT, name]); // sobe a sessao tmux do novo projeto
  return { ok: true, msg: `projeto "${name}" criado e sessao iniciada (Claude ${autoStartClaude ? 'ON' : 'OFF'}, remote ${autoRemote ? 'ON' : 'OFF'})` };
}
async function restartProject(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  const dir = path.join(PROJECTS_DIR, name);
  if (!fs.existsSync(dir)) return { ok: false, msg: 'pasta inexistente' };
  await sh('tmux', ['kill-session', '-t', sessionName(name)]);
  await sh('bash', [SESSION_SCRIPT, name]);
  const c = projConfig(name);
  return { ok: true, msg: `sessao de "${name}" reiniciada (Claude ${c.autoStartClaude ? 'ON' : 'OFF'}, remote ${c.autoRemote ? 'ON' : 'OFF'})` };
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
  await sh('tmux', ['kill-session', '-t', sessionName(oldName)]); // encerra a sessao antiga
  try { fs.renameSync(oldDir, newDir); }
  catch (e) { return { ok: false, msg: 'falha ao renomear: ' + e.message }; }
  const histMoved = migrateClaudeHistory(oldDir, newDir);
  const c = loadConfig();
  if (c.projects && c.projects[oldName]) {
    c.projects[newName] = c.projects[oldName];
    delete c.projects[oldName];
    saveConfig(c);
  }
  await sh('bash', [SESSION_SCRIPT, newName]); // sobe a sessao ja com o novo nome
  return {
    ok: true,
    msg: `"${oldName}" -> "${newName}"${histMoved ? ' (historico migrado)' : ''} (sessao recriada)`,
  };
}
async function sendRemote(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  if (!(await sessionUp(name))) return { ok: false, msg: 'sessao tmux nao esta de pe' };
  if (!loginInfo().logged) return { ok: false, msg: 'Claude nao esta logado' };
  const sess = sessionName(name);
  const cmd = remoteCmdFor(name);
  await sh('tmux', ['send-keys', '-t', sess, cmd]);
  await new Promise((r) => setTimeout(r, 1000));
  await sh('tmux', ['send-keys', '-t', sess, 'Enter']);
  return { ok: true, msg: `remote reenviado: ${cmd}` };
}
async function setConfig(name, key, value) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  if (key !== 'autoStartClaude' && key !== 'autoRemote') return { ok: false, msg: 'chave invalida' };
  const val = truthy(value);
  if (!setProjConfig(name, { [key]: val })) return { ok: false, msg: 'falha ao salvar panel.json' };
  if (key === 'autoRemote') {
    // toggle imediato: ligar -> envia o remote agora; desligar -> so grava (o atual encerra ao reiniciar)
    if (val) {
      const r = await sendRemote(name);
      return {
        ok: true,
        msg: r.ok ? `"${name}": remote LIGADO e reenviado (${remoteCmdFor(name)})`
                  : `"${name}": remote LIGADO (sera enviado quando sessao/login estiver pronto)`,
      };
    }
    return { ok: true, msg: `"${name}": remote DESLIGADO (nao religa mais; o atual encerra ao reiniciar a sessao)` };
  }
  // autoStartClaude: aplicado na proxima (re)criacao da sessao
  return { ok: true, msg: `"${name}": auto-start do Claude = ${val ? 'ON' : 'OFF'} — reinicie a sessao p/ aplicar` };
}

async function buildState() {
  const projects = [];
  for (const name of listProjects()) {
    const up = await sessionUp(name);
    const c = projConfig(name);
    projects.push({
      name,
      dir: path.join(PROJECTS_DIR, name),
      up,
      claudeRunning: up && claudeRunningFlag(name),
      autoStartClaude: c.autoStartClaude,
      autoRemote: c.autoRemote,
      remoteCmd: remoteCmdFor(name),
    });
  }
  return {
    projectsDir: PROJECTS_DIR,
    idePath: IDE_PATH,
    login: loginInfo(),
    version: await claudeVersion(),
    remoteNameForced: REMOTE_CONTROL_NAME,
    usage: usageCached(),
    projects,
  };
}

// ---------- file manager (sandbox em /root) ----------
// IDE simples: ver / editar / criar / excluir arquivos. Tudo CONFINADO a FS_BASE (=/root):
// resolveSafe rejeita qualquer caminho que escape da raiz (path traversal).
const FS_BASE = HOME;
function resolveSafe(rel) {
  const full = path.resolve(FS_BASE, String(rel == null ? '' : rel).replace(/^[/\\]+/, ''));
  if (full !== FS_BASE && !full.startsWith(FS_BASE + path.sep)) return null;
  return full;
}
const relOf = (full) => path.relative(FS_BASE, full); // caminho relativo a /root (p/ exibir)

function fsList(rel) {
  const full = resolveSafe(rel);
  if (!full) return { ok: false, msg: 'caminho invalido' };
  try {
    const entries = fs.readdirSync(full, { withFileTypes: true })
      .map((d) => {
        let size = 0; try { if (d.isFile()) size = fs.statSync(path.join(full, d.name)).size; } catch { /**/ }
        return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ok: true, path: relOf(full), entries };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsRead(rel) {
  const full = resolveSafe(rel);
  if (!full) return { ok: false, msg: 'caminho invalido' };
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return { ok: false, msg: 'nao e um arquivo' };
    if (st.size > 2 * 1024 * 1024) return { ok: false, msg: 'arquivo muito grande (>2MB)' };
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return { ok: false, msg: 'arquivo binario (nao editavel aqui)' };
    return { ok: true, path: relOf(full), content: buf.toString('utf8'), size: st.size };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsSave(rel, content) {
  const full = resolveSafe(rel);
  if (!full) return { ok: false, msg: 'caminho invalido' };
  if (typeof content !== 'string') return { ok: false, msg: 'conteudo invalido' };
  if (content.length > 5 * 1024 * 1024) return { ok: false, msg: 'conteudo muito grande (>5MB)' };
  try { fs.writeFileSync(full, content); return { ok: true, msg: `salvo: ${relOf(full)}` }; }
  catch (e) { return { ok: false, msg: e.message }; }
}
function fsCreate(rel, kind) {
  const full = resolveSafe(rel);
  if (!full || full === FS_BASE) return { ok: false, msg: 'caminho invalido' };
  if (fs.existsSync(full)) return { ok: false, msg: 'ja existe' };
  try {
    if (kind === 'dir') fs.mkdirSync(full, { recursive: true });
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, ''); }
    return { ok: true, msg: `${kind === 'dir' ? 'pasta' : 'arquivo'} criado: ${relOf(full)}` };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsDelete(rel) {
  const full = resolveSafe(rel);
  if (!full || full === FS_BASE) return { ok: false, msg: 'caminho invalido' };
  try { fs.rmSync(full, { recursive: true, force: true }); return { ok: true, msg: `excluido: ${relOf(full)}` }; }
  catch (e) { return { ok: false, msg: e.message }; }
}
function fsRename(rel, newRel) {
  const a = resolveSafe(rel), b = resolveSafe(newRel);
  if (!a || !b || a === FS_BASE) return { ok: false, msg: 'caminho invalido' };
  if (fs.existsSync(b)) return { ok: false, msg: 'o destino ja existe' };
  try { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); return { ok: true, msg: `renomeado: ${relOf(b)}` }; }
  catch (e) { return { ok: false, msg: e.message }; }
}

// ---------- terminal (via tmux capture-pane / send-keys) ----------
// Console simples: VER a tela de uma sessao e ENVIAR teclas. Dois tipos de alvo:
//  - "shell" (ou vazio): sessao "cr-shell" = um bash em /root (SSH simples no servidor)
//  - nome de projeto: a sessao claude-<projeto> (p/ ver/logar o Claude)
// Nao e um PTY completo, mas funciona com tmux sem dependencias nativas.
const SHELL_SESSION = 'cr-shell';
async function ensureShell() {
  if (!(await sh('tmux', ['has-session', '-t', SHELL_SESSION])).ok) {
    await sh('tmux', ['new-session', '-d', '-s', SHELL_SESSION, '-c', HOME]); // bash em /root
  }
  return SHELL_SESSION;
}
async function termTargetSession(name) {
  if (!name || name === 'shell') return ensureShell();   // shell em /root, criado sob demanda
  return validName(name) ? sessionName(name) : null;     // sessao do projeto
}
async function termCapture(name) {
  const sess = await termTargetSession(name);
  if (!sess) return { ok: false, msg: 'alvo invalido' };
  if (!(await sh('tmux', ['has-session', '-t', sess])).ok) return { ok: false, msg: 'sessao nao esta de pe' };
  const r = await sh('tmux', ['capture-pane', '-t', sess, '-p', '-S', '-200']);
  return { ok: r.ok, content: r.stdout || '', msg: r.ok ? '' : 'falha ao capturar a tela' };
}
async function termSend(name, text, key) {
  const sess = await termTargetSession(name);
  if (!sess) return { ok: false, msg: 'alvo invalido' };
  if (!(await sh('tmux', ['has-session', '-t', sess])).ok) return { ok: false, msg: 'sessao nao esta de pe' };
  if (typeof text === 'string' && text.length) {
    if (text.length > 4096) return { ok: false, msg: 'texto muito longo' };
    await sh('tmux', ['send-keys', '-t', sess, '-l', text]);
  }
  if (typeof key === 'string' && key.length) {
    const ALLOW = new Set(['Enter', 'Escape', 'Tab', 'Space', 'BSpace', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End', 'IC', 'DC']);
    // aceita tambem qualquer Ctrl+<letra> (C-a..C-z) p/ o terminal interativo
    if (!ALLOW.has(key) && !/^C-[a-z]$/.test(key)) return { ok: false, msg: 'tecla nao permitida' };
    await sh('tmux', ['send-keys', '-t', sess, key]);
  }
  return { ok: true };
}
// Sai do Claude da sessao (Ctrl-C duas vezes). Com autoStart ON, o supervisor (claude-loop.sh)
// reabre automaticamente uma conversa NOVA em ~3s; com autoStart OFF, cai no shell.
async function termExit(name) {
  if (!validName(name)) return { ok: false, msg: 'projeto invalido' };
  const sess = sessionName(name);
  if (!(await sh('tmux', ['has-session', '-t', sess])).ok) return { ok: false, msg: 'sessao nao esta de pe' };
  await sh('tmux', ['send-keys', '-t', sess, 'C-c']);
  await new Promise((r) => setTimeout(r, 400));
  await sh('tmux', ['send-keys', '-t', sess, 'C-c']);
  return { ok: true, msg: `Claude encerrado em ${sess} — o supervisor abre uma nova conversa` };
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
    if (req.method === 'POST' && url === '/api/login') return sendJson(res, 200, doLogin(await readJson(req), res, req));
    if (req.method === 'POST' && url === '/api/logout') {
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }

    // --- API protegida (cookie de sessao) ---
    if (url.startsWith('/api/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { ok: false, msg: 'nao autenticado' });
      if (req.method === 'GET' && url === '/api/state') return sendJson(res, 200, await buildState());
      if (req.method === 'GET' && url === '/api/fs/list') {
        const q = new URL(req.url, 'http://x').searchParams;
        return sendJson(res, 200, fsList(q.get('path') || ''));
      }
      if (req.method === 'GET' && url === '/api/fs/read') {
        const q = new URL(req.url, 'http://x').searchParams;
        return sendJson(res, 200, fsRead(q.get('path') || ''));
      }
      if (req.method === 'GET' && url === '/api/term/capture') {
        const q = new URL(req.url, 'http://x').searchParams;
        return sendJson(res, 200, await termCapture(q.get('name') || ''));
      }
      if (req.method === 'GET' && url === '/api/report') {
        const q = new URL(req.url, 'http://x').searchParams;
        return sendJson(res, 200, { ok: true, usage: aggregateRange(q.get('from') || '', q.get('to') || '') });
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        let r;
        if (url === '/api/create') r = await createProject(body.name, !!body.autoStartClaude, !!body.autoRemote);
        else if (url === '/api/rename') r = await renameProject(body.name, body.newName);
        else if (url === '/api/config') r = await setConfig(body.name, body.key, body.value);
        else if (url === '/api/restart') r = await restartProject(body.name);
        else if (url === '/api/remote') r = await sendRemote(body.name);
        else if (url === '/api/fs/save') r = fsSave(body.path, body.content);
        else if (url === '/api/fs/create') r = fsCreate(body.path, body.kind);
        else if (url === '/api/fs/delete') r = fsDelete(body.path);
        else if (url === '/api/fs/rename') r = fsRename(body.path, body.newPath);
        else if (url === '/api/term/send') r = await termSend(body.name, body.text, body.key);
        else if (url === '/api/term/exit') r = await termExit(body.name);
        else if (url === '/api/claude/logout') r = claudeLogout();
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
