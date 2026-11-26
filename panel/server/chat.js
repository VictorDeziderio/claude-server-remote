'use strict';
/*
 * Project chat behind a public link + key (/c/<key>, API at /chat-api/*).
 *
 * Keys: 32 random bytes (base64url), stored ONLY as sha256 + metadata in CHAT_KEYS_FILE (0600).
 *  - owner: full power on the project (Claude runs like in the panel);
 *  - limited: only sees the conversations it started; Claude runs with --restricted, file tools
 *    only, and the chat-guard.js PreToolUse hook refuses any path outside the project.
 * Conversations are the Claude *.jsonl of the project (same source as server/history.js). Each
 * message runs `claude -p --output-format stream-json --verbose --include-partial-messages`
 * (stdin = prompt; --session-id <new uuid> or --resume <id>), cwd = project, never the tmux terminal.
 *
 * Notes on the contract (spec: chat link), small additions only:
 *  - GET /chat-api/file also accepts the key as ?key=<key> (an <img>/<video> tag cannot send the
 *    Authorization header). Other routes take the Bearer header only.
 *  - /chat-api/stream on (re)connect first replays the current turn: every `message` already
 *    finished in this run, then one `delta` with the text streamed so far. Not running -> `done` at once.
 *    `done` carries {id, stopped?}.
 *  - cursors are opaque strings (conversations: "<updatedAt>|<id>", messages/media: an index).
 *  - 429 {ok:false} for the per-IP bad-key limit and for "3 runs per project" on send.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const cfg = require('./config');
const { tr } = require('./i18n');
const { readJson, sendJson, validName, clampInt, log, TMUX_STRIP_ENV } = require('./util');
const { audit } = require('./audit');
const auth = require('./auth');
const files = require('./files');
const jsonl = require('./jsonl');

const KEYS_FILE = cfg.CHAT_KEYS_FILE;
const MAX_RUNS_PER_PROJECT = 3;
const CLAUDE_BIN = process.env.CHAT_CLAUDE_BIN || 'claude';
const GUARD = path.join(__dirname, 'chat-guard.js');
const UPLOAD_DIR = files.UPLOAD_DIR;
const projectDir = (name) => path.join(cfg.PROJECTS_DIR, name);
const histDir = (name) => require('./history').dirOf(name);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(id);

// ---------------------------------------------------------------- key store
// { keys: [{id, hash, project, label, role, createdAt, lastUsedAt, revokedAt}], convs: {project: {convId: keyId}} }
let store = null;
function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch { store = null; }
  if (!store || !Array.isArray(store.keys)) store = { keys: [], convs: {} };
  if (!store.convs || typeof store.convs !== 'object') store.convs = {};
  return store;
}
function save() {
  try {
    fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
    const tmp = KEYS_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, KEYS_FILE);
  } catch (e) { log('error', 'chat keys: could not save', { err: e.message }); }
}
const pub = (k) => ({ id: k.id, label: k.label, role: k.role, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null });

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
  const role = b.role === 'owner' ? 'owner' : b.role === 'limited' ? 'limited' : null;
  if (!role) return { ok: false, msg: tr('srv.badParams') };
  const label = String(b.label || '').trim().slice(0, 60) || (role === 'owner' ? 'owner' : 'guest');
  const key = crypto.randomBytes(32).toString('base64url');
  const rec = { id: crypto.randomBytes(6).toString('hex'), hash: sha(key), project: name, label, role, createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null };
  load().keys.push(rec);
  save();
  audit('chat.key.create', { ip: auth.clientIp(req), name, id: rec.id, role });
  return { ok: true, id: rec.id, key, url: `${linkBase(req)}/remote/${encodeURIComponent(name)}?key=${key}` };
}
function revokeKey(b, req) {
  const k = load().keys.find((x) => x.id === (b && b.id) && !x.revokedAt);
  if (!k) return { ok: false, msg: tr('srv.notFound') };
  k.revokedAt = new Date().toISOString();
  save();
  for (const r of runs.values()) if (r.keyId === k.id) stopRun(r);
  audit('chat.key.revoke', { ip: auth.clientIp(req), name: k.project, id: k.id });
  return { ok: true };
}
// project renamed / deleted (server/projects.js): keys follow / are removed
function onRename(oldName, newName) {
  const s = load();
  for (const r of runs.values()) if (r.project === oldName) stopRun(r);
  for (const k of s.keys) if (k.project === oldName) k.project = newName;
  if (s.convs[oldName]) { s.convs[newName] = s.convs[oldName]; delete s.convs[oldName]; }
  save();
}
function onDelete(name) {
  const s = load();
  for (const r of runs.values()) if (r.project === name) stopRun(r);
  s.keys = s.keys.filter((k) => k.project !== name);
  delete s.convs[name];
  save();
}

// ---------------------------------------------------------------- auth of /chat-api
const limiter = auth.makeLimiter();
const bearerOf = (req, u) => {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (m) return m[1];
  return u && u.pathname === '/chat-api/file' ? (u.searchParams.get('key') || '') : '';
};
// -> {key} | {status, msg}
function keyFor(req, plain) {
  const ip = auth.clientIp(req);
  const wait = limiter.limited(ip);
  if (wait) return { status: 429, msg: tr('srv.tooManyTries', { s: wait }) };
  const h = plain && plain.length <= 128 ? sha(plain) : '';
  const k = h && load().keys.find((x) => x.hash === h && !x.revokedAt);
  if (!k || !fs.existsSync(projectDir(k.project))) { limiter.fail(ip); return { status: 401, msg: tr('srv.notAuthed') }; }
  // lastUsedAt written at most once a minute (no disk write per request)
  if (!k.lastUsedAt || Date.now() - Date.parse(k.lastUsedAt) > 60000) { k.lastUsedAt = new Date().toISOString(); save(); }
  return { key: k };
}
const ownerOf = (project, convId) => (load().convs[project] || {})[convId] || null;
// can this key see the conversation?
const canSee = (k, convId) => k.role === 'owner' || ownerOf(k.project, convId) === k.id;
function claimConv(k, convId) {
  const s = load();
  (s.convs[k.project] = s.convs[k.project] || {})[convId] = k.id;
  save();
}

// never log a key: /c/<key>... and ?key= are masked
const redactUrl = (u) => String(u || '').replace(/\/c\/[^/?#]+/g, '/c/[key]').replace(/([?&]key=)[^&#]*/g, '$1[key]');

