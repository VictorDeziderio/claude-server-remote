'use strict';
/*
 * Project chat behind a link + key (/remote/<project>?key=<key> or /c/<key>; API at /chat-api/*).
 *
 * ONE conversation per project: the one the project's terminal Claude (tmux session
 * claude-<project>) is on. The chat shows that conversation and drives that same Claude:
 *  - which conversation: the session id of the newest interactive hook line (devbox-hook.sh ->
 *    RUN_DIR/hooks.jsonl: sid + cwd + tty) whose cwd is the project folder. When there is none, or
 *    it is older than the newest *.jsonl and has no file of its own, the newest *.jsonl of the
 *    project (by mtime) is shown instead;
 *  - live: while a chat page is open, a watcher (every TICK_MS) reads the tail of that .jsonl and
 *    the tmux screen and pushes `state` / `messages` events over SSE (GET /chat-api/stream);
 *  - send: the text, plus the absolute paths of the uploaded attachments, is TYPED into the tmux
 *    pane like a person (util.typeText; several lines go in as one bracketed paste);
 *  - stop: Escape in the pane. Questions on the screen (server/screen.js: permission prompts,
 *    AskUserQuestion menus) are answered with the arrow keys + Enter, and only while the screen
 *    still shows the question the person saw (its `sig`);
 *  - Claude not running (project OFF, paused, session down, shell only): `start` does what the
 *    panel does (power on / resume / Claude ON / recreate the session).
 * Keys: 32 random bytes (base64url), stored ONLY as sha256 + metadata in CHAT_KEYS_FILE (0600).
 * Every key is an owner key; records of the removed "limited" role are dropped when the file is read.
 *
 * Notes on the contract:
 *  - GET /chat-api/file also accepts the key as ?key=<key> (an <img>/<video> tag cannot send the
 *    Authorization header). Other routes take the Bearer header only.
 *  - message/media cursors are opaque strings (an index, or "o<byte offset>" for big files).
 *  - 429 for the per-IP bad-key limit; 409 {code: off|asking|changed} when Claude cannot take a
 *    message/answer right now.
 *  - push: /chat-api/push* register this device for the pushes of THIS project only (push.js
 *    `chat`), and a tap on one opens /remote/<project> (public/chat-sw.js).
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { tr } = require('./i18n');
const { readJson, sendJson, sendStream, sendRange, validName, sessionName, paneOf, clampInt, log, sh, typeText } = require('./util');
const { audit } = require('./audit');
const auth = require('./auth');
const files = require('./files');
const jsonl = require('./jsonl');
const screen = require('./screen');
const push = require('./push');

// lazy: these modules (directly or not) require this one
const projects = () => require('./projects');
const notify = () => require('./notify');

const KEYS_FILE = cfg.CHAT_KEYS_FILE;
const UPLOAD_DIR = files.UPLOAD_DIR;
const TICK_MS = Math.max(200, parseInt(process.env.CHAT_TICK_MS || '1000', 10) || 1000);
const MAX_STREAMS_PER_PROJECT = 10;
const projectDir = (name) => path.join(cfg.PROJECTS_DIR, name);
const histDir = (name) => require('./history').dirOf(name);
const convFile = (project, id) => path.join(histDir(project), id + '.jsonl');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- key store
// { keys: [{id, hash, project, label, role: 'owner', createdAt, lastUsedAt, revokedAt}] }
let store = null;
function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch { store = null; }
  if (!store || !Array.isArray(store.keys)) store = { keys: [] };
  // only owner keys exist: an old "limited" key stops working (and leaves the file)
  const before = store.keys.length;
  store.keys = store.keys.filter((k) => k && k.role === 'owner');
  const legacy = 'convs' in store;
  delete store.convs;
  if (store.keys.length !== before || legacy) save();
  return store;
}
function save() {
  if (require('./restore').frozen()) return; // a config restore just wrote the file: the old state must not overwrite it
  try {
    fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
    const tmp = KEYS_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, KEYS_FILE);
  } catch (e) { log('error', 'chat keys: could not save', { err: e.message }); }
}
const pub = (k) => ({ id: k.id, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null });

function linkBase(req) {
  const host = auth.hostOf(req);
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}
function listKeys(name) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
  return { ok: true, keys: load().keys.filter((k) => k.project === name && !k.revokedAt).map(pub) };
}
function createKey(b, req) {
  const name = b && b.name;
  if (!validName(name) || !fs.existsSync(projectDir(name))) return { ok: false, msg: tr('srv.badName') };
  // the "limited" role was removed: a request for anything but an owner link is refused
  if (b.role != null && b.role !== 'owner') return { ok: false, msg: tr('srv.badParams') };
  const label = String(b.label || '').trim().slice(0, 60) || 'owner';
  const key = crypto.randomBytes(32).toString('base64url');
  const rec = { id: crypto.randomBytes(6).toString('hex'), hash: sha(key), project: name, label, role: 'owner', createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null };
  load().keys.push(rec);
  save();
  audit('chat.key.create', { ip: auth.clientIp(req), name, id: rec.id });
  return { ok: true, id: rec.id, key, url: `${linkBase(req)}/remote/${encodeURIComponent(name)}?key=${key}` };
}
// a person of the remote hub was removed: its chats close and its phones stop getting pushes
function onHubRevoke(keyId) {
  push.removeWhere((d) => !!d.chat && d.chat.keyId === keyId);
  for (const w of watchers.values()) for (const c of w.clients) if (c.keyId === keyId) c.end();
}
function revokeKey(b, req) {
  const k = load().keys.find((x) => x.id === (b && b.id) && !x.revokedAt);
  if (!k) return { ok: false, msg: tr('srv.notFound') };
  k.revokedAt = new Date().toISOString();
  save();
  push.removeWhere((d) => !!d.chat && d.chat.keyId === k.id); // its phone stops getting pushes
  for (const w of watchers.values()) for (const c of w.clients) if (c.keyId === k.id) c.end();
  audit('chat.key.revoke', { ip: auth.clientIp(req), name: k.project, id: k.id });
  return { ok: true };
}
// project renamed / deleted (server/projects.js): keys and chat devices follow / are removed
function onRename(oldName, newName) {
  require('./hub').onRename(oldName, newName);
  const s = load();
  closeWatcher(oldName);
  for (const k of s.keys) if (k.project === oldName) k.project = newName;
  save();
  push.renameChat(oldName, newName);
  hookSid.delete(oldName); hookTurn.delete(oldName);
}
function onDelete(name) {
  const s = load();
  closeWatcher(name);
  s.keys = s.keys.filter((k) => k.project !== name);
  save();
  push.removeWhere((d) => !!d.chat && d.chat.project === name);
  hookSid.delete(name); hookTurn.delete(name);
}

// ---------------------------------------------------------------- auth of /chat-api
const limiter = auth.makeLimiter();
const bearerOf = (req, u) => {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (m) return m[1];
  return u && u.pathname === '/chat-api/file' ? (u.searchParams.get('key') || '') : '';
};
// -> {key} | {status, msg}. `project`: the project named by the link (/remote/<project>); a key of
// the remote hub (server/hub.js) opens the chat of that project, a chat key only its own.
// A valid key always passes: the limiter only slows down WRONG keys (behind a proxy that hides the
// client IP every caller shares one IP, and a flood of bad keys must not lock the owner out).
function keyFor(req, plain, project) {
  const h = plain && plain.length <= 128 ? sha(plain) : '';
  const k = h && load().keys.find((x) => x.hash === h && !x.revokedAt);
  if (!k && h) {
    const hub = require('./hub');
    const hk = project ? hub.chatKeyOf(plain, project) : null;
    if (hk) return { key: hk };
    // a real hub key on a project that is gone (renamed, deleted): not a guess, never counted
    if (hub.isPersonKey(plain)) return { status: 404, msg: tr('srv.noProject') };
  }
  const ip = auth.clientIp(req);
  if (!k || !fs.existsSync(projectDir(k.project))) {
    const wait = limiter.limited(ip);
    if (wait) return { status: 429, msg: tr('srv.tooManyTries', { s: wait }) };
    limiter.fail(ip);
    return { status: 401, msg: tr('srv.notAuthed') };
  }
  // lastUsedAt written at most once a minute (no disk write per request)
  if (!k.lastUsedAt || Date.now() - Date.parse(k.lastUsedAt) > 60000) { k.lastUsedAt = new Date().toISOString(); save(); }
  return { key: k };
}

// never log a key: /c/<key>... and ?key= are masked
const redactUrl = (u) => String(u || '').replace(/\/c\/[^/?#]+/g, '/c/[key]').replace(/([?&]key=)[^&#]*/g, '$1[key]');

