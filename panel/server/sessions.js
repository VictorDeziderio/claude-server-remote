'use strict';
// Panel sessions (stateful, persisted in ~/.claude/.panel-sessions.json):
// each login creates an id; the cookie carries that id, signed. Revoke = delete it from the store
// ("sign out of this device" / "sign out everywhere"). Survives a panel restart.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { log } = require('./util');

let store = {}; // id -> { iat, exp, ip, ua, last }
let dirty = false;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(cfg.SESSIONS_FILE, 'utf8'));
    if (j && typeof j === 'object') store = j;
  } catch { store = {}; }
  prune();
}
function save() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(cfg.SESSIONS_FILE), { recursive: true });
    const tmp = cfg.SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, cfg.SESSIONS_FILE);
  } catch (e) { log('error', 'nao consegui salvar sessoes', { err: e.message }); }
}
function prune() {
  const now = Date.now() / 1000;
  for (const [id, s] of Object.entries(store)) if (!s || s.exp < now) { delete store[id]; dirty = true; }
}

function create(ip, ua) {
  const id = crypto.randomBytes(16).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  store[id] = { iat: now, exp: now + cfg.SESSION_DAYS * 86400, ip: String(ip || ''), ua: String(ua || '').slice(0, 200), last: now };
  dirty = true; save();
  return store[id] && { id, ...store[id] };
}
function get(id) {
  const s = store[id];
  if (!s) return null;
  if (s.exp < Date.now() / 1000) { delete store[id]; dirty = true; return null; }
  return s;
}
// updates "last seen" at most 1x per minute (avoids writing on every request)
function touch(id, ip) {
  const s = store[id];
  if (!s) return;
  const now = Math.floor(Date.now() / 1000);
  if (now - (s.last || 0) >= 60) { s.last = now; if (ip) s.ip = ip; dirty = true; }
}
// sliding expiry: a session in use is pushed to SESSION_DAYS from now again, at most once a day
// (a device used at least once a year never has to sign in again). -> new exp, or 0 when unchanged
function extend(id, nowMs = Date.now()) {
  const s = store[id];
  if (!s) return 0;
  const now = Math.floor(nowMs / 1000);
  const full = now + cfg.SESSION_DAYS * 86400;
  if (full - s.exp < 86400) return 0;
  s.exp = full; dirty = true; save();
  return full;
}
function revoke(id) { if (store[id]) { delete store[id]; dirty = true; save(); return true; } return false; }
function revokeAll(exceptId) {
  let n = 0;
  for (const id of Object.keys(store)) if (id !== exceptId) { delete store[id]; n++; }
  dirty = true; save();
  return n;
}
function list(currentId) {
  prune();
  return Object.entries(store)
    .map(([id, s]) => ({ id: id.slice(0, 8), current: id === currentId, iat: s.iat, exp: s.exp, last: s.last, ip: s.ip, ua: s.ua, _id: id }))
    .sort((a, b) => (b.last || 0) - (a.last || 0));
}
// full id from the displayed prefix (to revoke)
function resolve(prefix) {
  if (typeof prefix !== 'string' || prefix.length < 8) return null;
  return Object.keys(store).find((id) => id.startsWith(prefix)) || null;
}

load();
setInterval(() => { prune(); save(); }, 30000).unref();

module.exports = { create, get, touch, revoke, revokeAll, list, resolve, extend };
