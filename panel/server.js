#!/usr/bin/env node
'use strict';
/*
 * Claude Remote — servidor do painel do dev-box.
 *  - SPA (React/Vite) buildada em ./dist, com fallback p/ as rotas do react-router
 *  - API JSON em /api/*  (projetos, config, arquivos, relatorio, conta, terminal de apoio)
 *  - Terminal real em /ws/term (WebSocket <-> PTY <-> tmux attach)
 * Auth: pagina de login propria + cookie de sessao assinado (server/auth.js).
 * Roda como o usuario ubuntu (HOME=/root), sempre atras do gateway Caddy.
 *
 * Modulos em ./server: config, util, auth, claude, usage, projects, files, term, static.
 */
const http = require('http');
const cfg = require('./server/config');
const { readJson, readRaw, sendJson, log } = require('./server/util');
const auth = require('./server/auth');
const claude = require('./server/claude');
const usage = require('./server/usage');
const projects = require('./server/projects');
const files = require('./server/files');
const term = require('./server/term');
const { serveStatic } = require('./server/static');

require('fs').mkdirSync(cfg.PROJECTS_DIR, { recursive: true });

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

// rotas GET (todas exigem auth). q = URLSearchParams
const GET = {
  '/api/state': async () => projects.buildState(),
  '/api/report': async (q) => {
    const from = q.get('from') || '', to = q.get('to') || '';
    if (!usage.isDay(from) || !usage.isDay(to)) return { ok: false, msg: 'data invalida (YYYY-MM-DD)' };
    return { ok: true, usage: usage.aggregateRange(from, to) };
  },
  '/api/fs/stat': async (q) => files.fsStat(q.get('path') || ''),
  '/api/fs/list': async (q) => files.fsList(q.get('path') || ''),
  '/api/fs/read': async (q) => files.fsRead(q.get('path') || ''),
  '/api/term/capture': async (q) => term.termCapture(q.get('name') || ''),
  '/api/term/status': async () => ({ ok: true, pty: term.ptyAvailable }),
};
// rotas POST (JSON; todas exigem auth + mesma origem)
const POST = {
  '/api/create': (b) => projects.createProject(b.name, !!b.autoStartClaude, !!b.autoRemote),
  '/api/rename': (b) => projects.renameProject(b.name, b.newName),
  '/api/delete': (b) => projects.deleteProject(b.name),
  '/api/config': (b) => projects.setConfig(b.name, b.key, b.value),
  '/api/initline': (b) => projects.setInitLine(b.name, b.text),
  '/api/restart': (b) => projects.restartProject(b.name),
  '/api/remote': (b) => projects.sendRemote(b.name),
  '/api/fs/save': (b) => files.fsSave(b.path, b.content),
  '/api/fs/create': (b) => files.fsCreate(b.path, b.kind),
  '/api/fs/delete': (b) => files.fsDelete(b.path),
  '/api/fs/rename': (b) => files.fsRename(b.path, b.newPath),
  '/api/term/send': (b) => term.termSend(b.name, b.text, b.key),
  '/api/term/exit': (b) => term.termExit(b.name),
  '/api/claude/logout': () => claude.claudeLogout(),
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const u = new URL(req.url, 'http://x');
    const url = u.pathname;

    if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

    // --- endpoints livres ---
    if (req.method === 'POST' && url === '/api/login') {
      if (!auth.sameOrigin(req)) return sendJson(res, 403, { ok: false, msg: 'origem invalida' });
      const body = await readJson(req);
      if (!body) return sendJson(res, 400, { ok: false, msg: 'corpo invalido' });
      return sendJson(res, 200, auth.doLogin(body, req, res));
    }
    if (req.method === 'POST' && url === '/api/logout') return sendJson(res, 200, auth.doLogout(req, res));

    // --- API protegida ---
    if (url.startsWith('/api/')) {
      if (!auth.isAuthed(req)) return sendJson(res, 401, { ok: false, msg: 'nao autenticado' });
      if (req.method === 'GET') {
        if (url === '/api/fs/download') return files.fsDownload(u.searchParams.get('path') || '', res);
        const h = GET[url];
        if (!h) return sendJson(res, 404, { ok: false, msg: 'rota desconhecida' });
        return sendJson(res, 200, await h(u.searchParams));
      }
      if (req.method === 'POST') {
        if (!auth.sameOrigin(req)) return sendJson(res, 403, { ok: false, msg: 'origem invalida' });
        if (url === '/api/fs/upload') {
          const buf = await readRaw(req, files.MAX_UPLOAD);
          return sendJson(res, 200, files.fsUpload(u.searchParams.get('path') || '', buf, u.searchParams.get('overwrite') === '1'));
        }
        const h = POST[url];
        if (!h) return sendJson(res, 404, { ok: false, msg: 'rota desconhecida' });
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { ok: false, msg: 'corpo invalido' });
        return sendJson(res, 200, await h(body));
      }
      return sendJson(res, 405, { ok: false, msg: 'method not allowed' });
    }

    // --- SPA estatica (a propria SPA mostra o login quando /api/state da 401) ---
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
    sendJson(res, 405, { ok: false, msg: 'method not allowed' });
  } catch (e) {
    log('error', 'erro na request', { url: req.url, err: e.message });
    if (!res.headersSent) sendJson(res, 500, { ok: false, msg: 'erro interno' });
    else res.end();
  }
});

// WebSocket do terminal: mesma auth (cookie) + mesma origem
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (u.pathname !== '/ws/term') return reject(404, 'Not Found');
  if (!auth.sameOrigin(req)) return reject(403, 'Forbidden');
  if (!auth.isAuthed(req)) return reject(401, 'Unauthorized');
  term.handleUpgrade(req, socket, head, u.searchParams, auth.clientIp(req));
});

server.listen(cfg.PORT, cfg.BIND, () =>
  log('info', 'painel no ar', { bind: `${cfg.BIND}:${cfg.PORT}`, projects: cfg.PROJECTS_DIR, dist: cfg.DIST, pty: term.ptyAvailable }));

// shutdown limpo (tini/EasyPanel mandam SIGTERM): fecha PTYs (os tmux continuam vivos)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('info', 'encerrando', { sig });
    term.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