// ---------------------------------------------------------------- reading the conversation
const KIND = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.avif', '.bmp', '.svg'],
  video: ['.mp4', '.mov', '.m4v', '.webm', '.mkv'],
  audio: ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac'],
};
const kindOf = (p) => { const e = path.extname(String(p)).toLowerCase(); return Object.keys(KIND).find((k) => KIND[k].includes(e)) || 'file'; };
function attOf(p) {
  let size = 0;
  try { size = fs.statSync(p).size; } catch { /* gone */ }
  return { path: p, name: path.basename(p).replace(/^[0-9a-f]{8}-/, ''), kind: kindOf(p), size };
}
const ATT_RE = /\n*Attached files:\n((?:- [^\n]+\n?)+)\s*$/;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// the attachments of a user message -> {text, paths}. Two shapes: the paths the chat types after
// the text ("look /<project>/.chat-uploads/2026-11/ab12cd34-shot.png", absolute, no spaces: upload
// names are made safe), and the older "Attached files:\n- /a\n- /b" block.
function splitAttachments(text, dir) {
  let t = text || '';
  const paths = [];
  const m = ATT_RE.exec(t);
  if (m) {
    paths.push(...m[1].split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean));
    t = t.slice(0, m.index);
  }
  if (dir) {
    const re = new RegExp('(^|\\s)(' + escRe(path.join(dir, UPLOAD_DIR) + path.sep) + '\\S+)', 'g');
    t = t.replace(re, (all, sp, p) => { paths.push(p); return sp; }).replace(/[ \t]+$/gm, '').trimEnd();
  }
  return { text: t, paths };
}
const textBlocks = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function toolSummary(name, input) {
  const i = input || {};
  const v = i.file_path || i.notebook_path || i.command || i.pattern || i.url || i.query || i.description || i.path || '';
  return clip(String(v).replace(/\s+/g, ' '), 160);
}
const isNoiseText = (t) => !t.trim() || /^<(command-|local-command-|system-reminder)/.test(t.trim()) || t.startsWith('Caveat:') || t.startsWith('[Request interrupted');

