#!/usr/bin/env node
'use strict';
/*
 * Claude Remote — server of the dev box panel.
 *  - SPA (React/Vite) built into ./dist, with a fallback for the react-router routes
 *  - JSON API at /api/*  (projects, config, files, report, account, history, logs, health, backup)
 *  - Real time at /api/events (SSE: state, Claude activity, notifications)
 *  - Real terminal at /ws/term (WebSocket <-> PTY <-> tmux attach)
 * Auth: own login page + optional 2FA + signed session cookie (server/auth.js).
 * Runs as the ubuntu user (HOME=/root), always behind the Caddy gateway.
 */
const http = require('http');
const fs = require('fs');
const cfg = require('./server/config');
const { readJson, sendJson, log } = require('./server/util');
const auth = require('./server/auth');
const totp = require('./server/totp');
const { audit, summarize } = require('./server/audit');
const claude = require('./server/claude');
const claudeLogin = require('./server/login');
const usage = require('./server/usage');
const projects = require('./server/projects');
const disk = require('./server/disk');
const update = require('./server/update');
const files = require('./server/files');
const term = require('./server/term');
const events = require('./server/events');
const history = require('./server/history');
const logs = require('./server/logs');
const health = require('./server/health');
const backup = require('./server/backup');
const settings = require('./server/settings');
const alerts = require('./server/alerts');
const limits = require('./server/limits');
const notify = require('./server/notify');
const i18n = require('./server/i18n');
const { tr } = i18n;
const { serveStatic } = require('./server/static');

fs.mkdirSync(cfg.PROJECTS_DIR, { recursive: true });
fs.mkdirSync(cfg.LOGS_DIR, { recursive: true });

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  // a real deploy is always https behind a proxy; no effect at all on http (the browser only
  // obeys HSTS received over https) — safe to always send, local tests included.
  'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
};

// GET routes (all require auth). (q = URLSearchParams, req)
const GET = {
  '/api/state': async () => events.currentState(),
  '/api/update': async () => update.status(),
  '/api/disk': async (q) => disk.projectDisk(q.get('name') || '', { fresh: q.get('fresh') === '1', days: Number(q.get('days')) || 7 }),
  '/api/report': async (q) => {
    const from = q.get('from') || '', to = q.get('to') || '';
    if (!usage.isDay(from) || !usage.isDay(to)) return { ok: false, msg: tr('srv.badDate') };
    return { ok: true, usage: usage.aggregateRange(from, to) };
  },
  '/api/fs/stat': async (q) => files.fsStat(q.get('path') || ''),
  '/api/fs/list': async (q) => files.fsList(q.get('path') || ''),
  '/api/fs/read': async (q) => files.fsRead(q.get('path') || ''),
  '/api/term/capture': async (q) => term.termCapture(q.get('name') || '', q.get('lines')),
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
  '/api/claude/login/status': async () => claudeLogin.status(),
  '/api/usage': async () => ({ ok: true, usage: usage.usageSummary() }), // found by @perf: moved out of buildState (2s tick), served on demand
  '/api/limits': async () => limits.snapshot(), // Claude plan (5h/week) + API spend; poller cache, no network
  '/api/alerts': async () => { alerts.poll(); return { ok: true, alerts: alerts.list100() }; }, // on demand (when the page opens), not the 2s tick
};
// POST routes (JSON; all require auth + same origin). (body, req)
const POST = {
  '/api/create': (b) => projects.createProject(b.name, !!b.autoStartClaude, !!b.autoRemote),
  '/api/rename': (b) => projects.renameProject(b.name, b.newName),
  '/api/delete': (b) => projects.deleteProject(b.name),
  '/api/config': (b) => projects.setConfig(b.name, b.key, b.value),
  '/api/initline': (b) => projects.setInitLine(b.name, b.text),
  '/api/restart': (b) => projects.restartProject(b.name),
  '/api/power': (b) => projects.setPower(b.name, b.on),
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
  '/api/claude/login/start': () => claudeLogin.start(),
  '/api/claude/login/code': (b) => claudeLogin.sendCode(b.code),
  '/api/claude/login/key': (b) => claudeLogin.sendKey(b.key),
  '/api/claude/login/cancel': () => claudeLogin.cancel(),
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
  '/api/totp/setup': (b, req) => totp.setup(auth.hostOf(req), b.code),
  '/api/totp/enable': (b) => totp.enable(b.code),
  '/api/totp/disable': (b) => totp.disable(b.code),
  '/api/session-mode': (b) => projects.setSessionMode(b.name, b.mode, b.id),
  '/api/pause': (b) => projects.pauseProject(b.name),
  '/api/unpause': (b) => projects.unpauseProject(b.name),
  '/api/alerts/clear': () => { alerts.clear(); return { ok: true }; },
  '/api/limits/refresh': () => limits.refresh(),
  '/api/update': (b) => update.request(b.mode),
  '/api/disk/clean': (b) => disk.cleanWorktrees(b.name, b.worktrees, b.days),
};
// Web Push / notifications tab (routes live in server/notify.js)
Object.assign(GET, notify.routes.GET);
Object.assign(POST, notify.routes.POST);
// actions that go into the audit log (reads do not)
const AUDITED = new Set(['/api/create', '/api/rename', '/api/delete', '/api/config', '/api/initline', '/api/restart', '/api/power', '/api/remote',
  '/api/fs/save', '/api/fs/create', '/api/fs/delete', '/api/fs/rename', '/api/term/exit', '/api/term/window', '/api/claude/logout',
  '/api/claude/update', '/api/claude/login/start', '/api/claude/login/code', '/api/claude/login/cancel', '/api/history/resume', '/api/backup/run', '/api/backup/config', '/api/settings/defaults', '/api/settings',
  '/api/sessions/revoke', '/api/sessions/revoke-others', '/api/totp/enable', '/api/totp/disable',
  '/api/session-mode', '/api/pause', '/api/unpause', '/api/alerts/clear', '/api/disk/clean', '/api/update', ...notify.routes.AUDITED]);

