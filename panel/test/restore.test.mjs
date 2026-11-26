#!/usr/bin/env node
// Smoke test of import / restore (server/restore.js):
//  - upload: not a tgz, '..' / absolute paths, unknown layout -> refused; config and project -> kept;
//  - config restore: merged over the home after a safety config backup, panel login files kept;
//  - project restore: new folder; existing one refused while ON, replaced when OFF (old moved aside);
//  - project from a copy of the volume (VOLUME_BACKUP_DIR/<YYYYMMDD-HHMMSS>/projects/<name>);
//  - sources listing, removal of an upload, login required;
//  - the Backup page renders the card with no page errors (Chrome, when available).
// Usage: node test/restore.test.mjs
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && fs.existsSync(p))
let chromium
try { ({ chromium } = await import('playwright-core')) } catch { /* not installed */ }
const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-restore-'))
const HOME = path.join(ROOT, 'home')
const VOL = path.join(ROOT, 'volume-copies')
const WORK = path.join(ROOT, 'work')
for (const d of [path.join(HOME, 'projects', 'live'), path.join(HOME, '.claude', 'run'), path.join(HOME, '.claude-backups'), WORK]) fs.mkdirSync(d, { recursive: true })
// current state: a secret the restore must keep, a setting it must replace
fs.writeFileSync(path.join(HOME, '.claude', '.panel-secret'), 'CURRENT-SECRET')
fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), '{"old":true}')
fs.writeFileSync(path.join(HOME, '.claude', 'keep-me.txt'), 'not in the backup')
// a copy of the volume with an old project
fs.mkdirSync(path.join(VOL, '20260101-000000', 'projects', 'old1'), { recursive: true })
fs.writeFileSync(path.join(VOL, '20260101-000000', 'projects', 'old1', 'x.txt'), 'from the volume copy')
fs.mkdirSync(path.join(VOL, '20260102-000000.partial'), { recursive: true })
// a backup.sh stand-in: --config writes a config tarball (the safety copy), the rest is a no-op
const BK = path.join(ROOT, 'backup.sh')
// (with the file "skip-config" present it skips like the real one does on a taken lock / low memory: exit 0, no file)
fs.writeFileSync(BK, `#!/bin/sh\n[ -f "${ROOT}/skip-config" ] && exit 0\n[ "$1" = "--config" ] && tar czf "${HOME}/.claude-backups/config-safety-$$.tgz" -C "${HOME}" .claude\nexit 0\n`, { mode: 0o755 })
const NOOP = path.join(ROOT, 'noop.sh')
fs.writeFileSync(NOOP, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

// archives
const tgz = (name, dir, ...items) => { const f = path.join(ROOT, name); spawnSync('tar', ['czf', f, '-C', dir, ...items]); return f }
const C = path.join(WORK, 'c')
fs.mkdirSync(path.join(C, '.claude'), { recursive: true })
fs.writeFileSync(path.join(C, '.claude', 'settings.json'), '{"restored":true}')
fs.writeFileSync(path.join(C, '.claude', '.panel-secret'), 'SECRET-FROM-BACKUP')
fs.writeFileSync(path.join(C, '.claude.json'), '{"restoredJson":1}')
// access lists of an OLD state: must never come back with a restore
fs.writeFileSync(path.join(C, '.claude', '.panel-hub.json'), '{"people":[{"id":"oldperson","hash":"x","label":"revoked long ago","links":[]}]}')
fs.writeFileSync(path.join(C, '.claude', '.panel-chat-keys.json'), '{"keys":[{"id":"oldkey","hash":"y","project":"live","role":"owner"}]}')
const CONFIG_TGZ = tgz('config-a.tgz', C, '.claude', '.claude.json')
const P = path.join(WORK, 'p')
fs.mkdirSync(path.join(P, 'proj1', 'src'), { recursive: true })
fs.writeFileSync(path.join(P, 'proj1', 'src', 'a.txt'), 'project file')
const PROJ_TGZ = tgz('proj1.tgz', P, 'proj1')
const MIX = path.join(WORK, 'm')
fs.mkdirSync(path.join(MIX, 'a'), { recursive: true }); fs.mkdirSync(path.join(MIX, 'b'), { recursive: true })
fs.writeFileSync(path.join(MIX, 'a', '1'), '1'); fs.writeFileSync(path.join(MIX, 'b', '2'), '2')
const MIX_TGZ = tgz('mix.tgz', MIX, 'a', 'b')
// an entry with '..' (python builds it: tar refuses to create one)
const EVIL_TGZ = path.join(ROOT, 'evil.tgz')
spawnSync('python3', ['-c', `import tarfile,io
t=tarfile.open(${JSON.stringify(EVIL_TGZ)},'w:gz')
d=b'x'; i=tarfile.TarInfo('proj/../../escape.txt'); i.size=len(d); t.addfile(i,io.BytesIO(d)); t.close()`])

const PORT = 7000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`
const env = {
  ...process.env, HOME, PANEL_PORT: String(PORT), PANEL_BIND: '127.0.0.1',
  PANEL_LOGIN: 'admin', PANEL_PASSWORD: 'test123', PANEL_TEST_INSECURE_COOKIE: '1',
  PROJECTS_DIR: path.join(HOME, 'projects'), PANEL_CONFIG: path.join(HOME, '.claude', 'panel.json'),
  SESSION_SCRIPT: NOOP, BACKUP_SCRIPT: BK, TMUX_TMPDIR: ROOT, USAGE_API_BASE_URL: 'http://127.0.0.1:9', USAGE_POLL_INTERVAL: '600',
  USAGE_MONITOR: '0', AUTO_RESUME: '0', CLAUDE_AUTO_UPDATE: '0', PANEL_NO_SELF_RESTART: '1', VOLUME_BACKUP_DIR: VOL,
}
delete env.TMUX; delete env.TMUX_PANE
const srv = spawn(process.execPath, ['server.js'], { cwd: PANEL, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
srv.stdout.on('data', (d) => { logs += d }); srv.stderr.on('data', (d) => { logs += d })

let fails = 0, passes = 0
const ok = (name, cond, extra = '') => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + extra)); cond ? passes++ : fails++ }
const H = { origin: BASE, host: `127.0.0.1:${PORT}` }
let cookie = ''
const j = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', cookie, ...H }, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = null; try { data = await r.clone().json() } catch { data = await r.text() }
  return { status: r.status, data, headers: r.headers }
}
const send = async (file, name) => {
  const r = await fetch(`${BASE}/api/backup/import?name=${encodeURIComponent(name || path.basename(file))}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie, ...H }, body: fs.readFileSync(file) })
  return r.json()
}
const read = (...p) => { try { return fs.readFileSync(path.join(HOME, ...p), 'utf8') } catch { return null } }

