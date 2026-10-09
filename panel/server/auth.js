'use strict';
/*
 * Auth do painel: pagina de login propria + cookie de sessao ASSINADO + store de sessoes.
 *
 * Token = base64url(payload).base64url(hmac). Payload = {u, sid, exp}. A chave do HMAC
 * mistura um segredo aleatorio persistido no volume (~/.claude/.panel-secret) com a
 * PANEL_PASSWORD -> trocar a senha invalida todas as sessoes; reiniciar o painel nao.
 * O `sid` precisa existir no store (sessions.js) -> da pra revogar sessao a sessao.
 *
 * Protecoes: comparacao em tempo constante, rate-limit por IP no login (forca bruta),
 * 2FA TOTP opcional (totp.js), checagem de Origin/Sec-Fetch-Site em requests mutantes
 * e no upgrade do WebSocket (CSRF).
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

// FAIL-CLOSED: o painel expoe um shell no servidor (usuario com sudo). Ele NAO sobe:
//  - sem senha;
//  - com uma senha sabidamente publica: o default que ja esteve versionado no Dockerfile e no
//    .env.example (comparado por sha256 — o valor nao fica no codigo) e o "changeme" historico.
// Aviso em log ninguem le; recusar subir e o que garante que um deploy sem config nao fica aberto.
const KNOWN_PUBLIC = new Set([
  '98a2fc5119f2b61af6d90d9d7bb59813820e6cd43411eeb0a91484a769a0ccb9', // default antigo do Dockerfile/.env.example
  '057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86', // "changeme"
]);
const passHash = crypto.createHash('sha256').update(String(cfg.PANEL_PASSWORD)).digest('hex');
if (!cfg.PANEL_PASSWORD || KNOWN_PUBLIC.has(passHash)) {
  log('error', cfg.PANEL_PASSWORD
    ? 'PANEL_PASSWORD e uma senha PUBLICA (default que ja esteve no repo) — o painel expoe um shell e NAO sobe com ela.'
    : 'PANEL_PASSWORD nao definido — o painel expoe um shell e NAO sobe sem senha.',
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

// achado @security: gravar o "login" digitado verbatim no audit.log podia vazar senha (erro
// comum: digitar a senha no campo de usuario) ou dado pessoal. So um hash curto, pra ainda dar
// pra notar "mesmo valor repetido" sem guardar o texto em claro.
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

// achado @security: o deploy real e SEMPRE https atras do Traefik, mas o Traefik desse ambiente
// nao repassa x-forwarded-proto de um jeito que isHttps(req) enxergue — o cookie de sessao saia
// sem o atributo Secure. Em vez de depender do header, manda Secure sempre; so os testes (http
// em localhost) desligam, e so com a flag de teste explicita (nunca em producao).
const TEST_INSECURE_COOKIE = process.env.PANEL_TEST_INSECURE_COOKIE === '1';
const secureAttr = (req) => (TEST_INSECURE_COOKIE && !isHttps(req)) ? '' : '; Secure';

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
  if (!(okUser && okPass)) {
    fail(ip);
    audit('login.fail', { ip, loginHash: loginHashOf(body.login) });
    return { ok: false, msg: 'login ou senha incorretos' };
  }
  if (totp.isEnabled()) {
    if (!body.code) return { ok: false, need2fa: true, msg: 'informe o codigo do autenticador' };
    if (!totp.check(body.code)) { fail(ip); audit('login.fail2fa', { ip }); return { ok: false, need2fa: true, msg: 'codigo 2FA invalido' }; }
  }
  attempts.delete(ip);
  const s = sessions.create(ip, req.headers['user-agent']);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${issueToken(s.id, s.exp)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${cfg.SESSION_DAYS * 86400}${secureAttr(req)}`);
  audit('login.ok', { ip, ua: String(req.headers['user-agent'] || '').slice(0, 120), twofa: totp.isEnabled() });
  return { ok: true, msg: 'autenticado' };
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
  if (!id) return { ok: false, msg: 'sessao nao encontrada' };
  if (id === sessionId(req)) return { ok: false, msg: 'use "sair" para encerrar a sessao atual' };
  sessions.revoke(id); audit('session.revoke', { ip: clientIp(req), sid: prefix });
  return { ok: true, msg: 'sessao encerrada' };
}
function revokeOthers(req) {
  const n = sessions.revokeAll(sessionId(req));
  audit('session.revokeAll', { ip: clientIp(req), n });
  return { ok: true, msg: n ? `${n} sessao(oes) encerrada(s) nos outros dispositivos` : 'nenhuma outra sessao ativa' };
}

// CSRF: request mutante/WS precisa vir do mesmo site. Navegadores modernos mandam
// Sec-Fetch-Site; senao comparamos Origin com o Host.
//
// SEGURANCA (achado @security 2026-09-28): sem NENHUM dos dois sinais, a versao antiga
// aceitava a requisicao (raciocinio: "e' curl, e curl nao manda o cookie HttpOnly"). Isso
// protege contra CSRF classico (navegador sempre manda um dos dois), mas NAO protege
// contra um cookie de sessao ja vazado (log de proxy, extensao maliciosa) sendo reenviado
// via curl/script fora do navegador -- nesse caso a ausencia de ambos os headers deveria
// ser tratada como "origem nao comprovada", nao como "aceitar por omissao".
function sameOrigin(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs) return sfs === 'same-origin' || sfs === 'none';
  const origin = req.headers.origin;
  if (origin) { try { return new URL(origin).host === hostOf(req); } catch { return false; } }
  return false; // sem nenhum sinal: nao assume mesma origem
}

module.exports = { isAuthed, doLogin, doLogout, sameOrigin, clientIp, hostOf, sessionId, listSessions, revokeSession, revokeOthers, COOKIE };
