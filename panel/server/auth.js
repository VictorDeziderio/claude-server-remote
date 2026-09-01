'use strict';
/*
 * Auth do painel: pagina de login propria + cookie de sessao ASSINADO.
 *
 * Token = base64url(payload).base64url(hmac). Payload = {u, iat, exp, n}. A chave do HMAC
 * mistura um segredo aleatorio persistido no volume (~/.claude/.panel-secret) com a
 * PANEL_PASSWORD -> trocar a senha invalida todas as sessoes; reiniciar o painel nao.
 * Cada login gera um token diferente (nonce) com expiracao (PANEL_SESSION_DAYS).
 *
 * Protecoes: comparacao em tempo constante, rate-limit por IP no login (forca bruta),
 * checagem de Origin/Sec-Fetch-Site em requests mutantes e no upgrade do WebSocket (CSRF).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { log } = require('./util');

const COOKIE = 'cr_auth';

// FAIL-CLOSED: sem senha o painel nao sobe (ele expoe um shell no servidor).
if (!cfg.PANEL_PASSWORD) {
  log('error', 'PANEL_PASSWORD nao definido — o painel expoe um shell e NAO sobe sem senha.',
    { fix: 'defina PANEL_PASSWORD no Environment do servico e suba de novo.' });
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
    // sem volume gravavel: segredo so em memoria (sessoes caem no restart, mas o painel funciona)
    log('error', 'nao consegui persistir o segredo de sessao; sessoes nao sobrevivem a restart', { err: e.message });
  }
  return s;
}
const KEY = crypto.createHmac('sha256', loadOrCreateSecret()).update('claude-remote-session-v2:' + cfg.PANEL_PASSWORD).digest();

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', KEY).update(data).digest('base64url');
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

function issueToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({ u: cfg.PANEL_LOGIN, iat: now, exp: now + cfg.SESSION_DAYS * 86400, n: crypto.randomBytes(8).toString('hex') }));
  return payload + '.' + sign(payload);
}
function verifyToken(tok) {
  if (typeof tok !== 'string' || tok.length > 512) return false;
  const i = tok.indexOf('.');
  if (i < 0) return false;
  const payload = tok.slice(0, i), sig = tok.slice(i + 1);
  if (!safeEq(sig, sign(payload))) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return p && p.u === cfg.PANEL_LOGIN && typeof p.exp === 'number' && p.exp > Date.now() / 1000;
  } catch { return false; }
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
const isAuthed = (req) => verifyToken(cookie(req, COOKIE));

const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const clientIp = (req) => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req.socket && req.socket.remoteAddress) || '?';

// ---- rate-limit do login (por IP): 8 falhas em 10 min -> bloqueia 10 min ----
const attempts = new Map(); // ip -> { n, first, until }
const WINDOW = 10 * 60 * 1000, MAX_FAIL = 8;
function limited(ip) {
  const a = attempts.get(ip);
  if (!a) return 0;
  if (a.until && a.until > Date.now()) return Math.ceil((a.until - Date.now()) / 1000);
  if (Date.now() - a.first > WINDOW) attempts.delete(ip);
  return 0;
}
function fail(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, first: now, until: 0 };
  if (now - a.first > WINDOW) { a.n = 0; a.first = now; }
  a.n++;
  if (a.n >= MAX_FAIL) { a.until = now + WINDOW; a.n = 0; a.first = now; }
  attempts.set(ip, a);
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of attempts) if (now - a.first > WINDOW && (!a.until || a.until < now)) attempts.delete(ip); }, 60000).unref();

function doLogin(body, req, res) {
  const ip = clientIp(req);
  const wait = limited(ip);
  if (wait) return { ok: false, msg: `muitas tentativas — aguarde ${wait}s` };
  const okUser = safeEq(String(body.login || ''), cfg.PANEL_LOGIN);
  const okPass = safeEq(String(body.password || ''), cfg.PANEL_PASSWORD);
  if (okUser && okPass) {
    attempts.delete(ip);
    res.setHeader('Set-Cookie',
      `${COOKIE}=${issueToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${cfg.SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
    log('info', 'login ok', { ip });
    return { ok: true, msg: 'autenticado' };
  }
  fail(ip);
  log('info', 'login recusado', { ip });
  return { ok: false, msg: 'login ou senha incorretos' };
}
function doLogout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`);
  return { ok: true };
}

// CSRF: request mutante/WS precisa vir do mesmo site. Navegadores modernos mandam
// Sec-Fetch-Site; senao comparamos Origin com o Host. Sem nenhum dos dois (curl) -> aceita
// (o cookie HttpOnly ja nao e enviado por ferramentas externas).
function sameOrigin(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs) return sfs === 'same-origin' || sfs === 'none';
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return o.host === host;
  } catch { return false; }
}

module.exports = { isAuthed, doLogin, doLogout, sameOrigin, clientIp, COOKIE };
