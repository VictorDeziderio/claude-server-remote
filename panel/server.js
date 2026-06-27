#!/usr/bin/env node
'use strict';
/*
 * Painel de controle do dev-box "claude" (Node puro, sem dependencias).
 * - Lista/cadastra pastas de projeto em PROJECTS_DIR
 * - Config por projeto em panel.json (autoStartClaude, autoRemote) -> editavel pelos chips
 * - Acoes na sessao tmux "claude": reiniciar (tmux+Claude), religar remote-control
 * - "Abrir IDE": link pro code-server ja na pasta
 * - Status do Claude: versao, login, sessao, pane atual e CONSUMO de tokens (hoje/total)
 * Auth: o gateway (Caddy) ja autentica; aqui roda sem auth propria (IDE_PASSWORD vazio).
 * Roda como ubuntu (HOME=/root).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HOME = process.env.HOME || '/root';
const PORT = parseInt(process.env.PANEL_PORT || '7000', 10);
const PASSWORD = process.env.IDE_PASSWORD || '';
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(HOME, 'projects');
const ACTIVE_FILE = path.join(HOME, '.claude', 'active-project');
const CONFIG_FILE = process.env.PANEL_CONFIG || path.join(HOME, '.claude', 'panel.json');
const IDE_PUBLIC_URL = (process.env.IDE_PUBLIC_URL || '').replace(/\/+$/, '');
// Caminho do IDE no gateway (mesmo dominio). Vazio IDE_PUBLIC_URL -> usa este path.
const IDE_PATH = (process.env.IDE_PATH || '/ide').replace(/\/+$/, '');
const SESSION_SCRIPT = '/usr/local/bin/claude-session.sh';
const SESSION = 'claude';
// Comando do remote-control (vem do start.sh). Vazio -> remote desativado globalmente.
const FULL_AUTOCMD = process.env.FULL_AUTOCMD || '';

fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!PASSWORD) console.warn('[painel] AVISO: IDE_PASSWORD vazio -> painel SEM auth propria (gateway autentica)');

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

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
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const out = {};
      for (const pair of data.split('&')) {
        const i = pair.indexOf('=');
        if (i < 0) continue;
        out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      }
      resolve(out);
    });
  });
}

// ---------- config (panel.json) ----------
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c && typeof c === 'object') { c.defaults = c.defaults || {}; c.projects = c.projects || {}; return c; }
  } catch { /* arquivo ausente/invalido -> defaults */ }
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
  const pick = (k) => ('autoStartClaude' === k || 'autoRemote' === k)
    && (k in p ? !!p[k] : (k in d ? !!d[k] : true));
  return { autoStartClaude: pick('autoStartClaude'), autoRemote: pick('autoRemote') };
}
function setProjConfig(name, patch) {
  const c = loadConfig();
  c.projects = c.projects || {};
  c.projects[name] = Object.assign({}, c.projects[name], patch);
  return saveConfig(c);
}

// ---------- status do Claude ----------
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
  const claudeRunning = up && /node|claude/.test(pane);
  return { up, pane, claudeRunning, ver, logged: isLoggedIn(), active: activeProject() };
}

// Le os logs do Claude (~/.claude/projects/**/*.jsonl) e soma tokens (hoje + total).
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
      const u = o && o.message && o.message.usage;
      if (!u) continue;
      out.messages++;
      const iTok = u.input_tokens || 0, oTok = u.output_tokens || 0;
      const cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
      out.total.in += iTok; out.total.out += oTok; out.total.cacheW += cw; out.total.cacheR += cr;
      if (String(o.timestamp || '').slice(0, 10) === today) {
        out.today.in += iTok; out.today.out += oTok; out.today.cacheW += cw; out.today.cacheR += cr;
      }
    }
  }
  return out;
}

