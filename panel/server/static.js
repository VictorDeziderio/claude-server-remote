'use strict';
// Serves the built SPA (dist/): assets with a long cache (hashed names), index.html without
// cache + fallback for any react-router route (/dashboard, /files/..., /terminal/...).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { sendStream } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.ico': 'image/x-icon', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end('bad path'); }
  if (p === '/' || p === '') p = '/index.html';
  let file = path.join(cfg.DIST, path.normalize(p));
  if (!file.startsWith(cfg.DIST + path.sep) && file !== cfg.DIST) { res.writeHead(403); return res.end('forbidden'); }
  let st = null;
  try { st = fs.statSync(file); } catch { /* fallback */ }
  if (!st || !st.isFile()) { file = path.join(cfg.DIST, 'index.html'); try { st = fs.statSync(file); } catch { st = null; } }
  if (!st) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Claude Remote: build do painel ausente (rode "npm run build" em panel/).');
  }
  const ext = path.extname(file).toLowerCase();
  const hashed = /\/assets\//.test(file.split(path.sep).join('/'));
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    // sw.js too: a cached service worker would keep old push/click handlers alive
    'Cache-Control': ext === '.html' || path.basename(file) === 'sw.js' ? 'no-store' : (hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'),
  };
  if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
  return sendStream(res, file, { headers });
}

module.exports = { serveStatic };