// ---------------------------------------------------------------- reading the conversations
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
// splits "text\n\nAttached files:\n- /a\n- /b" -> {text, paths}
function splitAttachments(text) {
  const m = ATT_RE.exec(text || '');
  if (!m) return { text: text || '', paths: [] };
  return { text: text.slice(0, m.index), paths: m[1].split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean) };
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

// parses a .jsonl into Msg[] (+ title, updatedAt, written files)
function parseLines(entries, fallbackTs) {
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
      const { text, paths } = splitAttachments(raw);
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

// small cache: file -> {mtimeMs, size, parsed}
const cache = new Map();
// -> { id, title, updatedAt, msgs, big, start } (big: only the newest window was read; start = its
// first byte, the cursor of the older messages)
async function readConv(project, id) {
  const file = path.join(histDir(project), id + '.jsonl');
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  if (!st.isFile()) return null;
  const c = cache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.parsed;
  const fallback = new Date(st.mtimeMs).toISOString();
  let parsed;
  try {
    if (st.size <= jsonl.BIG) parsed = { id, ...parseLines(await jsonl.all(file), fallback), big: false, start: 0 };
    else {
      const w = await jsonl.windowBefore(file, st.size);
      const tail = parseLines(w.lines, fallback);
      parsed = { id, title: jsonl.pickTitle(parseLines(await jsonl.head(file, st.size), fallback).names, tail.names), updatedAt: tail.updatedAt, msgs: tail.msgs, big: true, start: w.start, size: st.size };
    }
  } catch { return null; }
  cache.delete(file);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return parsed;
}
// messages of a big conversation that end before byte `end` (older pages): one window, newest last
async function olderOf(project, id, end) {
  const file = path.join(histDir(project), id + '.jsonl');
  let st; try { st = await fsp.stat(file); } catch { return null; }
  const w = await jsonl.windowBefore(file, st.size, end);
  return { msgs: parseLines(w.lines, '').msgs, start: w.start };
}

// newest first by the .jsonl modification time (a stat per file); only the conversations of the
// requested page are parsed, so a project with hundreds of long conversations still answers fast
async function listConversations(k, q) {
  const limit = clampInt(q.get('limit'), 1, 100, 20);
  const before = q.get('before') || '';
  const dir = histDir(k.project);
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { /* no history yet */ }
  const cands = [];
  for (const f of names) {
    const id = f.slice(0, -6);
    if (!validId(id) || !canSee(k, id)) continue;
    let st; try { st = await fsp.stat(path.join(dir, f)); } catch { continue; }
    const run = runs.get(id);
    const t = new Date(Math.max(st.mtimeMs, run ? Date.parse(run.startedAt) : 0)).toISOString();
    cands.push({ id, t });
  }
  for (const r of runs.values()) if (r.project === k.project && canSee(k, r.id) && !cands.some((c) => c.id === r.id)) cands.push({ id: r.id, t: r.startedAt });
  const keyOf = (c) => `${c.t}|${c.id}`;
  cands.sort((a, b) => (keyOf(a) < keyOf(b) ? 1 : keyOf(a) > keyOf(b) ? -1 : 0));
  const rest = before ? cands.filter((c) => keyOf(c) < before) : cands;
  const items = [];
  let i = 0;
  for (; i < rest.length && items.length < limit; i++) {
    const { id, t } = rest[i];
    const c = await readConv(k.project, id);
    const run = runs.get(id);
    const msgs = c ? c.msgs : [];
    if (!msgs.length && !run) continue; // empty / meta-only conversation
    const last = msgs[msgs.length - 1];
    items.push({
      id,
      title: (c && c.title) || (run && clip(run.prompt.replace(/\s+/g, ' '), 120)) || tr('srv.untitled'),
      preview: last ? clip((last.text || (last.tools[0] ? last.tools[0].name : '')).replace(/\s+/g, ' ').trim(), 140) : '',
      updatedAt: t,
      messages: c && c.big ? null : msgs.length,
      running: !!run,
    });
  }
  return { ok: true, items, next: i < rest.length ? keyOf(rest[i - 1]) : null };
}

// pages of a list ordered oldest -> newest, read from the END: before = index (exclusive)
function pageFromEnd(list, q, def) {
  const limit = clampInt(q.get('limit'), 1, 200, def);
  const end = q.get('before') ? clampInt(q.get('before'), 0, list.length, list.length) : list.length;
  const start = Math.max(0, end - limit);
  return { items: list.slice(start, end), next: start > 0 ? String(start) : null };
}
async function listMessages(k, q) {
  const id = q.get('id') || '';
  if (!validId(id) || !canSee(k, id)) return { status: 404, ok: false, msg: tr('srv.convNotFound') };
  const c = await readConv(k.project, id);
  if (!c && !runs.has(id)) return { status: 404, ok: false, msg: tr('srv.convNotFound') };
  if (!c || !c.big) {
    const p = pageFromEnd(c ? c.msgs : [], q, 50);
    return { ok: true, items: p.items.map(cleanMsg), next: p.next };
  }
  // big file: the page ends at a byte offset; messages before it come from one more window
  const limit = clampInt(q.get('limit'), 1, 200, 50);
  const before = /^o\d+$/.test(q.get('before') || '') ? Number(q.get('before').slice(1)) : null;
  let msgs = c.msgs, start = c.start;
  if (before != null) {
    const w = await olderOf(k.project, id, before);
    if (!w) return { status: 404, ok: false, msg: tr('srv.convNotFound') };
    msgs = w.msgs.filter((m) => m._off < before); start = w.start;
  }
  const page = msgs.slice(-limit);
  const from = page.length ? page[0]._off : start;
  return { ok: true, items: page.map(cleanMsg), next: from > 0 ? 'o' + from : null };
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;:!?]/g;
async function listMedia(k, q) {
  const id = q.get('id') || '';
  const tab = q.get('tab') || 'media';
  if (!['media', 'files', 'links'].includes(tab)) return { status: 400, ok: false, msg: tr('srv.badParams') };
  if (!validId(id) || !canSee(k, id)) return { status: 404, ok: false, msg: tr('srv.convNotFound') };
  const c = await readConv(k.project, id);
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
  return { ok: true, items: p.items.reverse(), next: p.next };
}

// ---------------------------------------------------------------- runs
const runs = new Map(); // convId -> run
function runEnv() {
  const env = { ...process.env };
  for (const k of TMUX_STRIP_ENV) delete env[k];
  return env;
}
// argv of one run (exported for the test of the limited role)
function claudeArgs({ id, isNew, role, dir }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  args.push(...(isNew ? ['--session-id', id] : ['--resume', id]));
  if (role !== 'owner') {
    const hook = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `"${process.execPath}" "${GUARD}" "${dir}"` }] }] } };
    args.push(
      '--restricted',                                  // no Bash/code tools/WebFetch, file tools confined, no bypass
      '--tools', 'Read,Write,Edit,Glob,Grep',           // the only built-in tools that exist in this run
      '--disallowedTools', 'Bash,WebFetch,WebSearch,NotebookEdit,Task',
      '--permission-mode', 'acceptEdits',               // overrides the managed bypassPermissions default
      '--permission-prompts', 'none',                   // anything that would ask is denied
      '--strict-mcp-config',                            // no MCP servers
      '--settings', JSON.stringify(hook),               // chat-guard.js: paths outside the project refused
      '--append-system-prompt', `You are answering through a limited chat link: only the file tools work, and only inside ${dir}.`,
    );
  }
  return args;
}
function emit(run, event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of run.clients) { try { res.write(chunk); } catch { /* client gone */ } }
}
function stopRun(run) {
  if (!run || run.stopped) return;
  run.stopped = true;
  try { process.kill(-run.proc.pid, 'SIGTERM'); } catch { try { run.proc.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-run.proc.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
}
function stopAll() { for (const r of runs.values()) stopRun(r); }

function startRun(k, id, isNew, prompt) {
  const dir = projectDir(k.project);
  const proc = spawn(CLAUDE_BIN, claudeArgs({ id, isNew, role: k.role, dir }), { cwd: dir, env: runEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const run = { id, project: k.project, keyId: k.id, proc, prompt, partial: '', turn: [], clients: new Set(), startedAt: new Date().toISOString(), stopped: false, errored: false, stderr: '' };
  runs.set(id, run);
  proc.stdin.on('error', () => {});
  proc.stdin.end(prompt);
  proc.stderr.on('data', (d) => { run.stderr = (run.stderr + d).slice(-2000); });
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let o; try { o = JSON.parse(line); } catch { return; }
    if (!o || typeof o !== 'object') return;
    if (o.type === 'stream_event' && o.event) {
      const e = o.event;
      if (e.type === 'message_start') run.partial = '';
      else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) {
        run.partial += e.delta.text;
        emit(run, 'delta', { text: e.delta.text });
      }
    } else if (o.type === 'assistant' && o.message) {
      const p = assistantParts(o.message.content);
      for (const t of p.tools) emit(run, 'tool', { name: t.name, summary: t.summary });
      if (p.text || p.tools.length) {
        const msg = { id: o.uuid || (o.message.id || 'm') + '-' + run.turn.length, role: 'assistant', ts: new Date().toISOString(), text: p.text, tools: p.tools.map((t) => ({ name: t.name, summary: t.summary, ok: true })), attachments: [] };
        run.turn.push(msg);
        emit(run, 'message', msg);
      }
      run.partial = '';
    } else if (o.type === 'result' && o.is_error) {
      run.errored = true;
      emit(run, 'error', { msg: clip(String(o.result || o.subtype || 'error'), 500) });
    }
  });
  proc.on('error', (e) => { run.errored = true; emit(run, 'error', { msg: e.message }); });
  proc.on('close', (code) => {
    if (code && !run.errored && !run.stopped) emit(run, 'error', { msg: clip(run.stderr.trim() || `claude exited with code ${code}`, 500) });
    emit(run, 'done', run.stopped ? { id, stopped: true } : { id });
    for (const res of run.clients) { try { res.end(); } catch { /* */ } }
    runs.delete(id);
  });
  return run;
}

async function send(k, b) {
  const text = typeof b.text === 'string' ? b.text : '';
  const atts = Array.isArray(b.attachments) ? b.attachments.slice(0, 20) : [];
  if (!text.trim() && !atts.length) return { status: 400, ok: false, msg: tr('srv.badParams') };
  if (text.length > 100000) return { status: 400, ok: false, msg: tr('srv.contentTooBig') };
  const dir = projectDir(k.project);
  const upBase = path.join(dir, UPLOAD_DIR);
  const paths = [];
  for (const a of atts) {
    const p = typeof a === 'string' ? a : a && a.path;
    if (typeof p !== 'string' || !path.isAbsolute(p) || files.confine(upBase, path.resolve(p)).err || !fs.existsSync(p)) return { status: 400, ok: false, msg: tr('srv.badPath') };
    paths.push(path.resolve(p));
  }
  let id = b.id || null, isNew = false;
  if (id) {
    if (!validId(id) || !canSee(k, id) || (!runs.has(id) && !(await readConv(k.project, id)))) return { status: 404, ok: false, msg: tr('srv.convNotFound') };
    if (runs.has(id)) return { status: 409, ok: false, msg: tr('srv.chatBusy') };
  } else {
    id = crypto.randomUUID(); isNew = true;
  }
  if ([...runs.values()].filter((r) => r.project === k.project).length >= MAX_RUNS_PER_PROJECT) return { status: 429, ok: false, msg: tr('srv.chatTooMany', { n: MAX_RUNS_PER_PROJECT }) };
  if (isNew && k.role !== 'owner') claimConv(k, id);
  const prompt = text + (paths.length ? `${text ? '\n\n' : ''}Attached files:\n${paths.map((p) => '- ' + p).join('\n')}\n` : '');
  startRun(k, id, isNew, prompt);
  audit('chat.send', { name: k.project, keyId: k.id, role: k.role, id, textLen: text.length, files: paths.length });
  return { ok: true, id };
}

function stream(k, q, req, res) {
  const id = q.get('id') || '';
  if (!validId(id) || !canSee(k, id)) return sendJson(res, 404, { ok: false, msg: tr('srv.convNotFound') });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const run = runs.get(id);
  if (!run) { res.write(`event: done\ndata: ${JSON.stringify({ id })}\n\n`); return res.end(); }
  for (const m of run.turn) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
  if (run.partial) res.write(`event: delta\ndata: ${JSON.stringify({ text: run.partial })}\n\n`);
  run.clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 15000);
  req.on('close', () => { clearInterval(ping); run.clients.delete(res); });
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
  // single byte range (iOS plays video only with Range support)
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : Math.max(0, st.size - parseInt(m[2], 10));
    let end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

// ---------------------------------------------------------------- HTTP entry points
// /chat-api/* (no panel cookie; Bearer key)
async function handleApi(req, res, u) {
  const url = u.pathname;
  const a = keyFor(req, bearerOf(req, u));
  if (!a.key) return sendJson(res, a.status, { ok: false, msg: a.msg });
  const k = a.key;
  const q = u.searchParams;
  const reply = (r) => { const { status, ...body } = r; return sendJson(res, status || 200, body); };
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url === '/chat-api/me') return reply({ ok: true, project: k.project, label: k.label, role: k.role });
    if (url === '/chat-api/conversations') return reply(await listConversations(k, q));
    if (url === '/chat-api/messages') return reply(await listMessages(k, q));
    if (url === '/chat-api/media') return reply(await listMedia(k, q));
    if (url === '/chat-api/stream') return stream(k, q, req, res);
    if (url === '/chat-api/file') return serveFile(k, q, req, res);
    return sendJson(res, 404, { ok: false, msg: tr('srv.unknownRoute') });
  }
  if (req.method === 'POST') {
    if (url === '/chat-api/upload') return reply(await upload(k, q, req));
    const b = await readJson(req);
    if (!b) return sendJson(res, 400, { ok: false, msg: tr('srv.badBody') });
    if (url === '/chat-api/send') return reply(await send(k, b));
    if (url === '/chat-api/stop') {
      const run = runs.get(b.id);
      if (!run || run.project !== k.project || !canSee(k, b.id)) return reply({ status: 404, ok: false, msg: tr('srv.chatNotRunning') });
      stopRun(run);
      return reply({ ok: true });
    }
    return sendJson(res, 404, { ok: false, msg: tr('srv.unknownRoute') });
  }
  return sendJson(res, 405, { ok: false, msg: 'method not allowed' });
}

// chat page: /c/<key> or /remote/<project>?key=<key>, and the manifest of each link
// (/c/<key>/manifest.webmanifest, /remote/<project>/manifest.webmanifest?key=<key>)
function manifestOf(req, res, plain, project, start, scope) {
  const a = keyFor(req, plain);
  if (!a.key || (project && a.key.project !== project)) { res.writeHead(a.status === 429 ? 429 : 404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  const body = JSON.stringify({
    name: `Claude · ${a.key.project}`, short_name: a.key.project, start_url: start, scope,
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
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const routes = {
  GET: { '/api/chat/keys': async (q) => listKeys(q.get('name') || '') },
  POST: { '/api/chat/keys/create': (b, req) => createKey(b, req), '/api/chat/keys/revoke': (b, req) => revokeKey(b, req) },
};

module.exports = { routes, handleApi, handlePage, redactUrl, onRename, onDelete, stopAll, claudeArgs, parseLines, splitAttachments };
