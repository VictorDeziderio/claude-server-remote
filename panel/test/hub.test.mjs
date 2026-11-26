#!/usr/bin/env node
// Smoke test of the remote hub (server/hub.js): /remote?key=<person key>, API /hub-api/*.
//  - people (admin API): create (plain link shown once, only a sha256 stored), list, revoke;
//  - the person's key: me / projects / accounts / usage / report / server, links (add, refuse bad
//    or repeated ones, rename, move, remove), project account switch; a wrong key is refused;
//  - the hub key opens the chat of ANY project of the server (/remote/<project>?key=<hub key>,
//    X-Chat-Project), never without a project; revoking the person closes all of that;
//  - CORS: /hub-api and /chat-api answer preflights from any origin (Bearer only, no cookies);
//  - two servers: the hub of server A lists the projects of server B from a saved hub link;
//  - the built page in Chrome, desktop 1280x800 and phone 390x844: every section renders with no
//    page errors (CSP included), screenshots saved to $HUB_SHOTS when set.
// Usage: node test/hub.test.mjs
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && fs.existsSync(p))
let chromium
try { ({ chromium } = await import('playwright-core')) } catch { /* not installed */ }
const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = process.env.HUB_SHOTS || ''

// one isolated panel server: its own HOME, projects and port
function makeServer(projects) {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hub-'))
  for (const p of projects) fs.mkdirSync(path.join(ROOT, 'projects', p), { recursive: true })
  fs.mkdirSync(path.join(ROOT, '.claude', 'run'), { recursive: true })
  const NOOP = path.join(ROOT, 'noop.sh')
  fs.writeFileSync(NOOP, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const PORT = 7000 + Math.floor(Math.random() * 900)
  const env = {
    ...process.env, HOME: ROOT, PANEL_PORT: String(PORT), PANEL_BIND: '127.0.0.1',
    PANEL_LOGIN: 'admin', PANEL_PASSWORD: 'test123', PANEL_TEST_INSECURE_COOKIE: '1',
    PROJECTS_DIR: path.join(ROOT, 'projects'), PANEL_CONFIG: path.join(ROOT, '.claude', 'panel.json'),
    SESSION_SCRIPT: NOOP, BACKUP_SCRIPT: NOOP, TMUX_TMPDIR: ROOT, USAGE_API_BASE_URL: 'http://127.0.0.1:9', USAGE_POLL_INTERVAL: '600',
    USAGE_MONITOR: '0', AUTO_RESUME: '0', CLAUDE_AUTO_UPDATE: '0', HUB_NAME: `server-${PORT}`,
  }
  delete env.TMUX; delete env.TMUX_PANE; delete env.CLAUDE_CODE_OAUTH_TOKEN
  const proc = spawn(process.execPath, ['server.js'], { cwd: PANEL, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  proc.stdout.on('data', (d) => { logs += d }); proc.stderr.on('data', (d) => { logs += d })
  const BASE = `http://127.0.0.1:${PORT}`
  let cookie = ''
  const j = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', cookie, origin: BASE, host: `127.0.0.1:${PORT}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.clone().json() } catch { data = await r.text() }
    return { status: r.status, data, headers: r.headers }
  }
  const login = async () => { const r = await j('POST', '/api/login', { login: 'admin', password: 'test123' }); cookie = (r.headers.get('set-cookie') || '').split(';')[0] }
  return { ROOT, PORT, BASE, env, proc, j, login, logs: () => logs, stop: () => { proc.kill(); spawnSync('tmux', ['kill-server'], { env }); try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* */ } } }
}
// Bearer call: no cookie, no Origin
const b = async (base, key, method, url, body, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = null; try { data = await r.clone().json() } catch { data = await r.text() }
  return { status: r.status, data, headers: r.headers }
}

let fails = 0, passes = 0
const ok = (name, cond, extra = '') => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + extra)); cond ? passes++ : fails++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const A = makeServer(['alpha', 'beta'])
const B = makeServer(['gamma'])
try {
  await sleep(1500)
  await A.login(); await B.login()

  // ---- people (admin side) ----
  let r = await A.j('POST', '/api/hub/people/create', { label: '' })
  ok('a person needs a name', r.data.ok === false)
  r = await A.j('POST', '/api/hub/people/create', { label: 'Owner phone' })
  ok('create a person: link /remote?key=', r.data.ok && /\/remote\?key=[A-Za-z0-9_-]{40,}$/.test(r.data.url), JSON.stringify(r.data))
  const KEY = r.data.key, PID = r.data.id
  const stored = fs.readFileSync(path.join(A.ROOT, '.claude', '.panel-hub.json'), 'utf8')
  ok('only the sha256 of the key is stored (0600)', !stored.includes(KEY) && stored.includes(crypto.createHash('sha256').update(KEY).digest('hex')) && (fs.statSync(path.join(A.ROOT, '.claude', '.panel-hub.json')).mode & 0o777) === 0o600)
  r = await A.j('GET', '/api/hub/people')
  ok('people listed without keys', r.data.people.length === 1 && r.data.people[0].label === 'Owner phone' && !JSON.stringify(r.data).includes(KEY))
  r = await fetch(A.BASE + '/api/hub/people')
  ok('people list needs the panel login', r.status === 401)

  // ---- the hub API ----
  r = await b(A.BASE, 'wrong-key-wrong-key-wrong-key', 'GET', '/hub-api/me')
  ok('a wrong key is refused', r.status === 401)
  r = await b(A.BASE, KEY, 'GET', '/hub-api/me')
  ok('me: the person and the server', r.data.ok && r.data.label === 'Owner phone' && r.data.server.name === `server-${A.PORT}`, JSON.stringify(r.data))
  r = await b(A.BASE, KEY, 'GET', '/hub-api/projects')
  ok('projects of this server', r.data.ok && r.data.projects.map((p) => p.name).sort().join() === 'alpha,beta' && r.data.projects.every((p) => typeof p.claude === 'string'), JSON.stringify(r.data))
  r = await b(A.BASE, KEY, 'GET', '/hub-api/accounts')
  ok('accounts with limits and projects', r.data.ok && r.data.accounts.length >= 1 && Array.isArray(r.data.accounts[0].projects), JSON.stringify(r.data).slice(0, 300))
  r = await b(A.BASE, KEY, 'GET', '/hub-api/usage')
  ok('usage + limits', r.data.ok && r.data.usage && r.data.limits && r.data.limits.claude, JSON.stringify(r.data).slice(0, 200))
  r = await b(A.BASE, KEY, 'GET', '/hub-api/report?from=2026-01-01&to=2026-01-31')
  ok('report by dates', r.data.ok && r.data.usage.total)
  r = await b(A.BASE, KEY, 'GET', '/hub-api/report?from=bad&to=2026-01-31')
  ok('report: a bad date is refused', r.data.ok === false)
  r = await b(A.BASE, KEY, 'GET', '/hub-api/server')
  ok('server data', r.data.ok && r.data.mem && typeof r.data.uptime === 'number')
  r = await b(A.BASE, KEY, 'POST', '/hub-api/project/account', { name: 'alpha', account: 'nope' })
  ok('account switch: an unknown account is refused', r.data.ok === false)
  r = await b(A.BASE, KEY, 'POST', '/hub-api/project/account', { name: 'alpha', account: 'default' })
  ok('account switch: the same account is fine', r.data.ok, JSON.stringify(r.data))

  // ---- links ----
  r = await b(A.BASE, KEY, 'POST', '/hub-api/links/add', { url: 'javascript:alert(1)' })
  ok('links: not http(s) refused', r.data.ok === false)
  r = await b(A.BASE, KEY, 'POST', '/hub-api/links/add', { url: 'https://example.com/other' })
  ok('links: a URL that is not /remote or /c refused', r.data.ok === false)
  // server B: a hub person and a chat key, whose links go into the list of server A
  r = await B.j('POST', '/api/hub/people/create', { label: 'Me on B' })
  const KEYB = r.data.key, HUBB = r.data.url
  r = await B.j('POST', '/api/chat/keys/create', { name: 'gamma', label: 'gamma link' })
  const CHATB = r.data.url
  r = await b(A.BASE, KEY, 'POST', '/hub-api/links/add', { label: 'Server B', url: HUBB })
  ok('links: hub of another server added', r.data.ok && r.data.link.url === HUBB, JSON.stringify(r.data))
  const L1 = r.data.link.id
  r = await b(A.BASE, KEY, 'POST', '/hub-api/links/add', { url: HUBB + '#x' })
  ok('links: the same link twice refused (hash ignored)', r.data.ok === false)
  r = await b(A.BASE, KEY, 'POST', '/hub-api/links/add', { label: 'gamma', url: CHATB })
  ok('links: a project chat link added', r.data.ok)
  const L2 = r.data.link.id
  r = await b(A.BASE, KEY, 'POST', '/hub-api/links/move', { id: L2, dir: 'up' })
  r = await b(A.BASE, KEY, 'GET', '/hub-api/links')
  ok('links: moved up', r.data.links.map((l) => l.id).join() === [L2, L1].join())
  r = await b(A.BASE, KEY, 'POST', '/hub-api/links/edit', { id: L1, label: 'B renamed' })
  ok('links: renamed', r.data.ok && r.data.link.label === 'B renamed')

  // ---- the hub key opens the chats of this server ----
  r = await b(A.BASE, KEY, 'GET', '/chat-api/me')
  ok('chat: a hub key without a project is refused', r.status === 401)
  r = await b(A.BASE, KEY, 'GET', '/chat-api/me', undefined, { 'x-chat-project': 'beta' })
  ok('chat: the hub key opens project beta', r.data.ok && r.data.project === 'beta', JSON.stringify(r.data))
  r = await b(A.BASE, KEY, 'GET', '/chat-api/state', undefined, { 'x-chat-project': 'alpha' })
  ok('chat: state of alpha with the hub key', r.data.ok && r.data.claude === 'off', JSON.stringify(r.data))
  r = await b(A.BASE, KEY, 'GET', '/chat-api/me', undefined, { 'x-chat-project': 'nope' })
  ok('chat: a project that does not exist is refused', r.status === 401)
  r = await b(A.BASE, KEYB, 'GET', '/chat-api/me', undefined, { 'x-chat-project': 'alpha' })
  ok('chat: the hub key of another server is refused here', r.status === 401)
  r = await fetch(`${A.BASE}/remote/alpha/manifest.webmanifest?key=${KEY}`)
  ok('chat: the per-project manifest opens with the hub key', r.status === 200 && (await r.json()).short_name === 'alpha')
  r = await fetch(`${A.BASE}/remote/manifest.webmanifest?key=${KEY}`)
  ok('hub manifest with the key', r.status === 200 && /\/remote\?key=/.test((await r.json()).start_url))
  r = await fetch(`${A.BASE}/remote/manifest.webmanifest?key=bad`)
  ok('hub manifest refused with a bad key', r.status === 404)

  // ---- CORS (the hub of another server reads these) ----
  r = await fetch(`${A.BASE}/hub-api/projects`, { method: 'OPTIONS', headers: { origin: 'https://other.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } })
  ok('CORS: preflight of /hub-api', r.status === 204 && r.headers.get('access-control-allow-origin') === '*' && /authorization/i.test(r.headers.get('access-control-allow-headers')))
  r = await fetch(`${A.BASE}/chat-api/state`, { method: 'OPTIONS', headers: { origin: 'https://other.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,x-chat-project' } })
  ok('CORS: preflight of /chat-api (X-Chat-Project allowed)', r.status === 204 && /x-chat-project/i.test(r.headers.get('access-control-allow-headers')))
  r = await fetch(`${A.BASE}/api/state`, { method: 'OPTIONS', headers: { origin: 'https://other.example' } })
  ok('CORS: the cookie API (/api) stays closed', !r.headers.get('access-control-allow-origin'))

  // ---- pages ----
  const hasHub = fs.existsSync(path.join(PANEL, 'dist', 'hub.html'))
  if (!hasHub) console.log('  SKIP pages: dist/hub.html not built (npm run build)')
  else {
    r = await fetch(`${A.BASE}/remote?key=${KEY}`)
    const html = await r.text()
    ok('page /remote serves the hub', r.status === 200 && /src|assets\/hub/.test(html) && r.headers.get('referrer-policy') === 'no-referrer' && /connect-src[^;]*https:/.test(r.headers.get('content-security-policy')))
    r = await fetch(`${A.BASE}/remote/alpha?key=${KEY}`)
    ok('page /remote/<project> is still the chat', r.status === 200 && /assets\/chat/.test(await r.text()))
  }
  if (hasHub && chromium && CHROME) {
    const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
    try {
      for (const [name, opts] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
        const ctx = await browser.newContext(opts)
        const page = await ctx.newPage()
        const errors = []
        page.on('pageerror', (e) => errors.push(e.message))
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
        await page.goto(`${A.BASE}/remote?key=${KEY}`)
        await page.getByTestId('hub-project').first().waitFor({ timeout: 15000 }).catch(() => {})
        ok(`${name}: projects of this server listed`, (await page.getByTestId('hub-project').count()) === 2)
        await page.getByTestId('hub-remote-project').first().waitFor({ timeout: 10000 }).catch(() => {})
        ok(`${name}: the saved hub of server B lists its projects (cross-server)`, (await page.getByTestId('hub-remote-project').count()) === 1 && /gamma/.test(await page.getByTestId('hub-remote').innerText()))
        await page.getByTestId('hub-saved-chat').first().waitFor({ timeout: 10000 }).catch(() => {})
        ok(`${name}: the saved chat link of server B shows`, (await page.getByTestId('hub-saved-chat').count()) === 1)
        const navs = name === 'desktop' ? 'hub-nav-' : 'hub-tab-'
        ok(`${name}: the right menu is visible`, await page.getByTestId(navs + 'projects').isVisible())
        await sleep(400)
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `hub-${name}-projects.png`) })
        for (const sec of ['accounts', 'usage', 'server', 'links']) {
          await page.getByTestId(navs + sec).click()
          await page.waitForFunction((s) => location.hash === '#/' + s, sec)
          await sleep(sec === 'server' ? 1200 : 600)
          if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `hub-${name}-${sec}.png`) })
        }
        ok(`${name}: accounts section shows an account`, await page.goto(`${A.BASE}/remote?key=${KEY}#/accounts`).then(() => page.getByTestId('hub-account').first().waitFor({ timeout: 8000 })).then(() => true).catch(() => false))
        await page.goto(`${A.BASE}/remote#/links`) // no key in the URL: the one saved on this device
        await page.getByTestId('hub-link').first().waitFor({ timeout: 8000 }).catch(() => {})
        ok(`${name}: /remote without ?key= opens with the key saved on this device`, (await page.getByTestId('hub-link').count()) === 2)
        if (name === 'desktop') {
          await page.getByTestId('hub-link-url').fill('https://example.com/nope')
          await page.getByTestId('hub-link-add').click()
          ok('desktop: a bad link shows the error', await page.getByText(/not a chat or hub link/).waitFor({ timeout: 5000 }).then(() => true).catch(() => false))
          // open the chat of a local project from the hub
          await page.goto(`${A.BASE}/remote?key=${KEY}`)
          await page.getByTestId('hub-project').first().click()
          await page.waitForURL(/\/remote\/(alpha|beta)\?key=/, { timeout: 8000 }).catch(() => {})
          await page.getByTestId('screen-conversation').waitFor({ timeout: 10000 }).catch(() => {})
          ok('desktop: tapping a project opens its chat with the hub key', (await page.getByTestId('screen-conversation').count()) === 1, page.url())
        }
        ok(`${name}: no errors in the page (CSP, scripts)`, errors.length === 0, errors.join(' | '))
        await ctx.close()
      }
      // revoked: the page shows the "link no longer valid" screen
      r = await A.j('POST', '/api/hub/people/revoke', { id: PID })
      ok('revoke the person', r.data.ok)
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
      const page = await ctx.newPage()
      await page.goto(`${A.BASE}/remote?key=${KEY}`)
      ok('revoked: the page says the link is no longer valid', await page.getByTestId('hub-blocked').waitFor({ timeout: 8000 }).then(() => true).catch(() => false))
      await ctx.close()
    } finally { await browser.close() }
  } else {
    r = await A.j('POST', '/api/hub/people/revoke', { id: PID })
    ok('revoke the person', r.data.ok)
  }
  r = await b(A.BASE, KEY, 'GET', '/hub-api/me')
  ok('revoked: the hub key stops at once', r.status === 401)
  r = await b(A.BASE, KEY, 'GET', '/chat-api/me', undefined, { 'x-chat-project': 'alpha' })
  ok('revoked: the chats opened with it stop too', r.status === 401)

  ok('no key in the panel logs', !A.logs().includes(KEY) && !B.logs().includes(KEYB))
  const auditTxt = fs.readFileSync(path.join(A.ROOT, '.claude', 'logs', 'audit.log'), 'utf8')
  ok('audit: hub actions logged without the key', /hub\.person\.create/.test(auditTxt) && /hub\.person\.revoke/.test(auditTxt) && /hub\.project\.account/.test(auditTxt) && !auditTxt.includes(KEY))
} catch (e) {
  console.log('  EXCEPTION', e); fails++
} finally {
  if (fails) console.log('\n--- server A log ---\n' + A.logs().split('\n').slice(-25).join('\n'))
  A.stop(); B.stop()
  console.log(`\n${passes} PASS, ${fails} FAIL${fails ? '' : ' — ALL OK'}`)
  process.exit(fails ? 1 : 0)
}
