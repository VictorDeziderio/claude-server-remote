'use strict';
const { tr } = require('./i18n');
// File manager CONFINED to FS_BASE (=/root): list, stat, read, save, create,
// delete, rename, download and upload.
//
// Confinement (guard): two checks, in this order.
//  1. TEXTUAL: the requested path, normalized (path.resolve), must stay inside the base
//     -> blocks "../..", "/etc", "..\\..".
//  2. REAL (symlinks): the path is resolved with realpath — the target's own when it
//     exists; the nearest existing ancestor's when it is still going to be created — and the
//     result must stay inside the realpath of the base.
//     - a symlink pointing INSIDE the base: allowed (it is just a shortcut);
//     - a symlink pointing OUTSIDE: refused, with a message saying why;
//     - deleting/renaming the link ITSELF: allowed (acts on the link, never on the target) — so a
//       dangerous link can be removed from the panel. For that the parent directory is checked.
//  In the listing, a link to the outside shows up marked (outside:true) without a stat of the target.
//  Accepted risk: between the check and the use (TOCTOU) another process may swap a path
//  for a symlink. Whoever has panel access already has a shell on the server; the sandbox protects
//  against mistakes/wrong clicks in the manager, not against the shell user themselves.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { sendStream, sendRange } = require('./util');

const BASE = cfg.FS_BASE;
const MAX_TEXT = 2 * 1024 * 1024;     // leitura/edicao inline
const MAX_SAVE = 5 * 1024 * 1024;
const MAX_UPLOAD = 100 * 1024 * 1024;

let baseReal = null;
const realBase = () => {
  if (!baseReal) { try { baseReal = fs.realpathSync(BASE); } catch { baseReal = BASE; } }
  return baseReal;
};
const inside = (p, base) => p === base || p.startsWith(base + path.sep);
const OUTSIDE_MSG = 'recusado: esse caminho passa por um symlink que aponta para fora de ' + BASE;

// realpath of `full`; if it (or the end part of it) does not exist yet, the realpath of the nearest
// existing ancestor + the rest of the path
function realOf(full) {
  let cur = full;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return full;
      rest.push(path.basename(cur)); cur = parent;
    }
  }
}

// realpath check of an ABSOLUTE path against a base -> { full } | { err }. Shared by the file
// manager (base = FS_BASE) and the project chat (base = the project folder, server/chat.js).
// self=true: the operation acts on the path ITSELF (delete/rename), so a symlink at the end of the
// path is accepted and only the parent directory needs to be really inside.
function confine(base, full, { self = false } = {}) {
  if (!inside(full, base)) return { err: tr('srv.badPath') };
  let real;
  try {
    if (self && full !== base) {
      real = path.join(realOf(path.dirname(full)), path.basename(full));
    } else {
      // found by @security: if `full` is a BROKEN symlink (points to something that does not exist),
      // fs.realpathSync(full) gives ENOENT and realOf() fell into the "does not exist yet,
      // go up to the nearest ancestor" fallback — treating the link ITSELF as if it were just a new
      // file name, never resolving where it pointed. The "real" result came out
      // inside the base (the directory holding the link is real), guard() allowed it, and the
      // writeFileSync/openSync that came after really FOLLOWED the link -> wrote outside the
      // sandbox. A symlink at the end of the path must be fully resolved here; if it does not
      // resolve (broken), refuse — never treat it as a "new file".
      let lst;
      try { lst = fs.lstatSync(full); } catch { lst = null; }
      if (lst && lst.isSymbolicLink()) {
        try { real = fs.realpathSync(full); }
        catch { return { err: tr('srv.brokenLink') }; }
      } else {
        real = realOf(full);
      }
    }
  } catch (e) { return { err: e.message }; }
  let baseR;
  try { baseR = base === BASE ? realBase() : fs.realpathSync(base); } catch { baseR = base; }
  if (!inside(real, baseR)) return { err: base === BASE ? OUTSIDE_MSG : tr('srv.badPath') };
  return { full };
}
// file manager guard: `rel` is relative to FS_BASE
function guard(rel, opts) {
  return confine(BASE, path.resolve(BASE, String(rel == null ? '' : rel).replace(/^[/\\]+/, '')), opts);
}
// writes a NEW/truncated file refusing to follow a symlink in the last component (O_NOFOLLOW):
// defense in depth against TOCTOU between the guard() above and the real write.
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0; // not available on Windows -> degrades without the extra check
function writeFileNoFollow(full, data) {
  const fd = fs.openSync(full, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NOFOLLOW);
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
}
const relOf = (full) => path.relative(BASE, full).split(path.sep).join('/');