try {
  await new Promise((r) => setTimeout(r, 1500))
  let r = await fetch(`${BASE}/api/backup/sources`)
  ok('sources need the login', r.status === 401)
  r = await j('POST', '/api/login', { login: 'admin', password: 'test123' })
  cookie = (r.headers.get('set-cookie') || '').split(';')[0]

  // ---- uploads ----
  const junk = path.join(ROOT, 'junk.tgz'); fs.writeFileSync(junk, 'not a tarball')
  r = await send(junk); ok('upload: not a tgz refused', r.ok === false && /tgz/.test(r.msg), JSON.stringify(r))
  r = await send(EVIL_TGZ); ok("upload: a '..' entry refused", r.ok === false && /\.\./.test(r.msg), JSON.stringify(r))
  r = await send(MIX_TGZ); ok('upload: two top folders refused', r.ok === false, JSON.stringify(r))
  ok('upload: refused files are not kept', fs.readdirSync(path.join(HOME, '.claude-restore')).filter((f) => f.endsWith('.tgz')).length === 0)
  r = await send(CONFIG_TGZ, 'my config.tgz'); ok('upload: config tarball recognized', r.ok && r.kind === 'config', JSON.stringify(r))
  const CFG = r.file
  r = await send(PROJ_TGZ); ok('upload: project tarball recognized', r.ok && r.kind === 'project' && r.top === 'proj1', JSON.stringify(r))
  const PRJ = r.file
  r = await j('GET', '/api/backup/sources')
  ok('sources: the two uploads, with name and kind', r.data.imports.length === 2 && r.data.imports.some((f) => f.name === 'my config.tgz' && f.kind === 'config'), JSON.stringify(r.data.imports))
  ok('sources: volume copies (the .partial one left out) and their projects', r.data.volume && r.data.snapshots.length === 1 && r.data.snapshots[0].projects.join() === 'old1', JSON.stringify(r.data.snapshots))

  // ---- config ----
  r = await j('POST', '/api/backup/restore/config', { source: 'upload', file: '../../etc/passwd' })
  ok('config: a bad file name refused', r.data.ok === false)
  r = await j('POST', '/api/backup/restore/config', { source: 'upload', file: PRJ })
  ok('config: a project tarball is not a config', r.data.ok === false)
  fs.writeFileSync(path.join(ROOT, 'skip-config'), '')
  r = await j('POST', '/api/backup/restore/config', { source: 'upload', file: CFG })
  ok('config: refused when the safety backup was skipped (backup.sh exit 0, no new file)', r.data.ok === false && read('.claude', 'settings.json') === '{"old":true}', JSON.stringify(r.data))
  fs.rmSync(path.join(ROOT, 'skip-config'))
  fs.writeFileSync(path.join(HOME, '.claude', '.panel-hub.json'), '{"people":[]}')
  const secretBefore = read('.claude', '.panel-secret')
  r = await j('POST', '/api/backup/restore/config', { source: 'upload', file: CFG })
  ok('config: restored', r.data.ok, JSON.stringify(r.data))
  ok('config: setting replaced, .claude.json restored', read('.claude', 'settings.json') === '{"restored":true}' && read('.claude.json') === '{"restoredJson":1}')
  ok('config: files not in the backup are kept', read('.claude', 'keep-me.txt') === 'not in the backup')
  ok('config: the access lists are NOT replaced (no revoked key comes back)', read('.claude', '.panel-hub.json') === '{"people":[]}' && !/oldkey/.test(read('.claude', '.panel-chat-keys.json') || ''))
  ok('config: the answer names the new safety backup', /^config-safety/.test(r.data.safety || ''), JSON.stringify(r.data))
  ok('config: the panel login secret is NOT replaced', secretBefore && read('.claude', '.panel-secret') === secretBefore)
  ok('config: a safety backup of the old config was made first', fs.readdirSync(path.join(HOME, '.claude-backups')).some((f) => /^config-safety/.test(f)))
  r = await j('GET', '/api/state')
  ok('config: still logged in afterwards', r.status === 200)
  ok('config: no stage folder left behind', !fs.readdirSync(path.join(HOME, '.claude-restore')).some((f) => f.startsWith('stage-')))
  r = await j('GET', '/api/backup/sources')
  const local = r.data.configs.find((f) => /^config-safety/.test(f.file))
  r = await j('POST', '/api/backup/restore/config', { source: 'local', file: local.file })
  ok('config: restore from a config backup of this server (the way back)', r.data.ok && read('.claude', 'settings.json') === '{"old":true}', JSON.stringify(r.data))

  // ---- project from an upload ----
  r = await j('POST', '/api/backup/restore/project', { source: 'upload', file: PRJ })
  ok('project: restored as a new project', r.data.ok && read('projects', 'proj1', 'src', 'a.txt') === 'project file', JSON.stringify(r.data))
  ok('project: a restored project is OFF (Claude does not start by itself)', JSON.parse(read('.claude', 'panel.json')).projects.proj1.enabled === false)
  r = await j('POST', '/api/backup/restore/project', { source: 'upload', file: PRJ, name: 'bad/name' })
  ok('project: a bad name refused', r.data.ok === false)
  r = await j('POST', '/api/backup/restore/project', { source: 'upload', file: PRJ })
  ok('project: existing -> asks first', r.data.ok === false && r.data.exists === true)
  await j('POST', '/api/config', { name: 'proj1', key: 'enabled', value: true })
  r = await j('POST', '/api/backup/restore/project', { source: 'upload', file: PRJ, replace: true })
  ok('project: replace refused while the project is ON', r.data.ok === false && !r.data.exists, JSON.stringify(r.data))
  await j('POST', '/api/power', { name: 'proj1', on: false })
  fs.writeFileSync(path.join(HOME, 'projects', 'proj1', 'changed.txt'), 'local change')
  r = await j('POST', '/api/backup/restore/project', { source: 'upload', file: PRJ, replace: true })
  ok('project: replaced when OFF', r.data.ok && !fs.existsSync(path.join(HOME, 'projects', 'proj1', 'changed.txt')), JSON.stringify(r.data))
  ok('project: the old folder moved aside, not deleted', r.data.replaced && fs.readFileSync(path.join(r.data.replaced, 'changed.txt'), 'utf8') === 'local change')
  r = await j('POST', '/api/backup/restore/project', { source: 'upload', file: PRJ, name: 'proj1-copy' })
  ok('project: restored under another name', r.data.ok && read('projects', 'proj1-copy', 'src', 'a.txt') === 'project file')

  // ---- project from a copy of the volume ----
  r = await j('POST', '/api/backup/restore/project', { source: 'volume', snapshot: '20260101-000000', project: 'old1', name: 'old2' })
  ok('volume: project copied from the copy of the volume', r.data.ok && read('projects', 'old2', 'x.txt') === 'from the volume copy', JSON.stringify(r.data))
  r = await j('POST', '/api/backup/restore/project', { source: 'volume', snapshot: '../x', project: 'old1' })
  ok('volume: a bad copy name refused', r.data.ok === false)
  ok('volume: the copy itself is untouched', fs.existsSync(path.join(VOL, '20260101-000000', 'projects', 'old1', 'x.txt')))

  // ---- removal ----
  r = await j('POST', '/api/backup/import/remove', { file: CFG })
  r = await j('GET', '/api/backup/sources')
  ok('remove: the upload and its info are gone', r.data.imports.length === 1 && !fs.existsSync(path.join(HOME, '.claude-restore', CFG + '.json')))
  const auditTxt = fs.readFileSync(path.join(HOME, '.claude', 'logs', 'audit.log'), 'utf8')
  ok('audit: import and restores logged', /backup\.import/.test(auditTxt) && /backup\.restore\.config/.test(auditTxt) && /backup\.restore\.project/.test(auditTxt))

  // ---- the page ----
  if (chromium && CHROME && fs.existsSync(path.join(PANEL, 'dist', 'index.html'))) {
    const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
    try {
      for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        const ctx = await browser.newContext({ viewport: vp })
        await ctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: BASE }])
        const page = await ctx.newPage()
        const errors = []
        page.on('pageerror', (e) => errors.push(e.message))
        await page.goto(`${BASE}/backup`)
        const shown = await page.getByTestId('restore-import').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
        ok(`page ${vp.width}px: the card lists the upload and the volume projects`, shown && (await page.getByTestId('restore-snap-project').count()) === 1)
        if (process.env.HUB_SHOTS) { await page.getByTestId('restore-card').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.HUB_SHOTS, `restore-${vp.width}.png`) }) }
        ok(`page ${vp.width}px: no page errors`, errors.length === 0, errors.join(' | '))
        await ctx.close()
      }
    } finally { await browser.close() }
  }
  ok('nothing escaped the home', !fs.existsSync(path.join(ROOT, 'escape.txt')) && !fs.existsSync(path.join(HOME, 'escape.txt')))
} catch (e) {
  console.log('  EXCEPTION', e); fails++
} finally {
  srv.kill()
  if (fails) console.log('\n--- server log ---\n' + logs.split('\n').slice(-25).join('\n'))
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* */ }
  console.log(`\n${passes} PASS, ${fails} FAIL${fails ? '' : ' — ALL OK'}`)
  process.exit(fails ? 1 : 0)
}