// ---------- actions ----------
async function createProject(name, autoStartClaude, autoRemote) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido (use letras, numeros, . _ -)' };
  const dir = path.join(PROJECTS_DIR, name);
  if (fs.existsSync(dir)) return { ok: false, msg: 'ja existe' };
  fs.mkdirSync(dir, { recursive: true });
  await sh('git', ['-C', dir, 'init', '-q']); // best-effort
  setProjConfig(name, { autoStartClaude: !!autoStartClaude, autoRemote: !!autoRemote });
  return { ok: true, msg: `projeto "${name}" criado (Claude ${autoStartClaude ? 'ON' : 'OFF'}, remote ${autoRemote ? 'ON' : 'OFF'})` };
}
async function restartOn(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  const dir = path.join(PROJECTS_DIR, name);
  if (!fs.existsSync(dir)) return { ok: false, msg: 'pasta inexistente' };
  fs.writeFileSync(ACTIVE_FILE, dir + '\n');
  await sh('tmux', ['kill-session', '-t', SESSION]);   // ignora se nao existir
  await sh('bash', [SESSION_SCRIPT]);                   // recria na pasta ativa (honra panel.json)
  const c = projConfig(name);
  return { ok: true, msg: `sessao reiniciada em "${name}" (Claude ${c.autoStartClaude ? 'ON' : 'OFF'}, remote ${c.autoRemote ? 'ON' : 'OFF'})` };
}
// Claude guarda o historico de cada projeto em ~/.claude/projects/<cwd codificado>.
// A codificacao troca tudo que nao for alfanumerico por "-" (ex.: /root/projects/pilot
// -> -root-projects-pilot). No rename, migramos essa pasta p/ preservar as conversas.
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
  // se ativo, derruba a sessao antes (evita cwd preso na pasta antiga)
  if (wasActive) await sh('tmux', ['kill-session', '-t', SESSION]);
  try { fs.renameSync(oldDir, newDir); }
  catch (e) { return { ok: false, msg: 'falha ao renomear: ' + e.message }; }
  const histMoved = migrateClaudeHistory(oldDir, newDir);
  // migra a config no panel.json (oldName -> newName)
  const c = loadConfig();
  if (c.projects && c.projects[oldName]) {
    c.projects[newName] = c.projects[oldName];
    delete c.projects[oldName];
    saveConfig(c);
  }
  // se era ativo, aponta p/ a nova pasta e recria a sessao (honra panel.json)
  if (wasActive) { fs.writeFileSync(ACTIVE_FILE, newDir + '\n'); await sh('bash', [SESSION_SCRIPT]); }
  return {
    ok: true,
    msg: `"${oldName}" -> "${newName}"${histMoved ? ' (historico do Claude migrado)' : ''}${wasActive ? ' (sessao reiniciada)' : ''}`,
  };
}
async function setConfig(name, key, value) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  if (key !== 'autoStartClaude' && key !== 'autoRemote') return { ok: false, msg: 'chave invalida' };
  const val = value === 'true' || value === 'on' || value === '1';
  if (!setProjConfig(name, { [key]: val })) return { ok: false, msg: 'falha ao salvar panel.json' };
  const label = key === 'autoStartClaude' ? 'auto-start do Claude' : 'auto religar remote-control';
  const tail = (path.join(PROJECTS_DIR, name) === activeProject()) ? ' — reinicie a sessao p/ aplicar' : '';
  return { ok: true, msg: `"${name}": ${label} = ${val ? 'ON' : 'OFF'}${tail}` };
}
async function sendRemote() {
  if (!(await sh('tmux', ['has-session', '-t', SESSION])).ok) return { ok: false, msg: 'sessao tmux nao esta de pe' };
  if (!FULL_AUTOCMD) return { ok: false, msg: 'remote-control desativado globalmente (FULL_AUTOCMD vazio)' };
  await sh('tmux', ['send-keys', '-t', SESSION, FULL_AUTOCMD]);
  await new Promise((r) => setTimeout(r, 1000));
  await sh('tmux', ['send-keys', '-t', SESSION, 'Enter']);
  return { ok: true, msg: `remote-control reenviado: ${FULL_AUTOCMD}` };
}

