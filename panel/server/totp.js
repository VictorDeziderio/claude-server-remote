'use strict';
const { tr } = require('./i18n');
// TOTP 2FA (RFC 6238) with no dependencies: base32, HMAC-SHA1, 30s step, +-1 window.
// Secret persisted in ~/.claude/.panel-totp.json (mode 600). Flow: setup -> enable(code) -> login requires code.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { log } = require('./util');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1000000).padStart(6, '0');
}
function verifyCode(secret, code, window = 1) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const key = b32decode(secret);
  const t = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) {
    const expect = hotp(key, t + w);
    if (expect.length === c.length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(c))) return true;
  }
  return false;
}

// ---- persistencia ----
let state = { enabled: false, secret: '', pending: '', enabledAt: 0, lastUsed: '' };
function load() {
  try { const j = JSON.parse(fs.readFileSync(cfg.TOTP_FILE, 'utf8')); if (j && typeof j === 'object') state = { ...state, ...j, pending: '' }; }
  catch { /* no 2FA */ }
}
function save() {
  try {
    fs.mkdirSync(path.dirname(cfg.TOTP_FILE), { recursive: true });
    const tmp = cfg.TOTP_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ enabled: state.enabled, secret: state.secret, enabledAt: state.enabledAt, lastUsed: state.lastUsed }), { mode: 0o600 });
    fs.renameSync(tmp, cfg.TOTP_FILE);
  } catch (e) { log('error', 'nao consegui salvar 2FA', { err: e.message }); }
}
load();

const isEnabled = () => state.enabled && !!state.secret;
const issuer = 'Claude Remote';

// generates a pending secret (it only becomes active after enable() with a valid code).
// found by @security: with 2FA ALREADY on, generating a new QR without proving the current code let
// an already authenticated panel session (e.g. a leaked cookie) swap the secret for one the
// attacker controls — requires the code of the CURRENT secret before opening a new setup.
function setup(host, code) {
  if (isEnabled() && !verifyCode(state.secret, code)) {
    return { ok: false, msg: tr('srv.2faActive') };
  }
  state.pending = b32encode(crypto.randomBytes(20));
  const label = encodeURIComponent(`${issuer}:${cfg.PANEL_LOGIN}@${host || 'devbox'}`);
  const url = `otpauth://totp/${label}?secret=${state.pending}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { ok: true, secret: state.pending, otpauth: url };
}
function enable(code) {
  if (!state.pending) return { ok: false, msg: tr('srv.qrFirst') };
  if (!verifyCode(state.pending, code)) return { ok: false, msg: tr('srv.badCodeClock') };
  state.secret = state.pending; state.pending = ''; state.enabled = true; state.enabledAt = Date.now();
  save();
  return { ok: true, msg: tr('srv.2faOn') };
}
function disable(code) {
  if (!isEnabled()) return { ok: false, msg: tr('srv.2faNotOn') };
  if (!verifyCode(state.secret, code)) return { ok: false, msg: tr('srv.badCode') };
  state = { enabled: false, secret: '', pending: '', enabledAt: 0, lastUsed: '' };
  save();
  return { ok: true, msg: tr('srv.2faOff') };
}
// used at login. Blocks reuse of the SAME code within the window (replay).
function check(code) {
  if (!isEnabled()) return true;
  const c = String(code || '').replace(/\s+/g, '');
  if (state.lastUsed === c) return false;
  if (!verifyCode(state.secret, c)) return false;
  state.lastUsed = c; save();
  return true;
}
const status = () => ({ enabled: isEnabled(), enabledAt: state.enabledAt || 0 });

// test helpers: code of the current (or shifted) step for a base32 secret
const codeFor = (secret, offset = 0) => hotp(b32decode(secret), Math.floor(Date.now() / 30000) + offset);

module.exports = { isEnabled, setup, enable, disable, check, status, _verify: verifyCode, _code: codeFor, _b32encode: b32encode };