const TEXT_EXT = new Set(['.txt', '.md', '.json', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.html', '.sh', '.yml', '.yaml', '.toml', '.env', '.py', '.sql', '.xml', '.svg', '.csv', '.ini', '.conf', '.log', '.gitignore']);
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.zip': 'application/zip', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8',
};

function statEntry(full, name) {
  try {
    if (fs.lstatSync(full).isSymbolicLink() && !inside(realOf(full), realBase())) {
      return { name, type: 'file', size: 0, mtime: 0, link: true, outside: true }; // no stat of the target
    }
    const st = fs.statSync(full);
    return { name, type: st.isDirectory() ? 'dir' : 'file', size: st.isFile() ? st.size : 0, mtime: st.mtimeMs };
  } catch { return { name, type: 'file', size: 0, mtime: 0, broken: true }; }
}

function fsStat(rel) {
  const { full, err } = guard(rel);
  if (err) return { ok: false, msg: err };
  try {
    const st = fs.statSync(full);
    return { ok: true, path: relOf(full), type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs };
  } catch (e) { return { ok: false, msg: e.code === 'ENOENT' ? tr('srv.notFound') : e.message, code: e.code }; }
}
function fsList(rel) {
  const { full, err } = guard(rel);
  if (err) return { ok: false, msg: err };
  try {
    const entries = fs.readdirSync(full, { withFileTypes: true })
      .map((d) => statEntry(path.join(full, d.name), d.name))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ok: true, path: relOf(full), entries };
  } catch (e) { return { ok: false, msg: e.code === 'ENOTDIR' ? tr('srv.notADir') : e.message, code: e.code }; }
}
function fsRead(rel) {
  const { full, err } = guard(rel);
  if (err) return { ok: false, msg: err };
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return { ok: false, msg: tr('srv.notAFile') };
    if (st.size > MAX_TEXT) return { ok: false, msg: tr('srv.tooBig'), code: 'TOOBIG' };
    const buf = fs.readFileSync(full);
    const ext = path.extname(full).toLowerCase();
    if (!TEXT_EXT.has(ext) && buf.subarray(0, 8000).includes(0)) return { ok: false, msg: tr('srv.binary'), code: 'BINARY' };
    return { ok: true, path: relOf(full), content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsSave(rel, content) {
  const { full, err } = guard(rel);
  if (err) return { ok: false, msg: err };
  if (full === BASE) return { ok: false, msg: tr('srv.badPath') };
  if (typeof content !== 'string') return { ok: false, msg: tr('srv.badContent') };
  if (content.length > MAX_SAVE) return { ok: false, msg: tr('srv.contentTooBig') };
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    writeFileNoFollow(full, content);
    return { ok: true, msg: tr('srv.saved', { path: relOf(full) }) };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsCreate(rel, kind) {
  const { full, err } = guard(rel);
  if (err) return { ok: false, msg: err };
  if (full === BASE) return { ok: false, msg: tr('srv.badPath') };
  if (fs.existsSync(full)) return { ok: false, msg: tr('srv.exists') };
  try {
    if (kind === 'dir') fs.mkdirSync(full, { recursive: true });
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); writeFileNoFollow(full, ''); }
    return { ok: true, msg: tr(kind === 'dir' ? 'srv.dirCreated' : 'srv.fileCreated', { path: relOf(full) }), path: relOf(full) };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsDelete(rel) {
  const { full, err } = guard(rel, { self: true }); // deleting a link removes the LINK, never the target
  if (err) return { ok: false, msg: err };
  if (full === BASE) return { ok: false, msg: tr('srv.badPath') };
  // protects the heart of the volume (Claude login, panel config)
  if (full === path.join(BASE, '.claude') || full === path.join(BASE, '.claude.json')) return { ok: false, msg: tr('srv.protected') };
  try { fs.rmSync(full, { recursive: true, force: true }); return { ok: true, msg: tr('srv.removed', { path: relOf(full) }) }; }
  catch (e) { return { ok: false, msg: e.message }; }
}
function fsRename(rel, newRel) {
  const ga = guard(rel, { self: true }), gb = guard(newRel);
  if (ga.err || gb.err) return { ok: false, msg: ga.err || gb.err };
  const a = ga.full, b = gb.full;
  if (a === BASE || b === BASE) return { ok: false, msg: tr('srv.badPath') };
  if (fs.existsSync(b)) return { ok: false, msg: tr('srv.destExists') };
  try { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); return { ok: true, msg: tr('srv.renamed', { path: relOf(b) }), path: relOf(b) }; }
  catch (e) { return { ok: false, msg: e.message }; }
}
// download: streams the file with Content-Disposition (any type/size)
// files the viewer of the Files page shows in the page (?inline=1) instead of downloading them
const INLINE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg', '.pdf', '.mp4', '.m4v', '.webm', '.mov', '.mp3', '.m4a', '.wav', '.ogg']);
// inline: never a page of our origin that runs code. SVG (it can hold scripts) and media get a
// sandboxed CSP; the PDF must be framed by the panel itself (Chrome's PDF viewer does not run in a
// sandboxed frame, and the PDF has no access to the page).
function inlineHeaders(ext) {
  if (ext === '.pdf') return { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'" };
  return { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'" };
}
function fsDownload(rel, res, req, inline) {
  const { full, err } = guard(rel);
  if (err) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(err); }
  let st;
  try { st = fs.statSync(full); } catch { /* */ }
  if (!st || !st.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(tr('srv.fileNotFound'));
  }
  const name = path.basename(full);
  const ext = path.extname(full).toLowerCase();
  const show = !!inline && INLINE.has(ext);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Disposition': `${show ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(show ? inlineHeaders(ext) : {}),
  };
  if (show && req) return sendRange(req, res, full, st.size, headers); // video/audio seek (iOS needs Range)
  return sendStream(res, full, { headers: { ...headers, 'Content-Length': st.size } });
}
// upload: STREAMED straight to disk (found by @security: one Buffer per upload, up to 100MB,
// with no limit on how many in parallel, made the panel's RAM proportional to simultaneous uploads).
// Writes to a temp file in the SAME folder (rename is atomic) and only switches to the final name at the end; if
// it goes over the limit it just stops WRITING (without buffering in memory) and lets the body drain by itself
// until the natural 'end' — the same way as readRaw (it must not destroy the socket and lose the
// response). Cap on simultaneous uploads: protects against several big uploads at the same time
// saturating disk/CPU (proxy hash/gzip, etc.).
const MAX_CONCURRENT_UPLOADS = 2;
let activeUploads = 0;
function fsUploadStream(rel, req, overwrite) {
  const { full, err } = guard(rel);
  if (err) return Promise.resolve({ ok: false, msg: err });
  if (full === BASE) return Promise.resolve({ ok: false, msg: tr('srv.badPath') });
  return streamUpload(full, req, overwrite).then((r) => (r.ok ? { ...r, msg: tr('srv.uploaded', { path: relOf(full), size: r.size }), path: relOf(full) } : r));
}
// no request data for this long -> the upload fails and its temp file is removed (the server's own
// requestTimeout is far higher, so a big upload on a slow link is never cut while data keeps coming)
const UPLOAD_IDLE_MS = 120 * 1000;
// streams the request body into `full` (already checked by the caller) -> {ok, size} | {ok:false, msg, status?, code?}
// Async writes with backpressure: when the disk is slower than the network the request is paused
// (no unbounded buffering in memory) and resumed on 'drain'. Same outcome as before for every case:
// temp file + atomic rename, EXISTS check at the end, over the limit = stop writing and let the body
// drain until 'end' (so the "too big" answer really reaches the client), write error = keep draining
// and answer the error message.
// opts.idleMs: inactivity timeout override (tests).
function streamUpload(full, req, overwrite, opts = {}) {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return Promise.resolve({ ok: false, status: 429, msg: tr('srv.tooManyUploads') });
  }
  activeUploads++;
  const idleMs = opts.idleMs || UPLOAD_IDLE_MS;
  const max = opts.max || MAX_UPLOAD;
  const tmp = full + '.upload-' + crypto.randomBytes(8).toString('hex') + '.tmp';
  return new Promise((resolve) => {
    let size = 0, over = false, writeErr = null, out = null, done = false, ended = false, paused = false, idle = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (idle) clearTimeout(idle);
      if (out && !out.closed) out.destroy();
      activeUploads--;
      if (!v.ok) { try { fs.rmSync(tmp, { force: true }); } catch { /* */ } }
      resolve(v);
    };
    // inactivity: counts only while WE are waiting for the client (not while paused for the disk)
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = null;
      if (done || ended || paused) return;
      idle = setTimeout(() => {
        finish({ ok: false, status: 408, msg: tr('srv.uploadStalled', { s: Math.round(idleMs / 1000) }) });
        try { req.destroy(); } catch { /* */ }
      }, idleMs);
      if (idle.unref) idle.unref();
    };
    let fd;
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW);
    } catch (e) { return finish({ ok: false, msg: e.message }); }
    out = fs.createWriteStream(null, { fd, autoClose: true });
    const resume = () => { if (paused) { paused = false; req.resume(); arm(); } };
    out.on('drain', resume);
    out.on('error', (e) => { if (!writeErr) writeErr = e; resume(); }); // keeps draining the body
    // fd closed after out.end(): the file is complete on disk, switch it to the final name
    out.on('close', () => {
      if (done || !ended) return;
      if (writeErr) return finish({ ok: false, msg: writeErr.message });
      if (!overwrite && fs.existsSync(full)) return finish({ ok: false, code: 'EXISTS', msg: tr('srv.existsOverwrite') });
      try { fs.renameSync(tmp, full); }
      catch (e) { return finish({ ok: false, msg: e.message }); }
      finish({ ok: true, size });
    });
    req.on('data', (chunk) => {
      arm();
      if (over || writeErr) return;
      size += chunk.length;
      if (size > max) { over = true; return; } // stops writing, but lets the body drain
      if (!out.write(chunk)) { paused = true; req.pause(); arm(); }
    });
    req.on('end', () => {
      ended = true;
      if (idle) clearTimeout(idle);
      if (writeErr) return finish({ ok: false, msg: writeErr.message });
      if (over) return finish({ ok: false, msg: tr('srv.uploadTooBig', { mb: max / 1024 / 1024 }) });
      out.end(); // -> 'close' above
    });
    req.on('error', () => finish({ ok: false, msg: tr('srv.uploadBroken') }));
    // 'close' also comes right after a normal 'end', while the last write may still be on its way to
    // disk: only a close BEFORE the end means the client went away
    req.on('close', () => { if (!ended) finish({ ok: false, msg: tr('srv.uploadBroken') }); });
    arm();
  });
}

// a file sent from the chat or dropped on the terminal: saved under <dir>/.chat-uploads/<yyyy-mm>/
// with a random prefix (never overwrites, never leaves `dir`) -> {ok, path, size} | {ok:false, msg}
const UPLOAD_DIR = '.chat-uploads';
function safeName(n) {
  const base = path.basename(String(n || '')).normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-80);
  return base || 'file';
}
async function saveUpload(dir, name, req) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const full = path.join(dir, UPLOAD_DIR, month, crypto.randomBytes(4).toString('hex') + '-' + safeName(name));
  const g = confine(dir, full);
  if (g.err) return { status: 400, ok: false, msg: g.err };
  const r = await streamUpload(full, req, false);
  return r.ok ? { ok: true, path: full, size: r.size } : r;
}

module.exports = { UPLOAD_IDLE_MS, UPLOAD_DIR, saveUpload, fsStat, fsList, fsRead, fsSave, fsCreate, fsDelete, fsRename, fsDownload, fsUploadStream, MAX_UPLOAD, confine, streamUpload, MIME };