// one assistant line -> {text, tools, written:[paths]}
function assistantParts(content) {
  const out = { text: '', tools: [], written: [] };
  if (!Array.isArray(content)) { out.text = textBlocks(content); return out; }
  const texts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text') texts.push(b.text || '');
    else if (b.type === 'tool_use') {
      out.tools.push({ name: b.name || '?', summary: toolSummary(b.name, b.input), ok: true, _id: b.id });
      const fp = b.input && (b.input.file_path || b.input.notebook_path);
      if (fp && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(b.name)) out.written.push(String(fp));
    }
  }
  out.text = texts.join('\n');
  return out;
}

// parses .jsonl lines into Msg[] (+ title, updatedAt, written files). dir = project folder (to
// find the attachment paths in the user messages)
function parseLines(entries, fallbackTs, dir) {
  if (typeof entries === 'string') entries = entries.split('\n').map((line) => ({ line, off: 0 }));
  const msgs = [];
  const toolsById = new Map();
  const names = jsonl.titler();
  let updatedAt = '';
  for (const { line, off } of entries) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    names.line(o);
    if (!o || (o.type !== 'user' && o.type !== 'assistant') || o.isMeta || o.isSidechain || o.isCompactSummary) continue;
    const m = o.message;
    if (!m || !m.role) continue;
    const ts = String(o.timestamp || '');
    if (ts) updatedAt = ts;
    if (m.role === 'user') {
      const c = m.content;
      const results = Array.isArray(c) ? c.filter((b) => b && b.type === 'tool_result') : [];
      for (const r of results) { const t = toolsById.get(r.tool_use_id); if (t && r.is_error) t.ok = false; }
      const raw = textBlocks(c);
      if (isNoiseText(raw)) continue; // tool_result-only lines fold into the previous assistant tools
      const { text, paths } = splitAttachments(raw, dir);
      names.user(text || (paths[0] ? path.basename(paths[0]) : ''));
      msgs.push({ id: o.uuid || 'u' + msgs.length, role: 'user', ts, text, tools: [], attachments: paths.map(attOf), _written: [], _off: off });
    } else {
      const p = assistantParts(m.content);
      if (!p.text && !p.tools.length) continue; // thinking only
      let last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') {
        last = { id: o.uuid || 'a' + msgs.length, role: 'assistant', ts, text: '', tools: [], attachments: [], _written: [], _off: off };
        msgs.push(last);
      }
      if (p.text) last.text = last.text ? last.text + '\n\n' + p.text : p.text;
      for (const t of p.tools) { last.tools.push(t); if (t._id) toolsById.set(t._id, t); }
      last._written.push(...p.written);
    }
  }
  return { msgs, names: names.state(), title: jsonl.pickTitle(names.state()), updatedAt: updatedAt || fallbackTs };
}
const cleanMsg = (m) => ({ id: m.id, role: m.role, ts: m.ts, text: m.text, tools: m.tools.map((t) => ({ name: t.name, summary: t.summary, ok: t.ok })), attachments: m.attachments });
// changes when a message grows (a reply is several .jsonl lines folded into one message)
const msgSig = (m) => `${m.text.length}:${m.tools.length}:${m.tools.filter((t) => !t.ok).length}:${m.attachments.length}`;

