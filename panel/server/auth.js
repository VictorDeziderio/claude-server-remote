'use strict';
const { tr } = require('./i18n');
/*
 * Panel auth: own login page + SIGNED session cookie + session store.
 *
 * Token = base64url(payload).base64url(hmac). Payload = {u, sid, exp}. The HMAC key
 * mixes a random secret persisted on the volume (~/.claude/.panel-secret) with the
 * PANEL_PASSWORD -> changing the password invalidates every session; restarting the panel does not.
 * The `sid` must exist in the store (sessions.js) -> sessions can be revoked one by one.
 *
 * Protections: constant-time comparison, per-IP rate limit on login (brute force),
 * optional TOTP 2FA (totp.js), Origin/Sec-Fetch-Site check on mutating requests
 * and on the WebSocket upgrade (CSRF).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { log } = require('./util');
const sessions = require('./sessions');
const totp = require('./totp');
const { audit } = require('./audit');

const COOKIE = 'cr_auth';

// FAIL-CLOSED: the panel exposes a shell on the server (a user with sudo). It does NOT start:
//  - without a password;
//  - with a password known to be public: the default that was once versioned in the Dockerfile and in
//    .env.example (compared by sha256 — the value is not in the code) and the historic "changeme".
// A warning in a log nobody reads; refusing to start is what guarantees that a deploy without config is not left open.
const KNOWN_PUBLIC = new Set([
  '98a2fc5119f2b61af6d90d9d7bb59813820e6cd43411eeb0a91484a769a0ccb9', // old Dockerfile/.env.example default
  '057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86', // "changeme"
]);
const passHash = crypto.createHash('sha256').update(String(cfg.PANEL_PASSWORD)).digest('hex');
if (!cfg.PANEL_PASSWORD || KNOWN_PUBLIC.has(passHash)) {
  log('error', cfg.PANEL_PASSWORD
    ? 'PANEL_PASSWORD is a PUBLIC password (an old default) — the panel exposes a shell and will NOT start with it.'
    : 'PANEL_PASSWORD is not set — the panel exposes a shell and will NOT start without a password.',
  { fix: 'defina uma PANEL_PASSWORD forte no Environment do servico e suba de novo.' });
  process.exit(1);
}

function loadOrCreateSecret() {
  try {
    const s = fs.readFileSync(cfg.SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* cria abaixo */ }
  const s = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(cfg.SECRET_FILE), { recursive: true });
    fs.writeFileSync(cfg.SECRET_FILE, s + '\n', { mode: 0o600 });
  } catch (e) {
    log('error', 'nao consegui persistir o segredo de sessao; sessoes nao sobrevivem a restart', { err: e.message });
  }
  return s;
}
const KEY = crypto.createHmac('sha256', loadOrCreateSecret()).update('claude-remote-session-v3:' + cfg.PANEL_PASSWORD).digest();

// found by @security: writing the typed "login" verbatim to audit.log could leak a password (a common
// mistake: typing the password in the user field) or personal data. Only a short hash, to still
// notice "same value repeated" without keeping the plain text.
const loginHashOf = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 12);
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', KEY).update(data).digest('base64url');
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

function issueToken(sid, exp) {
  const payload = b64u(JSON.stringify({ u: cfg.PANEL_LOGIN, sid, exp }));
  return payload + '.' + sign(payload);
}
// -> sid valido | null
function verifyToken(tok) {
  if (typeof tok !== 'string' || tok.length > 512) return null;
  const i = tok.indexOf('.');
  if (i < 0) return null;
  const payload = tok.slice(0, i), sig = tok.slice(i + 1);
  if (!safeEq(sig, sign(payload))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!p || p.u !== cfg.PANEL_LOGIN || typeof p.exp !== 'number' || p.exp <= Date.now() / 1000) return null;
    return typeof p.sid === 'string' && sessions.get(p.sid) ? p.sid : null;
  } catch { return null; }
}

function cookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } }
  }
  return '';
}
const sessionId = (req) => verifyToken(cookie(req, COOKIE));
function isAuthed(req) {
  const sid = sessionId(req);
  if (sid) sessions.touch(sid, clientIp(req));
  return !!sid;
}

const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const clientIp = (req) => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req.socket && req.socket.remoteAddress) || '?';
const hostOf = (req) => String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();

// found by @security: the real deploy is ALWAYS https behind a reverse proxy, but the proxy of that environment
// did not pass x-forwarded-proto in a way isHttps(req) could see — the session cookie went out
// without the Secure attribute. Instead of depending on the header, always send Secure; only the tests (http
// on localhost) turn it off, and only with the explicit test flag (never in production).
const TEST_INSECURE_COOKIE = process.env.PANEL_TEST_INSECURE_COOKIE === '1';
const secureAttr = (req) => (TEST_INSECURE_COOKIE && !isHttps(req)) ? '' : '; Secure';

