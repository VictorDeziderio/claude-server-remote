#!/usr/bin/env node
// Smoke test of the project chat (server/chat.js): link keys (admin API), /c/<key> page and manifest,
// /chat-api/* with Bearer auth (bad key 401 + rate limit, limited key isolation, pagination of
// conversations/messages/media), send -> stream -> done, 409, stop, upload + file guard, the flags
// of a limited run and the chat-guard.js hook. Claude is a FAKE (test/fake-claude-stream.cjs) on PATH.
// Usage: node test/chat.test.mjs
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && fs.existsSync(p))
let chromium
try { ({ chromium } = await import('playwright-core')) } catch { /* not installed */ }

const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-chat-'))
const PROJ = path.join(ROOT, 'projects', 'demo')
fs.mkdirSync(PROJ, { recursive: true })
fs.mkdirSync(path.join(ROOT, 'projects', 'other'), { recursive: true })
const BIN = path.join(ROOT, 'bin')
fs.mkdirSync(BIN)
fs.copyFileSync(path.join(PANEL, 'test', 'fake-claude-stream.cjs'), path.join(BIN, 'claude'))
fs.chmodSync(path.join(BIN, 'claude'), 0o755)
const NOOP = path.join(ROOT, 'noop.sh')
fs.writeFileSync(NOOP, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
const PORT = 7000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`
const env = {
  ...process.env, PATH: BIN + path.delimiter + process.env.PATH, HOME: ROOT, PANEL_PORT: String(PORT), PANEL_BIND: '127.0.0.1',
  PANEL_LOGIN: 'admin', PANEL_PASSWORD: 'test123', PANEL_TEST_INSECURE_COOKIE: '1',
  PROJECTS_DIR: path.join(ROOT, 'projects'), PANEL_CONFIG: path.join(ROOT, '.claude', 'panel.json'),
  SESSION_SCRIPT: NOOP, BACKUP_SCRIPT: NOOP, TMUX_TMPDIR: ROOT, USAGE_API_BASE_URL: 'http://127.0.0.1:9', USAGE_POLL_INTERVAL: '600',
  PANEL_PUSH_TEST_SINK: path.join(ROOT, 'push-sink.jsonl'),
}
delete env.TMUX; delete env.TMUX_PANE; delete env.CLAUDE_CODE_OAUTH_TOKEN

// history of the demo project: 25 short conversations + one long one (120 messages) + one with media
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-')
const HIST = path.join(ROOT, '.claude', 'projects', enc(PROJ))
fs.mkdirSync(HIST, { recursive: true })
const line = (o) => JSON.stringify(o)
for (let i = 0; i < 25; i++) {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
  fs.writeFileSync(path.join(HIST, `conv${String(i).padStart(4, '0')}.jsonl`), [
    line({ type: 'user', uuid: `u${i}`, timestamp: ts, message: { role: 'user', content: `question ${i}` } }),
    line({ type: 'assistant', uuid: `a${i}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: `answer ${i}` }] } }),
  ].join('\n') + '\n')
}
{
  const L = []
  for (let i = 0; i < 60; i++) {
    const ts = new Date(Date.UTC(2025, 5, 1, 0, 0, i)).toISOString()
    L.push(line({ type: 'user', uuid: `lu${i}`, timestamp: ts, message: { role: 'user', content: `long q ${i}` } }))
    L.push(line({ type: 'assistant', uuid: `la${i}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: `long a ${i}` }] } }))
  }
  fs.writeFileSync(path.join(HIST, 'longconv01.jsonl'), L.join('\n') + '\n')
}
const IMG = path.join(PROJ, '.chat-uploads', '2025-01', 'abcd1234-photo.png')
fs.mkdirSync(path.dirname(IMG), { recursive: true })
fs.writeFileSync(IMG, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
fs.writeFileSync(path.join(PROJ, 'notes.md'), '# notes')
fs.writeFileSync(path.join(HIST, 'mediaconv1.jsonl'), [
  line({ type: 'user', uuid: 'mu1', timestamp: '2025-01-01T00:00:00Z', message: { role: 'user', content: `look at this https://example.org/page\n\nAttached files:\n- ${IMG}\n` } }),
  line({ type: 'user', uuid: 'meta', isMeta: true, timestamp: '2025-01-01T00:00:01Z', message: { role: 'user', content: 'meta line' } }),
  line({ type: 'assistant', uuid: 'ma1', timestamp: '2025-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Writing notes, see https://example.com/a.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: path.join(PROJ, 'notes.md'), content: 'x' } }] } }),
  line({ type: 'user', uuid: 'mr1', timestamp: '2025-01-01T00:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  line({ type: 'assistant', uuid: 'ma2', timestamp: '2025-01-01T00:00:04Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'false' } }] } }),
  line({ type: 'user', uuid: 'mr2', timestamp: '2025-01-01T00:00:05Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'exit 1' }] } }),
].join('\n') + '\n')

// a conversation always continued (claude --continue) grows to gigabytes: ~42 MB here, above the
// whole-file limit of server/jsonl.js, so it is read by windows
{
  const pad = 'x'.repeat(70 * 1024)
  const L = []
  for (let i = 0; i < 600; i++) {
    const ts = new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString()
    L.push(line({ type: 'user', uuid: `bu${i}`, timestamp: ts, message: { role: 'user', content: `big q ${i} ação` } }))
    L.push(line({ type: 'assistant', uuid: `ba${i}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: `big a ${i}` }, { type: 'tool_use', id: `bt${i}`, name: 'Read', input: { file_path: 'x', pad } }] } }))
  }
  fs.writeFileSync(path.join(HIST, 'bigconv0001.jsonl'), L.join('\n') + '\n')
}

// like Claude does, each .jsonl was last written when its last line was (the list is ordered by it)
for (const f of fs.readdirSync(HIST)) {
  const lines = fs.readFileSync(path.join(HIST, f), 'utf8').trim().split('\n')
  const t = new Date(JSON.parse(lines[lines.length - 1]).timestamp)
  fs.utimesSync(path.join(HIST, f), t, t)
}

const srv = spawn(process.execPath, ['server.js'], { cwd: PANEL, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
srv.stdout.on('data', (d) => { logs += d }); srv.stderr.on('data', (d) => { logs += d })
await new Promise((r) => setTimeout(r, 1500))

let fails = 0, passes = 0
const ok = (name, cond, extra = '') => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + extra)); cond ? passes++ : fails++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const H = { origin: BASE, host: `127.0.0.1:${PORT}` }
let cookie = ''
const j = async (method, url, body, headers = {}) => {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', cookie, ...H, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = null; try { data = await r.clone().json() } catch { data = await r.text() }
  return { status: r.status, data, headers: r.headers }
}
// chat API: Bearer key, NO cookie, no Origin
const c = async (key, method, url, body, headers = {}) => {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, ...headers }, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) })
  let data = null; try { data = await r.clone().json() } catch { data = await r.text() }
  return { status: r.status, data, headers: r.headers }
}
// reads an SSE stream until `done` (or timeout) -> [{event, data}]
const sse = async (key, id, timeout = 8000) => {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout)
  const evs = []
  try {
    const r = await fetch(`${BASE}/chat-api/stream?id=${id}`, { headers: { authorization: 'Bearer ' + key }, signal: ac.signal })
    let buf = ''
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString()
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block)
        if (ev) evs.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null })
      }
      if (evs.some((e) => e.event === 'done')) break
    }
  } catch { /* timeout */ } finally { clearTimeout(t); ac.abort() }
  return evs
}
const argvLog = () => { try { return fs.readFileSync(path.join(ROOT, '.fake-claude-argv.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } }

try {
  console.log(`\n== chat: servidor em ${BASE} | HOME=${ROOT}\n`)
  let r = await j('POST', '/api/login', { login: 'admin', password: 'test123' })
  cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  ok('login', r.data.ok === true)

  // ---- admin API ----
  r = await j('GET', '/api/chat/keys?name=demo'); ok('keys: empty list', r.data.ok && r.data.keys.length === 0, JSON.stringify(r.data))
  r = await fetch(BASE + '/api/chat/keys?name=demo'); ok('keys: needs the panel login', r.status === 401)
  r = await j('POST', '/api/chat/keys/create', { name: 'demo', label: 'Me', role: 'owner' }, { origin: 'http://evil.example' }); ok('keys: create from another origin -> 403', r.status === 403)
  r = await j('POST', '/api/chat/keys/create', { name: 'nope', label: 'x', role: 'owner' }); ok('keys: unknown project refused', r.data.ok === false)
  r = await j('POST', '/api/chat/keys/create', { name: 'demo', label: 'x', role: 'admin' }); ok('keys: unknown role refused', r.data.ok === false)
  r = await j('POST', '/api/chat/keys/create', { name: 'demo', label: 'Me', role: 'owner' })
  const OWNER = r.data.key
  ok('keys: create owner -> key + url', r.data.ok && /^[A-Za-z0-9_-]{43}$/.test(OWNER) && r.data.url === `http://127.0.0.1:${PORT}/remote/demo?key=${OWNER}`, JSON.stringify(r.data))
  r = await j('POST', '/api/chat/keys/create', { name: 'demo', label: 'Guest', role: 'limited' })
  const LIM = r.data.key, LIM_ID = r.data.id
  r = await j('POST', '/api/chat/keys/create', { name: 'demo', label: 'Gone', role: 'limited' })
  const GONE = r.data.key, GONE_ID = r.data.id
  r = await j('GET', '/api/chat/keys?name=demo')
  ok('keys: list has 3, no hash/key', r.data.keys.length === 3 && r.data.keys.every((k) => !('hash' in k) && !('key' in k) && k.id && k.role && k.createdAt), JSON.stringify(r.data))
  const storeTxt = fs.readFileSync(path.join(ROOT, '.claude', '.panel-chat-keys.json'), 'utf8')
  ok('keys: store keeps only hashes (no plain key), mode 0600', !storeTxt.includes(OWNER) && !storeTxt.includes(LIM) && (fs.statSync(path.join(ROOT, '.claude', '.panel-chat-keys.json')).mode & 0o777) === 0o600)
  r = await j('POST', '/api/chat/keys/revoke', { id: GONE_ID }); ok('keys: revoke', r.data.ok === true)
  r = await j('GET', '/api/chat/keys?name=demo'); ok('keys: revoked key leaves the list', r.data.keys.length === 2 && !r.data.keys.some((k) => k.id === GONE_ID))
  r = await c(GONE, 'GET', '/chat-api/me'); ok('revoked key -> 401', r.status === 401)

  // ---- auth of /chat-api ----
  r = await c(OWNER, 'GET', '/chat-api/me'); ok('me (owner)', r.status === 200 && r.data.project === 'demo' && r.data.role === 'owner' && r.data.label === 'Me', JSON.stringify(r.data))
  r = await c(LIM, 'GET', '/chat-api/me'); ok('me (limited)', r.data.role === 'limited')
  r = await fetch(BASE + '/chat-api/me', { headers: { cookie } }); ok('panel cookie alone does not open /chat-api', r.status === 401)
  {
    const ip = { 'x-forwarded-for': '10.9.9.9' }
    let last
    for (let i = 0; i < 8; i++) last = await c('wrong-key-' + i, 'GET', '/chat-api/me', undefined, ip)
    ok('bad key -> 401', last.status === 401 || last.status === 429)
    r = await c(OWNER, 'GET', '/chat-api/me', undefined, ip); ok('rate limit: after 8 bad keys even a good key waits (429)', r.status === 429, String(r.status))
    r = await c(OWNER, 'GET', '/chat-api/me'); ok('rate limit is per IP', r.status === 200)
  }

  // ---- page + manifest ----
  r = await fetch(`${BASE}/c/${OWNER}`)
  const hasChatHtml = fs.existsSync(path.join(PANEL, 'dist', 'chat.html'))
  ok('page /c/<key>: chat.html or 503 when not built', hasChatHtml ? (r.status === 200 && /text\/html/.test(r.headers.get('content-type'))) : r.status === 503, String(r.status))
  if (hasChatHtml) ok('page: no referrer (key in the URL)', r.headers.get('referrer-policy') === 'no-referrer')
  r = await fetch(`${BASE}/c/${OWNER}/manifest.webmanifest`); const man = await r.json().catch(() => null)
  ok('manifest per link', r.status === 200 && man && man.name === 'Claude · demo' && man.start_url === `/c/${OWNER}` && man.display === 'standalone', JSON.stringify(man))
  r = await fetch(`${BASE}/c/not-a-key/manifest.webmanifest`); ok('manifest with a bad key -> 404', r.status === 404)
  r = await fetch(`${BASE}/remote/demo?key=${OWNER}`); ok('page /remote/<project>?key=<key>', hasChatHtml ? r.status === 200 && r.headers.get('referrer-policy') === 'no-referrer' : r.status === 503)
  r = await fetch(`${BASE}/remote/demo/manifest.webmanifest?key=${OWNER}`); const man2 = await r.json().catch(() => null)
  ok('manifest of a /remote link starts at that link', r.status === 200 && man2 && man2.start_url === `/remote/demo?key=${OWNER}` && man2.scope === '/remote/demo', JSON.stringify(man2))
  r = await fetch(`${BASE}/remote/other/manifest.webmanifest?key=${OWNER}`); ok('manifest: key of another project -> 404', r.status === 404)

  // ---- conversations (pagination) ----
  r = await c(OWNER, 'GET', '/chat-api/conversations')
  ok('conversations: 20 + next', r.data.ok && r.data.items.length === 20 && typeof r.data.next === 'string', JSON.stringify(r.data).slice(0, 200))
  ok('conversations: newest first', r.data.items[0].id === 'conv0024' && r.data.items[0].title === 'question 24' && r.data.items[0].preview === 'answer 24' && r.data.items[0].messages === 2 && r.data.items[0].running === false, JSON.stringify(r.data.items[0]))
  const page2 = await c(OWNER, 'GET', '/chat-api/conversations?before=' + encodeURIComponent(r.data.next))
  const all = [...r.data.items, ...page2.data.items].map((x) => x.id)
  ok('conversations: page 2 = the rest, no repeats', page2.data.items.length === 8 && page2.data.next === null && new Set(all).size === 28, JSON.stringify(page2.data).slice(0, 200))
  {
    const big = all.length && [...r.data.items, ...page2.data.items].find((x) => x.id === 'bigconv0001')
    ok('big conversation (42 MB) is listed, title from its first message', big && big.title === 'big q 0 ação' && big.messages === null, JSON.stringify(big))
    let m = await c(OWNER, 'GET', '/chat-api/messages?id=bigconv0001')
    ok('big conversation: newest 50 messages, cursor in bytes', m.data.ok && m.data.items.length === 50 && m.data.items[49].text === 'big a 599' && /^o\d+$/.test(m.data.next || ''), JSON.stringify({ n: m.data.items && m.data.items.length, last: m.data.items && m.data.items[49] && m.data.items[49].text, next: m.data.next }))
    const seen = [...m.data.items].reverse()
    let pages = 1
    while (m.data.next && pages < 100) {
      m = await c(OWNER, 'GET', '/chat-api/messages?id=bigconv0001&before=' + m.data.next)
      if (!m.data.ok) break
      seen.push(...[...m.data.items].reverse()); pages++
    }
    const texts = seen.reverse().map((x) => x.text)
    const expected = Array.from({ length: 600 }, (_, i) => [`big q ${i} ação`, `big a ${i}`]).flat()
    ok('big conversation: scrolling back reaches the first message, none repeated or skipped', JSON.stringify(texts) === JSON.stringify(expected), `pages ${pages}, got ${texts.length}: ${texts.slice(0, 3)} ... ${texts.slice(-2)}`)
    const h = await j('GET', '/api/history?name=demo')
    const hb = h.data.sessions && h.data.sessions.find((x) => x.id === 'bigconv0001')
    ok('History lists the big conversation (partial counts)', hb && hb.title === 'big q 0 ação' && hb.partial === true && hb.messages > 0, JSON.stringify(hb))
  }
  r = await c(LIM, 'GET', '/chat-api/conversations'); ok('limited key sees none of the owner conversations', r.data.ok && r.data.items.length === 0, JSON.stringify(r.data).slice(0, 200))
  r = await c(LIM, 'GET', '/chat-api/messages?id=conv0001'); ok('limited key cannot read an owner conversation', r.status === 404)

  // ---- messages (pagination + parsing) ----
  r = await c(OWNER, 'GET', '/chat-api/messages?id=longconv01')
  ok('messages: newest 50 + next', r.data.items.length === 50 && r.data.next === '70' && r.data.items[49].text === 'long a 59' && r.data.items[0].text === 'long q 35', JSON.stringify(r.data).slice(0, 200))
  let r2 = await c(OWNER, 'GET', '/chat-api/messages?id=longconv01&before=' + r.data.next)
  ok('messages: older page', r2.data.items.length === 50 && r2.data.next === '20' && r2.data.items[49].text === 'long a 34')
  r2 = await c(OWNER, 'GET', '/chat-api/messages?id=longconv01&before=20'); ok('messages: last page', r2.data.items.length === 20 && r2.data.next === null)
  r = await c(OWNER, 'GET', '/chat-api/messages?id=mediaconv1')
  const [mu, ma] = r.data.items || []
  ok('messages: meta + tool_result lines folded (2 messages)', r.data.items.length === 2, JSON.stringify(r.data.items))
  ok('messages: attachments parsed out of the prompt', mu && mu.text === 'look at this https://example.org/page' && mu.attachments.length === 1 && mu.attachments[0].kind === 'image' && mu.attachments[0].name === 'photo.png', JSON.stringify(mu))
  ok('messages: tools with ok flag from tool_result', ma && ma.tools.length === 2 && ma.tools[0].name === 'Write' && ma.tools[0].ok === true && ma.tools[1].ok === false && ma.tools[1].summary === 'false', JSON.stringify(ma && ma.tools))
  r = await c(OWNER, 'GET', '/chat-api/messages?id=conv0003'); ok('messages: thinking skipped', r.data.items[1].text === 'answer 3')

  // ---- media / files / links ----
  r = await c(OWNER, 'GET', '/chat-api/media?id=mediaconv1&tab=media'); ok('media: the photo', r.data.items.length === 1 && r.data.items[0].path === IMG && r.data.items[0].kind === 'image', JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/media?id=mediaconv1&tab=files'); ok('files: the file Claude wrote', r.data.items.length === 1 && r.data.items[0].name === 'notes.md', JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/media?id=mediaconv1&tab=links'); ok('links: urls of the messages, newest first', r.data.items.map((x) => x.url).join() === 'https://example.com/a,https://example.org/page', JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/media?id=mediaconv1&tab=links&limit=1'); ok('links: paging', r.data.items.length === 1 && r.data.next === '1')

  // ---- upload + file guard ----
  r = await c(LIM, 'POST', '/chat-api/upload?name=' + encodeURIComponent('../../my photo.jpg'), Buffer.from([1, 2, 3, 4, 5]), { 'content-type': 'application/octet-stream' })
  const att = r.data.att
  ok('upload -> att inside .chat-uploads/<yyyy-mm>/ with a safe name', r.data.ok && att && att.path.startsWith(path.join(PROJ, '.chat-uploads') + path.sep) && /\/\d{4}-\d{2}\/[0-9a-f]{8}-my_photo\.jpg$/.test(att.path) && att.kind === 'image' && att.size === 5 && att.name === 'my_photo.jpg', JSON.stringify(r.data))
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(att.path)}`, { headers: { authorization: 'Bearer ' + LIM } })
  ok('file: served inline', r.status === 200 && /^inline/.test(r.headers.get('content-disposition')) && (await r.arrayBuffer()).byteLength === 5)
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(att.path)}&key=${LIM}`); ok('file: key in the query works (img tags)', r.status === 200)
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(att.path)}`, { headers: { authorization: 'Bearer ' + LIM, range: 'bytes=1-2' } })
  ok('file: byte range (video on iOS)', r.status === 206 && r.headers.get('content-range') === 'bytes 1-2/5' && (await r.arrayBuffer()).byteLength === 2)
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(path.join(PROJ, '../other/x'))}`, { headers: { authorization: 'Bearer ' + OWNER } }); ok('file: ../ refused', r.status === 403)
  r = await fetch(`${BASE}/chat-api/file?path=/etc/passwd`, { headers: { authorization: 'Bearer ' + OWNER } }); ok('file: absolute path outside refused', r.status === 403)
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-chat-out-')); fs.writeFileSync(path.join(OUT, 'secret.txt'), 'SECRET')
  fs.symlinkSync(OUT, path.join(PROJ, 'escape')); fs.symlinkSync(path.join(OUT, 'secret.txt'), path.join(PROJ, 'link.txt'))
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(path.join(PROJ, 'escape', 'secret.txt'))}`, { headers: { authorization: 'Bearer ' + OWNER } }); ok('file: symlinked folder escaping refused', r.status === 403 && !(await r.text()).includes('SECRET'))
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(path.join(PROJ, 'link.txt'))}`, { headers: { authorization: 'Bearer ' + OWNER } }); ok('file: symlinked file escaping refused', r.status === 403)
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(path.join(PROJ, 'notes.md'))}`, { headers: { authorization: 'Bearer ' + OWNER } }); ok('file: other files as attachment', r.status === 200 && /^attachment/.test(r.headers.get('content-disposition')) && /sandbox/.test(r.headers.get('content-security-policy')))

  // ---- send -> stream -> done (limited key, new conversation) ----
  r = await c(LIM, 'POST', '/chat-api/send', { id: null, text: 'hi there', attachments: ['/etc/passwd'] }); ok('send: attachment outside .chat-uploads refused', r.status === 400)
  r = await c(LIM, 'POST', '/chat-api/send', { id: null, text: 'hi there WRITE out.txt', attachments: [att.path] })
  const NEW = r.data.id
  ok('send (new) -> id', r.data.ok && /^[0-9a-f-]{36}$/.test(NEW || ''), JSON.stringify(r.data))
  let evs = await sse(LIM, NEW)
  const names = evs.map((e) => e.event)
  ok('stream: delta, tool, message, done', names.includes('delta') && names.includes('tool') && names.includes('message') && names[names.length - 1] === 'done', names.join(','))
  ok('stream: deltas build the text', evs.filter((e) => e.event === 'delta').map((e) => e.data.text).join('').startsWith('Hello from the fake Claude.'))
  ok('stream: tool event', evs.some((e) => e.event === 'tool' && e.data.name === 'Write' && e.data.summary.endsWith('out.txt')))
  ok('stream: message is a Msg', evs.some((e) => e.event === 'message' && e.data.role === 'assistant' && Array.isArray(e.data.tools) && Array.isArray(e.data.attachments)))
  {
    const a = argvLog().pop() || { argv: [] }
    const v = a.argv, at = (f) => v[v.indexOf(f) + 1]
    ok('limited run: -p stream-json --verbose, cwd = project, new --session-id', v[0] === '-p' && at('--output-format') === 'stream-json' && v.includes('--verbose') && at('--session-id') === NEW && a.cwd === PROJ, JSON.stringify(a))
    ok('limited run: --restricted + file tools only', v.includes('--restricted') && at('--tools') === 'Read,Write,Edit,Glob,Grep')
    ok('limited run: Bash/WebFetch denied, no bypass, no prompts, no MCP', /Bash/.test(at('--disallowedTools')) && /WebFetch/.test(at('--disallowedTools')) && at('--permission-mode') === 'acceptEdits' && at('--permission-prompts') === 'none' && v.includes('--strict-mcp-config') && !v.includes('--dangerously-skip-permissions'))
    let hook = null; try { hook = JSON.parse(at('--settings')) } catch { /* */ }
    const cmd = hook && hook.hooks.PreToolUse[0].hooks[0].command
    ok('limited run: PreToolUse guard hook on the project folder', !!cmd && cmd.includes('chat-guard.js') && cmd.includes(`"${PROJ}"`), String(cmd))
  }
  r = await c(LIM, 'GET', '/chat-api/conversations'); ok('limited key sees its own conversation', r.data.items.length === 1 && r.data.items[0].id === NEW && r.data.items[0].title === 'hi there WRITE out.txt', JSON.stringify(r.data))
  r = await c(LIM, 'GET', '/chat-api/messages?id=' + NEW)
  ok('messages of the new conversation (user with attachment + assistant)', r.data.items.length === 2 && r.data.items[0].attachments[0]?.path === att.path && r.data.items[1].text.startsWith('Hello'), JSON.stringify(r.data).slice(0, 300))
  r = await c(LIM, 'GET', `/chat-api/media?id=${NEW}&tab=files`); ok('files tab: the file Claude wrote in the new conversation', r.data.items.some((x) => x.name === 'out.txt'), JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/conversations'); ok('owner sees the limited conversation too', r.data.items[0].id === NEW)

  // ---- owner: resume, 409, stop ----
  const nArgv = argvLog().length
  r = await c(OWNER, 'POST', '/chat-api/send', { id: 'conv0002', text: 'SLOW please' })
  for (let i = 0; i < 40 && argvLog().length === nArgv; i++) await sleep(50) // the fake writes its argv when it starts
  ok('send (resume) -> same id', r.data.ok && r.data.id === 'conv0002', JSON.stringify(r.data))
  {
    const a = argvLog().pop() || { argv: [] }
    ok('owner run: --resume, no limited flags', a.argv[a.argv.indexOf('--resume') + 1] === 'conv0002' && !a.argv.includes('--restricted') && !a.argv.includes('--settings'), JSON.stringify(a.argv))
  }
  r = await c(OWNER, 'POST', '/chat-api/send', { id: 'conv0002', text: 'again' }); ok('second send while running -> 409', r.status === 409)
  r = await c(LIM, 'POST', '/chat-api/send', { id: 'conv0002', text: 'x' }); ok('limited key cannot send to an owner conversation', r.status === 404)
  r = await c(LIM, 'POST', '/chat-api/stop', { id: 'conv0002' }); ok('limited key cannot stop an owner run', r.status === 404)
  await sleep(700)
  r = await c(OWNER, 'GET', '/chat-api/conversations'); ok('conversations: running flag', r.data.items.find((x) => x.id === 'conv0002')?.running === true)
  const streamP = sse(OWNER, 'conv0002', 10000)
  await sleep(300)
  // a second client reconnecting gets the partial state first
  {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 1200)
    let txt = ''
    try { const rr = await fetch(`${BASE}/chat-api/stream?id=conv0002`, { headers: { authorization: 'Bearer ' + OWNER }, signal: ac.signal }); for await (const ch of rr.body) { txt += Buffer.from(ch).toString(); if (txt.includes('\n\n')) break } } catch { /* */ }
    ac.abort()
    ok('stream reconnect: starts with the text so far', /^event: delta\ndata: \{"text":"Hello/.test(txt), txt.slice(0, 120))
  }
  r = await c(OWNER, 'POST', '/chat-api/stop', { id: 'conv0002' }); ok('stop', r.data.ok === true)
  evs = await streamP
  ok('stop: stream ends with done (stopped)', evs.length && evs[evs.length - 1].event === 'done' && evs[evs.length - 1].data.stopped === true, JSON.stringify(evs.slice(-2)))
  await sleep(300)
  r = await c(OWNER, 'POST', '/chat-api/send', { id: 'conv0002', text: 'FAIL now' }); ok('send after stop works', r.data.ok)
  evs = await sse(OWNER, 'conv0002')
  ok('failed run -> error then done', evs.some((e) => e.event === 'error' && /fake failure/.test(e.data.msg)) && evs[evs.length - 1].event === 'done', JSON.stringify(evs))
  r = await c(OWNER, 'GET', '/chat-api/stream?id=conv0003'); ok('stream of an idle conversation -> done at once', /event: done/.test(r.data))
  // max 3 runs per project
  {
    const ids = []
    for (const id of ['conv0010', 'conv0011', 'conv0012']) ids.push((await c(OWNER, 'POST', '/chat-api/send', { id, text: 'SLOW' })).data.ok)
    r = await c(OWNER, 'POST', '/chat-api/send', { id: 'conv0013', text: 'SLOW' })
    ok('max 3 runs per project -> 429', ids.every(Boolean) && r.status === 429, JSON.stringify(r.data))
    for (const id of ['conv0010', 'conv0011', 'conv0012']) await c(OWNER, 'POST', '/chat-api/stop', { id })
  }

  // ---- logs never carry a key ----
  ok('no key in the panel log', !logs.includes(OWNER) && !logs.includes(LIM))
  const auditTxt = fs.readFileSync(path.join(ROOT, '.claude', 'logs', 'audit.log'), 'utf8')
  ok('audit: key actions logged without the key', /chat\.key\.create/.test(auditTxt) && /chat\.send/.test(auditTxt) && !auditTxt.includes(OWNER) && !auditTxt.includes(LIM))

  // ---- end to end: the BUILT page, served by this server, on an iPhone-sized screen ----
  if (hasChatHtml && chromium && CHROME) {
    const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
      const page = await ctx.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
      page.on('response', (r) => { if (r.status() >= 400) errors.push(r.status() + ' ' + r.url().replace(OWNER, '[key]')) })
      await page.goto(`${BASE}/remote/demo?key=${OWNER}`)
      await page.getByTestId('screen-list').waitFor({ timeout: 10000 }).catch(async (e) => { throw new Error(e.message + ' | page errors: ' + errors.join(' | ') + ' | body: ' + (await page.evaluate(() => document.body.innerText.slice(0, 300)))) })
      await page.getByTestId('conv-row').first().waitFor({ timeout: 10000 }).catch(() => {})
      ok('e2e: the link opens the conversation list', await page.getByTestId('conv-row').count() > 0)
      ok('e2e: iPhone status bar readable on the light theme (dark text bar)', await page.evaluate(() => document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').content) === 'default')
      ok('e2e: no horizontal overflow on the iPhone', await page.evaluate(() => document.documentElement.scrollWidth <= 390))
      ok('e2e: per-link manifest + apple-touch-icon', await page.evaluate(() => !!document.querySelector('link[rel="manifest"][href*="/manifest.webmanifest"]') && !!document.querySelector('link[rel="apple-touch-icon"]')))
      const icon = await fetch(BASE + '/apple-touch-icon.png'); ok('e2e: apple-touch-icon served', icon.status === 200 && /png/.test(icon.headers.get('content-type') || ''))
      await page.getByTestId('new-chat').click()
      await page.locator('textarea').fill('e2e hello')
      await page.getByTestId('send-btn').click()
      await page.locator('[data-testid="bubble"], [data-testid="bubble-live"]').filter({ hasText: /Hello from the fake Claude/ }).first().waitFor({ timeout: 15000 }).catch(async (e) => { await page.screenshot({ path: path.join(os.tmpdir(), 'chat-e2e-fail.png') }); throw new Error(e.message.split('\n')[0] + ' | ' + errors.join(' | ') + ' | ' + (await page.evaluate(() => document.body.innerText.slice(-400)))) })
      ok('e2e: send -> streamed answer of Claude shows up', true)
      await page.getByTestId('send-btn').waitFor({ timeout: 10000 })
      ok('e2e: run ends (send button back)', await page.getByTestId('stop-btn').count() === 0)
      await page.waitForTimeout(800)
      ok('e2e: the answer shows once after the run ends (not streamed copy + saved copy)', await page.getByTestId('bubble').filter({ hasText: /Hello from the fake Claude/ }).count() === 1, String(await page.getByTestId('bubble').filter({ hasText: /Hello from the fake Claude/ }).count()))
      await page.getByTestId('back-btn').click()
      await page.getByTestId('screen-list').waitFor()
      ok('e2e: the new conversation is first in the list', /e2e hello/.test(await page.getByTestId('conv-row').first().innerText()))
      ok('e2e: no errors in the page (CSP, scripts)', errors.length === 0, errors.join(' | '))
      await page.goto(`${BASE}/remote/not-this-project?key=${OWNER}`)
      await page.getByTestId('blocked').waitFor({ timeout: 10000 }).catch(() => {})
      ok('e2e: a /remote link with another project name is refused', await page.getByTestId('blocked').count() === 1)
      await page.goto(`${BASE}/c/${OWNER}`)
      await page.getByTestId('screen-list').waitFor({ timeout: 10000 }).catch(() => {})
      ok('e2e: the short /c/<key> link still works', await page.getByTestId('screen-list').count() === 1)
      if (process.env.CHAT_E2E_SHOT) await page.screenshot({ path: process.env.CHAT_E2E_SHOT })
    } finally { await browser.close() }
  }

  // ---- rename / delete of the project ----
  await sleep(500)
  r = await j('POST', '/api/rename', { name: 'demo', newName: 'demo2' }); ok('rename project', r.data.ok, JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/me'); ok('rename: key follows the project', r.data.project === 'demo2', JSON.stringify(r.data))
  r = await c(LIM, 'GET', '/chat-api/conversations'); ok('rename: limited key still sees its conversation', r.data.items.length === 1 && r.data.items[0].id === NEW, JSON.stringify(r.data).slice(0, 200))
  r = await j('GET', '/api/chat/keys?name=demo2'); ok('rename: keys listed under the new name', r.data.keys.length === 2)
  r = await j('POST', '/api/delete', { name: 'demo2' }); ok('delete project', r.data.ok, JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/me'); ok('delete: keys removed', r.status === 401)
  ok('delete: keys gone from the store', !/demo2/.test(fs.readFileSync(path.join(ROOT, '.claude', '.panel-chat-keys.json'), 'utf8')))

  // ---- chat-guard.js (the hook of the limited runs) ----
  {
    const G = path.join(PANEL, 'server', 'chat-guard.js')
    const P = path.join(ROOT, 'projects', 'other')
    fs.symlinkSync(OUT, path.join(P, 'esc'))
    const run = (ev) => spawnSync(process.execPath, [G, P], { input: JSON.stringify(ev), encoding: 'utf8' })
    ok('guard: Read inside allowed', run({ tool_name: 'Read', tool_input: { file_path: path.join(P, 'a.txt') } }).status === 0)
    ok('guard: relative Write inside allowed', run({ tool_name: 'Write', tool_input: { file_path: 'sub/new.txt' } }).status === 0)
    ok('guard: Bash denied', run({ tool_name: 'Bash', tool_input: { command: 'ls' } }).status === 2)
    ok('guard: WebFetch denied', run({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }).status === 2)
    ok('guard: an MCP tool denied', run({ tool_name: 'mcp__x__y', tool_input: {} }).status === 2)
    ok('guard: Read outside denied', run({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } }).status === 2)
    ok('guard: ../ denied', run({ tool_name: 'Edit', tool_input: { file_path: path.join(P, '..', 'x.txt') } }).status === 2)
    ok('guard: symlink escape denied', run({ tool_name: 'Read', tool_input: { file_path: path.join(P, 'esc', 'secret.txt') } }).status === 2)
    ok('guard: Grep path outside denied', run({ tool_name: 'Grep', tool_input: { pattern: 'x', path: '/root' } }).status === 2)
    ok('guard: Glob absolute pattern denied', run({ tool_name: 'Glob', tool_input: { pattern: '/etc/*' } }).status === 2)
    ok('guard: Glob relative pattern allowed', run({ tool_name: 'Glob', tool_input: { pattern: '**/*.md' } }).status === 0)
    ok('guard: Write to .claude/settings.json denied (hooks would run commands)', run({ tool_name: 'Write', tool_input: { file_path: path.join(P, '.claude', 'settings.json') } }).status === 2)
    ok('guard: Edit of .mcp.json denied', run({ tool_name: 'Edit', tool_input: { file_path: '.mcp.json' } }).status === 2)
    ok('guard: Write into .git/hooks denied', run({ tool_name: 'Write', tool_input: { file_path: '.git/hooks/pre-commit' } }).status === 2)
    ok('guard: Edit of CLAUDE.md denied', run({ tool_name: 'Edit', tool_input: { file_path: 'sub/CLAUDE.md' } }).status === 2)
    ok('guard: Read of .claude/settings.json still allowed', run({ tool_name: 'Read', tool_input: { file_path: '.claude/settings.json' } }).status === 0)
    ok('guard: invalid input denied', spawnSync(process.execPath, [G, P], { input: 'nope', encoding: 'utf8' }).status === 2)
  }
} catch (e) {
  console.log('  EXCEPTION', e); fails++
} finally {
  srv.kill()
  if (fails) console.log('\n--- server log ---\n' + logs.split('\n').slice(-20).join('\n'))
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* */ }
  console.log(`\n${passes} PASS, ${fails} FAIL${fails ? '' : ' — TUDO OK'}`)
  process.exit(fails ? 1 : 0)
}
