#!/usr/bin/env node
// Browser test of the overlays (Modal / Drawer in src/components/ui.jsx), on the built panel
// (dist/) served by the real server.js, in a real Chrome (playwright-core, no download: uses the
// installed Chrome — CHROME_PATH, or /usr/bin/google-chrome as on the GitHub runners).
// Covers the bugs of the old hand-made modal:
//   - it sat BELOW the fullscreen terminal (z-50 < z-60): the "Paste" box opened behind it;
//   - selecting text in a field and releasing the mouse on the backdrop closed it;
//   - no focus trap / focus not returned / background still scrollable.
// Usage: npm run build && node test/ui.test.mjs   (npm test runs it; no Chrome -> SKIP, but in CI it fails)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && fs.existsSync(p))
let chromium
try { ({ chromium } = await import('playwright-core')) } catch { /* not installed */ }
if (!CHROME || !chromium || !fs.existsSync(path.join(PANEL, 'dist', 'index.html'))) {
  console.log(`  SKIP ui test (chrome: ${CHROME || 'none'}, playwright-core: ${!!chromium}, dist: ${fs.existsSync(path.join(PANEL, 'dist', 'index.html'))})`)
  process.exit(process.env.CI ? 1 : 0)
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ui-'))
fs.mkdirSync(path.join(ROOT, 'projects', 'demo'), { recursive: true })
const PORT = 7900 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`
const PASS = 'ui-test-only-password'
const env = { ...process.env, HOME: ROOT, PANEL_PORT: String(PORT), PANEL_PASSWORD: PASS, PANEL_LOGIN: 'admin', PROJECTS_DIR: path.join(ROOT, 'projects'), PANEL_CONFIG: path.join(ROOT, 'panel.json'), USAGE_MONITOR: '0', AUTO_RESUME: '0', DEPLOY_WEBHOOK_URL: 'http://127.0.0.1:9/never-called' }
delete env.TMUX; delete env.TMUX_PANE
const srv = spawn(process.execPath, ['server.js'], { cwd: PANEL, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''; srv.stdout.on('data', (d) => { logs += d }); srv.stderr.on('data', (d) => { logs += d })
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/login/info')).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)) }

let fails = 0, passes = 0
const ok = (name, cond, extra = '') => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + extra)); cond ? passes++ : fails++ }
const browser = await chromium.launch({ executablePath: CHROME, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(BASE + '/')
  await page.fill('input[autocomplete="username"]', 'admin')
  await page.fill('input[type="password"]', PASS)
  await page.keyboard.press('Enter')
  await page.waitForURL(/dashboard/, { timeout: 15000 })

  // ---- light first load: the terminal (xterm), editor and QR code are NOT downloaded on the dashboard
  const loaded = async () => page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name.split('/').pop()))
  const first = await loaded()
  ok('dashboard does not download the terminal / editor / account code', !first.some((n) => /^(TerminalPage|CodeEditor|Account|xterm)-/.test(n)), first.filter((n) => n.endsWith('.js')).join(' '))
  const mainJs = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/assets\/index-.*\.js$/.test(e.name)).reduce((s, e) => s + (e.decodedBodySize || 0), 0))
  ok(`main bundle under 600 KB (${Math.round(mainJs / 1024)} KB)`, mainJs > 0 && mainJs < 600 * 1024, String(mainJs))

  // ---- Modal "New project"
  const openBtn = page.getByRole('button', { name: /new project/i }).first()
  await openBtn.click()
  const modal = page.locator('[data-slot="modal"]')
  await modal.waitFor({ timeout: 5000 })
  ok('modal opens with an accessible title', await page.getByRole('dialog', { name: /new project/i }).isVisible())
  ok('focus goes inside the modal', await page.evaluate(() => !!document.activeElement?.closest('[data-slot="modal"]')))
  const z = await modal.evaluate((el) => Number(getComputedStyle(el).zIndex))
  ok(`modal layer is above the fullscreen terminal (z ${z} > 70)`, z > 70, String(z))
  ok('modal is rendered in <body> (portal), not inside the page', await modal.evaluate((el) => el.parentElement === document.body || el.closest('body > div') === el.parentElement))
  ok('background does not scroll while open', await page.evaluate(() => getComputedStyle(document.body).overflow === 'hidden' || document.body.hasAttribute('data-scroll-locked')))

  // select text in the input and release the mouse on the backdrop: must NOT close
  const input = modal.locator('input').first()
  await input.fill('select-me-and-drag-out')
  const ib = await input.boundingBox()
  await page.mouse.move(ib.x + 10, ib.y + ib.height / 2)
  await page.mouse.down()
  await page.mouse.move(20, 20, { steps: 8 })
  await page.mouse.up()
  ok('drag-selecting out of the field does not close the modal', await modal.isVisible())

  // Tab stays inside (focus trap)
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
  ok('Tab keeps the focus inside the modal', await page.evaluate(() => !!document.activeElement?.closest('[data-slot="modal"]')))

  // a real click outside closes it
  await page.mouse.click(15, 15)
  await modal.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  ok('click outside closes', !(await modal.count()))

  // Escape closes and the focus goes back to the button that opened it
  await openBtn.click(); await modal.waitFor()
  await page.keyboard.press('Escape')
  await modal.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  ok('Escape closes', !(await modal.count()))
  await page.waitForTimeout(100) // Radix gives the focus back right after unmounting
  ok('focus returns to the button that opened it', await openBtn.evaluate((el) => el === document.activeElement), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)))

  // the X button closes
  await openBtn.click(); await modal.waitFor()
  await modal.getByRole('button', { name: /close/i }).first().click()
  await modal.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  ok('the X button closes', !(await modal.count()))

  // ---- Drawer "Configure project"
  const cfg = page.locator('button[title^="configure"]:visible').first()
  if (await cfg.count()) {
    await cfg.click()
    const drawer = page.locator('[data-slot="drawer"]')
    await drawer.waitFor({ timeout: 5000 })
    const db = await drawer.boundingBox()
    ok('drawer opens on the right side, full height', db && Math.round(db.x + db.width) >= 1279 && db.height >= 790, JSON.stringify(db))
    await drawer.locator('[data-testid="disk-section"]').getByText(/project/i).first().waitFor({ timeout: 8000 }).catch(() => {})
    ok('drawer shows the disk use of the project', await drawer.locator('[data-testid="disk-section"]').getByText(/project/i).first().isVisible().catch(() => false))
    // "Chat link": create a limited link (shown once), it is listed, revoke removes it
    {
      const sec = drawer.locator('[data-testid="chatlink-section"]')
      await sec.scrollIntoViewIfNeeded()
      await sec.locator('[data-testid="chatlink-label"]').fill('Guest UI')
      await sec.getByRole('button', { name: /create link/i }).click()
      const fresh = sec.locator('[data-testid="chatlink-fresh"] input')
      await fresh.waitFor({ timeout: 5000 }).catch(() => {})
      const url = await fresh.inputValue().catch(() => '')
      ok('chat link: created link shown once as /remote/<project>?key=<key>', /\/remote\/[^/?]+\?key=[A-Za-z0-9_-]{43}$/.test(url), url)
      const row = sec.locator('[data-testid="chatlink-key"]', { hasText: 'Guest UI' })
      await row.waitFor({ timeout: 5000 }).catch(() => {})
      ok('chat link: listed with its role', /limited/i.test(await row.innerText().catch(() => '')))
      await row.getByRole('button', { name: /revoke/i }).click()
      await page.locator('[role="dialog"]').last().getByRole('button', { name: /^revoke$/i }).click()
      await row.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
      ok('chat link: revoke removes it', !(await row.count()) && !(await fresh.count()))
    }
    // typing the name to delete keeps the focus in the field and the drawer where it was
    const del = drawer.locator('[data-testid="delete-confirm"]')
    await del.scrollIntoViewIfNeeded()
    await del.click()
    const scrollOf = () => drawer.evaluate((d) => Math.max(d.scrollTop, ...[...d.querySelectorAll('*')].map((e) => e.scrollTop)))
    const before = await scrollOf()
    await page.keyboard.type('demo', { delay: 30 })
    const typed = await del.inputValue()
    const focused = await del.evaluate((e) => e === document.activeElement)
    const after = await scrollOf()
    ok('drawer: typing the name to delete keeps focus and scroll', typed === 'demo' && focused && Math.abs(after - before) < 4, JSON.stringify({ typed, focused, before, after }))
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
    ok('drawer: Escape closes', !(await drawer.count()))
  } else ok('configure button found on the dashboard', false, 'no button[title^=configure]')

  // ---- terminal: an image dragged onto it is sent to the project (its path is typed in the terminal)
  await page.goto(BASE + '/terminal/demo')
  const dropZone = page.locator('[data-slot="term-drop"]')
  await dropZone.waitFor({ timeout: 8000 })
  const upDir = path.join(ROOT, 'projects', 'demo', '.chat-uploads')
  await dropZone.evaluate((el) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'drop.png', { type: 'image/png' }))
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })
  await page.getByText(/1 file\(s\) sent/i).first().waitFor({ timeout: 6000 }).catch(() => {})
  const saved = fs.existsSync(upDir) ? fs.readdirSync(upDir, { recursive: true }).filter((n) => /-drop\.png$/.test(String(n))) : []
  ok('terminal: dropped image is saved in the project and confirmed', saved.length === 1 && (await page.getByText(/1 file\(s\) sent/i).count()) > 0, `saved=${saved}`)
  ok('terminal: drop hint gone after sending', (await page.locator('[data-slot="term-drop-hint"]').count()) === 0)
  ok('terminal: image button opens a file picker for images', (await page.locator('[data-slot="term-pick"]').getAttribute('accept')) === 'image/*')

  // ---- file upload over an existing file: asks in the panel's modal (not window.confirm)
  let nativeDialog = false
  page.on('dialog', (d) => { nativeDialog = true; d.dismiss().catch(() => {}) })
  fs.writeFileSync(path.join(ROOT, 'projects', 'demo', 'same.txt'), 'old')
  await page.goto(BASE + '/files/projects/demo')
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.waitFor({ state: 'attached', timeout: 8000 })
  await fileInput.setInputFiles({ name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('new') })
  const ask = page.locator('[data-slot="modal"]')
  await ask.waitFor({ timeout: 5000 }).catch(() => {})
  ok('overwrite asks in the panel modal, not the browser box', (await ask.count()) === 1 && !nativeDialog)
  if (await ask.count()) {
    await ask.getByRole('button', { name: /replace/i }).click()
    await ask.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
    for (let i = 0; i < 20 && fs.readFileSync(path.join(ROOT, 'projects', 'demo', 'same.txt'), 'utf8') !== 'new'; i++) await page.waitForTimeout(150)
    ok('"Replace" overwrites the file', fs.readFileSync(path.join(ROOT, 'projects', 'demo', 'same.txt'), 'utf8') === 'new')
  }
  await page.goto(BASE + '/dashboard')

  // ---- Settings > Update the panel (shown only with DEPLOY_WEBHOOK_URL)
  await page.goto(BASE + '/settings')
  await page.locator('[data-testid="update-card"]').waitFor({ timeout: 8000 }).catch(() => {})
  ok('Settings shows "Update the panel" with a deploy hook', await page.getByRole('button', { name: /update when idle/i }).isVisible().catch(() => false))
  ok('the deploy hook URL is not shown on the page', !(await page.content()).includes('never-called'))
  await page.goto(BASE + '/dashboard')

  // ---- theme (shadcn on Tailwind v4): the classes the shadcn components use must produce CSS.
  // Under Tailwind v3 classes like rounded-4xl / ring-3 / has-data-[...] silently produced nothing.
  await page.locator('[data-slot="project-card"], [data-slot="stat-card"]').first().waitFor({ timeout: 10000 }).catch(() => {})
  const look = await page.evaluate(() => {
    const px = (v) => parseFloat(v) || 0
    const card = document.querySelector('[data-slot="project-card"], [data-slot="stat-card"]')
    const main = document.querySelector('main')
    const btn = document.querySelector('[data-slot="button"]')
    const probe = document.createElement('span'); probe.className = 'rounded-4xl shadow-xs bg-brand'; document.body.appendChild(probe)
    const ps = getComputedStyle(probe); const out = {
      cardRadius: card ? px(getComputedStyle(card).borderTopLeftRadius) : -1,
      cardBorder: card ? px(getComputedStyle(card).borderTopWidth) : -1,
      mainRadius: main ? px(getComputedStyle(main).borderTopLeftRadius) : -1,
      btnRadius: btn ? px(getComputedStyle(btn).borderTopLeftRadius) : -1,
      probeRadius: px(ps.borderTopLeftRadius), probeRing: ps.boxShadow, probeBg: ps.backgroundColor,
      bg: getComputedStyle(document.body).backgroundColor,
    }
    probe.remove(); return out
  })
  ok('cards: rounded + thin border (theme tokens applied)', look.cardRadius >= 10 && look.cardBorder >= 1, JSON.stringify(look))
  ok('layout "inset": the content is a rounded card on desktop', look.mainRadius >= 8, JSON.stringify(look))
  ok('Tailwind v4 classes of the shadcn components generate CSS (rounded-4xl, shadow-xs, bg-brand)', look.probeRadius >= 20 && look.probeRing !== 'none' && !/rgba\(0, 0, 0, 0\)/.test(look.probeBg), JSON.stringify(look))

  // ---- command palette: Ctrl+K opens, typing filters, Enter navigates, Escape closes
  await page.keyboard.press('Control+k')
  const cmd = page.locator('[data-slot="command-menu"]')
  ok('Ctrl+K opens the command palette', await cmd.waitFor({ timeout: 3000 }).then(() => true).catch(() => false))
  ok('the palette lists the pages and the projects', (await cmd.getByRole('option', { name: /logs/i }).count()) > 0 && (await cmd.getByRole('option', { name: /terminal · demo/i }).count()) > 0)
  await page.keyboard.type('logs')
  ok('typing filters the list', (await cmd.getByRole('option').count()) >= 1 && !(await cmd.getByRole('option', { name: /terminal · demo/i }).count()))
  await page.keyboard.press('Enter')
  ok('Enter opens the selected page', await page.waitForURL(/\/logs$/, { timeout: 5000 }).then(() => true).catch(() => false), page.url())
  ok('the palette closes after running', !(await cmd.count()))
  await page.getByTestId('cmd-open').click()
  ok('the header search button opens it too', await cmd.isVisible().catch(() => false))
  await page.keyboard.press('Escape')
  ok('Escape closes the palette', !(await cmd.count()))
  await page.goto(BASE + '/dashboard')

  // ---- every page of the panel opens without a script error (the Backup page was blank: it read
  // a field of the data before the data arrived)
  {
    const pageErrors = []
    const onErr = (e) => pageErrors.push(e.message)
    page.on('pageerror', onErr)
    const broken = []
    for (const route of ['/dashboard', '/terminal', '/files', '/history', '/report', '/logs', '/backup', '/settings', '/notifications', '/account']) {
      pageErrors.length = 0
      await page.goto(BASE + route)
      await page.waitForTimeout(1200)
      const empty = await page.evaluate(() => !document.querySelector('main') || document.querySelector('main').innerText.trim().length < 5)
      if (pageErrors.length || empty) broken.push(`${route}: ${pageErrors[0] || 'empty page'}`)
    }
    page.off('pageerror', onErr)
    ok('every panel page opens without errors', broken.length === 0, broken.join(' | '))
  }

  // ---- one shared health poll: header pill + dashboard card ask /api/health once, not once each
  let healthCalls = 0
  const countHealth = (r) => { if (r.url().endsWith('/api/health')) healthCalls++ }
  page.on('request', countHealth)
  await page.goto(BASE + '/dashboard'); await page.waitForTimeout(2500)
  page.off('request', countHealth)
  ok(`dashboard asks /api/health once (header + card share it): ${healthCalls}`, healthCalls === 1, String(healthCalls))

  // ---- the header theme button follows a theme change made from the palette
  const themeTitle = () => page.locator('header button[title*="("]').first().getAttribute('title')
  const before = await themeTitle()
  await page.keyboard.press('Control+k'); await page.keyboard.type('theme'); await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  ok('header theme button follows a change made in the palette', (await themeTitle()) !== before, before)

  // ---- mobile: the modal fits the screen
  await page.setViewportSize({ width: 375, height: 640 })
  await page.getByRole('button', { name: /new project/i }).first().click() // icon-only on the phone: needs its aria-label
  await modal.waitFor()
  const mb = await modal.boundingBox()
  ok('mobile: modal fits inside the screen', mb && mb.x >= 0 && mb.x + mb.width <= 375 && mb.y >= 0 && mb.y + mb.height <= 640, JSON.stringify(mb))
} catch (e) {
  ok('ui test ran to the end', false, e.message + '\n' + logs.slice(-600))
} finally {
  await browser.close()
  srv.kill()
  fs.rmSync(ROOT, { recursive: true, force: true })
}
console.log(`${passes} PASS, ${fails} FAIL${fails ? '' : ' — TUDO OK'}`)
process.exit(fails ? 1 : 0)
