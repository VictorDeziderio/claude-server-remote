#!/usr/bin/env node
// Smoke test of the Files viewer: /api/fs/download?inline=1 (server/files.js) and the viewer of the
// Files page (src/components/FileViewer.jsx).
//  - inline only for images / PDF / video / audio; any other file is still an attachment;
//  - SVG and media get a sandboxed CSP; the PDF may be framed by the panel only (SAMEORIGIN);
//  - byte ranges (iOS video): 206 / 416;
//  - Chrome (1280 and 390 wide): tapping an image opens the viewer, next / previous / keyboard /
//    swipe step through the images, PDF and video of the folder, Esc closes; a link straight to an
//    image opens its folder with the viewer on it; text files still open in the editor.
// Usage: node test/viewer.test.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && fs.existsSync(p))
let chromium
try { ({ chromium } = await import('playwright-core')) } catch { /* not installed */ }
const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-viewer-'))
const DIR = path.join(ROOT, 'projects', 'pics')
fs.mkdirSync(DIR, { recursive: true })
fs.mkdirSync(path.join(ROOT, '.claude', 'run'), { recursive: true })
const NOOP = path.join(ROOT, 'noop.sh')
fs.writeFileSync(NOOP, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

// a real PNG of w x h in one color
function png(w, h, [r, g, b]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))])
}
fs.writeFileSync(path.join(DIR, 'a-red.png'), png(64, 48, [220, 40, 40]))
fs.writeFileSync(path.join(DIR, 'b-blue.png'), png(48, 64, [40, 80, 220]))
fs.writeFileSync(path.join(DIR, 'c-logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>window.x=1</script><circle cx="20" cy="20" r="18" fill="green"/></svg>')
fs.writeFileSync(path.join(DIR, 'd-doc.pdf'), '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
fs.writeFileSync(path.join(DIR, 'e-clip.mp4'), Buffer.alloc(5000, 7))
fs.writeFileSync(path.join(DIR, 'notes.txt'), 'plain text')
fs.writeFileSync(path.join(DIR, 'page.html'), '<script>alert(1)</script>')

const PORT = 7000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`
const env = {
  ...process.env, HOME: ROOT, PANEL_PORT: String(PORT), PANEL_BIND: '127.0.0.1',
  PANEL_LOGIN: 'admin', PANEL_PASSWORD: 'test123', PANEL_TEST_INSECURE_COOKIE: '1',
  PROJECTS_DIR: path.join(ROOT, 'projects'), PANEL_CONFIG: path.join(ROOT, '.claude', 'panel.json'),
  SESSION_SCRIPT: NOOP, BACKUP_SCRIPT: NOOP, TMUX_TMPDIR: ROOT, USAGE_API_BASE_URL: 'http://127.0.0.1:9', USAGE_POLL_INTERVAL: '600',
  USAGE_MONITOR: '0', AUTO_RESUME: '0', CLAUDE_AUTO_UPDATE: '0',
}
delete env.TMUX; delete env.TMUX_PANE
const srv = spawn(process.execPath, ['server.js'], { cwd: PANEL, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
srv.stdout.on('data', (d) => { logs += d }); srv.stderr.on('data', (d) => { logs += d })

let fails = 0, passes = 0
const ok = (name, cond, extra = '') => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + extra)); cond ? passes++ : fails++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let cookie = ''
const dl = (p, inline, headers = {}) => fetch(`${BASE}/api/fs/download?path=${encodeURIComponent('projects/pics/' + p)}${inline ? '&inline=1' : ''}`, { headers: { cookie, ...headers } })

try {
  await sleep(1500)
  const lr = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, host: `127.0.0.1:${PORT}` }, body: JSON.stringify({ login: 'admin', password: 'test123' }) })
  cookie = (lr.headers.get('set-cookie') || '').split(';')[0]

  let r = await dl('a-red.png', true)
  ok('png inline', r.status === 200 && /^inline/.test(r.headers.get('content-disposition')) && r.headers.get('content-type') === 'image/png')
  r = await dl('a-red.png', false)
  ok('png without inline=1 is still a download', /^attachment/.test(r.headers.get('content-disposition')))
  r = await dl('c-logo.svg', true)
  ok('svg inline in a sandbox (its script cannot run as the panel)', /^inline/.test(r.headers.get('content-disposition')) && /sandbox/.test(r.headers.get('content-security-policy')))
  r = await dl('d-doc.pdf', true)
  ok('pdf inline, framed by the panel only', /^inline/.test(r.headers.get('content-disposition')) && r.headers.get('x-frame-options') === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(r.headers.get('content-security-policy')))
  r = await dl('page.html', true)
  ok('html is never inline', /^attachment/.test(r.headers.get('content-disposition')))
  r = await dl('notes.txt', true)
  ok('txt is never inline', /^attachment/.test(r.headers.get('content-disposition')))
  r = await dl('e-clip.mp4', true, { range: 'bytes=100-199' })
  ok('video: byte range -> 206', r.status === 206 && r.headers.get('content-range') === 'bytes 100-199/5000' && (await r.arrayBuffer()).byteLength === 100)
  r = await dl('e-clip.mp4', true, { range: 'bytes=9000-' })
  ok('video: range past the end -> 416', r.status === 416)
  r = await fetch(`${BASE}/api/fs/download?path=projects/pics/a-red.png&inline=1`)
  ok('inline needs the login too', r.status === 401)

  if (chromium && CHROME && fs.existsSync(path.join(PANEL, 'dist', 'index.html'))) {
    const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
    try {
      for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile })
        await ctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: BASE }])
        const page = await ctx.newPage()
        const errors = []
        page.on('pageerror', (e) => errors.push(e.message))
        await page.goto(`${BASE}/files/projects/pics`)
        await page.getByText('a-red.png').first().waitFor({ timeout: 15000 })
        await page.getByText('a-red.png').first().click()
        const v = page.getByTestId('file-viewer')
        ok(`${w}px: tapping an image opens the viewer`, await v.waitFor({ timeout: 5000 }).then(() => true).catch(() => false))
        ok(`${w}px: the image is shown (loaded)`, await page.waitForFunction(() => { const i = document.querySelector('[data-testid=viewer-image]'); return i && i.complete && i.naturalWidth === 64 }, null, { timeout: 5000 }).then(() => true).catch(() => false))
        ok(`${w}px: position 1 of 5 (images, svg, pdf, video; not txt/html)`, /1 (of|de) 5/.test(await v.innerText()), await v.innerText())
        if (w === 1280) await page.screenshot({ path: path.join(process.env.HUB_SHOTS || ROOT, `viewer-${w}-image.png`) })
        await page.getByTestId('viewer-next').click()
        ok(`${w}px: next -> the second image`, (await page.getByTestId('viewer-name').innerText()) === 'b-blue.png')
        if (mobile) {
          // swipe left -> next
          await page.evaluate(() => {
            const el = document.querySelector('[data-testid=viewer-image]').parentElement
            const tp = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 })
            el.dispatchEvent(new TouchEvent('touchstart', { touches: [tp(300)], changedTouches: [tp(300)], bubbles: true }))
            el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [tp(120)], bubbles: true }))
          })
        } else await page.keyboard.press('ArrowRight')
        ok(`${w}px: ${mobile ? 'swipe' : 'arrow key'} -> the svg`, (await page.getByTestId('viewer-name').innerText()) === 'c-logo.svg')
        await page.getByTestId('viewer-next').click()
        ok(`${w}px: the pdf in a frame`, (await page.getByTestId('viewer-pdf').count()) === 1)
        if (w === 1280) { await sleep(800); await page.screenshot({ path: path.join(process.env.HUB_SHOTS || ROOT, `viewer-${w}-pdf.png`) }) }
        await page.getByTestId('viewer-next').click()
        // the test file is not a real video: the player gives up and the viewer says so (with download / new tab)
        ok(`${w}px: the video player, or the "cannot show" note for a broken file`, await page.waitForFunction(() => !!document.querySelector('[data-testid=viewer-video]') || /cannot be shown|não pode ser mostrado/.test(document.querySelector('[data-testid=file-viewer]')?.innerText || ''), null, { timeout: 5000 }).then(() => true).catch(() => false))
        ok(`${w}px: next is off on the last file`, await page.getByTestId('viewer-next').isDisabled())
        await page.getByTestId('viewer-prev').click()
        ok(`${w}px: previous goes back`, (await page.getByTestId('viewer-name').innerText()) === 'd-doc.pdf')
        await page.keyboard.press('Escape')
        ok(`${w}px: Esc closes`, (await page.getByTestId('file-viewer').count()) === 0)
        await page.getByText('notes.txt').first().click()
        ok(`${w}px: a text file still opens in the editor`, await page.waitForURL(/notes\.txt$/, { timeout: 5000 }).then(() => true).catch(() => false) && (await page.getByTestId('file-viewer').count()) === 0)
        await page.goto(`${BASE}/files/projects/pics/b-blue.png`)
        ok(`${w}px: a link straight to an image opens the viewer on it`, await page.getByTestId('file-viewer').waitFor({ timeout: 8000 }).then(() => true).catch(() => false) && (await page.getByTestId('viewer-name').innerText()) === 'b-blue.png')
        if (mobile) await page.screenshot({ path: path.join(process.env.HUB_SHOTS || ROOT, `viewer-${w}-image.png`) })
        ok(`${w}px: no page errors`, errors.length === 0, errors.join(' | '))
        await ctx.close()
      }
    } finally { await browser.close() }
  }
} catch (e) {
  console.log('  EXCEPTION', e); fails++
} finally {
  srv.kill()
  if (fails) console.log('\n--- server log ---\n' + logs.split('\n').slice(-20).join('\n'))
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* */ }
  console.log(`\n${passes} PASS, ${fails} FAIL${fails ? '' : ' — ALL OK'}`)
  process.exit(fails ? 1 : 0)
}
