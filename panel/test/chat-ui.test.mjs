#!/usr/bin/env node
// Browser test of the public project chat (chat.html + src/chat/*), on the BUILT page (dist/),
// served by a tiny static server inside this test, in a real Chrome (playwright-core; CHROME_PATH or
// /usr/bin/google-chrome). The /chat-api/* calls are mocked with page.route; the live stream
// (/chat-api/stream) is passed through to the tiny server, which keeps an SSE connection open so the
// test can push `state` / `messages` events like the real server (server/chat.js) does.
// Covers: the link opens straight into THE conversation (no list, no "new chat"); the iPhone rules
// (390x844): no horizontal overflow, fields >= 16px, safe areas on header and composer, composer at
// the bottom and above a (simulated) keyboard, 44px tap targets; message paging, local echo,
// working / stop, "Claude is not running" + start, Claude's question as a card (and the raw screen
// with quick keys), the notification control in each state (off -> on, install on iPhone Safari,
// denied), info screen with the Media / Files / Links tabs and the viewer; desktop (1280x800):
// right sidebar, centered column, Enter sends / Shift+Enter new line; light and dark.
// Usage: npm run build && node test/chat-ui.test.mjs   (CHAT_SHOTS=<dir> also saves screenshots)
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(PANEL, 'dist')
const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && fs.existsSync(p))
let chromium
try { ({ chromium } = await import('playwright-core')) } catch { /* not installed */ }
if (!CHROME || !chromium || !fs.existsSync(path.join(DIST, 'chat.html'))) {
  console.log(`  SKIP chat ui test (chrome: ${CHROME || 'none'}, playwright-core: ${!!chromium}, dist/chat.html: ${fs.existsSync(path.join(DIST, 'chat.html'))})`)
  process.exit(process.env.CI ? 1 : 0)
}
const SHOTS = process.env.CHAT_SHOTS || ''
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })

// same Content-Security-Policy as the real server, so blocked blob:/inline things show up here
const CSP = /'Content-Security-Policy':\s*"([^"]+)"/.exec(fs.readFileSync(path.join(PANEL, 'server.js'), 'utf8'))?.[1] || ''
const KEY = 'test-key_' + 'A'.repeat(34)
const PNG = fs.readFileSync(path.join(PANEL, 'public', 'apple-touch-icon.png'))
const VAPID = (() => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return e.getPublicKey().toString('base64url') })()

// ---------- mock data ----------
const NOW = Date.now()
const LONG_CODE = 'const veryLongLine = "' + 'x'.repeat(220) + '"'
const mkMsg = (i) => {
  const user = i % 2 === 0
  const m = { id: `m${i}`, role: user ? 'user' : 'assistant', ts: NOW - (120 - i) * 60e3, text: user ? `Question ${i}: can you check this?` : `Answer ${i}. Here is **bold**, \`code\` and a link https://example.com/docs/${i}`, tools: [], attachments: [] }
  if (i === 119) {
    m.text = '## Summary\n\nI changed two files:\n\n- `src/app.js` — the fix\n- `README.md` — notes\n\n```js\n' + LONG_CODE + '\n```\n\n| file | lines |\n| --- | --- |\n| app.js | 12 |'
    m.tools = [{ name: 'Read', summary: 'src/app.js', ok: true }, { name: 'Edit', summary: 'src/app.js', ok: true }, { name: 'Bash', summary: 'npm test', ok: false }]
  }
  if (i === 118) {
    m.text = 'Here is the screenshot and the log'
    m.attachments = [{ path: '/projects/demo/.chat-uploads/2026-11/a-shot.png', name: 'shot.png', kind: 'image', size: 48213 }, { path: '/projects/demo/.chat-uploads/2026-11/b-error.log', name: 'error.log', kind: 'file', size: 1290 }]
  }
  return m
}
let MSGS = Array.from({ length: 120 }, (_, i) => mkMsg(i))
const MEDIA = Array.from({ length: 40 }, (_, i) => ({ path: `/projects/demo/.chat-uploads/2026-11/img-${i}.png`, name: `img-${i}.png`, kind: 'image', size: 1000 + i }))
const FILES = [{ path: '/projects/demo/src/app.js', name: 'app.js', kind: 'file', size: 5120, ts: NOW - 3600e3 }, { path: '/projects/demo/.chat-uploads/2026-11/b-error.log', name: 'error.log', kind: 'file', size: 1290, ts: NOW - 7200e3 }]
const LINKS = ['https://example.com/docs/1', { url: 'https://example.org/guide', title: 'The guide' }]
const QUESTION = {
  question: 'Which database should the app use?', detail: '☐ Database', cursor: 1, multi: false, sig: 'sig-db-1',
  options: [
    { n: 1, label: 'PostgreSQL', desc: 'Relational, runs as a server' }, { n: 2, label: 'SQLite', desc: 'A single file, no server to run' },
    { n: 3, label: 'Type something.', desc: '' }, { n: 4, label: 'Chat about this', desc: '' },
  ],
}
let STATE = { conv: 'c1', title: 'Fix the checkout page layout on small screens', claude: 'idle' }

