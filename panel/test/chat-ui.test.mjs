#!/usr/bin/env node
// Browser test of the public project chat (chat.html + src/chat/*), on the BUILT page (dist/),
// served by a tiny static server inside this test, in a real Chrome (playwright-core; CHROME_PATH or
// /usr/bin/google-chrome). The /chat-api/* calls are mocked with page.route; the live reply stream
// (/chat-api/stream) is passed through to the tiny server, which keeps an SSE connection open so the
// test can push delta / tool / message / done events one by one.
// Covers the iPhone rules (390x844): no horizontal overflow, fields >= 16px, safe areas on header
// and composer, composer at the bottom and above a (simulated) keyboard, 44px tap targets; plus
// paging (list 20 by 20, older messages on scroll-up), streaming + stop, attachments, info tabs and
// the image viewer; the desktop column; light and dark.
// Usage: npm run build && node test/chat-ui.test.mjs   (CHAT_SHOTS=<dir> also saves screenshots)
import http from 'node:http'
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

// ---------- tiny static server + controllable SSE ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
const sse = new Set()
let sseOpened = 0
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/chat-api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write(': open\n\n')
    sse.add(res)
    sseOpened++
    req.on('close', () => sse.delete(res))
    return
  }
  let file = path.join(DIST, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''))
  if (/^\/c\/[^/]+\/?$/.test(u.pathname)) file = path.join(DIST, 'chat.html')
  if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...(CSP ? { 'Content-Security-Policy': CSP } : {}) })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${srv.address().port}`
// like the real server, a finished run is in the saved conversation: the messages of the run are
// saved under OTHER ids (the server folds the parts of one reply into one message)
const SAVED = {}
let runMsgs = []
const save = (id, msgs) => { SAVED[id] = [...(SAVED[id] || []), ...msgs.map((m) => ({ ...m, id: 'saved-' + m.id }))] }
const push = (event, data) => {
  if (event === 'message') runMsgs.push(data)
  if (event === 'done') { save(data.id, runMsgs); runMsgs = [] }
  for (const res of sse) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
const endStreams = () => { for (const res of sse) res.end(); sse.clear() }

// ---------- mock data ----------
const NOW = Date.now()
const CONVS = Array.from({ length: 45 }, (_, i) => ({
  id: `c${i + 1}`,
  title: i === 0 ? 'Fix the checkout page layout on small screens' : `Conversation number ${i + 1}`,
  preview: i === 0 ? 'Done: the totals no longer wrap and the button stays visible.' : `Last message of conversation ${i + 1}`,
  updatedAt: NOW - i * 3 * 3600e3,
  messages: 120 - i,
  running: i === 1,
}))
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
const MSGS = Array.from({ length: 120 }, (_, i) => mkMsg(i))
const MEDIA = Array.from({ length: 40 }, (_, i) => ({ path: `/projects/demo/.chat-uploads/2026-11/img-${i}.png`, name: `img-${i}.png`, kind: 'image', size: 1000 + i }))
const FILES = [{ path: '/projects/demo/src/app.js', name: 'app.js', kind: 'file', size: 5120, ts: NOW - 3600e3 }, { path: '/projects/demo/.chat-uploads/2026-11/b-error.log', name: 'error.log', kind: 'file', size: 1290, ts: NOW - 7200e3 }]
const LINKS = ['https://example.com/docs/1', { url: 'https://example.org/guide', title: 'The guide' }]

const page2 = (arr, before, limit) => {
  const start = before ? Number(before) : 0
  const items = arr.slice(start, start + limit)
  return { ok: true, items, next: start + limit < arr.length ? String(start + limit) : null }
}
// messages: newest first in pages, oldest -> newest inside a page
const msgPage = (before, limit, extra = []) => {
  const all = [...MSGS, ...extra]
  const end = before ? Number(before) : all.length
  const start = Math.max(0, end - limit)
  return { ok: true, items: all.slice(start, end), next: start > 0 ? String(start) : null }
}

let fails = 0, passes = 0
const ok = (name, cond, extra = '') => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + extra)); cond ? passes++ : fails++ }
const calls = []
let badAuth = 0
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
    if (p === 'me') return json({ ok: true, project: 'demo', label: 'Phone', role: 'owner' })
    if (p === 'conversations') return json(page2(CONVS, q.get('before'), Number(q.get('limit')) || 20))
    if (p === 'messages') {
      if (q.get('id') === 'c1') return json(msgPage(q.get('before'), Number(q.get('limit')) || 50, SAVED.c1))
      if (q.get('id') === 'c2') return json({ ok: true, items: [{ id: 'r1', role: 'user', ts: NOW - 60e3, text: 'Run the tests', tools: [], attachments: [] }, ...(SAVED.c2 || [])], next: null })
      return json({ ok: true, items: SAVED[q.get('id')] || [], next: null })
    }
    if (p === 'send') {
      const b = JSON.parse(req.postData() || '{}')
      if (b.text === 'busy please') return json({ ok: false, msg: 'running' }, 409)
      if (b.text === 'too many please') return json({ ok: false, msg: 'Too many runs in this project' }, 429)
      if (b.text === 'revoked please') return json({ ok: false, msg: 'bad key' }, 401)
      runMsgs = [{ id: 'sent-' + calls.length, role: 'user', ts: Date.now(), text: b.text || '', tools: [], attachments: [] }]
      return json({ ok: true, id: b.id || 'new1' })
    }
    if (p === 'stop') return json({ ok: true })
    if (p === 'upload') { await new Promise((r) => setTimeout(r, 700)); return json({ ok: true, att: { path: `/projects/demo/.chat-uploads/2026-11/z-${q.get('name')}`, name: q.get('name'), kind: 'image', size: 68 } }) }
    if (p === 'file') return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    if (p === 'media') {
      const tab = q.get('tab')
      return json(page2(tab === 'media' ? MEDIA : tab === 'files' ? FILES : LINKS, q.get('before'), Number(q.get('limit')) || 30))
    }
    if (p === 'stream') {
      // c2 is "running": the server replays the partial reply on connect, then finishes
      if (q.get('id') === 'c2') {
        const ev = (e, d) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`
        if (!SAVED.c2) save('c2', [{ id: 'r2', role: 'assistant', ts: NOW - 30e3, text: 'Running them now.', tools: [{ name: 'Bash', summary: 'npm test', ok: true }], attachments: [] }, { id: 'r3', role: 'assistant', ts: NOW, text: 'All 12 tests pass.', tools: [], attachments: [] }])
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ev('message', { id: 'r2', role: 'assistant', ts: NOW - 30e3, text: 'Running them now.', tools: [{ name: 'Bash', summary: 'npm test', ok: true }], attachments: [] }) + ev('delta', { text: 'All 12 tests pass.' }) + ev('message', { id: 'r3', role: 'assistant', ts: NOW, text: 'All 12 tests pass.', tools: [], attachments: [] }) + ev('done', { id: 'c2' }) })
      }
      return route.continue()
    }
    return json({ ok: false }, 404)
  })
}

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

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'en-US' }
try {
  // ================= iPhone, light =================
  const ctx = await browser.newContext({ ...iphone, colorScheme: 'light' })
  ctx.setDefaultTimeout(8000)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
  await mockApi(page)
  await page.goto(`${BASE}/c/${KEY}`)
  const rows = page.locator('[data-testid="conv-row"]')
  await rows.first().waitFor({ timeout: 10000 })

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
  ok('per-link manifest /c/<key>/manifest.webmanifest', head.manifest === `/c/${KEY}/manifest.webmanifest`, head.manifest)
  ok('home-screen title = project, tab title "Claude · <project>"', head.appTitle === 'demo' && head.title === 'Claude · demo', JSON.stringify(head))
  ok('every call sends the key as Bearer (no 401 seen)', badAuth === 0 && calls.length > 0, String(badAuth))
  ok('the page does not use the panel layout / terminal / editor code', !(await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /(TerminalPage|CodeEditor|xterm|Layout)-/.test(e.name)))))
  const jsKb = await page.evaluate(() => Math.round(performance.getEntriesByType('resource').filter((e) => /\.js$/.test(e.name)).reduce((s, e) => s + (e.decodedBodySize || 0), 0) / 1024))
  ok(`chat JavaScript stays small (${jsKb} KB < 420 KB)`, jsKb > 0 && jsKb < 420, String(jsKb))

  // ---- conversations screen
  ok('list header shows the project', await page.getByTestId('list-header').getByText('demo').isVisible())
  ok('list loads 20 first', (await rows.count()) === 20, String(await rows.count()))
  ok('running conversation shows the dot', (await page.locator('[data-id="c2"] [data-testid="running-dot"]').count()) === 1)
  let o = await noOverflow(page)
  ok('list: no horizontal overflow at 390px', o.ok, JSON.stringify(o))
  ok('header pads the top safe area', await safeArea(page, '[data-testid="list-header"]', 'top'))
  ok('app column pads the side safe areas', await safeArea(page, '.chat-app', 'left') && await safeArea(page, '.chat-app', 'right'))
  ok('page itself does not scroll (only the list)', await page.evaluate(() => getComputedStyle(document.body).overflow === 'hidden' && getComputedStyle(document.documentElement).overscrollBehaviorY === 'none'))
  let st = await smallTargets(page)
  ok('list: tap targets >= 44px', !st.length, st.join(', '))
  await shot(page, 'list-light')
  const scrollList = () => page.getByTestId('list-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await scrollList()
  ok('scrolling loads 20 more (40)', await waitFor(async () => (await rows.count()) === 40), String(await rows.count()))
  await scrollList()
  ok('and the rest (45), then stops', await waitFor(async () => (await rows.count()) === 45), String(await rows.count()))
  await page.waitForTimeout(300)
  ok('no request after the last page', calls.filter((c) => c.p === 'conversations' && c.q.before === '40').length === 1)
  await page.getByTestId('list-scroll').evaluate((el) => { el.scrollTop = 0 })

  // ---- conversation screen
  await page.locator('[data-id="c1"]').click()
  const bubbles = page.locator('[data-testid="bubble"]')
  await bubbles.first().waitFor({ timeout: 8000 })
  ok('conversation opens with the newest 50 messages', (await bubbles.count()) === 50, String(await bubbles.count()))
  ok('URL keeps the place (#/c/<id>)', page.url().endsWith('#/c/c1'), page.url())
  const msgBox = page.getByTestId('messages')
  ok('starts scrolled to the bottom', await waitFor(() => msgBox.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 5)))
  const vp = page.viewportSize()
  let cb = await page.getByTestId('composer').boundingBox()
  ok('composer sits at the bottom of the screen', cb && Math.abs(cb.y + cb.height - vp.height) <= 1, JSON.stringify(cb))
  ok('composer pads the bottom safe area', await safeArea(page, '[data-testid="composer"]', 'bottom'))
  ok('conversation header pads the top safe area', await safeArea(page, '[data-testid="conv-header"]', 'top'))
  const small = await smallFields(page)
  ok('every input/textarea is >= 16px (no iOS zoom)', !small.length, small.join(' | '))
  o = await noOverflow(page)
  ok('conversation: no horizontal overflow (long code scrolls inside its block)', o.ok, JSON.stringify(o))
  ok('markdown: heading, list, code block and table render', await page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid="bubble"]')].pop(); return !!(b.querySelector('[role=heading]') && b.querySelector('ul li') && b.querySelector('pre code') && b.querySelector('table')) }))
  ok('markdown: links are real anchors opening a new tab', await page.locator('[data-testid="bubble"] a[href^="https://example.com/docs/"][target="_blank"]').count() > 0)
  const chip = bubbles.last().getByTestId('tool-chip')
  ok('tool calls show as one collapsed chip', (await chip.count()) === 1 && (await chip.getAttribute('aria-expanded')) === 'false')
  await chip.click()
  ok('tapping the chip lists the tools', await bubbles.last().getByText('npm test').isVisible())
  st = await smallTargets(page)
  ok('conversation: tap targets >= 44px', !st.length, st.join(', '))
  await shot(page, 'conversation-light')

  // tap an image in a message -> viewer
  await bubbles.nth(48).getByTestId('thumb').click()
  const viewer = page.getByTestId('viewer')
  ok('tapping an image opens the full-screen viewer', await viewer.locator('img').waitFor({ timeout: 5000 }).then(() => true).catch(() => false))
  ok('viewer image loads from /chat-api/file with ?key=', /^\/chat-api\/file\?path=.*&key=/.test(await viewer.locator('img').getAttribute('src') || '') && await viewer.locator('img').evaluate((i) => i.complete && i.naturalWidth > 0))
  await page.waitForTimeout(250)
  await shot(page, 'viewer-light')
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

  // ---- attachment chip with upload, then send + streaming + stop
  await page.getByTestId('attach-btn').click()
  ok('attach menu: camera / photos / files', (await page.getByTestId('attach-menu').getByRole('menuitem').count()) === 3)
  await page.keyboard.press('Escape')
  await page.getByTestId('file-photos').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG })
  const ac = page.getByTestId('attach-chip')
  ok('attachment chip appears while uploading (with progress)', await ac.waitFor({ timeout: 3000 }).then(async () => (await ac.getAttribute('data-status')) === 'up').catch(() => false))
  await shot(page, 'composer-upload-light')
  ok('send waits for the upload', await page.getByTestId('send-btn').isDisabled())
  ok('chip turns ready when the upload ends', await waitFor(async () => (await ac.getAttribute('data-status')) === 'ok'))
  await page.getByRole('textbox').fill('Please look at this photo')
  await page.getByTestId('send-btn').click()
  ok('send posts text + attachment paths to /chat-api/send', await waitFor(() => calls.some((c) => c.p === 'send' && /Please look at this photo/.test(c.body) && /z-photo\.png/.test(c.body) && /"id":"c1"/.test(c.body))))
  ok('the chip is cleared after sending', await waitFor(async () => (await ac.count()) === 0))
  ok('own message shows at once', await page.getByText('Please look at this photo').isVisible())
  ok('the live stream opens', await waitFor(() => sse.size > 0))
  const liveB = page.getByTestId('bubble-live')
  ok('a "typing" bubble shows before the first word', await liveB.getByTestId('typing').isVisible().catch(() => false))
  ok('stop button replaces send while running', await page.getByTestId('stop-btn').isVisible())
  push('delta', { text: 'Looking at ' })
  push('delta', { text: 'the photo' })
  ok('streaming text appears as it arrives', await waitFor(async () => /Looking at the photo/.test(await liveB.textContent({ timeout: 300 }).catch(() => ''))))
  // back from the background: reconnect; the server replays ONE delta with all the text so far
  const opened = sseOpened
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  ok('coming back to the app reconnects the stream', await waitFor(() => sseOpened > opened && sse.size === 1))
  push('delta', { text: 'Looking at the photo' })
  ok('reconnect: the replayed text is not shown twice', await waitFor(async () => (await liveB.textContent({ timeout: 300 }).catch(() => '')).trim() === 'Looking at the photo'), await liveB.textContent({ timeout: 300 }).catch(() => ''))
  push('tool', { name: 'Read', summary: 'photo.png' })
  ok('tool calls stream as a chip', await waitFor(async () => (await liveB.getByTestId('tool-chip').count()) === 1))
  ok('follows the bottom while streaming', await msgBox.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 5))
  await shot(page, 'streaming-light')
  await page.getByTestId('stop-btn').click()
  ok('stop calls /chat-api/stop with the conversation', await waitFor(() => calls.some((c) => c.p === 'stop' && /"id":"c1"/.test(c.body))))
  push('message', { id: 'm200', role: 'assistant', ts: Date.now(), text: 'Looking at the photo: it shows the app icon.', tools: [{ name: 'Read', summary: 'photo.png', ok: true }], attachments: [] })
  push('done', { id: 'c1' })
  ok('final message replaces the live bubble', await waitFor(async () => (await liveB.count()) === 0 && await page.getByText('Looking at the photo: it shows the app icon.').isVisible()))
  ok('send button is back after "done"', await waitFor(() => page.getByTestId('send-btn').isVisible()))
  endStreams()

  // ---- simulated keyboard: the visible area shrinks -> composer stays above it
  await page.getByRole('textbox').focus()
  await page.setViewportSize({ width: 390, height: 500 })
  await page.waitForTimeout(250)
  cb = await page.getByTestId('composer').boundingBox()
  ok('with the keyboard open the composer sits right above it', cb && Math.abs(cb.y + cb.height - 500) <= 1, JSON.stringify(cb))
  ok('keyboard open: bottom safe-area padding is dropped', await page.evaluate(() => document.documentElement.dataset.kb === '1' && getComputedStyle(document.querySelector('[data-testid="composer"]')).paddingBottom === '0px'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)

  // ---- info screen
  await page.getByTestId('conv-title').click()
  await page.getByTestId('screen-info').waitFor({ timeout: 5000 })
  ok('title tap opens the info screen (#/c/<id>/info)', page.url().endsWith('#/c/c1/info'))
  ok('info shows title and message count', await page.getByTestId('info-title').textContent() === CONVS[0].title && await page.getByText('120 messages').isVisible())
  const grid = page.getByTestId('media-grid')
  await grid.waitFor({ timeout: 5000 })
  ok('Media: 3-column grid', (await grid.evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)) === 3)
  const items = page.getByTestId('media-item')
  ok('Media: first 30 items', (await items.count()) === 30, String(await items.count()))
  ok('Media: thumbnails load', await waitFor(async () => (await grid.locator('img').count()) >= 6))
  o = await noOverflow(page)
  ok('info: no horizontal overflow', o.ok, JSON.stringify(o))
  await shot(page, 'info-media-light')
  await page.locator('[data-testid="screen-info"] .chat-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight })
  ok('Media: more on scroll (40)', await waitFor(async () => (await items.count()) === 40), String(await items.count()))
  await items.first().click()
  ok('Media: tap opens the viewer', await viewer.locator('img').waitFor({ timeout: 5000 }).then(() => true).catch(() => false))
  await viewer.getByRole('button', { name: /close/i }).click()
  await page.getByTestId('tab-files').click()
  ok('Files tab lists the files', await waitFor(async () => (await page.getByTestId('screen-info').getByTestId('file-row').count()) === 2))
  await shot(page, 'info-files-light')
  await page.getByTestId('tab-links').click()
  const links = page.getByTestId('link-row')
  ok('Links tab lists the links (string or {url,title})', await waitFor(async () => (await links.count()) === 2) && (await links.nth(1).getAttribute('href')) === 'https://example.org/guide' && await page.getByText('The guide').isVisible())
  await shot(page, 'info-links-light')
  st = await smallTargets(page)
  ok('info: tap targets >= 44px', !st.length, st.join(', '))
  await page.getByTestId('info-back').click()
  ok('back from info returns to the same conversation (kept loaded)', await waitFor(async () => page.url().endsWith('#/c/c1') && (await bubbles.count()) >= 120))
  await page.getByTestId('back-btn').click()
  ok('back returns to the list, scroll and pages kept', await waitFor(async () => (await rows.count()) === 45 && await page.getByTestId('screen-list').isVisible()))

  // ---- running conversation: the reply already in progress is replayed on connect
  await page.locator('[data-id="c2"]').click()
  ok('running conversation: replayed messages + text end in the final message', await waitFor(async () => await page.getByText('All 12 tests pass.').isVisible().catch(() => false) && await page.getByText('Running them now.').isVisible().catch(() => false)))
  ok('running conversation: the replayed text is not left as a duplicate', (await page.getByText('All 12 tests pass.').count()) === 1 && !(await page.getByTestId('bubble-live').count()))
  await page.getByTestId('back-btn').click()

  // ---- new conversation
  await page.getByTestId('new-chat').click()
  ok('new chat: empty conversation', await page.getByTestId('conv-empty').isVisible())
  await shot(page, 'new-chat-light')
  await page.getByRole('textbox').fill('Hello there')
  await page.getByRole('textbox').press('Enter') // phone: Enter is a new line, not send
  ok('phone: Enter adds a line instead of sending', !calls.some((c) => c.p === 'send' && /Hello there/.test(c.body)))
  await page.getByTestId('send-btn').click()
  ok('new chat: sends with id null', await waitFor(() => calls.some((c) => c.p === 'send' && /"id":null/.test(c.body))))
  ok('new chat: URL gets the new id', await waitFor(() => page.url().endsWith('#/c/new1')), page.url())
  ok('new chat: the stream of the new id opens', await waitFor(() => sse.size > 0 && calls.some((c) => c.p === 'stream' && c.q.id === 'new1')))
  push('done', { id: 'new1' })
  endStreams()
  await page.getByTestId('send-btn').waitFor({ timeout: 5000 })
  // errors on send: the text comes back to the composer and a short notice explains
  const toastSays = async (re) => waitFor(async () => (await page.getByTestId('toast').allTextContents()).some((x) => re.test(x)))
  await page.getByRole('textbox').fill('busy please')
  await page.getByTestId('send-btn').click()
  ok('409: "still answering" notice, text kept', await toastSays(/still answering/i) && (await page.getByRole('textbox').inputValue()) === 'busy please')
  await page.getByRole('textbox').fill('too many please')
  await page.getByTestId('send-btn').click()
  ok('429: shows the server message', await toastSays(/too many runs/i))
  await page.getByRole('textbox').fill('revoked please')
  await page.getByTestId('send-btn').click()
  ok('401 while using it: "link no longer valid" screen', await page.getByTestId('blocked').waitFor({ timeout: 5000 }).then(() => true).catch(() => false))
  ok('no page errors', !errors.length, errors.join(' | '))
  await ctx.close()

  // ================= iPhone, dark (screenshots + theme) =================
  const dctx = await browser.newContext({ ...iphone, colorScheme: 'dark' })
  dctx.setDefaultTimeout(8000)
  const dp = await dctx.newPage()
  await mockApi(dp)
  await dp.goto(`${BASE}/c/${KEY}`)
  await dp.locator('[data-testid="conv-row"]').first().waitFor({ timeout: 10000 })
  ok('dark: follows the system', await dp.evaluate(() => document.documentElement.classList.contains('dark')))
  ok('dark: status bar is translucent over the dark header', await dp.evaluate(() => document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]').content) === 'black-translucent')
  await shot(dp, 'list-dark')
  await dp.locator('[data-id="c1"]').click()
  await dp.locator('[data-testid="bubble"]').first().waitFor()
  await dp.waitForTimeout(300)
  await shot(dp, 'conversation-dark')
  await dp.getByRole('textbox').fill('Run it')
  await dp.getByTestId('send-btn').click()
  await waitFor(() => sse.size > 0)
  push('delta', { text: 'Running the **tests** now…' })
  push('tool', { name: 'Bash', summary: 'npm test' })
  await dp.waitForTimeout(300)
  await shot(dp, 'streaming-dark')
  push('done', { id: 'c1' })
  endStreams()
  await dp.getByTestId('conv-title').click()
  await dp.getByTestId('media-grid').waitFor()
  await waitFor(async () => (await dp.locator('[data-testid="media-grid"] img').count()) >= 6)
  await shot(dp, 'info-media-dark')
  await dp.getByTestId('media-item').first().click()
  await dp.getByTestId('viewer').locator('img').waitFor()
  await dp.waitForTimeout(250)
  await shot(dp, 'viewer-dark')
  await dctx.close()

  // ================= desktop =================
  const wctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' })
  wctx.setDefaultTimeout(8000)
  const wp = await wctx.newPage()
  await mockApi(wp)
  await wp.goto(`${BASE}/c/${KEY}#/c/c1`)
  await wp.locator('[data-testid="bubble"]').first().waitFor({ timeout: 10000 })
  const col = await wp.locator('.chat-app').boundingBox()
  ok('desktop: centered column up to 760px', col && col.width <= 761 && Math.abs(col.x - (1280 - col.width) / 2) <= 1, JSON.stringify(col))
  o = await noOverflow(wp)
  ok('desktop: no horizontal overflow', o.ok, JSON.stringify(o))
  await wp.getByRole('textbox').fill('desktop enter')
  await wp.getByRole('textbox').press('Enter')
  ok('desktop: Enter sends', await waitFor(() => calls.some((c) => c.p === 'send' && /desktop enter/.test(c.body))))
  await waitFor(() => sse.size > 0)
  push('done', { id: 'c1' })
  endStreams()
  await shot(wp, 'desktop-light')
  await wctx.close()

  // ================= bad key =================
  const bctx = await browser.newContext({ ...iphone })
  const bp = await bctx.newPage()
  await mockApi(bp)
  await bp.goto(`${BASE}/c/not-a-valid-key`)
  ok('revoked/invalid key: clear message, no list', await bp.getByTestId('blocked').waitFor({ timeout: 5000 }).then(() => true).catch(() => false) && !(await bp.locator('[data-testid="conv-row"]').count()))
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