// small cache: file -> {mtimeMs, size, parsed}
const cache = new Map();
// -> { id, title, updatedAt, msgs, big, start } (big: only the newest window was read; start = its
// first byte, the cursor of the older messages)
async function readConv(project, id) {
  const file = convFile(project, id);
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  if (!st.isFile()) return null;
  const c = cache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.parsed;
  const fallback = new Date(st.mtimeMs).toISOString();
  const dir = projectDir(project);
  let parsed;
  try {
    if (st.size <= jsonl.BIG) parsed = { id, ...parseLines(await jsonl.all(file), fallback, dir), big: false, start: 0 };
    else {
      const w = await jsonl.windowBefore(file, st.size);
      const tail = parseLines(w.lines, fallback, dir);
      parsed = { id, title: jsonl.pickTitle(parseLines(await jsonl.head(file, st.size), fallback, dir).names, tail.names), updatedAt: tail.updatedAt, msgs: tail.msgs, big: true, start: w.start, size: st.size };
    }
  } catch { return null; }
  cache.delete(file);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return parsed;
}
// messages of a big conversation that end before byte `end` (older pages): one window, newest last
async function olderOf(project, id, end) {
  const file = convFile(project, id);
  let st; try { st = await fsp.stat(file); } catch { return null; }
  const w = await jsonl.windowBefore(file, st.size, end);
  return { msgs: parseLines(w.lines, '', projectDir(project)).msgs, start: w.start };
}

// ---------------------------------------------------------------- which conversation
// From the hook lines of interactive Claude runs (tty=1, not a subagent, not `claude -p`) whose
// cwd is the project folder: project -> newest session id, and the last turn event.
const hookSid = new Map();  // project -> { sid, t }
const hookTurn = new Map(); // project -> { ev, t }
function ingestHook(h) {
  if (!h || typeof h !== 'object' || h.agent || h.tty === 0 || h.src === 'sdk' || typeof h.cwd !== 'string' || !h.cwd) return;
  const project = notify().projectOf(h.cwd);
  if (!project || path.resolve(h.cwd) !== projectDir(project)) return;
  const t = typeof h.t === 'number' ? h.t : Date.now();
  if (validId(h.sid)) { const cur = hookSid.get(project); if (!cur || cur.t <= t) hookSid.set(project, { sid: h.sid, t }); }
  if (['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionStart'].includes(h.ev)) hookTurn.set(project, { ev: h.ev, t });
  const w = watchers.get(project);
  if (w) setTimeout(() => tickWatcher(w), 50);
}
// panel start: the lines written before (hooks.jsonl.old, then hooks.jsonl; the newest 512 KB)
function scanHooks() {
  const file = notify().HOOK_FILE;
  for (const f of [file + '.old', file]) {
    let buf;
    try {
      const st = fs.statSync(f);
      const len = Math.min(st.size, 512 * 1024);
      const fd = fs.openSync(f, 'r');
      try { buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    } catch { continue; }
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      try { ingestHook(JSON.parse(line)); } catch { /* cut or broken line */ }
    }
  }
}

// the newest *.jsonl of the project by mtime (a stat per file; cached a moment)
const newestCache = new Map(); // project -> { at, val }
async function newestConv(project) {
  const c = newestCache.get(project);
  if (c && Date.now() - c.at < 2000) return c.val;
  let best = null;
  const dir = histDir(project);
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { /* no history yet */ }
  for (const f of names) {
    const id = f.slice(0, -6);
    if (!validId(id)) continue;
    let st; try { st = await fsp.stat(path.join(dir, f)); } catch { continue; }
    if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { id, mtimeMs: st.mtimeMs };
  }
  newestCache.set(project, { at: Date.now(), val: best });
  return best;
}
async function currentConv(project) {
  const h = hookSid.get(project);
  const n = await newestConv(project);
  if (h) {
    let has = false;
    try { has = (await fsp.stat(convFile(project, h.sid))).isFile(); } catch { /* not written yet */ }
    // a fresh session has no file until its first message: it is still THE conversation
    if (has || !n || h.t >= n.mtimeMs) return h.sid;
  }
  return n ? n.id : null;
}

// ---------------------------------------------------------------- Claude's state
async function captureScreen(sess) {
  const r = await sh('tmux', ['capture-pane', '-t', paneOf(sess), '-p', '-J']);
  return r.ok ? r.stdout || '' : '';
}
// -> { claude: 'off'|'idle'|'working'|'asking', why?, question? }
async function claudeOf(project) {
  const P = projects();
  const sess = sessionName(project);
  if (!P.projConfig(project).enabled) return { claude: 'off', why: 'disabled' };
  if (!(await P.sessionUp(sess))) return { claude: 'off', why: 'down' };
  if (P.pausedFlag(sess)) return { claude: 'off', why: 'paused' };
  if (!P.claudeRunningFlag(sess)) return { claude: 'off', why: 'shell' };
  const scr = await captureScreen(sess);
  const q = screen.parseQuestion(scr);
  if (q) return { claude: 'asking', question: q };
  if (screen.looksLikePrompt(scr)) return { claude: 'asking', question: { raw: screen.screenTail(scr), options: [] } };
  const turn = hookTurn.get(project);
  // the prompt was just sent: the spinner may not be on screen yet
  const justSent = turn && turn.ev === 'UserPromptSubmit' && Date.now() - turn.t < 15000;
  return { claude: screen.isWorking(scr) || justSent ? 'working' : 'idle' };
}
async function stateOf(project) {
  const conv = await currentConv(project);
  const c = conv ? await readConv(project, conv) : null;
  return { conv, title: (c && c.title) || '', ...(await claudeOf(project)) };
}

