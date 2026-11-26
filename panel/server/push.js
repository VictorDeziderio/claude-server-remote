'use strict';
const { tr } = require('./i18n');
// Web Push transport (VAPID): device subscriptions + delivery.
//
// State lives in CLAUDE_DIR/.panel-push.json (persistent volume, mode 0600, never in the repo):
//   { vapid: {publicKey, privateKey, createdAt}, devices: [...], prefs: {...}, lastBoot }
// The VAPID key pair is generated on first use. Losing the file only means every device has to
// tap "Enable" again (old subscriptions are bound to the old public key).
//
// Only endpoints of the real browser push services are accepted (no SSRF through a crafted
// "subscription"). Tests set PANEL_PUSH_TEST_SINK=<file>: deliveries are then encrypted and
// signed exactly as in production (web-push generateRequestDetails) but written to that file
// instead of going to the network, and the fake host "push.test" becomes acceptable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { log } = require('./util');

let webpush = null;
try { webpush = require('web-push'); } catch { /* dependency missing: push disabled, panel keeps working */ }

const FILE = process.env.PANEL_PUSH_FILE || path.join(cfg.CLAUDE_DIR, '.panel-push.json');
const SINK = process.env.PANEL_PUSH_TEST_SINK || '';
const MAX_DEVICES = 20;
const SEND_TIMEOUT_MS = 10000;
// push services of Chrome/Android (FCM), Firefox, Safari/iOS (Apple) and Edge/Windows (WNS)
const HOST_RX = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const extraHosts = () => String(process.env.PANEL_PUSH_EXTRA_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

let state = null;

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return true;
  } catch (e) { log('error', 'push: could not save state', { err: e.message }); return false; }
}

function load() {
  if (state) return state;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { /* first run */ }
  if (typeof s !== 'object' || Array.isArray(s)) s = {};
  s.devices = Array.isArray(s.devices) ? s.devices : [];
  s.prefs = s.prefs && typeof s.prefs === 'object' ? s.prefs : {};
  state = s;
  if (webpush && !(s.vapid && s.vapid.publicKey && s.vapid.privateKey)) {
    const k = webpush.generateVAPIDKeys();
    s.vapid = { publicKey: k.publicKey, privateKey: k.privateKey, createdAt: Date.now() };
    save();
    log('info', 'push: VAPID keys generated', { file: FILE });
  }
  return state;
}

const supported = () => !!webpush;
const publicKey = () => (load().vapid || {}).publicKey || '';
const idOf = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 12);

// "https://host" when the panel is reached by a real name (Apple refuses localhost subjects)
function subjectOf() {
  if (process.env.PANEL_PUSH_SUBJECT) return process.env.PANEL_PUSH_SUBJECT;
  const s = load();
  return s.subject || 'mailto:admin@example.com';
}
function rememberHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h || !/^[a-z0-9.-]{1,253}$/.test(h) || h === 'localhost' || /^[\d.]+$/.test(h) || !h.includes('.')) return;
  const s = load();
  if (s.subject !== 'https://' + h) { s.subject = 'https://' + h; save(); }
}

function checkEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return 'invalid endpoint';
  let u;
  try { u = new URL(endpoint); } catch { return 'invalid endpoint'; }
  if (u.protocol !== 'https:') return 'endpoint must be https';
  const host = u.hostname.toLowerCase();
  if (SINK && host === 'push.test') return '';
  if (HOST_RX.some((rx) => rx.test(host)) || extraHosts().includes(host)) return '';
  return 'unknown push service';
}

// registers (or refreshes) a device. sub = PushSubscription.toJSON()
// meta.chat = { project, keyId }: a device of a project chat link (server/chat.js). It only gets the
// pushes of that project, and its taps open the chat; panel devices (no `chat`) get the rest.
function subscribe(sub, meta = {}) {
  if (!webpush) return { ok: false, msg: tr('srv.pushMissing') };
  if (!sub || typeof sub !== 'object') return { ok: false, msg: tr('srv.noSub') };
  const bad = checkEndpoint(sub.endpoint);
  if (bad) return { ok: false, msg: bad };
  const keys = sub.keys || {};
  if (typeof keys.p256dh !== 'string' || !B64URL.test(keys.p256dh) || keys.p256dh.length > 200
    || typeof keys.auth !== 'string' || !B64URL.test(keys.auth) || keys.auth.length > 64) return { ok: false, msg: tr('srv.badSubKeys') };
  const s = load();
  rememberHost(meta.host);
  let oldName = '';
  if (meta.replaces && meta.replaces !== sub.endpoint) {
    const old = s.devices.find((d) => d.endpoint === meta.replaces);
    if (old) oldName = old.name;
    s.devices = s.devices.filter((d) => d.endpoint !== meta.replaces);
  }
  const name = String(oldName || meta.name || 'Device').replace(/[\u0000-\u001f]/g, '').slice(0, 60) || 'Device';
  const now = Date.now();
  let d = s.devices.find((x) => x.endpoint === sub.endpoint);
  const lang = require('./i18n').current(); // language of whoever subscribed (cr_lang cookie): the push goes out in it
  const chat = meta.chat && typeof meta.chat.project === 'string' ? { project: meta.chat.project, keyId: String(meta.chat.keyId || '') } : undefined;
  if (d) { d.keys = { p256dh: keys.p256dh, auth: keys.auth }; d.name = name; d.fails = 0; d.lastError = ''; d.lang = lang; d.chat = chat; }
  else {
    d = { id: idOf(sub.endpoint), endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, name, lang, createdAt: now, lastOkAt: 0, lastError: '', fails: 0, chat };
    s.devices.push(d);
    if (s.devices.length > MAX_DEVICES) s.devices.sort((a, b) => (b.lastOkAt || b.createdAt) - (a.lastOkAt || a.createdAt)).splice(MAX_DEVICES);
  }
  return save() ? { ok: true, msg: tr('srv.deviceAdded'), device: publicDevice(d) } : { ok: false, msg: tr('srv.saveFailed') };
}