// ---------- view ----------
function statusCard(st, usage) {
  const dot = (on) => on ? '🟢' : '🔴';
  const t = usage.today, g = usage.total;
  const activeName = st.active ? path.basename(st.active) : '—';
  return `<div class="card">
    <div class="grid">
      <div><span class="k">Sessao tmux</span><span class="v">${dot(st.up)} ${st.up ? 'de pe' : 'fora do ar'}</span></div>
      <div><span class="k">Claude</span><span class="v">${dot(st.claudeRunning)} ${st.claudeRunning ? 'rodando' : 'parado'} <span class="muted">(pane: ${esc(st.pane || '—')})</span></span></div>
      <div><span class="k">Login</span><span class="v">${dot(st.logged)} ${st.logged ? 'logado' : 'deslogado'}</span></div>
      <div><span class="k">Versao</span><span class="v">${esc(st.ver)}</span></div>
      <div><span class="k">Projeto ativo</span><span class="v">${esc(activeName)}</span></div>
      <div><span class="k">Remote-control</span><span class="v">${FULL_AUTOCMD ? '<code>' + esc(FULL_AUTOCMD) + '</code>' : '<span class="muted">desativado</span>'}</span></div>
    </div>
    <div class="usage">
      <b>📊 Consumo de tokens</b> <span class="muted">(${usage.sessions} sessoes · ${fmtInt(usage.messages)} msgs)</span>
      <table class="utab"><thead><tr><th></th><th>Entrada</th><th>Saida</th><th>Cache (escrita)</th><th>Cache (leitura)</th></tr></thead>
      <tbody>
        <tr><td class="ulabel">Hoje</td><td>${fmtTok(t.in)}</td><td>${fmtTok(t.out)}</td><td>${fmtTok(t.cacheW)}</td><td>${fmtTok(t.cacheR)}</td></tr>
        <tr><td class="ulabel">Total</td><td>${fmtTok(g.in)}</td><td>${fmtTok(g.out)}</td><td>${fmtTok(g.cacheW)}</td><td>${fmtTok(g.cacheR)}</td></tr>
      </tbody></table>
    </div>
  </div>`;
}

function projectRow(name, active) {
  const dir = path.join(PROJECTS_DIR, name);
  const isActive = dir === active;
  const cfg = projConfig(name);
  const ideBase = IDE_PUBLIC_URL || IDE_PATH;
  const ideHref = `${ideBase}/?folder=${encodeURIComponent(dir)}`;
  // chips de config (cada um posta o valor INVERTIDO -> clique alterna)
  const chip = (key, on, labelOn, labelOff) => `<form method="POST" style="display:inline">
      <input type="hidden" name="action" value="config">
      <input type="hidden" name="name" value="${esc(name)}">
      <input type="hidden" name="key" value="${key}">
      <input type="hidden" name="value" value="${on ? 'false' : 'true'}">
      <button class="chip ${on ? 'on' : 'off'}" title="clique p/ alternar">${on ? labelOn : labelOff}</button>
    </form>`;
  const restartBtn = `<form method="POST" style="display:inline">
      <input type="hidden" name="action" value="restart">
      <input type="hidden" name="name" value="${esc(name)}">
      <button class="btn">${isActive ? '🔄 Reiniciar sessao' : '▶️ Ativar aqui'}</button>
    </form>`;
  const remoteBtn = isActive ? `<form method="POST" style="display:inline">
      <input type="hidden" name="action" value="remote">
      <button class="btn">📡 Religar remote</button>
    </form>` : '';
  return `<tr class="${isActive ? 'on' : ''}">
    <td>${isActive ? '🟢' : '⚪'} <b>${esc(name)}</b>${isActive ? ' <span class="tag">ativo</span>' : ''}
      <br><span class="muted">${esc(dir)}</span>
      <div class="chips">${chip('autoStartClaude', cfg.autoStartClaude, '🤖 Claude: ON', '🤖 Claude: OFF')}${chip('autoRemote', cfg.autoRemote, '📡 Remote: ON', '📡 Remote: OFF')}</div>
      <form method="POST" class="rename">
        <input type="hidden" name="action" value="rename">
        <input type="hidden" name="name" value="${esc(name)}">
        <input type="text" name="newName" value="${esc(name)}" pattern="[A-Za-z0-9._-]{1,64}" required>
        <button class="chip neutral" title="renomeia a pasta + migra o historico do Claude">✏️ Renomear</button>
      </form>
    </td>
    <td class="acts">
      ${restartBtn}
      ${remoteBtn}
      <a class="btn ide" href="${esc(ideHref)}" target="_blank">🖥️ IDE</a>
    </td></tr>`;
}