// ---------------------------------------------------------------- live updates (SSE)
// project -> { project, clients:Set<res>, timer, busy, stateJson, conv, fileSig, sigs }
const watchers = new Map();
const sse = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
const emitAll = (w, event, data) => { for (const res of w.clients) sse(res, event, data); };
async function tickWatcher(w) {
  if (w.busy || !w.clients.size) return;
  w.busy = true;
  try {
    const st = await stateOf(w.project);
    const sj = JSON.stringify(st);
    if (sj !== w.stateJson) { w.stateJson = sj; emitAll(w, 'state', st); }
    if (st.conv !== w.conv) { w.conv = st.conv; w.sigs = null; w.fileSig = ''; }
    if (!st.conv) return;
    let fsig = '';
    try { const s = await fsp.stat(convFile(w.project, st.conv)); fsig = `${s.size}:${s.mtimeMs}`; } catch { /* not written yet */ }
    if (fsig === w.fileSig) return;
    w.fileSig = fsig;
    const c = await readConv(w.project, st.conv);
    const tail = c ? c.msgs.slice(-60) : [];
    const sigs = new Map(tail.map((m) => [m.id, msgSig(m)]));
    // new messages, and the reply that grew since the last look
    const changed = w.sigs ? tail.filter((m) => w.sigs.get(m.id) !== sigs.get(m.id)) : [];
    w.sigs = sigs;
    if (changed.length) emitAll(w, 'messages', { conv: st.conv, items: changed.map(cleanMsg) });
  } catch (e) { log('error', 'chat watcher', { project: w.project, err: e.message }); }
  finally { w.busy = false; }
}
const poke = (project) => { const w = watchers.get(project); if (w) setTimeout(() => tickWatcher(w), 100); };
function closeWatcher(project) {
  const w = watchers.get(project);
  if (!w) return;
  clearInterval(w.timer);
  for (const res of w.clients) { try { res.end(); } catch { /* */ } }
  watchers.delete(project);
}
function stopAll() { for (const p of [...watchers.keys()]) closeWatcher(p); }

async function stream(k, req, res) {
  let w = watchers.get(k.project);
  if (w && w.clients.size >= MAX_STREAMS_PER_PROJECT) return sendJson(res, 429, { ok: false, msg: tr('srv.tooManyEvents') });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(':ok\n\n');
  res.keyId = k.id;
  if (!w) {
    w = { project: k.project, clients: new Set(), timer: null, busy: false, stateJson: '', conv: undefined, fileSig: '', sigs: null };
    watchers.set(k.project, w);
  }
  w.clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 15000);
  const bye = () => {
    clearInterval(ping);
    w.clients.delete(res);
    if (!w.clients.size && watchers.get(k.project) === w) { clearInterval(w.timer); watchers.delete(k.project); }
  };
  req.on('close', bye);
  res.on('close', bye);
  // this client: the state now + the newest messages (anything that changed between its page load
  // and this connection is in there; the page merges them by id)
  try {
    const st = await stateOf(k.project);
    sse(res, 'state', st);
    const c = st.conv ? await readConv(k.project, st.conv) : null;
    if (c) sse(res, 'messages', { conv: st.conv, items: c.msgs.slice(-20).map(cleanMsg) });
  } catch (e) { log('error', 'chat stream', { err: e.message }); }
  if (!w.timer) { w.timer = setInterval(() => tickWatcher(w), TICK_MS); w.timer.unref(); tickWatcher(w); }
}