function unsubscribe(b = {}) {
  const s = load();
  const before = s.devices.length;
  s.devices = s.devices.filter((d) => !(b.id && d.id === b.id) && !(b.endpoint && d.endpoint === b.endpoint));
  if (s.devices.length === before) return { ok: false, msg: tr('srv.deviceNotFound') };
  return save() ? { ok: true, msg: tr('srv.deviceRemoved') } : { ok: false, msg: tr('srv.saveFailed') };
}

const SERVICE = [[/apple\.com$/, 'Apple'], [/googleapis\.com$/, 'Google'], [/mozilla\.com$/, 'Mozilla'], [/windows\.com$/, 'Microsoft']];
function publicDevice(d) {
  let host = '';
  try { host = new URL(d.endpoint).hostname; } catch { /* */ }
  const svc = (SERVICE.find(([rx]) => rx.test(host)) || [null, host])[1];
  return { id: d.id, name: d.name, lang: d.lang || 'en', service: svc, endpoint: d.endpoint, createdAt: d.createdAt, lastOkAt: d.lastOkAt || 0, lastError: d.lastError || '', fails: d.fails || 0, chat: d.chat ? d.chat.project : '' };
}
const devices = () => load().devices.map(publicDevice);
// chat devices: removed with their key / project, follow a project rename
function removeWhere(pred) {
  const s = load();
  const before = s.devices.length;
  s.devices = s.devices.filter((d) => !pred(d));
  if (s.devices.length !== before) save();
  return before - s.devices.length;
}
function renameChat(oldName, newName) {
  const s = load();
  let n = 0;
  for (const d of s.devices) if (d.chat && d.chat.project === oldName) { d.chat.project = newName; n++; }
  if (n) save();
  return n;
}

// one delivery -> HTTP status of the push service (0 = network error)
async function deliver(d, body, opts) {
  const options = {
    vapidDetails: { subject: subjectOf(), publicKey: load().vapid.publicKey, privateKey: load().vapid.privateKey },
    TTL: opts.TTL == null ? 3600 : opts.TTL,
    urgency: opts.urgency || 'normal',
    timeout: SEND_TIMEOUT_MS,
  };
  if (opts.topic) options.topic = crypto.createHash('sha256').update(String(opts.topic)).digest('base64url').slice(0, 32);
  const sub = { endpoint: d.endpoint, keys: d.keys };
  if (SINK) {
    const det = webpush.generateRequestDetails(sub, body, options);
    fs.appendFileSync(SINK, JSON.stringify({ t: Date.now(), endpoint: det.endpoint, headers: det.headers, bodyLen: det.body ? det.body.length : 0, payload: JSON.parse(body) }) + '\n');
    return /\/gone\b/.test(d.endpoint) ? 410 : 201;
  }
  try { return (await webpush.sendNotification(sub, body, options)).statusCode || 201; }
  catch (e) { return e.statusCode || 0; }
}

// sends `payload` ({title, body, url, tag, ...}) to every device (or only `opts.id`, or the ones
// `opts.filter(device)` accepts).
// `payload` can be a function (lang) => payload: each device gets it in its own language.
// 404/410 = subscription gone (uninstalled app, revoked permission) -> device removed.
async function sendAll(payload, opts = {}) {
  if (!webpush) return { ok: false, msg: tr('srv.pushUnavailable'), sent: 0, failed: 0, removed: 0 };
  const s = load();
  const targets = s.devices.filter((d) => (!opts.id || d.id === opts.id) && (!opts.filter || opts.filter(d)));
  if (opts.id && !targets.length) return { ok: false, msg: tr('srv.deviceNotFound'), sent: 0, failed: 0, removed: 0 };
  const bodyFor = (d) => JSON.stringify(typeof payload === 'function' ? payload(d.lang || 'en') : payload);
  let sent = 0, failed = 0;
  const gone = new Set();
  await Promise.all(targets.map(async (d) => {
    let status = 0;
    try { status = await deliver(d, bodyFor(d), opts); } catch (e) { log('error', 'push: send', { err: e.message }); }
    if (status >= 200 && status < 300) { sent++; d.lastOkAt = Date.now(); d.fails = 0; d.lastError = ''; return; }
    failed++;
    if (status === 404 || status === 410) { gone.add(d.id); return; }
    d.fails = (d.fails || 0) + 1;
    d.lastError = status ? `HTTP ${status}` : 'network error';
  }));
  if (gone.size) s.devices = s.devices.filter((d) => !gone.has(d.id));
  if (targets.length) save();
  return { ok: sent > 0 || targets.length === 0, sent, failed, removed: gone.size, msg: targets.length ? `sent to ${sent}/${targets.length} device(s)` : 'no devices registered' };
}

// small key/value storage for notify.js (prefs, last boot id) in the same 0600 file
const getPref = (k) => load().prefs[k];
function setPref(k, v) { load().prefs[k] = v; return save(); }
const getMeta = (k) => load()[k];
function setMeta(k, v) { if (['vapid', 'devices', 'prefs'].includes(k)) return false; load()[k] = v; return save(); }
const _reset = () => { state = null; };

module.exports = { supported, publicKey, subscribe, unsubscribe, devices, removeWhere, renameChat, sendAll, checkEndpoint, getPref, setPref, getMeta, setMeta, FILE, _reset };