// ---------- tiny static server + controllable SSE ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
const sse = new Set()
let sseOpened = 0
const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/chat-api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    // like the real server: the state first, then the newest messages
    res.write(ev('state', STATE) + ev('messages', { conv: STATE.conv, items: MSGS.slice(-20) }))
    sse.add(res)
    sseOpened++
    req.on('close', () => sse.delete(res))
    return
  }
  let file = path.join(DIST, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''))
  if (/^\/(c\/[^/]+|remote\/[^/]+)\/?$/.test(u.pathname)) file = path.join(DIST, 'chat.html')
  if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...(CSP ? { 'Content-Security-Policy': CSP } : {}) })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${srv.address().port}`
const emit = (event, data) => { for (const res of sse) res.write(ev(event, data)) }
const setState = (patch) => { STATE = { ...STATE, ...patch }; if (!('question' in patch) && patch.claude !== 'asking') delete STATE.question; if (patch.claude !== 'off') delete STATE.why; emit('state', STATE) }
const endStreams = () => { for (const res of sse) res.end(); sse.clear() }

let fails = 0, passes = 0
const ok = (name, cond, extra = '') => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + extra)); cond ? passes++ : fails++ }
const calls = []
let badAuth = 0
const subscribed = new Set()
const msgPage = (before, limit) => {
  const end = before ? Number(before) : MSGS.length
  const start = Math.max(0, end - limit)
  return { ok: true, conv: STATE.conv, items: MSGS.slice(start, end), next: start > 0 ? String(start) : null }
}
const page2 = (arr, before, limit) => {
  const start = before ? Number(before) : 0
  return { ok: true, conv: STATE.conv, items: arr.slice(start, start + limit), next: start + limit < arr.length ? String(start + limit) : null }
}
async function mockApi(page) {
  await page.route('**/chat-api/**', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    const p = u.pathname.replace('/chat-api/', '')
    const q = u.searchParams
    // files go in <img>/<video> src, which cannot send a header: there the key comes as ?key=
    const authOk = p === 'file' ? q.get('key') === KEY : req.headers().authorization === `Bearer ${KEY}`
    calls.push({ p, q: Object.fromEntries(q), method: req.method(), body: req.postData() })
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) })
    if (!authOk) { badAuth++; return json({ ok: false, error: 'bad key' }, 401) }
    if (p === 'stream') return route.continue()
    if (p === 'me') return json({ ok: true, project: 'demo', label: 'Phone' })
    if (p === 'state') return json({ ok: true, ...STATE })
    if (p === 'messages') return json(msgPage(q.get('before'), Number(q.get('limit')) || 50))
    if (p === 'send') {
      const b = JSON.parse(req.postData() || '{}')
      if (b.text === 'asking please') return json({ ok: false, code: 'asking', msg: 'Claude is asking something in the terminal: answer it first.' }, 409)
      if (b.text === 'revoked please') return json({ ok: false, msg: 'bad key' }, 401)
      return json({ ok: true })
    }
    if (['stop', 'answer', 'keys', 'start'].includes(p)) return json({ ok: true })
    if (p === 'upload') { await new Promise((r) => setTimeout(r, 700)); return json({ ok: true, att: { path: `/projects/demo/.chat-uploads/2026-11/z-${q.get('name')}`, name: q.get('name'), kind: 'image', size: 68 } }) }
    if (p === 'file') return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    if (p === 'media') {
      const tab = q.get('tab')
      return json(page2(tab === 'media' ? MEDIA : tab === 'files' ? FILES : LINKS, q.get('before'), Number(q.get('limit')) || 30))
    }
    if (p === 'push') return json({ ok: true, supported: true, publicKey: VAPID })
    if (p === 'push/subscribe') { subscribed.add(JSON.parse(req.postData()).subscription.endpoint); return json({ ok: true }) }
    if (p === 'push/status') return json({ ok: true, registered: subscribed.has(JSON.parse(req.postData()).endpoint) })
    if (p === 'push/unsubscribe') { subscribed.delete(JSON.parse(req.postData()).endpoint); return json({ ok: true }) }
    return json({ ok: false }, 404)
  })
}
// headless Chrome has no push service: a fake PushManager (the page code above it is the real one)
const FAKE_PUSH = () => {
  const fake = { endpoint: 'https://push.test/sub/ui', options: {}, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'x', auth: 'y' } } }, async unsubscribe() { window.__sub = null; return true } }
  PushManager.prototype.getSubscription = async function () { return window.__sub || null }
  PushManager.prototype.subscribe = async function () { window.__sub = fake; return fake }
}
const DENIED = () => { Object.defineProperty(Notification, 'permission', { get: () => 'denied' }) }

// ---------- page checks ----------
const noOverflow = (page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth
  const wide = [...document.querySelectorAll('#root *')].filter((e) => {
    const r = e.getBoundingClientRect()
    if (!r.width || getComputedStyle(e).position === 'fixed') return false
    // inside a horizontal scroller (code block, table, chips row) is fine
    for (let p = e.parentElement; p && p.id !== 'root'; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return false }
    return r.right > w + 1 || r.left < -1
  }).map((e) => e.tagName + '.' + String(e.className).slice(0, 40))
  return { ok: document.documentElement.scrollWidth <= w && document.body.scrollWidth <= w && !wide.length, wide: wide.slice(0, 5), sw: document.documentElement.scrollWidth, w }
})
const smallFields = (page) => page.evaluate(() => [...document.querySelectorAll('input:not([type=file]), textarea, select')].filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.outerHTML.slice(0, 80)))
// a CSS rule that applies to the element pads it with env(safe-area-inset-<side>)
const safeArea = (page, sel, side) => page.evaluate(([sel, side]) => {
  const el = document.querySelector(sel)
  if (!el) return false
  const rules = []
  const walk = (list) => { for (const r of list) { if (r.cssRules && !r.selectorText) walk(r.cssRules); else if (r.selectorText) rules.push(r) } }
  for (const s of document.styleSheets) { try { walk(s.cssRules) } catch { /* cross-origin */ } }
  return rules.some((r) => { try { return el.matches(r.selectorText) && r.style.cssText.includes(`safe-area-inset-${side}`) } catch { return false } })
}, [sel, side])
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll('#root button, #root a[href]')].filter((e) => {
  const r = e.getBoundingClientRect()
  if (!r.width || e.closest('.md') || e.closest('[data-testid="attach-chip"]')) return false
  return r.height < 43.5 && !e.closest('[data-testid="tool-chip"]') && e.dataset.testid !== 'tool-chip'
}).map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).slice(0, 30) + ' ' + Math.round(e.getBoundingClientRect().height)))
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }) }
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)) } return false }
const lastCall = (p) => [...calls].reverse().find((c) => c.p === p)

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'en-US' }
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
try {
  // ================= phone (390x844), light =================
  const ctx = await browser.newContext({ ...iphone, colorScheme: 'light' })
  ctx.setDefaultTimeout(8000)
  await ctx.grantPermissions(['notifications'], { origin: BASE })
  await ctx.addInitScript(FAKE_PUSH)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
  await mockApi(page)
  await page.goto(`${BASE}/remote/demo?key=${KEY}`)
  const bubbles = page.locator('[data-testid="bubble"]')
  await bubbles.first().waitFor({ timeout: 10000 })

  // ---- head / PWA bits
  const head = await page.evaluate(() => ({
    vp: document.querySelector('meta[name=viewport]')?.content || '',
    capable: document.querySelector('meta[name=apple-mobile-web-app-capable]')?.content,
    bar: document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]')?.content,
    icon: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href'),
    manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'),
    title: document.title,
    appTitle: document.querySelector('meta[name=apple-mobile-web-app-title]')?.content,
  }))
  ok('viewport-fit=cover', head.vp.includes('viewport-fit=cover'), head.vp)
  ok('apple-mobile-web-app-capable + readable status bar on light (default = dark text)', head.capable === 'yes' && head.bar === 'default', JSON.stringify(head))
  ok('apple-touch-icon is a PNG that exists', /\.png$/.test(head.icon || '') && (await page.request.get(BASE + head.icon)).ok(), head.icon)
  ok('per-link manifest of the /remote link', head.manifest === `/remote/demo/manifest.webmanifest?key=${KEY}`, head.manifest)
  ok('home-screen title = project, tab title "Claude · <project>"', head.appTitle === 'demo' && head.title === 'Claude · demo', JSON.stringify(head))
  ok('every call sends the key as Bearer (no 401 seen)', badAuth === 0 && calls.length > 0, String(badAuth))
  ok('the page does not use the panel layout / terminal / editor code', !(await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /(TerminalPage|CodeEditor|xterm|Layout)-/.test(e.name)))))
  const jsKb = await page.evaluate(() => Math.round(performance.getEntriesByType('resource').filter((e) => /\.js$/.test(e.name)).reduce((s, e) => s + (e.decodedBodySize || 0), 0) / 1024))
  ok(`chat JavaScript stays small (${jsKb} KB < 420 KB)`, jsKb > 0 && jsKb < 420, String(jsKb))

  // ---- straight into THE conversation
  ok('opens straight into the conversation: no list, no "new chat", no back button', await page.getByTestId('screen-conversation').isVisible() && !(await page.getByTestId('screen-list').count()) && !(await page.getByTestId('new-chat').count()) && !(await page.getByTestId('conv-row').count()) && !(await page.getByTestId('back-btn').count()))
  ok('no conversation list is ever asked for', !calls.some((c) => c.p === 'conversations'))
  ok('newest 50 messages', (await bubbles.count()) === 50, String(await bubbles.count()))
  ok('the live stream opens', await waitFor(() => sse.size === 1))
  ok('header: project name + Claude status (ready)', /demo/.test(await page.getByTestId('conv-title').innerText()) && (await page.getByTestId('claude-status').getAttribute('data-state')) === 'idle')
  ok('phone: no sidebar', !(await page.getByTestId('sidebar').count()))
  const msgBox = page.getByTestId('messages')
  ok('starts scrolled to the bottom', await waitFor(() => msgBox.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 5)))
  const vp = page.viewportSize()
  let cb = await page.getByTestId('composer').boundingBox()
  ok('composer sits at the bottom of the screen', cb && Math.abs(cb.y + cb.height - vp.height) <= 1, JSON.stringify(cb))
  ok('composer pads the bottom safe area', await safeArea(page, '[data-testid="composer"]', 'bottom'))
  ok('header pads the top safe area', await safeArea(page, '[data-testid="conv-header"]', 'top'))
  ok('app column pads the side safe areas', await safeArea(page, '.chat-app', 'left') && await safeArea(page, '.chat-app', 'right'))
  ok('page itself does not scroll (only the messages)', await page.evaluate(() => getComputedStyle(document.body).overflow === 'hidden' && getComputedStyle(document.documentElement).overscrollBehaviorY === 'none'))
  const small = await smallFields(page)
  ok('every input/textarea is >= 16px (no iOS zoom)', !small.length, small.join(' | '))
  let o = await noOverflow(page)
  ok('conversation: no horizontal overflow at 390px (long code scrolls inside its block)', o.ok, JSON.stringify(o))
  ok('markdown: heading, list, code block and table render', await page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid="bubble"]')].pop(); return !!(b.querySelector('[role=heading]') && b.querySelector('ul li') && b.querySelector('pre code') && b.querySelector('table')) }))
  ok('markdown: links are real anchors opening a new tab', await page.locator('[data-testid="bubble"] a[href^="https://example.com/docs/"][target="_blank"]').count() > 0)
  const chip = bubbles.last().getByTestId('tool-chip')
  ok('tool calls show as one collapsed chip', (await chip.count()) === 1 && (await chip.getAttribute('aria-expanded')) === 'false')
  await chip.click()
  ok('tapping the chip lists the tools', await bubbles.last().getByText('npm test').isVisible())
  let st = await smallTargets(page)
  ok('conversation: tap targets >= 44px', !st.length, st.join(', '))
  ok('notification bell: off (permission not asked yet)', await waitFor(async () => (await page.getByTestId('notify-btn').getAttribute('data-state')) === 'off'))
  await shot(page, 'phone-conversation-light')

  // tap an image in a message -> viewer
  await bubbles.nth(48).getByTestId('thumb').click()
  const viewer = page.getByTestId('viewer')
  ok('tapping an image opens the full-screen viewer', await viewer.locator('img').waitFor({ timeout: 5000 }).then(() => true).catch(() => false))
  ok('viewer image loads from /chat-api/file with ?key=', /^\/chat-api\/file\?path=.*&key=/.test(await viewer.locator('img').getAttribute('src') || '') && await viewer.locator('img').evaluate((i) => i.complete && i.naturalWidth > 0))
  await page.waitForTimeout(250)
  await shot(page, 'phone-viewer-light')
  await page.keyboard.press('Escape')
  ok('Escape closes the viewer', await viewer.waitFor({ state: 'detached', timeout: 3000 }).then(() => true).catch(() => false))

  // scroll up -> older messages, without jumping
  const firstId = await bubbles.first().evaluate((e) => e.querySelector('div').textContent)
  await msgBox.evaluate((el) => { el.scrollTop = 0 })
  ok('scroll-up loads 50 older messages', await waitFor(async () => (await bubbles.count()) === 100), String(await bubbles.count()))
  const stillThere = await page.evaluate((txt) => {
    const el = [...document.querySelectorAll('[data-testid="bubble"]')].find((b) => b.querySelector('div').textContent === txt)
    const box = document.querySelector('[data-testid="messages"]').getBoundingClientRect()
    const r = el?.getBoundingClientRect()
    return !!r && r.bottom > box.top && r.top < box.bottom
  }, firstId)
  ok('the message that was on top stays on screen (no jump)', stillThere)
  ok('"jump to bottom" shows when scrolled up', await page.getByTestId('jump-bottom').isVisible())
  await msgBox.evaluate((el) => { el.scrollTop = 0 })
  ok('and the last 20 (120 total)', await waitFor(async () => (await bubbles.count()) === 120), String(await bubbles.count()))
  await page.getByTestId('jump-bottom').click()
  ok('"jump to bottom" goes to the end', await waitFor(() => msgBox.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 5)))

  // ---- attachment + send: typed into the terminal by the server; the echo until it is saved
  await page.getByTestId('attach-btn').click()
  ok('attach menu: camera / photos / files', (await page.getByTestId('attach-menu').getByRole('menuitem').count()) === 3)
  await page.keyboard.press('Escape')
  await page.getByTestId('file-photos').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG })
  const ac = page.getByTestId('attach-chip')
  ok('attachment chip appears while uploading (with progress)', await ac.waitFor({ timeout: 3000 }).then(async () => (await ac.getAttribute('data-status')) === 'up').catch(() => false))
  await shot(page, 'phone-composer-upload-light')
  ok('send waits for the upload', await page.getByTestId('send-btn').isDisabled())
  ok('chip turns ready when the upload ends', await waitFor(async () => (await ac.getAttribute('data-status')) === 'ok'))
  await page.getByRole('textbox').fill('Please look at this photo')
  await page.getByRole('textbox').press('Enter') // phone: Enter is a new line, not send
  ok('phone: Enter adds a line instead of sending', !calls.some((c) => c.p === 'send') && /\n$/.test(await page.getByRole('textbox').inputValue()))
  await page.getByRole('textbox').fill('Please look at this photo')
  await page.getByTestId('send-btn').click()
  ok('send posts text + attachment paths (no conversation id: there is only one)', await waitFor(() => { const c = lastCall('send'); if (!c) return false; const b = JSON.parse(c.body); return b.text === 'Please look at this photo' && /z-photo\.png$/.test(b.attachments[0]) && !('id' in b) }), lastCall('send')?.body)
  ok('the chip is cleared after sending', await waitFor(async () => (await ac.count()) === 0))
  const local = page.getByTestId('bubble-local')
  ok('own message shows at once, marked "sent"', await local.filter({ hasText: 'Please look at this photo' }).isVisible() && /sent/i.test(await local.innerText()))
  // the server sees Claude start: working
  setState({ claude: 'working' })
  ok('working: status + working bubble', await waitFor(async () => (await page.getByTestId('claude-status').getAttribute('data-state')) === 'working' && await page.getByTestId('working').isVisible()))
  ok('working: stop button replaces send while the box is empty', await page.getByTestId('stop-btn').isVisible() && !(await page.getByTestId('send-btn').count()))
  await page.getByRole('textbox').fill('one more thing')
  ok('working: typing brings the send button back (Claude queues the message)', await page.getByTestId('send-btn').isVisible() && (await page.getByTestId('composer').getAttribute('data-mode')) === 'working')
  await page.getByRole('textbox').fill('')
  await shot(page, 'phone-working-light')
  await page.getByTestId('stop-btn').click()
  ok('stop calls /chat-api/stop', await waitFor(() => !!lastCall('stop')))
  // the saved message arrives on the stream: the echo is replaced
  const saved = { id: 'u-saved', role: 'user', ts: Date.now(), text: 'Please look at this photo', tools: [], attachments: [{ path: '/projects/demo/.chat-uploads/2026-11/z-photo.png', name: 'photo.png', kind: 'image', size: 68 }] }
  const reply = { id: 'a-saved', role: 'assistant', ts: Date.now(), text: 'It shows the app icon.', tools: [{ name: 'Read', summary: 'z-photo.png', ok: true }], attachments: [] }
  MSGS = [...MSGS, saved, reply]
  emit('messages', { conv: 'c1', items: [saved, reply] })
  setState({ claude: 'idle' })
  ok('the "sent" copy is replaced by the saved message (shown once)', await waitFor(async () => (await local.count()) === 0 && (await bubbles.filter({ hasText: 'Please look at this photo' }).count()) === 1))
  ok('Claude\'s reply shows live, working bubble gone', await waitFor(async () => await page.getByText('It shows the app icon.').isVisible() && !(await page.getByTestId('working').count())))
  ok('follows the bottom when new messages arrive', await waitFor(() => msgBox.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 5)))
  // a send refused by the server: the echo goes away and the notice says why
  await page.getByRole('textbox').fill('asking please')
  await page.getByTestId('send-btn').click()
  const toastSays = async (re) => waitFor(async () => (await page.getByTestId('toast').allTextContents()).some((x) => re.test(x)))
  ok('409: the server message is shown, no echo left', await toastSays(/answer it first/i) && !(await local.count()))

  // ---- Claude asks: a card with the options as buttons
  setState({ claude: 'asking', question: QUESTION })
  const card = page.getByTestId('question-card')
  ok('question card with the question, the header and 4 options', await card.waitFor({ timeout: 5000 }).then(() => true).catch(() => false) && (await card.getByTestId('question-option').count()) === 4 && (await card.getByTestId('question-text').innerText()) === QUESTION.question && /Database/.test(await card.getByTestId('question-detail').innerText()))
  ok('option descriptions shown', /single file/.test(await card.getByTestId('question-option').nth(1).innerText()))
  await page.getByRole('textbox').fill('a draft')
  ok('composer closed while Claude asks (send off, the draft can still be typed)', (await page.getByTestId('composer').getAttribute('data-mode')) === 'asking' && await page.getByTestId('send-btn').isDisabled() && /answer/i.test(await page.getByRole('textbox').getAttribute('placeholder')))
  await page.getByRole('textbox').fill('')
  ok('status says Claude is asking', (await page.getByTestId('claude-status').getAttribute('data-state')) === 'asking')
  o = await noOverflow(page)
  ok('question card: no horizontal overflow', o.ok, JSON.stringify(o))
  st = await smallTargets(page)
  ok('question card: tap targets >= 44px', !st.length, st.join(', '))
  await shot(page, 'phone-question-light')
  await card.getByTestId('question-option').nth(1).click()
  ok('tapping option 2 answers n=2 with the question sig', await waitFor(() => { const c = lastCall('answer'); return c && JSON.parse(c.body).n === 2 && JSON.parse(c.body).sig === 'sig-db-1' }), lastCall('answer')?.body)
  await card.getByTestId('quick-key').filter({ hasText: /esc/i }).click()
  ok('a parsed card still has Esc (cancel)', await waitFor(() => { const c = lastCall('keys'); return c && JSON.parse(c.body).keys[0] === 'Escape' }))
  // a prompt the parser cannot read: the screen text + quick keys
  setState({ claude: 'asking', question: { raw: 'Overwrite the existing config file? (y/n)', options: [] } })
  ok('unreadable prompt: the screen text + quick keys (y/n, 1/2/3, Enter, Esc)', await waitFor(async () => (await card.getAttribute('data-parsed')) === '0') && /Overwrite the existing/.test(await card.getByTestId('question-screen').innerText()) && JSON.stringify(await card.getByTestId('quick-key').evaluateAll((l) => l.map((e) => e.dataset.key))) === JSON.stringify(['y', 'n', '1', '2', '3', 'Up', 'Down', 'Enter', 'Escape']))
  await shot(page, 'phone-question-raw-light')
  await card.locator('[data-testid="quick-key"][data-key="y"]').click()
  ok('quick key "y" sent', await waitFor(() => { const c = lastCall('keys'); return c && JSON.parse(c.body).keys[0] === 'y' }))
  st = await smallTargets(page)
  ok('raw card: tap targets >= 44px', !st.length, st.join(', '))

  // ---- Claude not running: the card + start
  setState({ claude: 'off', why: 'down' })
  ok('not running: off card with a start button, composer closed', await page.getByTestId('off-card').waitFor({ timeout: 5000 }).then(() => true).catch(() => false) && !(await card.count()) && (await page.getByTestId('composer').getAttribute('data-mode')) === 'off')
  await shot(page, 'phone-off-light')
  await page.getByTestId('start-btn').click()
  ok('start calls /chat-api/start', await waitFor(() => !!lastCall('start')))
  setState({ claude: 'idle' })
  ok('after start: card gone, composer open', await waitFor(async () => !(await page.getByTestId('off-card').count()) && (await page.getByTestId('composer').getAttribute('data-mode')) === 'ready'))

  // ---- the terminal Claude moves to another conversation (/clear): reloads
  {
    const n = calls.filter((c) => c.p === 'messages').length
    MSGS = [{ id: 'n1', role: 'user', ts: Date.now(), text: 'A fresh start', tools: [], attachments: [] }]
    setState({ conv: 'c2', title: 'A fresh start' })
    ok('conversation switch: reloads the messages of the new one', await waitFor(async () => calls.filter((c) => c.p === 'messages').length > n && (await bubbles.count()) === 1 && await bubbles.first().getByText('A fresh start').isVisible()))
  }
  // back from the background: reconnect
  {
    const opened = sseOpened
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    ok('coming back to the app reconnects the stream', await waitFor(() => sseOpened > opened && sse.size === 1))
  }

  // ---- simulated keyboard: the visible area shrinks -> composer stays above it
  await page.getByRole('textbox').focus()
  await page.setViewportSize({ width: 390, height: 500 })
  await page.waitForTimeout(250)
  cb = await page.getByTestId('composer').boundingBox()
  ok('with the keyboard open the composer sits right above it', cb && Math.abs(cb.y + cb.height - 500) <= 1, JSON.stringify(cb))
  ok('keyboard open: bottom safe-area padding is dropped', await page.evaluate(() => document.documentElement.dataset.kb === '1' && getComputedStyle(document.querySelector('[data-testid="composer"]')).paddingBottom === '0px'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  // iOS: the layout viewport keeps its height, only the visible area (--app-h) shrinks. A toast
  // must stay inside the visible app box, not behind the keyboard.
  await page.evaluate(() => { document.documentElement.style.setProperty('--app-h', '400px'); window.dispatchEvent(new CustomEvent('chat-toast', { detail: 'kb toast' })) })
  {
    const tb = await page.getByTestId('toast').filter({ hasText: 'kb toast' }).boundingBox().catch(() => null)
    const app = await page.locator('.chat-app').boundingBox()
    ok('toast sits inside the visible app box when the keyboard shrinks it', tb && app && app.height <= 401 && tb.y >= app.y && tb.y + tb.height <= app.y + app.height, JSON.stringify({ tb, app }))
  }
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.waitForTimeout(100)

  // ---- info screen (#/info)
  MSGS = Array.from({ length: 120 }, (_, i) => mkMsg(i))
  await page.getByTestId('info-btn').click()
  await page.getByTestId('screen-info').waitFor({ timeout: 5000 })
  ok('info button opens the info screen (#/info)', page.url().endsWith('#/info'))
  ok('info shows the project and the conversation title', (await page.getByTestId('info-title').textContent()) === 'demo' && /fresh start/.test(await page.getByTestId('info-conv').textContent()))
  ok('info: notifications section, off, with the "turn on" button', (await page.getByTestId('notify-section').getAttribute('data-state')) === 'off' && await page.getByTestId('notify-toggle').isVisible())
  const grid = page.getByTestId('media-grid')
  await grid.waitFor({ timeout: 5000 })
  ok('Media: 3-column grid', (await grid.evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)) === 3)
  const items = page.getByTestId('media-item')
  ok('Media: first 30 items', (await items.count()) === 30, String(await items.count()))
  ok('Media: thumbnails load', await waitFor(async () => (await grid.locator('img').count()) >= 6))
  o = await noOverflow(page)
  ok('info: no horizontal overflow', o.ok, JSON.stringify(o))
  await shot(page, 'phone-info-light')
  // turn notifications on from the info screen (permission granted, fake push service)
  await page.getByTestId('notify-toggle').click()
  ok('turn on: subscribes this device through /chat-api/push/subscribe', await waitFor(() => !!lastCall('push/subscribe')) && /push\.test\/sub\/ui/.test(lastCall('push/subscribe').body))
  ok('turn on: section and bell say "on"', await waitFor(async () => (await page.getByTestId('notify-section').getAttribute('data-state')) === 'on' && (await page.getByTestId('notify-btn').getAttribute('data-state')) === 'on'))
  await shot(page, 'phone-info-notify-on-light')
  await page.locator('[data-testid="screen-info"] .chat-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight })
  ok('Media: more on scroll (40)', await waitFor(async () => (await items.count()) === 40), String(await items.count()))
  await items.first().click()
  ok('Media: tap opens the viewer', await viewer.locator('img').waitFor({ timeout: 5000 }).then(() => true).catch(() => false))
  await viewer.getByRole('button', { name: /close/i }).click()
  await page.getByTestId('tab-files').click()
  ok('Files tab lists the files', await waitFor(async () => (await page.getByTestId('screen-info').getByTestId('file-row').count()) === 2))
  await page.getByTestId('tab-links').click()
  const links = page.getByTestId('link-row')
  ok('Links tab lists the links (string or {url,title})', await waitFor(async () => (await links.count()) === 2) && (await links.nth(1).getAttribute('href')) === 'https://example.org/guide' && await page.getByText('The guide').isVisible())
  await shot(page, 'phone-info-links-light')
  st = await smallTargets(page)
  ok('info: tap targets >= 44px', !st.length, st.join(', '))
  await page.getByTestId('info-back').click()
  ok('back from info returns to the conversation (kept loaded)', await waitFor(async () => !page.url().includes('#/info') && await page.getByTestId('screen-conversation').isVisible() && (await bubbles.count()) >= 1))
  await page.getByTestId('notify-btn').click()
  ok('bell when on: explains (opens info), does not unsubscribe', await waitFor(() => page.url().endsWith('#/info')) && !lastCall('push/unsubscribe'))
  await page.getByTestId('notify-toggle').click()
  ok('turn off from the info screen', await waitFor(async () => !!lastCall('push/unsubscribe') && (await page.getByTestId('notify-section').getAttribute('data-state')) === 'off'))
  await page.getByTestId('info-back').click()
  await page.getByTestId('notify-btn').click()
  ok('bell when off: one tap turns them on', await waitFor(async () => (await page.getByTestId('notify-btn').getAttribute('data-state')) === 'on'))

  // revoked while in use: the "link no longer valid" screen
  await page.getByRole('textbox').fill('revoked please')
  await page.getByTestId('send-btn').click()
  ok('401 while using it: "link no longer valid" screen', await page.getByTestId('blocked').waitFor({ timeout: 5000 }).then(() => true).catch(() => false))
  ok('no page errors', !errors.length, errors.join(' | '))
  endStreams()
  await ctx.close()

  // ================= iPhone Safari (not installed), dark =================
  STATE = { conv: 'c1', title: 'Fix the checkout page layout on small screens', claude: 'working' }
  MSGS = Array.from({ length: 120 }, (_, i) => mkMsg(i))
  const dctx = await browser.newContext({ ...iphone, colorScheme: 'dark', userAgent: IPHONE_UA })
  dctx.setDefaultTimeout(8000)
  const dp = await dctx.newPage()
  await mockApi(dp)
  await dp.goto(`${BASE}/c/${KEY}`)
  await dp.locator('[data-testid="bubble"]').first().waitFor({ timeout: 10000 })
  ok('dark: follows the system', await dp.evaluate(() => document.documentElement.classList.contains('dark')))
  ok('dark: status bar is translucent over the dark header', await dp.evaluate(() => document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]').content) === 'black-translucent')
  ok('the short /c/<key> link opens the same conversation', await dp.getByTestId('screen-conversation').isVisible())
  ok('iPhone Safari (not on the Home Screen): bell in the "install" state', await waitFor(async () => (await dp.getByTestId('notify-btn').getAttribute('data-state')) === 'install'))
  await dp.waitForTimeout(300)
  await shot(dp, 'phone-working-dark')
  await dp.getByTestId('notify-btn').click()
  ok('bell in "install": opens the info screen with the Home Screen steps', await dp.getByTestId('notify-hint').waitFor({ timeout: 5000 }).then(() => true).catch(() => false) && /Home Screen/.test(await dp.getByTestId('notify-hint').innerText()) && !(await dp.getByTestId('notify-toggle').count()))
  await dp.getByTestId('media-grid').waitFor()
  await waitFor(async () => (await dp.locator('[data-testid="media-grid"] img').count()) >= 6)
  await shot(dp, 'phone-info-install-dark')
  await dp.getByTestId('info-back').click()
  setState({ claude: 'asking', question: QUESTION })
  await dp.getByTestId('question-card').waitFor()
  await dp.waitForTimeout(200)
  await shot(dp, 'phone-question-dark')
  setState({ claude: 'off', why: 'shell' })
  await dp.getByTestId('off-card').waitFor()
  await shot(dp, 'phone-off-dark')
  endStreams()
  await dctx.close()

  // ================= desktop (1280x800) =================
  STATE = { conv: 'c1', title: 'Fix the checkout page layout on small screens', claude: 'idle' }
  const wctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' })
  wctx.setDefaultTimeout(8000)
  await wctx.addInitScript(DENIED)
  const wp = await wctx.newPage()
  await mockApi(wp)
  await wp.goto(`${BASE}/remote/demo?key=${KEY}`)
  await wp.locator('[data-testid="bubble"]').first().waitFor({ timeout: 10000 })
  const side = await wp.getByTestId('sidebar').boundingBox().catch(() => null)
  ok('desktop: info as a right sidebar', side && Math.abs(side.x + side.width - 1280) <= 1 && side.width >= 340 && side.width <= 400 && side.height >= 790, JSON.stringify(side))
  ok('desktop: no info button (the sidebar is always there)', !(await wp.getByTestId('info-btn').count()))
  const main = await wp.locator('main').boundingBox()
  const colB = await wp.getByTestId('messages-column').boundingBox()
  ok('desktop: messages column <= 820px, centered in the conversation area', colB && colB.width <= 821 && Math.abs((colB.x - main.x) - (main.x + main.width - colB.x - colB.width)) <= 2, JSON.stringify({ main, colB }))
  ok('desktop: sidebar shows the media of the conversation', await wp.getByTestId('info-sidebar').getByTestId('media-grid').waitFor({ timeout: 5000 }).then(() => true).catch(() => false))
  ok('desktop: notifications blocked -> "denied" with the settings hint', await waitFor(async () => (await wp.getByTestId('notify-section').getAttribute('data-state')) === 'denied') && /settings/i.test(await wp.getByTestId('notify-hint').innerText()))
  o = await noOverflow(wp)
  ok('desktop: no horizontal overflow', o.ok, JSON.stringify(o))
  await wp.getByRole('textbox').fill('first line')
  await wp.getByRole('textbox').press('Shift+Enter')
  await wp.getByRole('textbox').pressSequentially('second line')
  ok('desktop: Shift+Enter makes a new line', (await wp.getByRole('textbox').inputValue()) === 'first line\nsecond line' && !calls.some((c) => c.p === 'send' && /second line/.test(c.body || '')))
  await wp.getByRole('textbox').press('Enter')
  ok('desktop: Enter sends', await waitFor(() => calls.some((c) => c.p === 'send' && JSON.parse(c.body).text === 'first line\nsecond line')))
  await wp.waitForTimeout(300)
  await shot(wp, 'desktop-light')
  setState({ claude: 'asking', question: QUESTION })
  await wp.getByTestId('question-card').waitFor()
  const cardB = await wp.getByTestId('question-card').boundingBox()
  ok('desktop: the question card stays in the centered column', cardB && cardB.width <= 821 && cardB.x >= main.x, JSON.stringify(cardB))
  await wp.getByTestId('question-option').first().hover()
  await wp.waitForTimeout(150)
  await shot(wp, 'desktop-question-light')
  endStreams()
  await wctx.close()

  const ddk = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
  STATE = { conv: 'c1', title: 'Fix the checkout page layout on small screens', claude: 'working' }
  const dk = await ddk.newPage()
  await mockApi(dk)
  await dk.goto(`${BASE}/remote/demo?key=${KEY}`)
  await dk.locator('[data-testid="bubble"]').first().waitFor({ timeout: 10000 })
  await dk.getByTestId('media-grid').waitFor()
  await dk.waitForTimeout(400)
  await shot(dk, 'desktop-dark')
  endStreams()
  await ddk.close()

  // ================= bad key =================
  const bctx = await browser.newContext({ ...iphone })
  const bp = await bctx.newPage()
  await mockApi(bp)
  await bp.goto(`${BASE}/c/not-a-valid-key`)
  ok('revoked/invalid key: clear message, no conversation', await bp.getByTestId('blocked').waitFor({ timeout: 5000 }).then(() => true).catch(() => false) && !(await bp.getByTestId('screen-conversation').count()))
  await shot(bp, 'invalid-light')
  await bctx.close()
} catch (e) {
  ok('chat ui test ran to the end', false, e.stack || e.message)
} finally {
  await browser.close()
  endStreams()
  srv.closeAllConnections?.()
  srv.close()
}
console.log(`${passes} PASS, ${fails} FAIL${fails ? '' : ' — ALL OK'}`)
process.exit(fails ? 1 : 0)
