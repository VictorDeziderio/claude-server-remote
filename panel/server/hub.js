'use strict';
/*
 * Remote hub: one page per person at /remote?key=<the person's key> (API at /hub-api/*).
 *
 *  - People are created in the panel (Settings -> Remote hub). Each one gets a key: 32 random
 *    bytes (base64url), stored ONLY as sha256 + metadata in HUB_FILE (0600). Every person is an
 *    owner (there are no limited guests): the hub opens the chat of any project of this server,
 *    switches the Claude account of a project, and shows usage, limits, report and server data.
 *  - A person's hub key also opens the project chats: /remote/<project>?key=<hub key>. The chat
 *    API (server/chat.js) asks keyFor() here for a key that is not a chat key, with the project
 *    taken from the link (X-Chat-Project header or ?project=).
 *  - Each person keeps a list of links (projects or hubs of THIS or OTHER servers). The list is
 *    stored here, so it follows the person to any device. The page reads the state of a link on
 *    another server straight from that server (CORS on /hub-api and /chat-api: Bearer keys only,
 *    never cookies, so any origin may call them).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { tr } = require('./i18n');
const { readJson, sendJson, sendStream, validName, log } = require('./util');
const { audit } = require('./audit');
const auth = require('./auth');

// lazy: these modules require a lot (and some of them require chat.js, which requires this one)
const projects = () => require('./projects');
const events = () => require('./events');
const accounts = () => require('./accounts');
const usage = () => require('./usage');
const limits = () => require('./limits');
const health = () => require('./health');
const chat = () => require('./chat');

const FILE = cfg.HUB_FILE;
const MAX_LINKS = 200;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------------------------------------------------------------- store
// { people: [{id, hash, label, createdAt, lastUsedAt, revokedAt, links: [{id, label, url, addedAt}]}] }
let store = null;
function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { store = null; }
  if (!store || !Array.isArray(store.people)) store = { people: [] };
  for (const p of store.people) if (!Array.isArray(p.links)) p.links = [];
  return store;
}
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { log('error', 'hub: could not save', { err: e.message }); }
}
const pub = (p) => ({ id: p.id, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt || null, links: p.links.length });
const live = () => load().people.filter((p) => !p.revokedAt);

function linkBase(req) {
  const host = auth.hostOf(req);
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------- admin side (panel cookie)
function listPeople() { return { ok: true, people: live().map(pub) }; }
function createPerson(b, req) {
  const label = String((b && b.label) || '').trim().slice(0, 60);
  if (!label) return { ok: false, msg: tr('srv.badParams') };
  const key = crypto.randomBytes(32).toString('base64url');
  const rec = { id: crypto.randomBytes(6).toString('hex'), hash: sha(key), label, createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null, links: [] };
  load().people.push(rec);
  save();
  audit('hub.person.create', { ip: auth.clientIp(req), id: rec.id });
  return { ok: true, id: rec.id, key, url: `${linkBase(req)}/remote?key=${key}` };
}
function revokePerson(b, req) {
  const p = live().find((x) => x.id === (b && b.id));
  if (!p) return { ok: false, msg: tr('srv.notFound') };
  p.revokedAt = new Date().toISOString();
  p.links = [];
  save();
  chat().onHubRevoke('hub:' + p.id); // its open chats close and its phones stop getting pushes
  audit('hub.person.revoke', { ip: auth.clientIp(req), id: p.id });
  return { ok: true };
}

// ---------------------------------------------------------------- auth of /hub-api (and of the chat)
const limiter = auth.makeLimiter();
const bearerOf = (req) => { const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || '')); return m ? m[1] : ''; };
// the person of a plain key, or null (no limiter here: callers count the failure)
function personOf(plain) {
  const h = plain && plain.length <= 128 ? sha(plain) : '';
  const p = h && live().find((x) => x.hash === h);
  if (!p) return null;
  if (!p.lastUsedAt || Date.now() - Date.parse(p.lastUsedAt) > 60000) { p.lastUsedAt = new Date().toISOString(); save(); }
  return p;
}
// -> {person} | {status, msg}
function authOf(req) {
  const ip = auth.clientIp(req);
  const wait = limiter.limited(ip);
  if (wait) return { status: 429, msg: tr('srv.tooManyTries', { s: wait }) };
  const p = personOf(bearerOf(req));
  if (!p) { limiter.fail(ip); return { status: 401, msg: tr('srv.notAuthed') }; }
  return { person: p };
}
// for server/chat.js: a hub key opens the chat of any project of this server
function chatKeyOf(plain, project) {
  if (!validName(project) || !fs.existsSync(path.join(cfg.PROJECTS_DIR, project))) return null;
  const p = personOf(plain);
  return p ? { id: 'hub:' + p.id, project, label: p.label, hub: true } : null;
}

// ---------------------------------------------------------------- links
// a link is any http(s) URL of a project chat or a hub (of this server or another one)
function cleanUrl(s) {
  let u;
  try { u = new URL(String(s || '').trim()); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (!/^\/(remote|c)(\/|$)/.test(u.pathname)) return '';
  u.hash = '';
  return u.toString().slice(0, 600);
}
function addLink(p, b) {
  const url = cleanUrl(b && b.url);
  if (!url) return { ok: false, msg: tr('srv.hub.badLink') };
  if (p.links.length >= MAX_LINKS) return { ok: false, msg: tr('srv.hub.tooManyLinks', { n: MAX_LINKS }) };
  if (p.links.some((l) => l.url === url)) return { ok: false, msg: tr('srv.hub.linkExists') };
  const rec = { id: crypto.randomBytes(5).toString('hex'), label: String((b && b.label) || '').trim().slice(0, 60), url, addedAt: new Date().toISOString() };
  p.links.push(rec);
  save();
  return { ok: true, link: rec };
}
function editLink(p, b) {
  const l = p.links.find((x) => x.id === (b && b.id));
  if (!l) return { ok: false, msg: tr('srv.notFound') };
  if (b.label != null) l.label = String(b.label).trim().slice(0, 60);
  save();
  return { ok: true, link: l };
}
function removeLink(p, b) {
  const n = p.links.length;
  p.links = p.links.filter((x) => x.id !== (b && b.id));
  if (p.links.length === n) return { ok: false, msg: tr('srv.notFound') };
  save();
  return { ok: true };
}
function moveLink(p, b) {
  const i = p.links.findIndex((x) => x.id === (b && b.id));
  const j = i + (b && b.dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= p.links.length) return { ok: false, msg: tr('srv.notFound') };
  [p.links[i], p.links[j]] = [p.links[j], p.links[i]];
  save();
  return { ok: true };
}

// ---------------------------------------------------------------- what the hub shows
const claudeState = (x) => (!x.enabled ? 'off' : x.paused ? 'paused' : !x.up ? 'down' : x.claudeRunning ? 'on' : 'shell');
async function projectList() {
  const st = await events().currentState();
  const act = (x) => { try { return events().activityOf(x.session) || 'off'; } catch { return 'off'; } };
  return {
    ok: true,
    server: { name: cfg.HUB_NAME || require('os').hostname(), version: cfg.PANEL_VERSION },
    projects: (st && st.projects ? st.projects : []).map((x) => ({
      name: x.name, claude: claudeState(x), account: x.account || accounts().DEFAULT,
      activity: act(x), autoResumeAt: x.autoResumeAt || 0,
    })),
  };
}
function accountList() {
  const snap = limits().snapshot();
  return {
    ok: true,
    accounts: accounts().summary().map((a) => ({
      ...a, projects: accounts().projectsUsing(a.id),
      limits: a.isDefault ? snap.claude : (snap.accounts[a.id] || null),
    })),
  };
}

// ---------------------------------------------------------------- HTTP entry points
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Chat-Project',
  'Access-Control-Max-Age': '600',
};
// Bearer-only APIs (/hub-api, /chat-api): any origin may call them, the key is the only proof
function cors(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204);
  res.end();
  return true;
}

async function handleApi(req, res, u) {
  if (cors(req, res)) return undefined;
  const a = authOf(req);
  if (!a.person) return sendJson(res, a.status, { ok: false, msg: a.msg });
  const p = a.person;
  const url = u.pathname, q = u.searchParams;
  const reply = (r) => sendJson(res, (r && r.status) || 200, r);
  if (req.method === 'GET') {
    if (url === '/hub-api/me') return reply({ ok: true, id: p.id, label: p.label, server: { name: cfg.HUB_NAME || require('os').hostname(), version: cfg.PANEL_VERSION } });
    if (url === '/hub-api/projects') return reply(await projectList());
    if (url === '/hub-api/links') return reply({ ok: true, links: p.links });
    if (url === '/hub-api/accounts') return reply(accountList());
    if (url === '/hub-api/usage') return reply({ ok: true, usage: usage().usageSummary(), limits: limits().snapshot() });
    if (url === '/hub-api/report') {
      const from = q.get('from') || '', to = q.get('to') || '';
      if (!usage().isDay(from) || !usage().isDay(to)) return reply({ ok: false, msg: tr('srv.badDate') });
      return reply({ ok: true, usage: usage().aggregateRange(from, to) });
    }
    if (url === '/hub-api/server') return reply(await health().health());
    return sendJson(res, 404, { ok: false, msg: tr('srv.unknownRoute') });
  }
  if (req.method === 'POST') {
    const b = await readJson(req);
    if (!b) return sendJson(res, 400, { ok: false, msg: tr('srv.badBody') });
    const ip = auth.clientIp(req);
    if (url === '/hub-api/links/add') return reply(addLink(p, b));
    if (url === '/hub-api/links/edit') return reply(editLink(p, b));
    if (url === '/hub-api/links/remove') return reply(removeLink(p, b));
    if (url === '/hub-api/links/move') return reply(moveLink(p, b));
    if (url === '/hub-api/project/account') {
      const r = await projects().setAccount(b.name, b.account);
      audit('hub.project.account', { ip, person: p.id, name: b.name, account: b.account, ok: !!r.ok });
      return reply(r);
    }
    if (url === '/hub-api/limits/refresh') return reply(await limits().refresh());
    return sendJson(res, 404, { ok: false, msg: tr('srv.unknownRoute') });
  }
  return sendJson(res, 405, { ok: false, msg: 'method not allowed' });
}

// the hub page (/remote?key=...) and its manifest (/remote/manifest.webmanifest?key=...)
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https: http: ws: wss:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
function handlePage(req, res, u) {
  if (u.pathname === '/remote/manifest.webmanifest') {
    const key = u.searchParams.get('key') || '';
    const ip = auth.clientIp(req);
    const p = !limiter.limited(ip) && personOf(key);
    if (!p) { limiter.fail(ip); res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      name: 'Claude Remote', short_name: 'Claude Remote', start_url: `/remote?key=${encodeURIComponent(key)}`, scope: '/remote',
      display: 'standalone', background_color: '#0b0d12', theme_color: '#0b0d12',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  }
  const file = path.join(cfg.DIST, 'hub.html');
  let st = null;
  try { st = fs.statSync(file); } catch { /* not built */ }
  if (!st) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Claude Remote: hub page not built (run "npm run build" in panel/).'); }
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': PAGE_CSP };
  if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
  return sendStream(res, file, { headers });
}

const routes = {
  GET: { '/api/hub/people': async () => listPeople() },
  POST: { '/api/hub/people/create': (b, req) => createPerson(b, req), '/api/hub/people/revoke': (b, req) => revokePerson(b, req) },
  AUDITED: [],
};

module.exports = { routes, handleApi, handlePage, cors, chatKeyOf, cleanUrl, _reset: () => { store = null; } };
