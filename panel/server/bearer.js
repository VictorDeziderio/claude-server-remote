'use strict';
/*
 * Keys in a link (chat links /remote/<project>?key=, hub links /remote?key=): what every such key
 * has in common, in one place.
 *  - only the sha256 of a key is ever stored;
 *  - check(): a VALID key always passes; only wrong keys are counted, per IP, in ONE limiter for
 *    every kind of key (a guesser gets the same few tries whatever API it calls). Behind a proxy
 *    that hides the client IP everyone shares an IP, and bad keys must not lock the owner out;
 *  - the APIs behind these keys never use cookies, so any origin may call them (CORS *): the key
 *    is the only proof, and the hub of another server reads them from its own page;
 *  - the link base (scheme + host the person used) and the web app manifest of a link.
 */
const crypto = require('crypto');
const auth = require('./auth');
const { tr } = require('./i18n');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hashOf = (plain) => (plain && String(plain).length <= 128 ? sha(plain) : '');
const newKey = () => crypto.randomBytes(32).toString('base64url');

const fromHeader = (req) => { const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || '')); return m ? m[1] : ''; };
// a key record was used: lastUsedAt, written at most once a minute (no disk write per request)
function touch(rec, save) {
  if (!rec.lastUsedAt || Date.now() - Date.parse(rec.lastUsedAt) > 60000) { rec.lastUsedAt = new Date().toISOString(); save(); }
  return rec;
}

const limiter = auth.makeLimiter();
// found: whatever the caller resolved from the key (null/undefined = wrong key) -> {ok: found} | {status, msg}
function check(req, found) {
  if (found) return { ok: found };
  const ip = auth.clientIp(req);
  const wait = limiter.limited(ip);
  if (wait) return { status: 429, msg: tr('srv.tooManyTries', { s: wait }) };
  limiter.fail(ip);
  return { status: 401, msg: tr('srv.notAuthed') };
}

function linkBase(req) {
  const host = auth.hostOf(req);
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Chat-Project',
  'Access-Control-Max-Age': '600',
};
// sets the CORS headers; answers a preflight (true = answered)
function cors(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204);
  res.end();
  return true;
}

// the home-screen app of a link: its own name and start URL (the key travels in it)
function sendManifest(res, { name, shortName, startUrl, scope }) {
  res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    name, short_name: shortName, start_url: startUrl, scope,
    display: 'standalone', background_color: '#0b0d12', theme_color: '#0b0d12',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  }));
}
const notFound = (res, status = 404) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); };

module.exports = { sha, hashOf, newKey, fromHeader, touch, check, linkBase, cors, sendManifest, notFound };