function page(flash, st, usage) {
  const active = activeProject();
  const projs = listProjects();
  const rows = projs.length
    ? projs.map((name) => projectRow(name, active)).join('')
    : `<tr><td colspan="2" class="muted">Nenhum projeto ainda. Crie um abaixo.</td></tr>`;

  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel · dev-box claude</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background:#0f1117; color:#e6e6e6; margin:0; padding:24px; }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color:#8a93a6; margin:0 0 16px; font-size:13px; }
  a.refresh { color:#6ea8ff; text-decoration:none; font-size:12px; }
  table { width:100%; border-collapse: collapse; background:#171a23; border-radius:10px; overflow:hidden; }
  td { padding:12px 14px; border-bottom:1px solid #232735; vertical-align:middle; }
  tr.on td { background:#16241c; }
  th { text-align:left; font-weight:600; color:#8a93a6; font-size:11px; padding:6px 8px; }
  .acts { text-align:right; white-space:nowrap; }
  .muted { color:#8a93a6; font-size:12px; }
  .tag { background:#1f6f43; color:#bdf0d2; font-size:11px; padding:1px 7px; border-radius:10px; }
  .btn { display:inline-block; background:#2b3242; color:#e6e6e6; border:0; border-radius:7px;
         padding:7px 12px; font-size:13px; cursor:pointer; text-decoration:none; margin-left:6px; }
  .btn:hover { background:#3a4252; }
  .btn.ide { background:#244; }
  .chips { margin-top:8px; }
  .chip { border:0; border-radius:20px; padding:4px 11px; font-size:12px; cursor:pointer; margin-right:6px; }
  .chip.on { background:#1f6f43; color:#bdf0d2; }
  .chip.off { background:#3a2230; color:#f0bdcb; }
  .chip.neutral { background:#2b3242; color:#cfd5e1; }
  .rename { margin-top:8px; }
  .rename input[type=text] { background:#0f1117; border:1px solid #2b3242; color:#e6e6e6;
         border-radius:7px; padding:5px 9px; font-size:12px; width:170px; }
  .card { background:#171a23; border-radius:10px; padding:16px; margin-bottom:18px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px 18px; }
  .grid .k { display:block; color:#8a93a6; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .grid .v { font-size:14px; }
  .usage { margin-top:16px; border-top:1px solid #232735; padding-top:12px; }
  .utab { margin-top:8px; background:transparent; }
  .utab td, .utab th { border:0; padding:4px 10px; font-size:13px; }
  .utab .ulabel { color:#8a93a6; }
  .create { margin-top:18px; background:#171a23; border-radius:10px; padding:16px; }
  .create input[type=text] { background:#0f1117; border:1px solid #2b3242; color:#e6e6e6;
         border-radius:7px; padding:8px 10px; font-size:14px; width:240px; }
  .create label { display:inline-block; margin:10px 14px 0 0; font-size:13px; color:#cfd5e1; }
  .flash { background:#1d2740; border:1px solid #2f436f; padding:10px 14px; border-radius:8px; margin-bottom:16px; font-size:13px; }
  .flash.err { background:#3a1d1d; border-color:#6f2f2f; }
</style></head><body><div class="wrap">
  <h1>🧩 Painel · dev-box <code>claude</code></h1>
  <p class="sub">Projetos em <code>${esc(PROJECTS_DIR)}</code> · o Claude roda na pasta marcada como ativo. <a class="refresh" href="/">↻ atualizar</a></p>
  ${flash ? `<div class="flash ${flash.ok ? '' : 'err'}">${flash.ok ? '✅' : '⚠️'} ${esc(flash.msg)}</div>` : ''}
  ${statusCard(st, usage)}
  <table><thead><tr><th>Projeto · config</th><th class="acts">acoes</th></tr></thead><tbody>${rows}</tbody></table>
  <form class="create" method="POST">
    <input type="hidden" name="action" value="create">
    <b>➕ Novo projeto</b><br><br>
    <input type="text" name="name" placeholder="nome-do-projeto" pattern="[A-Za-z0-9._-]{1,64}" required>
    <br>
    <label><input type="checkbox" name="autoStartClaude" checked> Iniciar o Claude automaticamente</label>
    <label><input type="checkbox" name="autoRemote" checked> Religar o remote-control automaticamente</label>
    <br><br>
    <button class="btn">Criar</button>
    <div class="muted" style="margin-top:8px">Cria a pasta em <code>${esc(PROJECTS_DIR)}</code> + <code>git init</code> e grava a config no <code>panel.json</code>. Letras, números, <code>. _ -</code>.</div>
  </form>
</div></body></html>`;
}

function send(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function authed(req) {
  if (!PASSWORD) return true;
  const m = (req.headers['authorization'] || '').match(/^Basic (.+)$/);
  if (!m) return false;
  let dec = '';
  try { dec = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  return dec.slice(dec.indexOf(':') + 1) === PASSWORD;
}

async function render(flash) {
  let st = { up: false, pane: '', claudeRunning: false, ver: '?', logged: false, active: '' };
  let usage = { sessions: 0, messages: 0, today: { in: 0, out: 0, cacheW: 0, cacheR: 0 }, total: { in: 0, out: 0, cacheW: 0, cacheR: 0 } };
  try { st = await getStatus(); } catch (e) { console.error('[painel] status:', e.message); }
  try { usage = claudeUsage(); } catch (e) { console.error('[painel] usage:', e.message); }
  return page(flash, st, usage);
}

const server = http.createServer(async (req, res) => {
  if (!authed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Painel Claude"' });
    return res.end('Autenticacao necessaria');
  }
  // Rotas independentes de path (funciona em "/" e sob "/proxy/7000/" do code-server):
  // GET -> renderiza; POST -> processa pelo campo "action" (create | restart | config | remote).
  try {
    if (req.method === 'POST') {
      const body = await readBody(req);
      let r = null;
      if (body.action === 'create') r = await createProject(body.name, body.autoStartClaude === 'on', body.autoRemote === 'on');
      else if (body.action === 'restart') r = await restartOn(body.name);
      else if (body.action === 'config') r = await setConfig(body.name, body.key, body.value);
      else if (body.action === 'rename') r = await renameProject(body.name, body.newName);
      else if (body.action === 'remote') r = await sendRemote();
      else r = { ok: false, msg: 'acao desconhecida' };
      return send(res, 200, await render(r));
    }
    return send(res, 200, await render(null));
  } catch (e) {
    res.writeHead(500); res.end('erro: ' + e.message);
  }
});

const BIND = process.env.PANEL_BIND || '0.0.0.0';
server.listen(PORT, BIND, () => console.log(`[painel] ouvindo em ${BIND}:${PORT} | projetos: ${PROJECTS_DIR} | config: ${CONFIG_FILE}`));
