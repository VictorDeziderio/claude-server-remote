#!/usr/bin/env node
'use strict';
/*
 * Claude Remote — servidor do painel do dev-box.
 *  - SPA (React/Vite) buildada em ./dist, com fallback p/ as rotas do react-router
 *  - API JSON em /api/*  (projetos, config, arquivos, relatorio, conta, historico, logs, saude, backup)
 *  - Tempo real em /api/events (SSE: estado, atividade do Claude, notificacoes)
 *  - Terminal real em /ws/term (WebSocket <-> PTY <-> tmux attach)
 * Auth: pagina de login propria + 2FA opcional + cookie de sessao assinado (server/auth.js).
 * Roda como o usuario ubuntu (HOME=/root), sempre atras do gateway Caddy.
 */
const http = require('http');
const fs = require('fs');
const cfg = require('./server/config');
const { readJson, readRaw, sendJson, log } = require('./server/util');
const auth = require('./server/auth');
const totp = require('./server/totp');
const { audit, summarize } = require('./server/audit');
const claude = require('./server/claude');
const usage = require('./server/usage');
const projects = require('./server/projects');
const files = require('./server/files');
const term = require('./server/term');
const events = require('./server/events');
const history = require('./server/history');
const logs = require('./server/logs');
const health = require('./server/health');
const backup = require('./server/backup');
const settings = require('./server/settings');
const { serveStatic } = require('./server/static');

fs.mkdirSync(cfg.PROJECTS_DIR, { recursive: true });
fs.mkdirSync(cfg.LOGS_DIR, { recursive: true });

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

// rotas GET (todas exigem auth). (q = URLSearchParams, req)
const GET = {
  '/api/state': async () => events.currentState(),
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
  '/api/term/windows': async (q) => term.listWindows(q.get('name') || ''),
  '/api/history': async (q) => history.listHistory(q.get('name') || ''),
  '/api/history/conversation': async (q) => history.readConversation(q.get('name') || '', q.get('id') || ''),
  '/api/logs': async () => logs.listLogs(),
  '/api/logs/tail': async (q) => logs.tailLog(q.get('file') || 'panel', q.get('lines') || 300),
  '/api/health': async () => health.health(),
  '/api/backup/status': async () => backup.backupStatusFull(),
  '/api/settings': async () => settings.getSettings(),
  '/api/sessions': async (q, req) => auth.listSessions(req),
  '/api/totp/status': async () => ({ ok: true, ...totp.status() }),
};
// rotas POST (JSON; todas exigem auth + mesma origem). (body, req)
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
  '/api/term/window': (b) => term.windowAction(b.name, b.action, b.index),
  '/api/claude/logout': () => claude.claudeLogout(),
  '/api/claude/update': () => health.updateClaude(),
  '/api/history/resume': async (b) => {
    const st = await events.currentState();
    const p = st && st.projects.find((x) => x.name === b.name);
    return history.resumeConversation(b.name, b.id, !!(p && p.claudeRunning));
  },
  '/api/backup/run': (b) => backup.runBackup(b.name || ''),
  '/api/backup/config': () => backup.runConfigBackup(),
  '/api/settings/defaults': (b) => settings.setDefaults(b),
  '/api/settings': (b) => settings.setSettings(b),
  '/api/sessions/revoke': (b, req) => auth.revokeSession(req, b.id),
  '/api/sessions/revoke-others': (b, req) => auth.revokeOthers(req),
  '/api/totp/setup': (b, req) => totp.setup(auth.hostOf(req)),
  '/api/totp/enable': (b) => totp.enable(b.code),
  '/api/totp/disable': (b) => totp.disable(b.code),
};
// acoes que entram no audit log (as de leitura nao)
const AUDITED = new Set(['/api/create', '/api/rename', '/api/delete', '/api/config', '/api/initline', '/api/restart', '/api/remote',
  '/api/fs/save', '/api/fs/create', '/api/fs/delete', '/api/fs/rename', '/api/term/exit', '/api/term/window', '/api/claude/logout',
  '/api/claude/update', '/api/history/resume', '/api/backup/run', '/api/backup/config', '/api/settings/defaults', '/api/settings',
  '/api/sessions/revoke', '/api/sessions/revoke-others', '/api/totp/enable', '/api/totp/disable']);

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
    if (req.method === 'GET' && url === '/api/login/info') return sendJson(res, 200, { ok: true, twofa: totp.isEnabled(), panelVersion: cfg.PANEL_VERSION });

    // --- API protegida ---
    if (url.startsWith('/api/')) {
      if (!auth.isAuthed(req)) return sendJson(res, 401, { ok: false, msg: 'nao autenticado' });
      if (req.method === 'GET') {
        if (url === '/api/events') return events.attach(req, res);
        if (url === '/api/fs/download') return files.fsDownload(u.searchParams.get('path') || '', res);
        if (url === '/api/backup/download') return backup.downloadConfig(res, u.searchParams.get('file') || '', u.searchParams.get('full') === '1');
        const h = GET[url];
        if (!h) return sendJson(res, 404, { ok: false, msg: 'rota desconhecida' });
        return sendJson(res, 200, await h(u.searchParams, req));
      }
      if (req.method === 'POST') {
        if (!auth.sameOrigin(req)) return sendJson(res, 403, { ok: false, msg: 'origem invalida' });
        if (url === '/api/fs/upload') {
          const buf = await readRaw(req, files.MAX_UPLOAD);
          const r = files.fsUpload(u.searchParams.get('path') || '', buf, u.searchParams.get('overwrite') === '1');
          audit('fs.upload', { ip: auth.clientIp(req), path: u.searchParams.get('path') || '', ok: r.ok, size: buf ? buf.length : 0 });
          return sendJson(res, 200, r);
        }
        const h = POST[url];
        if (!h) return sendJson(res, 404, { ok: false, msg: 'rota desconhecida' });
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { ok: false, msg: 'corpo invalido' });
        const r = await h(body, req);
        if (AUDITED.has(url)) audit(url.replace('/api/', '').replace(/\//g, '.'), { ip: auth.clientIp(req), ...summarize(body), ok: !!(r && r.ok) });
        return sendJson(res, 200, r);
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

server.listen(cfg.PORT, cfg.BIND, () => {
  log('info', 'painel no ar', { bind: `${cfg.BIND}:${cfg.PORT}`, projects: cfg.PROJECTS_DIR, dist: cfg.DIST, pty: term.ptyAvailable, twofa: totp.isEnabled() });
  events.start(projects.buildState); // watcher + SSE
});

// shutdown limpo (tini/EasyPanel mandam SIGTERM): fecha PTYs/SSE (os tmux continuam vivos)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('info', 'encerrando', { sig });
    term.shutdown(); events.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