// ---------------------------------------------------------------- messages / media of THE conversation
// pages of a list ordered oldest -> newest, read from the END: before = index (exclusive)
function pageFromEnd(list, q, def) {
  const limit = clampInt(q.get('limit'), 1, 200, def);
  const end = q.get('before') ? clampInt(q.get('before'), 0, list.length, list.length) : list.length;
  const start = Math.max(0, end - limit);
  return { items: list.slice(start, end), next: start > 0 ? String(start) : null };
}
async function listMessages(k, q) {
  const conv = await currentConv(k.project);
  const c = conv ? await readConv(k.project, conv) : null;
  if (!c || !c.big) {
    const p = pageFromEnd(c ? c.msgs : [], q, 50);
    return { ok: true, conv, items: p.items.map(cleanMsg), next: p.next };
  }
  // big file: the page ends at a byte offset; messages before it come from one more window
  const limit = clampInt(q.get('limit'), 1, 200, 50);
  const before = /^o\d+$/.test(q.get('before') || '') ? Number(q.get('before').slice(1)) : null;
  let msgs = c.msgs, start = c.start;
  if (before != null) {
    const w = await olderOf(k.project, conv, before);
    if (!w) return { status: 404, ok: false, msg: tr('srv.convNotFound') };
    msgs = w.msgs.filter((m) => m._off < before); start = w.start;
  }
  const page = msgs.slice(-limit);
  const from = page.length ? page[0]._off : start;
  return { ok: true, conv, items: page.map(cleanMsg), next: from > 0 ? 'o' + from : null };
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;:!?]/g;
async function listMedia(k, q) {
  const tab = q.get('tab') || 'media';
  if (!['media', 'files', 'links'].includes(tab)) return { status: 400, ok: false, msg: tr('srv.badParams') };
  const conv = await currentConv(k.project);
  const c = conv ? await readConv(k.project, conv) : null;
  const msgs = c ? c.msgs : [];
  const seen = new Set();
  const out = []; // oldest -> newest; the page is read from the end (newest first in each page)
  const dir = projectDir(k.project);
  for (const m of msgs) {
    if (tab === 'links') {
      for (const url of (m.text.match(URL_RE) || [])) {
        if (seen.has(url)) continue;
        seen.add(url); out.push({ url, ts: m.ts, msgId: m.id, from: m.role });
      }
      continue;
    }
    const paths = [...m.attachments.map((a) => a.path), ...m._written.map((p) => path.resolve(dir, p))];
    for (const p of paths) {
      if (seen.has(p) || files.confine(dir, p).err || !fs.existsSync(p)) continue;
      const a = attOf(p);
      if ((tab === 'media') !== (a.kind === 'image' || a.kind === 'video')) continue;
      seen.add(p); out.push({ ...a, ts: m.ts, msgId: m.id, from: m.role });
    }
  }
  const p = pageFromEnd(out, q, 30);
  return { ok: true, conv, items: p.items.reverse(), next: p.next };
}

// ---------------------------------------------------------------- driving the terminal Claude
// one typing at a time per project (two sends at once would interleave their keys)
const locks = new Map();
function locked(project, fn) {
  const prev = locks.get(project) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(project, tail);
  tail.then(() => { if (locks.get(project) === tail) locks.delete(project); });
  return run;
}
const busyReply = (st) => (st.claude === 'off'
  ? { status: 409, ok: false, code: 'off', msg: tr('srv.chatClaudeOff') }
  : { status: 409, ok: false, code: 'asking', msg: tr('srv.chatAsking') });

