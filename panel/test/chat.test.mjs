#!/usr/bin/env node
// Smoke test of the project chat (server/chat.js + server/screen.js): ONE conversation per project,
// the one its terminal Claude is on, driven through that tmux session.
//  - link keys (admin API), only owner keys: "limited" ones refused / dropped from the stored file;
//  - which conversation: the newest interactive hook line (tty=1, cwd = the project folder), else
//    the newest *.jsonl; switches live (SSE `state`) when the terminal Claude moves on;
//  - messages of it (pages, big files by windows, attachments), media / files / links;
//  - live updates over SSE while the .jsonl grows;
//  - send / stop / answer / quick keys TYPED into a real tmux session (isolated socket: TMUX_TMPDIR)
//    running test/fake-tui.cjs, which logs every key it gets (never the real Claude);
//  - "Claude is not running" + start; working / asking states from the screen (recorded samples in
//    test/screens/); question detection on those samples;
//  - push: a chat device subscribed with the key gets only its project's done/asking pushes, with
//    the chat link; devbox-hook.sh puts the AskUserQuestion question in the hook line;
//  - page/manifest, upload + file guard, rename/delete, logs without keys, and the built page
//    end to end in a phone-sized Chrome.
// Usage: node test/chat.test.mjs
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && fs.existsSync(p))
let chromium
try { ({ chromium } = await import('playwright-core')) } catch { /* not installed */ }