async function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const u = new URL(req.url, 'http://x');
    const url = u.pathname;

    if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

    // --- endpoints livres ---
    if (req.method === 'POST' && url === '/api/login') {
      if (!auth.sameOrigin(req)) return sendJson(res, 403, { ok: false, msg: tr('srv.badOrigin') });
      const body = await readJson(req);
      if (!body) return sendJson(res, 400, { ok: false, msg: tr('srv.badBody') });
      return sendJson(res, 200, auth.doLogin(body, req, res));
    }
    if (req.method === 'POST' && url === '/api/logout') {
      if (!auth.sameOrigin(req)) return sendJson(res, 403, { ok: false, msg: tr('srv.badOrigin') });
      return sendJson(res, 200, auth.doLogout(req, res));
    }
    if (req.method === 'GET' && url === '/api/login/info') return sendJson(res, 200, { ok: true, twofa: totp.isEnabled(), panelVersion: cfg.PANEL_VERSION });

    // --- API protegida ---
    if (url.startsWith('/api/')) {
      if (!auth.isAuthed(req)) return sendJson(res, 401, { ok: false, msg: tr('srv.notAuthed') });
      if (req.method === 'GET') {
        if (url === '/api/events') return events.attach(req, res, auth.sessionId(req));
        if (url === '/api/fs/download') return files.fsDownload(u.searchParams.get('path') || '', res);
        if (url === '/api/backup/download') return backup.downloadConfig(res, u.searchParams.get('file') || '', u.searchParams.get('full') === '1');
        const h = GET[url];
        if (!h) return sendJson(res, 404, { ok: false, msg: tr('srv.unknownRoute') });
        return sendJson(res, 200, await h(u.searchParams, req));
      }
      if (req.method === 'POST') {
        if (!auth.sameOrigin(req)) return sendJson(res, 403, { ok: false, msg: tr('srv.badOrigin') });
        if (url === '/api/fs/upload') {
          const r = await files.fsUploadStream(u.searchParams.get('path') || '', req, u.searchParams.get('overwrite') === '1');
          audit('fs.upload', { ip: auth.clientIp(req), path: u.searchParams.get('path') || '', ok: r.ok, size: r.size || 0 });
          return sendJson(res, r.status || 200, r);
        }
        const h = POST[url];
        if (!h) return sendJson(res, 404, { ok: false, msg: tr('srv.unknownRoute') });
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { ok: false, msg: tr('srv.badBody') });
        const r = await h(body, req);
        if (AUDITED.has(url)) audit(url.replace('/api/', '').replace(/\//g, '.'), { ip: auth.clientIp(req), ...summarize(body), ok: !!(r && r.ok) });
        return sendJson(res, 200, r);
      }
      return sendJson(res, 405, { ok: false, msg: 'method not allowed' });
    }

    // --- static SPA (the SPA itself shows the login when /api/state answers 401) ---
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
    sendJson(res, 405, { ok: false, msg: 'method not allowed' });
  } catch (e) {
    log('error', 'erro na request', { url: req.url, err: e.message });
    if (!res.headersSent) sendJson(res, 500, { ok: false, msg: tr('srv.internal') });
    else res.end();
  }
}
// each request is answered in the language of whoever asked (server/i18n.js: cr_lang cookie / Accept-Language)
const server = http.createServer((req, res) => i18n.withLang(req, () => handle(req, res)));

// terminal WebSocket: same auth (cookie) + same origin
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (u.pathname !== '/ws/term') return reject(404, 'Not Found');
  if (!auth.sameOrigin(req)) return reject(403, 'Forbidden');
  if (!auth.isAuthed(req)) return reject(401, 'Unauthorized');
  i18n.withLang(req, () => term.handleUpgrade(req, socket, head, u.searchParams, auth.clientIp(req), auth.sessionId(req)));
});

server.listen(cfg.PORT, cfg.BIND, () => {
  log('info', 'painel no ar', { bind: `${cfg.BIND}:${cfg.PORT}`, projects: cfg.PROJECTS_DIR, dist: cfg.DIST, pty: term.ptyAvailable, twofa: totp.isEnabled() });
  events.start(projects.buildState); // watcher + SSE
  limits.start(); // plan limits / API spend poller (server/limits.js)
  notify.start(); // Web Push: hooks, alerts, login, boot
  require('./server/autoresume').start(); // "continue" by itself after a usage-limit reset
});

// clean shutdown (tini/docker stop send SIGTERM): closes PTYs/SSE (the tmux sessions stay alive)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('info', 'encerrando', { sig });
    term.shutdown(); events.stop(); limits.stop(); notify.stop(); require('./server/autoresume').stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