async function send(k, b) {
  const text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim() : '';
  const atts = Array.isArray(b.attachments) ? b.attachments.slice(0, 20) : [];
  if (!text && !atts.length) return { status: 400, ok: false, msg: tr('srv.badParams') };
  if (text.length > 20000) return { status: 400, ok: false, msg: tr('srv.contentTooBig') };
  const upBase = path.join(projectDir(k.project), UPLOAD_DIR);
  const paths = [];
  for (const a of atts) {
    const p = typeof a === 'string' ? a : a && a.path;
    if (typeof p !== 'string' || !path.isAbsolute(p) || /\s/.test(p) || files.confine(upBase, path.resolve(p)).err || !fs.existsSync(p)) return { status: 400, ok: false, msg: tr('srv.badPath') };
    paths.push(path.resolve(p));
  }
  return locked(k.project, async () => {
    const st = await claudeOf(k.project);
    if (st.claude === 'off' || st.claude === 'asking') return busyReply(st);
    // the paths go after the text: Claude Code takes an image from its absolute path
    const line = [text, paths.join(' ')].filter(Boolean).join(text.includes('\n') ? '\n\n' : ' ');
    if (!(await typeText(sessionName(k.project), line))) return { status: 500, ok: false, msg: tr('srv.chatTypeFailed') };
    hookTurn.set(k.project, { ev: 'UserPromptSubmit', t: Date.now() });
    poke(k.project);
    audit('chat.send', { name: k.project, keyId: k.id, textLen: text.length, files: paths.length });
    return { ok: true };
  });
}
async function stop(k) {
  const st = await claudeOf(k.project);
  if (st.claude === 'off') return busyReply(st);
  await sh('tmux', ['send-keys', '-t', paneOf(sessionName(k.project)), 'Escape']);
  poke(k.project);
  audit('chat.stop', { name: k.project, keyId: k.id });
  return { ok: true };
}
// a button of the question card: option n of the menu on the screen (arrow keys to it + Enter)
async function answer(k, b) {
  const n = Number(b && b.n);
  return locked(k.project, async () => {
    const sess = sessionName(k.project);
    const st = await claudeOf(k.project);
    const q = st.question;
    if (st.claude !== 'asking' || !q || !q.options.length || (b.sig && q.sig !== b.sig)) return { status: 409, ok: false, code: 'changed', msg: tr('srv.chatQuestionGone') };
    if (!q.options.some((o) => o.n === n)) return { status: 400, ok: false, msg: tr('srv.badParams') };
    const delta = n - q.cursor;
    if (delta) {
      await sh('tmux', ['send-keys', '-t', paneOf(sess), ...Array(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up')]);
      await sleep(150);
    }
    await sh('tmux', ['send-keys', '-t', paneOf(sess), 'Enter']);
    poke(k.project);
    audit('chat.answer', { name: k.project, keyId: k.id, n });
    return { ok: true };
  });
}
// quick keys (the question could not be read: the card shows the screen and these keys)
const QUICK_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'Space', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
async function keys(k, b) {
  const list = Array.isArray(b && b.keys) ? b.keys.slice(0, 10) : [];
  if (!list.length || !list.every((x) => QUICK_KEYS.has(x))) return { status: 400, ok: false, msg: tr('srv.keyNotAllowed') };
  return locked(k.project, async () => {
    const st = await claudeOf(k.project);
    if (st.claude === 'off') return busyReply(st);
    const pane = paneOf(sessionName(k.project));
    for (const x of list) {
      await sh('tmux', /^[\dyn]$/.test(x) ? ['send-keys', '-t', pane, '-l', x] : ['send-keys', '-t', pane, x]);
      await sleep(80);
    }
    poke(k.project);
    audit('chat.keys', { name: k.project, keyId: k.id, keys: list.join(' ') });
    return { ok: true };
  });
}
// "Start Claude": what the panel does for an OFF / paused / stopped project
async function start(k) {
  const P = projects();
  const name = k.project;
  const sess = sessionName(name);
  const c = P.projConfig(name);
  const wasOff = !c.enabled, wasPaused = P.pausedFlag(sess);
  let r = { ok: true };
  if (wasOff) r = await P.setPower(name, true);
  if (r.ok && wasPaused) r = P.unpauseProject(name);
  if (r.ok && !P.projConfig(name).autoStartClaude) r = await P.setConfig(name, 'autoStartClaude', true); // recreates the session with Claude
  else if (r.ok && !wasOff && !wasPaused) {
    if (!(await P.sessionUp(sess))) await P.ensureSession(name);
    else if (!P.claudeRunningFlag(sess)) await P.recreateSession(name);
  }
  if (!r.ok) return { status: 500, ok: false, msg: r.msg };
  poke(name);
  audit('chat.start', { name, keyId: k.id });
  return { ok: true };
}

// ---------------------------------------------------------------- push (this device, this project)
function pushApi(k, url, b, req) {
  if (url === '/chat-api/push/subscribe') {
    const name = `Chat · ${k.project}` + (b.name ? ' · ' + String(b.name).slice(0, 40) : '');
    const r = push.subscribe(b.subscription, { name, host: auth.hostOf(req), chat: { project: k.project, keyId: k.id } });
    if (r.ok) audit('chat.push.subscribe', { name: k.project, keyId: k.id });
    return r;
  }
  const mine = push.devices().find((d) => d.endpoint === b.endpoint && d.chat === k.project);
  if (url === '/chat-api/push/status') return { ok: true, registered: !!mine };
  if (url === '/chat-api/push/unsubscribe') return mine ? push.unsubscribe({ endpoint: mine.endpoint }) : { status: 404, ok: false, msg: tr('srv.deviceNotFound') };
  return null;
}

// ---------------------------------------------------------------- upload / file
async function upload(k, q, req) {
  const r = await files.saveUpload(projectDir(k.project), q.get('name'), req);
  if (!r.ok) return r;
  audit('chat.upload', { name: k.project, keyId: k.id, size: r.size });
  return { ok: true, att: attOf(r.path) };
}
const INLINE = new Set(['image', 'video', 'audio']);
const EXTRA_MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.heic': 'image/heic', '.avif': 'image/avif' };
function serveFile(k, q, req, res) {
  const raw = q.get('path') || '';
  const dir = projectDir(k.project);
  const full = path.resolve(dir, raw);
  const g = raw ? files.confine(dir, full) : { err: tr('srv.badPath') };
  if (g.err) return sendJson(res, 403, { ok: false, msg: g.err });
  let st;
  try { st = fs.statSync(full); } catch { /* */ }
  if (!st || !st.isFile()) return sendJson(res, 404, { ok: false, msg: tr('srv.fileNotFound') });
  const ext = path.extname(full).toLowerCase();
  const kind = kindOf(full);
  const type = EXTRA_MIME[ext] || files.MIME[ext] || 'application/octet-stream';
  const inline = (INLINE.has(kind) && ext !== '.svg') || ext === '.pdf';
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`,
    'Accept-Ranges': 'bytes',
  };
  return sendRange(req, res, full, st.size, headers);
}

// ---------------------------------------------------------------- HTTP entry points
// /chat-api/* (no panel cookie; Bearer key)
async function handleApi(req, res, u) {
  if (require('./hub').cors(req, res)) return undefined; // Bearer only: callable from the hub of another server
  const url = u.pathname;
  const linkProject = String(req.headers['x-chat-project'] || u.searchParams.get('project') || '');
  const a = keyFor(req, bearerOf(req, u), linkProject);
  if (!a.key) return sendJson(res, a.status, { ok: false, msg: a.msg });
  const k = a.key;
  const q = u.searchParams;
  const reply = (r) => { const { status, ...body } = r; return sendJson(res, status || 200, body); };
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url === '/chat-api/me') return reply({ ok: true, project: k.project, label: k.label });
    if (url === '/chat-api/state') return reply({ ok: true, ...(await stateOf(k.project)) });
    if (url === '/chat-api/messages') return reply(await listMessages(k, q));
    if (url === '/chat-api/media') return reply(await listMedia(k, q));
    if (url === '/chat-api/stream') return stream(k, req, res);
    if (url === '/chat-api/file') return serveFile(k, q, req, res);
    if (url === '/chat-api/push') return reply({ ok: true, supported: push.supported(), publicKey: push.supported() ? push.publicKey() : '' });
    return sendJson(res, 404, { ok: false, msg: tr('srv.unknownRoute') });
  }
  if (req.method === 'POST') {
    if (url === '/chat-api/upload') return reply(await upload(k, q, req));
    const b = await readJson(req);
    if (!b) return sendJson(res, 400, { ok: false, msg: tr('srv.badBody') });
    if (url === '/chat-api/send') return reply(await send(k, b));
    if (url === '/chat-api/stop') return reply(await stop(k));
    if (url === '/chat-api/answer') return reply(await answer(k, b));
    if (url === '/chat-api/keys') return reply(await keys(k, b));
    if (url === '/chat-api/start') return reply(await start(k));
    if (url.startsWith('/chat-api/push/')) { const r = pushApi(k, url, b, req); if (r) return reply(r); }
    return sendJson(res, 404, { ok: false, msg: tr('srv.unknownRoute') });
  }
  return sendJson(res, 405, { ok: false, msg: 'method not allowed' });
}

// chat page: /c/<key> or /remote/<project>?key=<key>, and the manifest of each link
// (/c/<key>/manifest.webmanifest, /remote/<project>/manifest.webmanifest?key=<key>)
function manifestOf(req, res, plain, project, startUrl, scope) {
  const a = keyFor(req, plain, project);
  if (!a.key || (project && a.key.project !== project)) { res.writeHead(a.status === 429 ? 429 : 404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  const body = JSON.stringify({
    name: `Claude · ${a.key.project}`, short_name: a.key.project, start_url: startUrl, scope,
    display: 'standalone', background_color: '#0b0d12', theme_color: '#0b0d12',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  });
  res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(body);
}
function handlePage(req, res, url, u) {
  const m = /^\/c\/([^/]+)(\/.*)?$/.exec(url);
  if (m && m[2] === '/manifest.webmanifest') return manifestOf(req, res, m[1], '', `/c/${m[1]}`, `/c/${m[1]}`);
  const r = /^\/remote\/([^/]+)(\/manifest\.webmanifest)?\/?$/.exec(url);
  if (!m && !r) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  if (r && r[2]) {
    const key = (u && u.searchParams.get('key')) || '';
    return manifestOf(req, res, key, decodeURIComponent(r[1]), `/remote/${r[1]}?key=${encodeURIComponent(key)}`, `/remote/${r[1]}`);
  }
  const file = path.join(cfg.DIST, 'chat.html');
  let st = null;
  try { st = fs.statSync(file); } catch { /* not built */ }
  if (!st) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Claude Remote: chat page not built (run "npm run build" in panel/).'); }
  // the key is in the URL: never send it on as a Referer
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
  return sendStream(res, file, { headers });
}

// boot: the hook lines already on disk, then every new one (notify.js polls the file)
let started = false;
function startChat() {
  if (started) return;
  started = true;
  load();
  scanHooks();
  notify().onHookLine(ingestHook);
}

const routes = {
  GET: { '/api/chat/keys': async (q) => listKeys(q.get('name') || '') },
  POST: { '/api/chat/keys/create': (b, req) => createKey(b, req), '/api/chat/keys/revoke': (b, req) => revokeKey(b, req) },
};

const isChatKey = (plain) => { const h = plain && plain.length <= 128 ? sha(plain) : ''; return !!h && load().keys.some((x) => x.hash === h && !x.revokedAt); };
module.exports = { isChatKey, routes, handleApi, handlePage, redactUrl, onRename, onDelete, onHubRevoke, stopAll, start: startChat, parseLines, splitAttachments, currentConv, ingestHook };