const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEVBOX = path.resolve(PANEL, '..')
const require = createRequire(import.meta.url)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-chat-'))
const PROJ = path.join(ROOT, 'projects', 'demo')
const OTHER = path.join(ROOT, 'projects', 'other')
fs.mkdirSync(PROJ, { recursive: true })
fs.mkdirSync(OTHER, { recursive: true })
const RUN = path.join(ROOT, '.claude', 'run')
fs.mkdirSync(RUN, { recursive: true })
const HOOKS = path.join(RUN, 'hooks.jsonl')
const NOOP = path.join(ROOT, 'noop.sh')
fs.writeFileSync(NOOP, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
// session script: a tmux session (isolated socket) running the fake TUI, once the test allows it
const TUI = path.join(PANEL, 'test', 'fake-tui.cjs')
const SESSION = path.join(ROOT, 'session.sh')
fs.writeFileSync(SESSION, `#!/bin/sh
[ -f "${ROOT}/allow-sessions" ] || exit 0
[ "$1" = "--all" ] && exit 0
name="$1"; sess="claude-$(printf %s "$name" | tr -c 'A-Za-z0-9_-' '_')"
tmux has-session -t "=$sess" 2>/dev/null && exit 0
tmux new-session -d -s "$sess" -x 120 -y 40 -c "${ROOT}/projects/$name" -e "FAKE_TUI_LOG=${ROOT}/tui-$name.log" -e "FAKE_TUI_SCREEN=${ROOT}/screen-$name.txt" "${process.execPath} ${TUI}"
mkdir -p "${RUN}"; touch "${RUN}/$sess.running"
`, { mode: 0o755 })
const PORT = 7000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`
const env = {
  ...process.env, HOME: ROOT, PANEL_PORT: String(PORT), PANEL_BIND: '127.0.0.1',
  PANEL_LOGIN: 'admin', PANEL_PASSWORD: 'test123', PANEL_TEST_INSECURE_COOKIE: '1',
  PROJECTS_DIR: path.join(ROOT, 'projects'), PANEL_CONFIG: path.join(ROOT, '.claude', 'panel.json'),
  SESSION_SCRIPT: SESSION, BACKUP_SCRIPT: NOOP, TMUX_TMPDIR: ROOT, USAGE_API_BASE_URL: 'http://127.0.0.1:9', USAGE_POLL_INTERVAL: '600',
  USAGE_MONITOR: '0', AUTO_RESUME: '0', CHAT_TICK_MS: '300',
  PANEL_PUSH_TEST_SINK: path.join(ROOT, 'push-sink.jsonl'),
}
delete env.TMUX; delete env.TMUX_PANE; delete env.CLAUDE_CODE_OAUTH_TOKEN
const tmux = (...args) => spawnSync('tmux', args, { env, encoding: 'utf8' })

// ---------- history of the demo project ----------
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-')
const HIST = path.join(ROOT, '.claude', 'projects', enc(PROJ))
const HIST_OTHER = path.join(ROOT, '.claude', 'projects', enc(OTHER))
fs.mkdirSync(HIST, { recursive: true })
fs.mkdirSync(HIST_OTHER, { recursive: true })
const line = (o) => JSON.stringify(o)
const NOW = Date.now()
// the terminal conversation: 120 messages
{
  const L = []
  for (let i = 0; i < 60; i++) {
    const ts = new Date(Date.UTC(2025, 5, 1, 0, 0, i)).toISOString()
    L.push(line({ type: 'user', uuid: `lu${i}`, timestamp: ts, message: { role: 'user', content: `long q ${i}` } }))
    L.push(line({ type: 'assistant', uuid: `la${i}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: `long a ${i}` }] } }))
  }
  fs.writeFileSync(path.join(HIST, 'termconv01.jsonl'), L.join('\n') + '\n')
}
// a `claude -p` run (newer file, but not the terminal's)
fs.writeFileSync(path.join(HIST, 'headless01.jsonl'), line({ type: 'user', uuid: 'h1', timestamp: '2025-07-01T00:00:00Z', message: { role: 'user', content: 'headless run' } }) + '\n')
const IMG = path.join(PROJ, '.chat-uploads', '2025-01', 'abcd1234-photo.png')
const OLDIMG = path.join(PROJ, '.chat-uploads', '2025-01', 'ef567890-old.png')
fs.mkdirSync(path.dirname(IMG), { recursive: true })
fs.writeFileSync(IMG, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
fs.writeFileSync(OLDIMG, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
fs.writeFileSync(path.join(PROJ, 'notes.md'), '# notes')
fs.writeFileSync(path.join(HIST, 'mediaconv1.jsonl'), [
  // the chat types the attachment paths after the text (current shape)
  line({ type: 'user', uuid: 'mu1', timestamp: '2025-01-01T00:00:00Z', message: { role: 'user', content: `look at this https://example.org/page ${IMG}` } }),
  line({ type: 'user', uuid: 'meta', isMeta: true, timestamp: '2025-01-01T00:00:01Z', message: { role: 'user', content: 'meta line' } }),
  line({ type: 'assistant', uuid: 'ma1', timestamp: '2025-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Writing notes, see https://example.com/a.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: path.join(PROJ, 'notes.md'), content: 'x' } }] } }),
  line({ type: 'user', uuid: 'mr1', timestamp: '2025-01-01T00:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  line({ type: 'assistant', uuid: 'ma2', timestamp: '2025-01-01T00:00:04Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'false' } }] } }),
  line({ type: 'user', uuid: 'mr2', timestamp: '2025-01-01T00:00:05Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'exit 1' }] } }),
  // the older "Attached files:" block
  line({ type: 'user', uuid: 'mu2', timestamp: '2025-01-01T00:00:06Z', message: { role: 'user', content: `older shape\n\nAttached files:\n- ${OLDIMG}\n` } }),
].join('\n') + '\n')
// a conversation always continued grows to gigabytes: ~42 MB here, above the whole-file limit of
// server/jsonl.js, so it is read by windows
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
// mtimes: headless01 is the newest file; the terminal conversation is older
const setM = (f, ms) => fs.utimesSync(f, new Date(ms), new Date(ms))
setM(path.join(HIST, 'bigconv0001.jsonl'), NOW - 5 * 3600e3)
setM(path.join(HIST, 'mediaconv1.jsonl'), NOW - 4 * 3600e3)
setM(path.join(HIST, 'termconv01.jsonl'), NOW - 3 * 3600e3)
setM(path.join(HIST, 'headless01.jsonl'), NOW - 600e3)
// project "other": no hook lines at all -> its newest .jsonl
fs.writeFileSync(path.join(HIST_OTHER, 'otherold001.jsonl'), line({ type: 'user', uuid: 'o1', timestamp: '2025-01-01T00:00:00Z', message: { role: 'user', content: 'old one' } }) + '\n')
fs.writeFileSync(path.join(HIST_OTHER, 'othernew001.jsonl'), line({ type: 'user', uuid: 'o2', timestamp: '2025-02-01T00:00:00Z', message: { role: 'user', content: 'new one' } }) + '\n')
setM(path.join(HIST_OTHER, 'otherold001.jsonl'), NOW - 7200e3)
setM(path.join(HIST_OTHER, 'othernew001.jsonl'), NOW - 3600e3)

// hook lines already on disk when the panel starts (read at boot)
const hookLine = (o) => line({ t: Date.now(), tty: 1, cwd: PROJ, src: '', ...o })
fs.writeFileSync(HOOKS, [
  hookLine({ ev: 'SessionStart', sid: 'termconv01', t: NOW - 3 * 3600e3 }),
  hookLine({ ev: 'UserPromptSubmit', sid: 'headless01', tty: 0, t: NOW - 600e3 }),           // claude -p: not the terminal
  hookLine({ ev: 'UserPromptSubmit', sid: 'subagent001', agent: true, t: NOW - 500e3 }),     // a subagent
  hookLine({ ev: 'UserPromptSubmit', sid: 'subfolder01', cwd: path.join(PROJ, 'sub'), t: NOW - 400e3 }), // another folder
].join('\n') + '\n')
const hook = (o) => fs.appendFileSync(HOOKS, hookLine(o) + '\n')

// a key file from before: an owner key and a "limited" one (that role was removed)
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const LEGACY_OWNER = 'legacy-owner-' + 'A'.repeat(30), LEGACY_LIM = 'legacy-limited-' + 'B'.repeat(28)
fs.writeFileSync(path.join(ROOT, '.claude', '.panel-chat-keys.json'), JSON.stringify({
  keys: [
    { id: 'legacyown01', hash: sha(LEGACY_OWNER), project: 'demo', label: 'Old phone', role: 'owner', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null },
    { id: 'legacylim01', hash: sha(LEGACY_LIM), project: 'demo', label: 'Guest', role: 'limited', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null },
  ],
  convs: { demo: { x123456: 'legacylim01' } },
}), { mode: 0o600 })

const srv = spawn(process.execPath, ['server.js'], { cwd: PANEL, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
srv.stdout.on('data', (d) => { logs += d }); srv.stderr.on('data', (d) => { logs += d })
await new Promise((r) => setTimeout(r, 1500))

let fails = 0, passes = 0
const ok = (name, cond, extra = '') => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + extra)); cond ? passes++ : fails++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100) } return false }
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
// an open SSE stream of the chat: events collected in `evs` until close()
const openStream = (key) => {
  const ac = new AbortController()
  const evs = []
  const done = (async () => {
    try {
      const r = await fetch(`${BASE}/chat-api/stream`, { headers: { authorization: 'Bearer ' + key }, signal: ac.signal })
      let buf = ''
      for await (const chunk of r.body) {
        buf += Buffer.from(chunk).toString()
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block)
          if (ev) evs.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null })
        }
      }
    } catch { /* closed */ }
  })()
  return { evs, close: () => { ac.abort(); return done }, last: (name) => [...evs].reverse().find((e) => e.event === name) }
}
const tuiLog = (name = 'demo') => { try { return fs.readFileSync(path.join(ROOT, `tui-${name}.log`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).d) } catch { return [] } }
const tuiText = (name) => tuiLog(name).join('')
const showScreen = (file) => fs.writeFileSync(path.join(ROOT, 'screen-demo.txt'), file ? fs.readFileSync(path.join(PANEL, 'test', 'screens', file), 'utf8') : '')
const sinkLines = () => { try { return fs.readFileSync(env.PANEL_PUSH_TEST_SINK, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const fakeSub = (endpoint) => {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys()
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }
}
const stateOf = async (key) => (await c(key, 'GET', '/chat-api/state')).data

try {
  console.log(`\n== chat: server at ${BASE} | HOME=${ROOT}\n`)

  // ---- question detection on recorded screens (server/screen.js) ----
  {
    const S = require(path.join(PANEL, 'server', 'screen.js'))
    const scr = (f) => fs.readFileSync(path.join(PANEL, 'test', 'screens', f), 'utf8')
    let q = S.parseQuestion(scr('permission-bash.txt'))
    ok('screen: permission prompt -> question + 3 options, cursor on 1', q && q.question === 'Do you want to proceed?' && q.options.length === 3 && q.options[0].label === 'Yes' && /don't ask again/.test(q.options[1].label) && q.cursor === 1 && /rm -rf build/.test(q.detail) && /^Bash command/.test(q.detail), JSON.stringify(q))
    q = S.parseQuestion(scr('permission-boxed.txt'))
    ok('screen: boxed dialog of older versions (│ edges dropped)', q && q.question === 'Do you want to proceed?' && q.options.length === 3 && !/│/.test(JSON.stringify(q)) && /npm publish/.test(q.detail), JSON.stringify(q))
    q = S.parseQuestion(scr('ask-user-question.txt'))
    ok('screen: AskUserQuestion -> question, 4 options with descriptions, header in the detail', q && q.question === 'Which database should the app use?' && q.options.length === 4 && q.options[0].label === 'PostgreSQL' && /Relational/.test(q.options[0].desc) && q.options[1].desc === 'A single file, no server to run' && q.options[3].label === 'Chat about this' && /Database/.test(q.detail) && !q.multi, JSON.stringify(q))
    q = S.parseQuestion(scr('edit-cursor-2.txt'))
    ok('screen: edit prompt with the cursor on option 2', q && q.cursor === 2 && /make this edit/.test(q.question) && /Edit file/.test(q.detail), JSON.stringify(q))
    q = S.parseQuestion(scr('multi-select.txt'))
    ok('screen: multi-select question flagged', q && q.multi === true && q.options.length === 4, JSON.stringify(q))
    ok('screen: a numbered list in Claude\'s answer above the input box is NOT a question', S.parseQuestion(scr('idle-numbered-list.txt')) === null && !S.looksLikePrompt(scr('idle-numbered-list.txt')) && !S.isWorking(scr('idle-numbered-list.txt')))
    ok('screen: working spinner -> working, no question', S.parseQuestion(scr('working.txt')) === null && S.isWorking(scr('working.txt')))
    ok('screen: (y/n) prompt that is not a menu -> looks like a prompt, no options', S.parseQuestion(scr('unreadable-prompt.txt')) === null && S.looksLikePrompt(scr('unreadable-prompt.txt')))
    ok('screen: same question -> same sig, other question -> other sig', S.parseQuestion(scr('permission-bash.txt')).sig === S.parseQuestion(scr('permission-bash.txt')).sig && S.parseQuestion(scr('permission-bash.txt')).sig !== S.parseQuestion(scr('permission-boxed.txt')).sig)
    ok('screen: empty screen -> nothing', S.parseQuestion('') === null && !S.isWorking(''))
  }

  let r = await j('POST', '/api/login', { login: 'admin', password: 'test123' })
  cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  ok('login', r.data.ok === true)

  // ---- keys: only owner keys ----
  r = await c(LEGACY_LIM, 'GET', '/chat-api/me'); ok('a stored "limited" key no longer works (401)', r.status === 401)
  r = await c(LEGACY_OWNER, 'GET', '/chat-api/me'); ok('a stored owner key keeps working', r.status === 200 && r.data.project === 'demo' && r.data.label === 'Old phone', JSON.stringify(r.data))
  {
    const txt = fs.readFileSync(path.join(ROOT, '.claude', '.panel-chat-keys.json'), 'utf8')
    ok('the limited key and its conversation map are dropped from the file', !txt.includes('legacylim01') && !txt.includes('convs') && txt.includes('legacyown01'))
  }
  r = await j('GET', '/api/chat/keys?name=demo'); ok('keys: list shows the owner key only, no role', r.data.ok && r.data.keys.length === 1 && r.data.keys[0].id === 'legacyown01' && !('role' in r.data.keys[0]), JSON.stringify(r.data))
  r = await fetch(BASE + '/api/chat/keys?name=demo'); ok('keys: needs the panel login', r.status === 401)
  r = await j('POST', '/api/chat/keys/create', { name: 'demo', label: 'Me' }, { origin: 'http://evil.example' }); ok('keys: create from another origin -> 403', r.status === 403)
  r = await j('POST', '/api/chat/keys/create', { name: 'nope', label: 'x' }); ok('keys: unknown project refused', r.data.ok === false)
  r = await j('POST', '/api/chat/keys/create', { name: 'demo', label: 'Guest', role: 'limited' }); ok('keys: a "limited" key cannot be created any more', r.data.ok === false, JSON.stringify(r.data))
  r = await j('POST', '/api/chat/keys/create', { name: 'demo', label: 'Me' })
  const OWNER = r.data.key
  ok('keys: create -> key + /remote link', r.data.ok && /^[A-Za-z0-9_-]{43}$/.test(OWNER) && r.data.url === `http://127.0.0.1:${PORT}/remote/demo?key=${OWNER}`, JSON.stringify(r.data))
  r = await j('POST', '/api/chat/keys/create', { name: 'demo', label: 'Gone' })
  const GONE = r.data.key, GONE_ID = r.data.id
  r = await j('POST', '/api/chat/keys/create', { name: 'other', label: 'O' })
  const OTHER_KEY = r.data.key
  const storeTxt = fs.readFileSync(path.join(ROOT, '.claude', '.panel-chat-keys.json'), 'utf8')
  ok('keys: store keeps only hashes (no plain key), mode 0600', !storeTxt.includes(OWNER) && (fs.statSync(path.join(ROOT, '.claude', '.panel-chat-keys.json')).mode & 0o777) === 0o600)

  // ---- auth of /chat-api ----
  r = await c(OWNER, 'GET', '/chat-api/me'); ok('me', r.status === 200 && r.data.project === 'demo' && r.data.label === 'Me' && !('role' in r.data), JSON.stringify(r.data))
  r = await fetch(BASE + '/chat-api/me', { headers: { cookie } }); ok('panel cookie alone does not open /chat-api', r.status === 401)
  {
    const ip = { 'x-forwarded-for': '10.9.9.9' }
    let last
    for (let i = 0; i < 8; i++) last = await c('wrong-key-' + i, 'GET', '/chat-api/me', undefined, ip)
    ok('bad key -> 401', last.status === 401 || last.status === 429)
    r = await c('wrong-key-x', 'GET', '/chat-api/me', undefined, ip); ok('rate limit: after 8 bad keys the next bad key waits (429)', r.status === 429, String(r.status))
    r = await c('wrong-key-y', 'GET', '/chat-api/me'); ok('rate limit is per IP', r.status === 401, String(r.status))
    // behind a proxy that hides client IPs everyone shares one IP: bad keys must not lock the owner out
    r = await c(OWNER, 'GET', '/chat-api/me', undefined, ip); ok('rate limit: a valid key still passes from the limited IP', r.status === 200, String(r.status))
  }
  for (const gone of ['/chat-api/conversations', '/chat-api/conversations?before=x']) {
    r = await c(OWNER, 'GET', gone); ok(`no conversation list any more (${gone} -> 404)`, r.status === 404)
  }

  // ---- which conversation ----
  let st = await stateOf(OWNER)
  ok('conversation: the terminal one from the hook lines read at boot (not the newer `claude -p` file, not a subagent, not a subfolder)', st.conv === 'termconv01', JSON.stringify(st))
  ok('state: project session down -> Claude off (down)', st.claude === 'off' && st.why === 'down', JSON.stringify(st))
  r = await c(OTHER_KEY, 'GET', '/chat-api/state'); ok('no hook line for the project -> its newest .jsonl', r.data.conv === 'othernew001', JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/messages')
  ok('messages: newest 50 of THE conversation + next', r.data.conv === 'termconv01' && r.data.items.length === 50 && r.data.next === '70' && r.data.items[49].text === 'long a 59' && r.data.items[0].text === 'long q 35', JSON.stringify(r.data).slice(0, 200))
  let r2 = await c(OWNER, 'GET', '/chat-api/messages?before=' + r.data.next)
  ok('messages: older page', r2.data.items.length === 50 && r2.data.next === '20' && r2.data.items[49].text === 'long a 34')
  r2 = await c(OWNER, 'GET', '/chat-api/messages?before=20'); ok('messages: last page (thinking skipped)', r2.data.items.length === 20 && r2.data.next === null && r2.data.items[1].text === 'long a 0')

  // live: the terminal Claude moves to another conversation -> `state` with the new id
  const s1 = openStream(OWNER)
  ok('stream: starts with the state and the newest messages', await waitFor(() => s1.evs.length >= 2 && s1.evs[0].event === 'state' && s1.evs[0].data.conv === 'termconv01' && s1.evs[1].event === 'messages' && s1.evs[1].data.items.length === 20), JSON.stringify(s1.evs.slice(0, 2)).slice(0, 200))
  hook({ ev: 'UserPromptSubmit', sid: 'mediaconv1' })
  ok('switch: a new hook line (tty=1, project folder) moves THE conversation, pushed as `state`', await waitFor(() => s1.evs.some((e) => e.event === 'state' && e.data.conv === 'mediaconv1'), 8000), JSON.stringify(s1.evs.map((e) => e.data && e.data.conv)))
  hook({ ev: 'UserPromptSubmit', sid: 'headless02', tty: 0 })
  hook({ ev: 'UserPromptSubmit', sid: 'agentrun01', agent: true })
  await sleep(2600)
  ok('switch: `claude -p` / subagent hook lines do not move it', (await stateOf(OWNER)).conv === 'mediaconv1')

  // ---- messages / media of mediaconv1 ----
  r = await c(OWNER, 'GET', '/chat-api/messages')
  {
    const [mu, ma, mu2] = r.data.items || []
    ok('messages: meta + tool_result lines folded (3 messages)', r.data.items.length === 3, JSON.stringify(r.data.items))
    ok('messages: attachment paths typed after the text are parsed out', mu && mu.text === 'look at this https://example.org/page' && mu.attachments.length === 1 && mu.attachments[0].path === IMG && mu.attachments[0].kind === 'image' && mu.attachments[0].name === 'photo.png', JSON.stringify(mu))
    ok('messages: the older "Attached files:" block too', mu2 && mu2.text === 'older shape' && mu2.attachments[0]?.path === OLDIMG, JSON.stringify(mu2))
    ok('messages: tools with ok flag from tool_result', ma && ma.tools.length === 2 && ma.tools[0].name === 'Write' && ma.tools[0].ok === true && ma.tools[1].ok === false && ma.tools[1].summary === 'false', JSON.stringify(ma && ma.tools))
  }
  r = await c(OWNER, 'GET', '/chat-api/media?tab=media'); ok('media: the photos', r.data.items.length === 2 && r.data.items.map((x) => x.path).join() === [OLDIMG, IMG].join(), JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/media?tab=files'); ok('files: the file Claude wrote', r.data.items.length === 1 && r.data.items[0].name === 'notes.md', JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/media?tab=links'); ok('links: urls of the messages, newest first', r.data.items.map((x) => x.url).join() === 'https://example.com/a,https://example.org/page', JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/media?tab=links&limit=1'); ok('links: paging', r.data.items.length === 1 && r.data.next === '1')

  // back to the terminal conversation (a new session of it: no prompt sent, so not "working")
  hook({ ev: 'SessionStart', sid: 'termconv01' })
  await waitFor(async () => (await stateOf(OWNER)).conv === 'termconv01', 8000)

  // ---- Claude not running -> start ----
  r = await c(OWNER, 'POST', '/chat-api/send', { text: 'hello' }); ok('send while Claude is off -> 409 off', r.status === 409 && r.data.code === 'off', JSON.stringify(r.data))
  fs.writeFileSync(path.join(ROOT, 'allow-sessions'), '')
  r = await c(OWNER, 'POST', '/chat-api/start'); ok('start -> ok', r.data.ok === true, JSON.stringify(r.data))
  ok('start: the project session comes up with Claude (fake TUI)', await waitFor(async () => (await stateOf(OWNER)).claude === 'idle', 8000), JSON.stringify(await stateOf(OWNER)))
  ok('stream: the new state is pushed', await waitFor(() => s1.evs.some((e) => e.event === 'state' && e.data.claude === 'idle')))

  // ---- send: typed into the terminal ----
  r = await c(OWNER, 'POST', '/chat-api/send', { text: 'hello from the chat' }); ok('send -> ok', r.data.ok === true, JSON.stringify(r.data))
  ok('send: the text is typed into the tmux pane, then Enter', await waitFor(() => /hello from the chat\r/.test(tuiText('demo'))), JSON.stringify(tuiLog()))
  r = await c(OWNER, 'POST', '/chat-api/upload?name=' + encodeURIComponent('../../my photo.jpg'), Buffer.from([1, 2, 3, 4, 5]), { 'content-type': 'application/octet-stream' })
  const att = r.data.att
  ok('upload -> att inside .chat-uploads/<yyyy-mm>/ with a safe name', r.data.ok && att && att.path.startsWith(path.join(PROJ, '.chat-uploads') + path.sep) && /\/\d{4}-\d{2}\/[0-9a-f]{8}-my_photo\.jpg$/.test(att.path) && att.kind === 'image' && att.size === 5 && att.name === 'my_photo.jpg', JSON.stringify(r.data))
  r = await c(OWNER, 'POST', '/chat-api/send', { text: 'see this', attachments: [att.path] })
  ok('send with an attachment: its absolute path goes after the text', r.data.ok && await waitFor(() => tuiText('demo').includes(`see this ${att.path}\r`)), JSON.stringify(tuiLog().slice(-3)))
  r = await c(OWNER, 'POST', '/chat-api/send', { text: 'x', attachments: ['/etc/passwd'] }); ok('send: attachment outside .chat-uploads refused', r.status === 400)
  r = await c(OWNER, 'POST', '/chat-api/send', { text: '   ' }); ok('send: empty text refused', r.status === 400)
  r = await c(OWNER, 'POST', '/chat-api/send', { text: 'line one\nline two' })
  ok('send several lines: one bracketed paste (newlines inside the message), then Enter', r.data.ok && await waitFor(() => /\x1b\[200~line one[\r\n]+line two\x1b\[201~/.test(tuiText('demo')) && /\x1b\[201~\r$/.test(tuiText('demo'))), JSON.stringify(tuiLog().slice(-3)))
  {
    const before = tuiLog().length
    const [a, b] = await Promise.all([c(OWNER, 'POST', '/chat-api/send', { text: 'first at once' }), c(OWNER, 'POST', '/chat-api/send', { text: 'second at once' })])
    await waitFor(() => /second at once\r/.test(tuiLog().slice(before).join('')) && /first at once\r/.test(tuiLog().slice(before).join('')))
    const typed = tuiLog().slice(before).join('')
    ok('two sends at the same time are typed one after the other (not interleaved)', a.data.ok && b.data.ok && /^(first at once\rsecond at once\r|second at once\rfirst at once\r)$/.test(typed), JSON.stringify(typed))
  }

  // ---- live updates while the .jsonl grows ----
  {
    const F = path.join(HIST, 'termconv01.jsonl')
    const ts = new Date().toISOString()
    fs.appendFileSync(F, line({ type: 'user', uuid: 'live-u1', timestamp: ts, message: { role: 'user', content: 'hello from the chat' } }) + '\n')
    fs.appendFileSync(F, line({ type: 'assistant', uuid: 'live-a1', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } }) + '\n')
    const got = await waitFor(() => s1.evs.find((e) => e.event === 'messages' && e.data.items.some((m) => m.id === 'live-a1')), 5000)
    ok('live: new messages of the terminal conversation arrive over SSE', got && got.data.conv === 'termconv01' && got.data.items.some((m) => m.id === 'live-u1' && m.role === 'user') && got.data.items.find((m) => m.id === 'live-a1').text === 'Working on it.', JSON.stringify(got && got.data).slice(0, 300))
    fs.appendFileSync(F, line({ type: 'assistant', uuid: 'live-a2', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'lt1', name: 'Edit', input: { file_path: 'src/app.js' } }, { type: 'text', text: 'Done.' }] } }) + '\n')
    const grown = await waitFor(() => s1.evs.find((e) => e.event === 'messages' && e.data.items.some((m) => m.id === 'live-a1' && /Done\./.test(m.text))), 5000)
    ok('live: a reply that grows comes again under the same id (text + tools)', grown && grown.data.items.length === 1 && grown.data.items[0].tools.length === 1 && grown.data.items[0].text === 'Working on it.\n\nDone.', JSON.stringify(grown && grown.data).slice(0, 300))
  }

  // ---- working / stop ----
  showScreen('working.txt')
  ok('state: the spinner on screen -> working', await waitFor(() => s1.evs.some((e) => e.event === 'state' && e.data.claude === 'working')), JSON.stringify(s1.last('state')))
  {
    const before = tuiLog().length
    r = await c(OWNER, 'POST', '/chat-api/stop'); ok('stop -> ok', r.data.ok === true)
    ok('stop: sends Escape to the pane', await waitFor(() => tuiLog().slice(before).includes('\x1b')), JSON.stringify(tuiLog().slice(before)))
  }

  // ---- a question on the screen ----
  showScreen('permission-bash.txt')
  ok('state: a permission prompt on screen -> asking, with its options', await waitFor(async () => { const s = await stateOf(OWNER); return s.claude === 'asking' && s.question && s.question.options.length === 3 && s.question.question === 'Do you want to proceed?' }), JSON.stringify(await stateOf(OWNER)))
  ok('stream: the question is pushed as state', await waitFor(() => s1.evs.some((e) => e.event === 'state' && e.data.claude === 'asking' && e.data.question.options.length === 3)))
  r = await c(OWNER, 'POST', '/chat-api/send', { text: '1 sneaky' }); ok('send while Claude asks -> 409 asking (a digit would pick an option)', r.status === 409 && r.data.code === 'asking')
  {
    const q = (await stateOf(OWNER)).question
    r = await c(OWNER, 'POST', '/chat-api/answer', { n: 2, sig: 'not-the-same' }); ok('answer with another question\'s sig -> 409 changed', r.status === 409 && r.data.code === 'changed')
    r = await c(OWNER, 'POST', '/chat-api/answer', { n: 9, sig: q.sig }); ok('answer: option that does not exist -> 400', r.status === 400)
    const before = tuiLog().length
    r = await c(OWNER, 'POST', '/chat-api/answer', { n: 2, sig: q.sig })
    ok('answer option 2 (cursor on 1): Down then Enter', r.data.ok && await waitFor(() => /^\x1b(\[|O)B\r$/.test(tuiLog().slice(before).join(''))), JSON.stringify(tuiLog().slice(before)))
  }
  showScreen('edit-cursor-2.txt')
  await waitFor(async () => (await stateOf(OWNER)).question?.cursor === 2)
  {
    const q = (await stateOf(OWNER)).question
    const before = tuiLog().length
    r = await c(OWNER, 'POST', '/chat-api/answer', { n: 1, sig: q.sig })
    ok('answer option 1 (cursor on 2): Up then Enter', r.data.ok && await waitFor(() => /^\x1b(\[|O)A\r$/.test(tuiLog().slice(before).join(''))), JSON.stringify(tuiLog().slice(before)))
  }
  showScreen('unreadable-prompt.txt')
  ok('state: a prompt that is not a readable menu -> asking with the screen text, no options', await waitFor(async () => { const s = await stateOf(OWNER); return s.claude === 'asking' && s.question.options.length === 0 && /Overwrite the existing config file\? \(y\/n\)/.test(s.question.raw) }), JSON.stringify(await stateOf(OWNER)))
  {
    const before = tuiLog().length
    r = await c(OWNER, 'POST', '/chat-api/keys', { keys: ['y'] })
    ok('quick key "y" typed', r.data.ok && await waitFor(() => tuiLog().slice(before).join('') === 'y'), JSON.stringify(tuiLog().slice(before)))
    r = await c(OWNER, 'POST', '/chat-api/keys', { keys: ['Enter', 'Escape'] })
    ok('quick keys Enter + Esc', r.data.ok && await waitFor(() => tuiLog().slice(before).join('') === 'y\r\x1b'), JSON.stringify(tuiLog().slice(before)))
    r = await c(OWNER, 'POST', '/chat-api/keys', { keys: ['C-c'] }); ok('quick keys: anything outside the list refused', r.status === 400)
    r = await c(OWNER, 'POST', '/chat-api/keys', { keys: ['rm -rf /'] }); ok('quick keys: text refused', r.status === 400)
  }
  showScreen('idle-numbered-list.txt')
  await waitFor(async () => (await stateOf(OWNER)).claude !== 'asking')
  r = await c(OWNER, 'POST', '/chat-api/send', { text: 'next task' })
  ok('state: right after a send (no spinner on screen yet) -> working', r.data.ok && (await stateOf(OWNER)).claude === 'working', JSON.stringify(r.data))
  hook({ ev: 'Stop', sid: 'termconv01' })
  ok('state: idle screen (numbered list in the answer) + Stop hook -> idle', await waitFor(async () => (await stateOf(OWNER)).claude === 'idle'))

  // ---- a big conversation (read by windows) ----
  hook({ ev: 'UserPromptSubmit', sid: 'bigconv0001' })
  ok('switch to the big conversation', await waitFor(async () => (await stateOf(OWNER)).conv === 'bigconv0001', 8000))
  {
    let m = await c(OWNER, 'GET', '/chat-api/messages')
    ok('big conversation: newest 50 messages, cursor in bytes', m.data.ok && m.data.items.length === 50 && m.data.items[49].text === 'big a 599' && /^o\d+$/.test(m.data.next || ''), JSON.stringify({ n: m.data.items && m.data.items.length, next: m.data.next }))
    const seen = [...m.data.items].reverse()
    let pages = 1
    while (m.data.next && pages < 100) {
      m = await c(OWNER, 'GET', '/chat-api/messages?before=' + m.data.next)
      if (!m.data.ok) break
      seen.push(...[...m.data.items].reverse()); pages++
    }
    const texts = seen.reverse().map((x) => x.text)
    const expected = Array.from({ length: 600 }, (_, i) => [`big q ${i} ação`, `big a ${i}`]).flat()
    ok('big conversation: scrolling back reaches the first message, none repeated or skipped', JSON.stringify(texts) === JSON.stringify(expected), `pages ${pages}, got ${texts.length}`)
    ok('big conversation: title from its first message', (await stateOf(OWNER)).title === 'big q 0 ação')
    const h = await j('GET', '/api/history?name=demo')
    const hb = h.data.sessions && h.data.sessions.find((x) => x.id === 'bigconv0001')
    ok('History lists the big conversation (partial counts)', hb && hb.title === 'big q 0 ação' && hb.partial === true && hb.messages > 0, JSON.stringify(hb))
  }
  // a fresh terminal session has no file yet: it is still THE conversation (empty)
  hook({ ev: 'SessionStart', sid: 'freshsess01' })
  ok('a new session without a file yet -> empty conversation of that id', await waitFor(async () => (await stateOf(OWNER)).conv === 'freshsess01', 8000) && (await c(OWNER, 'GET', '/chat-api/messages')).data.items.length === 0)
  hook({ ev: 'SessionStart', sid: 'termconv01' })
  await waitFor(async () => (await stateOf(OWNER)).conv === 'termconv01', 8000)
  await s1.close()

  // ---- push from the chat ----
  {
    r = await c(OWNER, 'GET', '/chat-api/push'); ok('push info via the key', r.data.ok && r.data.supported && /^[A-Za-z0-9_-]{80,90}$/.test(r.data.publicKey), JSON.stringify(r.data))
    r = await c(OWNER, 'POST', '/chat-api/push/subscribe', { subscription: fakeSub('https://evil.example/x') }); ok('push: unknown push service refused', r.data.ok === false)
    r = await c(OWNER, 'POST', '/chat-api/push/subscribe', { subscription: fakeSub('https://push.test/sub/chatphone'), name: 'iPhone · Safari (app)' }); ok('push: chat device subscribed with the key', r.data.ok === true, JSON.stringify(r.data))
    r = await c(OWNER, 'POST', '/chat-api/push/status', { endpoint: 'https://push.test/sub/chatphone' }); ok('push: status -> registered', r.data.registered === true)
    r = await c(OTHER_KEY, 'POST', '/chat-api/push/status', { endpoint: 'https://push.test/sub/chatphone' }); ok('push: a key of another project does not see it', r.data.registered === false)
    r = await c(OTHER_KEY, 'POST', '/chat-api/push/unsubscribe', { endpoint: 'https://push.test/sub/chatphone' }); ok('push: nor remove it', r.status === 404)
    r = await j('POST', '/api/push/subscribe', { subscription: fakeSub('https://push.test/sub/panelphone'), name: 'panel' }); ok('push: a panel device too', r.data.ok)
    r = await j('GET', '/api/push/info')
    ok('panel lists the chat device with its project', r.data.devices.some((d) => d.endpoint.endsWith('/chatphone') && d.chat === 'demo' && /Chat · demo/.test(d.name)) && r.data.devices.some((d) => d.endpoint.endsWith('/panelphone') && !d.chat), JSON.stringify(r.data.devices))
    const before = sinkLines().length
    hook({ ev: 'UserPromptSubmit', sid: 'termconv01', src: 'user', t: Date.now() - 60000 })
    hook({ ev: 'Stop', sid: 'termconv01', msg: 'All tests pass.' })
    const got = await waitFor(() => { const s = sinkLines().slice(before); return s.length >= 2 && s }, 8000) || []
    const chatP = got.find((x) => x.endpoint.endsWith('/chatphone')), panelP = got.find((x) => x.endpoint.endsWith('/panelphone'))
    ok('push "finished": the chat device gets it, opening the chat link', chatP && chatP.payload.event === 'done' && chatP.payload.url === '/remote/demo' && chatP.payload.project === 'demo' && /tests pass/.test(chatP.payload.body), JSON.stringify(chatP && chatP.payload))
    ok('push "finished": the panel device gets its own (terminal link)', panelP && panelP.payload.url === '/terminal/demo', JSON.stringify(panelP && panelP.payload))
    const b2 = sinkLines().length
    hook({ ev: 'PreToolUse', sid: 'termconv01', tool: 'AskUserQuestion', msg: 'Which database should the app use?' })
    const asked = await waitFor(() => sinkLines().slice(b2).find((x) => x.endpoint.endsWith('/chatphone')), 8000)
    ok('push "asking" (PreToolUse AskUserQuestion): carries the question', asked && asked.payload.event === 'waiting' && asked.payload.body === 'Which database should the app use?' && /question/i.test(asked.payload.title), JSON.stringify(asked && asked.payload))
    const b3 = sinkLines().length
    fs.appendFileSync(HOOKS, line({ t: Date.now(), tty: 1, cwd: OTHER, ev: 'UserPromptSubmit', sid: 'othernew001', src: 'user' }) + '\n')
    fs.appendFileSync(HOOKS, line({ t: Date.now() + 1, tty: 1, cwd: OTHER, ev: 'PreToolUse', sid: 'othernew001', tool: 'AskUserQuestion', msg: 'other project question' }) + '\n')
    await waitFor(() => sinkLines().length > b3, 6000)
    await sleep(500)
    ok('push of another project: not sent to this chat device', !sinkLines().slice(b3).some((x) => x.endpoint.endsWith('/chatphone')) && sinkLines().slice(b3).some((x) => x.endpoint.endsWith('/panelphone')), JSON.stringify(sinkLines().slice(b3).map((x) => x.endpoint)))
    r = await c(OWNER, 'POST', '/chat-api/push/unsubscribe', { endpoint: 'https://push.test/sub/chatphone' }); ok('push: unsubscribe via the key', r.data.ok === true)
    r = await c(GONE, 'POST', '/chat-api/push/subscribe', { subscription: fakeSub('https://push.test/sub/gonephone') }); ok('push: device of a second key', r.data.ok)
    r = await j('POST', '/api/chat/keys/revoke', { id: GONE_ID }); ok('keys: revoke', r.data.ok === true)
    r = await c(GONE, 'GET', '/chat-api/me'); ok('revoked key -> 401', r.status === 401)
    r = await j('GET', '/api/push/info'); ok('revoking a key removes its push device', !r.data.devices.some((d) => d.endpoint.endsWith('/gonephone')), JSON.stringify(r.data.devices.map((d) => d.endpoint)))
  }

  // ---- devbox-hook.sh + managed settings: the question text reaches the hook line ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hook-'))
    const input = JSON.stringify({ session_id: 'abc123', cwd: PROJ, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which database?', options: [{ label: 'A' }] }] } })
    const out = spawnSync('bash', [path.join(DEVBOX, 'devbox-hook.sh'), 'PreToolUse'], { input, env: { ...process.env, DEVBOX_HOOK_DIR: dir }, encoding: 'utf8' })
    let h = null; try { h = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.jsonl'), 'utf8').trim()) } catch { /* */ }
    ok('devbox-hook.sh PreToolUse: one line with the tool and the question, prints nothing, exit 0', out.status === 0 && out.stdout === '' && h && h.ev === 'PreToolUse' && h.tool === 'AskUserQuestion' && h.msg === 'Which database?' && h.sid === 'abc123', JSON.stringify(h))
    spawnSync('bash', [path.join(DEVBOX, 'devbox-hook.sh'), 'SessionStart'], { input: JSON.stringify({ session_id: 'abc124', cwd: PROJ, source: 'startup', tool_input: 'not an object' }), env: { ...process.env, DEVBOX_HOOK_DIR: dir }, encoding: 'utf8' })
    const last = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.jsonl'), 'utf8').trim().split('\n').pop())
    ok('devbox-hook.sh SessionStart: sid + cwd recorded (odd input does not break the line)', last.ev === 'SessionStart' && last.sid === 'abc124' && last.cwd === PROJ, JSON.stringify(last))
    const ms = JSON.parse(fs.readFileSync(path.join(DEVBOX, 'managed-settings.json'), 'utf8'))
    ok('managed-settings: PreToolUse hook only for AskUserQuestion, SessionStart hook', ms.hooks.PreToolUse.length === 1 && ms.hooks.PreToolUse[0].matcher === 'AskUserQuestion' && JSON.stringify(ms.hooks.PreToolUse).includes('devbox-hook.sh PreToolUse') && JSON.stringify(ms.hooks.SessionStart).includes('devbox-hook.sh SessionStart'))
    fs.rmSync(dir, { recursive: true, force: true })
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
  if (hasChatHtml) {
    r = await fetch(`${BASE}/chat-sw.js`); ok('chat service worker served, never cached', r.status === 200 && /javascript/.test(r.headers.get('content-type')) && r.headers.get('cache-control') === 'no-store')
  }

  // ---- file guard ----
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(att.path)}`, { headers: { authorization: 'Bearer ' + OWNER } })
  ok('file: served inline', r.status === 200 && /^inline/.test(r.headers.get('content-disposition')) && (await r.arrayBuffer()).byteLength === 5)
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(att.path)}&key=${OWNER}`); ok('file: key in the query works (img tags)', r.status === 200)
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(att.path)}`, { headers: { authorization: 'Bearer ' + OWNER, range: 'bytes=1-2' } })
  ok('file: byte range (video on iOS)', r.status === 206 && r.headers.get('content-range') === 'bytes 1-2/5' && (await r.arrayBuffer()).byteLength === 2)
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(path.join(PROJ, '../other/x'))}`, { headers: { authorization: 'Bearer ' + OWNER } }); ok('file: ../ refused', r.status === 403)
  r = await fetch(`${BASE}/chat-api/file?path=/etc/passwd`, { headers: { authorization: 'Bearer ' + OWNER } }); ok('file: absolute path outside refused', r.status === 403)
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-chat-out-')); fs.writeFileSync(path.join(OUT, 'secret.txt'), 'SECRET')
  fs.symlinkSync(OUT, path.join(PROJ, 'escape')); fs.symlinkSync(path.join(OUT, 'secret.txt'), path.join(PROJ, 'link.txt'))
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(path.join(PROJ, 'escape', 'secret.txt'))}`, { headers: { authorization: 'Bearer ' + OWNER } }); ok('file: symlinked folder escaping refused', r.status === 403 && !(await r.text()).includes('SECRET'))
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(path.join(PROJ, 'link.txt'))}`, { headers: { authorization: 'Bearer ' + OWNER } }); ok('file: symlinked file escaping refused', r.status === 403)
  r = await fetch(`${BASE}/chat-api/file?path=${encodeURIComponent(path.join(PROJ, 'notes.md'))}`, { headers: { authorization: 'Bearer ' + OWNER } }); ok('file: other files as attachment', r.status === 200 && /^attachment/.test(r.headers.get('content-disposition')) && /sandbox/.test(r.headers.get('content-security-policy')))
  fs.rmSync(OUT, { recursive: true, force: true })

  // ---- end to end: the BUILT page, served by this server, on an iPhone-sized screen ----
  if (hasChatHtml && chromium && CHROME) {
    const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
      const page = await ctx.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
      page.on('response', (x) => { if (x.status() >= 400) errors.push(x.status() + ' ' + x.url().replace(OWNER, '[key]')) })
      showScreen('')
      await page.goto(`${BASE}/remote/demo?key=${OWNER}`)
      await page.getByTestId('screen-conversation').waitFor({ timeout: 10000 }).catch(async (e) => { throw new Error(e.message + ' | page errors: ' + errors.join(' | ') + ' | body: ' + (await page.evaluate(() => document.body.innerText.slice(0, 300)))) })
      await page.getByTestId('bubble').first().waitFor({ timeout: 10000 }).catch(() => {})
      ok('e2e: the link opens straight into the terminal conversation (no list)', await page.getByTestId('bubble').count() > 0 && !(await page.getByTestId('screen-list').count()) && /Done\./.test(await page.getByTestId('messages').innerText()))
      ok('e2e: status says Claude is ready', await waitFor(async () => (await page.getByTestId('claude-status').getAttribute('data-state')) === 'idle'))
      ok('e2e: iPhone status bar readable on the light theme (dark text bar)', await page.evaluate(() => document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').content) === 'default')
      ok('e2e: no horizontal overflow on the iPhone', await page.evaluate(() => document.documentElement.scrollWidth <= 390))
      ok('e2e: per-link manifest + apple-touch-icon', await page.evaluate(() => !!document.querySelector('link[rel="manifest"][href*="/manifest.webmanifest"]') && !!document.querySelector('link[rel="apple-touch-icon"]')))
      const before = tuiLog().length
      await page.locator('textarea').fill('e2e hello')
      await page.getByTestId('send-btn').click()
      ok('e2e: send types the message into the terminal', await waitFor(() => /e2e hello\r/.test(tuiLog().slice(before).join(''))), JSON.stringify(tuiLog().slice(before)))
      ok('e2e: own message shows at once (sent)', await page.getByTestId('bubble-local').filter({ hasText: 'e2e hello' }).count() === 1)
      fs.appendFileSync(path.join(HIST, 'termconv01.jsonl'), line({ type: 'user', uuid: 'e2e-u', timestamp: new Date().toISOString(), message: { role: 'user', content: 'e2e hello' } }) + '\n' + line({ type: 'assistant', uuid: 'e2e-a', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Hello from the terminal Claude.' }] } }) + '\n')
      ok('e2e: Claude\'s reply in the terminal shows up live', await page.getByText('Hello from the terminal Claude.').waitFor({ timeout: 8000 }).then(() => true).catch(() => false))
      ok('e2e: the "sent" copy is replaced by the saved message (shown once)', await waitFor(async () => (await page.getByTestId('bubble-local').count()) === 0 && (await page.getByTestId('bubble').filter({ hasText: 'e2e hello' }).count()) === 1))
      showScreen('ask-user-question.txt')
      const card = page.getByTestId('question-card')
      ok('e2e: Claude\'s question shows as a card with the options as buttons', await card.waitFor({ timeout: 8000 }).then(() => true).catch(() => false) && (await card.getByTestId('question-option').count()) === 4 && /Which database/.test(await card.innerText()))
      ok('e2e: the composer is closed while Claude asks', (await page.getByTestId('composer').getAttribute('data-mode')) === 'asking')
      const b2 = tuiLog().length
      await card.getByTestId('question-option').nth(1).click()
      ok('e2e: tapping option 2 sends Down + Enter', await waitFor(() => /^\x1b(\[|O)B\r$/.test(tuiLog().slice(b2).join(''))), JSON.stringify(tuiLog().slice(b2)))
      showScreen('working.txt')
      ok('e2e: working -> stop button', await page.getByTestId('stop-btn').waitFor({ timeout: 8000 }).then(() => true).catch(() => false) && !(await card.count()))
      const b3 = tuiLog().length
      await page.getByTestId('stop-btn').click()
      ok('e2e: stop sends Escape', await waitFor(() => tuiLog().slice(b3).includes('\x1b')))
      showScreen('')
      ok('e2e: no errors in the page (CSP, scripts)', errors.length === 0, errors.join(' | '))
      await page.goto(`${BASE}/remote/not-this-project?key=${OWNER}`)
      await page.getByTestId('blocked').waitFor({ timeout: 10000 }).catch(() => {})
      ok('e2e: a /remote link with another project name is refused', await page.getByTestId('blocked').count() === 1)
      await page.goto(`${BASE}/remote/demo`)
      await page.getByTestId('screen-conversation').waitFor({ timeout: 10000 }).catch(() => {})
      ok('e2e: the bare /remote/<project> link (a notification tap) works with the key saved on this device', await page.getByTestId('screen-conversation').count() === 1)
      await page.goto(`${BASE}/c/${OWNER}`)
      await page.getByTestId('screen-conversation').waitFor({ timeout: 10000 }).catch(() => {})
      ok('e2e: the short /c/<key> link still works', await page.getByTestId('screen-conversation').count() === 1)
    } finally { await browser.close() }
  }

  // ---- two projects must never map to the same tmux session ('.' becomes '_' in the session name) ----
  r = await j('POST', '/api/create', { name: 'dot.name' }); ok('create "dot.name"', r.data.ok, JSON.stringify(r.data))
  r = await j('POST', '/api/create', { name: 'dot_name' }); ok('create "dot_name" refused: same tmux session as "dot.name"', r.data.ok === false && /dot\.name/.test(r.data.msg) && !fs.existsSync(path.join(ROOT, 'projects', 'dot_name')), JSON.stringify(r.data))
  r = await j('POST', '/api/rename', { name: 'other', newName: 'dot_name' }); ok('rename to "dot_name" refused: same tmux session as "dot.name"', r.data.ok === false && fs.existsSync(path.join(ROOT, 'projects', 'other')), JSON.stringify(r.data))
  r = await j('POST', '/api/rename', { name: 'dot.name', newName: 'dot_name' }); ok('renaming a project to its own session name is fine', r.data.ok, JSON.stringify(r.data))
  r = await j('POST', '/api/delete', { name: 'dot_name' }); ok('delete "dot_name"', r.data.ok, JSON.stringify(r.data))

  // ---- logs never carry a key ----
  ok('no key in the panel log', !logs.includes(OWNER) && !logs.includes(LEGACY_OWNER))
  const auditTxt = fs.readFileSync(path.join(ROOT, '.claude', 'logs', 'audit.log'), 'utf8')
  ok('audit: chat actions logged without the key', /chat\.key\.create/.test(auditTxt) && /chat\.send/.test(auditTxt) && /chat\.answer/.test(auditTxt) && /chat\.start/.test(auditTxt) && !auditTxt.includes(OWNER))

  // ---- rename / delete of the project ----
  r = await c(OWNER, 'POST', '/chat-api/push/subscribe', { subscription: fakeSub('https://push.test/sub/renamephone') })
  r = await j('POST', '/api/rename', { name: 'demo', newName: 'demo2' }); ok('rename project', r.data.ok, JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/me'); ok('rename: key follows the project', r.data.project === 'demo2', JSON.stringify(r.data))
  r = await j('GET', '/api/chat/keys?name=demo2'); ok('rename: keys listed under the new name', r.data.keys.length === 2)
  r = await j('GET', '/api/push/info'); ok('rename: the chat device follows', r.data.devices.some((d) => d.endpoint.endsWith('/renamephone') && d.chat === 'demo2'), JSON.stringify(r.data.devices))
  r = await j('POST', '/api/delete', { name: 'demo2' }); ok('delete project', r.data.ok, JSON.stringify(r.data))
  r = await c(OWNER, 'GET', '/chat-api/me'); ok('delete: keys removed', r.status === 401)
  ok('delete: keys gone from the store', !/demo2/.test(fs.readFileSync(path.join(ROOT, '.claude', '.panel-chat-keys.json'), 'utf8')))
  r = await j('GET', '/api/push/info'); ok('delete: its chat devices removed', !r.data.devices.some((d) => d.chat === 'demo2'))
} catch (e) {
  console.log('  EXCEPTION', e); fails++
} finally {
  srv.kill()
  tmux('kill-server')
  if (fails) console.log('\n--- server log ---\n' + logs.split('\n').slice(-25).join('\n'))
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* */ }
  console.log(`\n${passes} PASS, ${fails} FAIL${fails ? '' : ' — ALL OK'}`)
  process.exit(fails ? 1 : 0)
}