// ---- per-IP failure limiter: 8 failures in 10 min -> blocks for 10 min ----
// Used by the login and by the chat link keys (server/chat.js), each with its own counter.
function makeLimiter(WINDOW = 10 * 60 * 1000, MAX_FAIL = 8) {
  const attempts = new Map(); // ip -> { n, first, until }
  const limited = (ip) => {
    const a = attempts.get(ip);
    if (!a) return 0;
    if (a.until && a.until > Date.now()) return Math.ceil((a.until - Date.now()) / 1000);
    if (Date.now() - a.first > WINDOW) attempts.delete(ip);
    return 0;
  };
  const fail = (ip) => {
    const now = Date.now();
    const a = attempts.get(ip) || { n: 0, first: now, until: 0 };
    if (now - a.first > WINDOW) { a.n = 0; a.first = now; }
    a.n++;
    if (a.n >= MAX_FAIL) { a.until = now + WINDOW; a.n = 0; a.first = now; }
    attempts.set(ip, a);
  };
  setInterval(() => { const now = Date.now(); for (const [ip, a] of attempts) if (now - a.first > WINDOW && (!a.until || a.until < now)) attempts.delete(ip); }, 60000).unref();
  return { limited, fail, clear: (ip) => attempts.delete(ip) };
}
const loginLimiter = makeLimiter();
const { limited, fail } = loginLimiter;

function doLogin(body, req, res) {
  const ip = clientIp(req);
  const wait = limited(ip);
  if (wait) return { ok: false, msg: tr('srv.tooManyTries', { s: wait }) };
  const okUser = safeEq(String(body.login || ''), cfg.PANEL_LOGIN);
  const okPass = safeEq(String(body.password || ''), cfg.PANEL_PASSWORD);
  if (!(okUser && okPass)) {
    fail(ip);
    audit('login.fail', { ip, loginHash: loginHashOf(body.login) });
    return { ok: false, msg: tr('srv.wrongLogin') };
  }
  if (totp.isEnabled()) {
    if (!body.code) return { ok: false, need2fa: true, msg: tr('srv.need2fa') };
    if (!totp.check(body.code)) { fail(ip); audit('login.fail2fa', { ip }); return { ok: false, need2fa: true, msg: tr('srv.bad2fa') }; }
  }
  loginLimiter.clear(ip);
  const s = sessions.create(ip, req.headers['user-agent']);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${issueToken(s.id, s.exp)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${cfg.SESSION_DAYS * 86400}${secureAttr(req)}`);
  audit('login.ok', { ip, ua: String(req.headers['user-agent'] || '').slice(0, 120), twofa: totp.isEnabled() });
  return { ok: true, msg: tr('srv.signedIn') };
}
function doLogout(req, res) {
  const sid = sessionId(req);
  if (sid) { sessions.revoke(sid); audit('logout', { ip: clientIp(req) }); }
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttr(req)}`);
  return { ok: true };
}
// sessoes ativas (pagina Conta)
function listSessions(req) { return { ok: true, sessions: sessions.list(sessionId(req)).map(({ _id, ...s }) => s), twofa: totp.status() }; }
function revokeSession(req, prefix) {
  const id = sessions.resolve(prefix);
  if (!id) return { ok: false, msg: tr('srv.sessionNotFound') };
  if (id === sessionId(req)) return { ok: false, msg: tr('srv.useLogout') };
  sessions.revoke(id); audit('session.revoke', { ip: clientIp(req), sid: prefix });
  return { ok: true, msg: tr('srv.sessionEnded') };
}
function revokeOthers(req) {
  const n = sessions.revokeAll(sessionId(req));
  audit('session.revokeAll', { ip: clientIp(req), n });
  return { ok: true, msg: n ? tr('srv.othersEnded', { n }) : tr('srv.noOthers') };
}

// CSRF: a mutating request/WS must come from the same site. Modern browsers send
// Sec-Fetch-Site; otherwise we compare Origin with Host.
//
// SECURITY (found by @security 2026-09-28): with NEITHER signal, the old version
// accepted the request (reasoning: "it is curl, and curl does not send the HttpOnly cookie"). That
// protects against classic CSRF (a browser always sends one of the two), but does NOT protect
// against an already leaked session cookie (proxy log, malicious extension) being resent
// via curl/script outside the browser -- in that case the absence of both headers should
// be treated as "origin not proven", not as "accept by default".
function sameOrigin(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs) return sfs === 'same-origin' || sfs === 'none';
  const origin = req.headers.origin;
  if (origin) { try { return new URL(origin).host === hostOf(req); } catch { return false; } }
  return false; // no signal at all: do not assume same origin
}

module.exports = { isAuthed, doLogin, doLogout, sameOrigin, clientIp, hostOf, sessionId, listSessions, revokeSession, revokeOthers, makeLimiter, COOKIE };
