#!/usr/bin/env node
'use strict';
/*
 * Painel de controle do dev-box "claude" (Node puro, sem dependencias).
 * - Lista/cadastra pastas de projeto em PROJECTS_DIR
 * - "Reiniciar aqui": grava a pasta ativa e recria a sessao tmux do Claude nela
 * - "Abrir IDE": link pro code-server ja na pasta (precisa IDE_PUBLIC_URL)
 * Auth: Basic, senha = IDE_PASSWORD (mesma do IDE). Roda como ubuntu (HOME=/root).
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
const IDE_PUBLIC_URL = (process.env.IDE_PUBLIC_URL || '').replace(/\/+$/, '');
const SESSION_SCRIPT = '/usr/local/bin/claude-session.sh';

fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!PASSWORD) console.warn('[painel] AVISO: IDE_PASSWORD vazio -> painel SEM autenticacao');

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

// ---------- actions ----------
async function createProject(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido (use letras, numeros, . _ -)' };
  const dir = path.join(PROJECTS_DIR, name);
  if (fs.existsSync(dir)) return { ok: false, msg: 'ja existe' };
  fs.mkdirSync(dir, { recursive: true });
  await sh('git', ['-C', dir, 'init', '-q']); // best-effort
  return { ok: true, msg: `projeto "${name}" criado` };
}
async function restartOn(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  const dir = path.join(PROJECTS_DIR, name);
  if (!fs.existsSync(dir)) return { ok: false, msg: 'pasta inexistente' };
  fs.writeFileSync(ACTIVE_FILE, dir + '\n');
  await sh('tmux', ['kill-session', '-t', 'claude']);  // ignora se nao existir
  await sh('bash', [SESSION_SCRIPT]);                   // recria na pasta ativa
  return { ok: true, msg: `Claude reiniciado em "${name}"` };
}

// ---------- view ----------
function page(flash) {
  const active = activeProject();
  const projs = listProjects();
  const rows = projs.length ? projs.map((name) => {
    const dir = path.join(PROJECTS_DIR, name);
    const isActive = dir === active;
    // IDE na raiz do dominio: sob /proxy/7000/ do code-server, href="/" cai no IDE.
    // IDE_PUBLIC_URL (opcional) sobrepoe, caso o painel seja acessado por dominio proprio.
    const ideHref = `${IDE_PUBLIC_URL}/?folder=${encodeURIComponent(dir)}`;
    return `<tr class="${isActive ? 'on' : ''}">
      <td>${isActive ? '🟢' : '⚪'} <b>${esc(name)}</b>${isActive ? ' <span class="tag">ativo</span>' : ''}<br><span class="muted">${esc(dir)}</span></td>
      <td class="acts">
        <form method="POST" style="display:inline">
          <input type="hidden" name="action" value="restart">
          <input type="hidden" name="name" value="${esc(name)}">
          <button class="btn">🔄 Reiniciar aqui</button>
        </form>
        <a class="btn ide" href="${esc(ideHref)}" target="_blank">🖥️ Abrir IDE</a>
      </td></tr>`;
  }).join('') : `<tr><td colspan="2" class="muted">Nenhum projeto ainda. Crie um abaixo.</td></tr>`;

  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel · dev-box claude</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background:#0f1117; color:#e6e6e6; margin:0; padding:24px; }
  .wrap { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color:#8a93a6; margin:0 0 20px; font-size:13px; }
  table { width:100%; border-collapse: collapse; background:#171a23; border-radius:10px; overflow:hidden; }
  td { padding:12px 14px; border-bottom:1px solid #232735; vertical-align:middle; }
  tr.on td { background:#16241c; }
  .acts { text-align:right; white-space:nowrap; }
  .muted { color:#8a93a6; font-size:12px; }
  .tag { background:#1f6f43; color:#bdf0d2; font-size:11px; padding:1px 7px; border-radius:10px; }
  .btn { display:inline-block; background:#2b3242; color:#e6e6e6; border:0; border-radius:7px;
         padding:7px 12px; font-size:13px; cursor:pointer; text-decoration:none; margin-left:6px; }
  .btn:hover { background:#3a4252; }
  .btn.ide { background:#244; }
  .create { margin-top:18px; background:#171a23; border-radius:10px; padding:16px; }
  .create input[type=text] { background:#0f1117; border:1px solid #2b3242; color:#e6e6e6;
         border-radius:7px; padding:8px 10px; font-size:14px; width:240px; }
  .flash { background:#1d2740; border:1px solid #2f436f; padding:10px 14px; border-radius:8px; margin-bottom:16px; font-size:13px; }
  .flash.err { background:#3a1d1d; border-color:#6f2f2f; }
</style></head><body><div class="wrap">
  <h1>🧩 Painel · dev-box <code>claude</code></h1>
  <p class="sub">Projetos em <code>${esc(PROJECTS_DIR)}</code> · o Claude roda na pasta marcada como ativo.</p>
  ${flash ? `<div class="flash ${flash.ok ? '' : 'err'}">${flash.ok ? '✅' : '⚠️'} ${esc(flash.msg)}</div>` : ''}
  <table><tbody>${rows}</tbody></table>
  <form class="create" method="POST">
    <input type="hidden" name="action" value="create">
    <b>➕ Novo projeto</b><br><br>
    <input type="text" name="name" placeholder="nome-do-projeto" pattern="[A-Za-z0-9._-]{1,64}" required>
    <button class="btn">Criar</button>
    <div class="muted" style="margin-top:8px">Cria a pasta + <code>git init</code>. Letras, números, <code>. _ -</code>.</div>
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

const server = http.createServer(async (req, res) => {
  if (!authed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Painel Claude"' });
    return res.end('Autenticacao necessaria');
  }
  // Rotas independentes de path (funciona em "/" e sob "/proxy/7000/" do code-server):
  // GET -> renderiza; POST -> processa pelo campo "action" (create | restart).
  try {
    if (req.method === 'POST') {
      const body = await readBody(req);
      let r = null;
      if (body.action === 'create') r = await createProject(body.name);
      else if (body.action === 'restart') r = await restartOn(body.name);
      else r = { ok: false, msg: 'acao desconhecida' };
      return send(res, 200, page(r));
    }
    return send(res, 200, page(null));
  } catch (e) {
    res.writeHead(500); res.end('erro: ' + e.message);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[painel] ouvindo em 0.0.0.0:${PORT} | projetos: ${PROJECTS_DIR}`));
