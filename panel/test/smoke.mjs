#!/usr/bin/env node
// Smoke test do server.js do painel. Sobe o servidor num HOME temporario e exercita: auth
// (login, cookie assinado, rate-limit, CSRF, 2FA, sessoes), arquivos (sandbox, upload/download),
// projetos/config, relatorio, logs, saude, backup, settings, SSE e o WebSocket do terminal.
// Com `tmux` disponivel (Linux/CI) o WebSocket abre um PTY REAL e valida a saida da sessao.
// Uso: node test/smoke.mjs   (ou npm test)
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const WSLib = require(path.join(PANEL, 'node_modules', 'ws'))
const totp = require(path.join(PANEL, 'server', 'totp.js'))

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-smoke-'))
fs.mkdirSync(path.join(ROOT, 'projects', 'demo'), { recursive: true })
const HAS_TMUX = spawnSync('tmux', ['-V']).status === 0
const PORT = 7000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`
// session script falso: cria a sessao tmux do projeto (como o claude-session.sh faria)
const SESSION_SCRIPT = path.join(ROOT, 'session.sh')
fs.writeFileSync(SESSION_SCRIPT, '#!/usr/bin/env bash\nn="$1"; s="claude-$n"; tmux has-session -t "=$s" 2>/dev/null && exit 0; tmux new-session -d -s "$s" -c "$HOME" "echo SMOKE-READY-$n; exec bash"\n')
const BACKUP_SCRIPT = path.join(ROOT, 'backup.sh')
fs.writeFileSync(BACKUP_SCRIPT, '#!/usr/bin/env bash\nmkdir -p "$HOME/.claude/logs"; echo "[2026-01-01 00:00:00] ok    demo: snapshot enviado" | tee -a "$HOME/.claude/logs/backup.log"; if [ "$1" = "--config" ]; then mkdir -p "$HOME/.claude-backups"; tar czf "$HOME/.claude-backups/config-smoke.tgz" -C "$HOME" .claude; echo "[2026-01-01 00:00:00] ok    config: config-smoke.tgz"; fi\n')

// no Windows, bash/tar do Git for Windows (p/ os scripts falsos de backup)
let PATH = process.env.PATH || ''
if (process.platform === 'win32') {
  for (const d of ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\bin']) if (fs.existsSync(d)) PATH = d + path.delimiter + PATH
}
const env = {
  ...process.env, PATH, HOME: ROOT, PANEL_PORT: String(PORT), PANEL_BIND: '127.0.0.1', PANEL_LOGIN: 'admin', PANEL_PASSWORD: 'test123',
  PROJECTS_DIR: path.join(ROOT, 'projects'), PANEL_CONFIG: path.join(ROOT, '.claude', 'panel.json'),
  SESSION_SCRIPT, BACKUP_SCRIPT, TMUX_TMPDIR: ROOT,
}
// historico falso do Claude (usado pelo relatorio de custo e pela pagina Historico) — antes de
// subir o servidor, porque o relatorio cacheia a varredura por 10s
const encDir = path.join(ROOT, '.claude', 'projects', path.join(ROOT, 'projects', 'demo').replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(encDir, { recursive: true })
fs.writeFileSync(path.join(encDir, 'abc123def456.jsonl'), [
  JSON.stringify({ timestamp: '2026-08-01T10:00:00Z', message: { role: 'user', content: 'Cria um README' } }),
  JSON.stringify({ timestamp: '2026-08-01T10:00:05Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Feito.' }], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 } } }),
].join('\n') + '\n')
const srv = spawn(process.execPath, ['server.js'], { cwd: PANEL, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
srv.stdout.on('data', (d) => { logs += d })
srv.stderr.on('data', (d) => { logs += d })
await new Promise((r) => setTimeout(r, 1500))

let fails = 0, passes = 0
const ok = (name, cond, extra = '') => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + extra)); cond ? passes++ : fails++ }
const skip = (name) => console.log('  SKIP ' + name)
const H = { origin: BASE, host: `127.0.0.1:${PORT}` }
let cookie = ''
const j = async (method, url, body, extra = {}) => {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', cookie, ...H, ...extra.headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) })
  let data = null; try { data = await r.clone().json() } catch { data = await r.text() }
  return { status: r.status, data, headers: r.headers }
}
const wsOpen = (url, headers) => new Promise((resolve) => {
  const ws = new WSLib(url, { headers })
  const out = { code: null, reason: '', data: '', ctl: [] }
  ws.on('message', (m) => { const s = m.toString(); if (s.charCodeAt(0) === 1) out.ctl.push(JSON.parse(s.slice(1))); else out.data += s })
  ws.on('close', (code, reason) => { out.code = code; out.reason = reason.toString(); resolve(out) })
  ws.on('error', (e) => { out.code = -1; out.reason = e.message; resolve(out) })
  out.ws = ws
  out.done = () => resolve(out)
  return out
})

try {
  console.log(`\n== servidor em ${BASE} | HOME=${ROOT} | tmux: ${HAS_TMUX ? 'sim' : 'nao'}\n`)
  let r = await fetch(BASE + '/healthz'); ok('healthz', r.status === 200 && (await r.text()) === 'ok')
  r = await j('GET', '/api/login/info'); ok('login/info sem 2FA', r.data.ok && r.data.twofa === false)
  r = await j('GET', '/api/state'); ok('state sem auth -> 401', r.status === 401)
  r = await j('POST', '/api/login', { login: 'admin', password: 'errada' }); ok('login errado', r.data.ok === false)
  r = await j('POST', '/api/login', '{bad json'); ok('login corpo invalido -> 400', r.status === 400)
  r = await j('POST', '/api/login', { login: 'admin', password: 'test123' }, { headers: { origin: 'http://evil.example' } }); ok('login origem errada -> 403', r.status === 403)
  r = await j('POST', '/api/login', { login: 'admin', password: 'test123' })
  ok('login certo', r.data.ok === true && /cr_auth=/.test(r.headers.get('set-cookie') || ''))
  cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  ok('cookie assinado tem 2 partes', cookie.split('=')[1].split('.').length === 2)
  ok('segredo persistido', fs.existsSync(path.join(ROOT, '.claude', '.panel-secret')))
  ok('store de sessoes persistido', fs.existsSync(path.join(ROOT, '.claude', '.panel-sessions.json')))

  // cookie forjado com sid inexistente -> 401
  const forged = cookie.replace(/^cr_auth=/, '')
  const [payload] = forged.split('.')
  const fakePayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sid: 'deadbeef' })).toString('base64url')
  r = await fetch(BASE + '/api/state', { headers: { cookie: `cr_auth=${fakePayload}.${forged.split('.')[1]}` } }); ok('cookie com assinatura errada -> 401', r.status === 401)

  await new Promise((s) => setTimeout(s, 2500)) // watcher roda o 1o tick
  r = await j('GET', '/api/state'); ok('state com auth', r.status === 200 && Array.isArray(r.data.projects) && r.data.projects[0]?.name === 'demo', JSON.stringify(r.data).slice(0, 200))
  ok('state: shellSession + settings', r.data.shellSession === 'cr-shell' && typeof r.data.settings === 'object')
  r = await j('GET', '/api/report?from=2026-01-01&to=2026-12-31'); ok('report', r.data.ok === true && 'cost' in r.data.usage.total && Array.isArray(r.data.usage.unknownModels))
  r = await j('GET', '/api/report?from=xx'); ok('report data invalida', r.data.ok === false)

  // arquivos
  r = await j('POST', '/api/fs/create', { path: 'projects/demo/a.txt', kind: 'file' }); ok('fs create', r.data.ok, r.data.msg)
  r = await j('POST', '/api/fs/save', { path: 'projects/demo/a.txt', content: 'olá\n' }); ok('fs save', r.data.ok)
  r = await j('GET', '/api/fs/read?path=projects/demo/a.txt'); ok('fs read', r.data.ok && r.data.content === 'olá\n')
  r = await j('GET', '/api/fs/stat?path=projects/demo'); ok('fs stat dir', r.data.ok && r.data.type === 'dir')
  r = await j('GET', '/api/fs/list?path=projects/demo'); ok('fs list', r.data.ok && r.data.entries.some((e) => e.name === 'a.txt' && typeof e.mtime === 'number'))
  r = await j('GET', '/api/fs/list?path=../../'); ok('fs traversal bloqueado', r.data.ok === false)
  r = await j('GET', '/api/fs/read?path=..%5C..%5Cetc'); ok('fs traversal backslash bloqueado', r.data.ok === false)
  r = await j('POST', '/api/fs/rename', { path: 'projects/demo/a.txt', newPath: 'projects/demo/b.txt' }); ok('fs rename', r.data.ok)
  r = await fetch(BASE + '/api/fs/download?path=projects/demo/b.txt', { headers: { cookie } }); ok('fs download', r.status === 200 && /attachment/.test(r.headers.get('content-disposition')) && (await r.text()) === 'olá\n')
  r = await fetch(BASE + '/api/fs/upload?path=projects/demo/up.bin', { method: 'POST', headers: { cookie, ...H, 'content-type': 'application/octet-stream' }, body: Buffer.from([0, 1, 2, 3]) }); ok('fs upload', (await r.json()).ok)
  r = await j('GET', '/api/fs/read?path=projects/demo/up.bin'); ok('fs read binario recusado', r.data.ok === false && r.data.code === 'BINARY')
  r = await j('POST', '/api/fs/delete', { path: '' }); ok('fs delete raiz bloqueado', r.data.ok === false)
  r = await j('POST', '/api/fs/delete', { path: '.claude' }); ok('fs delete .claude protegido', r.data.ok === false)
  r = await j('POST', '/api/fs/delete', { path: 'projects/demo/b.txt' }); ok('fs delete', r.data.ok)

  // projetos / config
  r = await j('POST', '/api/config', { name: 'demo', key: 'autoStartClaude', value: false }); ok('config set', r.data.ok, r.data.msg)
  r = await j('POST', '/api/initline', { name: 'demo', text: 'oi\nmundo' }); ok('initline', r.data.ok)
  const cfgj = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'panel.json'), 'utf8')); ok('panel.json gravado', cfgj.projects.demo.autoStartClaude === false && cfgj.projects.demo.initLine === 'oi mundo')
  r = await j('POST', '/api/config', { name: 'x y', key: 'autoRemote', value: true }); ok('config nome invalido', r.data.ok === false)
  r = await j('POST', '/api/nada', {}); ok('rota POST desconhecida 404', r.status === 404)
  r = await j('POST', '/api/create', { name: 'demo' }, { headers: { origin: 'http://evil.example' } }); ok('POST origem errada -> 403', r.status === 403)
  r = await j('GET', '/api/term/status'); ok('term status', r.data.ok === true && typeof r.data.pty === 'boolean')

  // settings / logs / saude / backup / historico / sessoes
  r = await j('POST', '/api/settings/defaults', { autoRemote: false }); ok('settings defaults', r.data.ok && r.data.defaults.autoRemote === false)
  r = await j('POST', '/api/settings', { notifyDone: false }); ok('settings prefs', r.data.ok && r.data.settings.notifyDone === false)
  r = await j('GET', '/api/settings'); ok('settings get (env mascarado)', r.data.ok && r.data.env.find((e) => e.key === 'PANEL_PASSWORD').value !== 'test123' && r.data.defaults.autoRemote === false)
  r = await j('GET', '/api/logs'); ok('logs list', r.data.ok && r.data.logs.some((l) => l.key === 'audit'))
  r = await j('GET', '/api/logs/tail?file=audit&lines=50'); ok('audit log registrou acoes', r.data.ok && r.data.lines.some((l) => /"action":"config"/.test(l)) && r.data.lines.some((l) => /login\.ok/.test(l)), JSON.stringify(r.data).slice(0, 300))
  r = await j('GET', '/api/logs/tail?file=nada'); ok('log desconhecido', r.data.ok === false)
  r = await j('GET', '/api/health'); ok('health', r.data.ok && r.data.mem && Array.isArray(r.data.load) && r.data.claude, JSON.stringify(r.data).slice(0, 200))
  r = await j('POST', '/api/backup/run', { name: 'demo' }); ok('backup run', r.data.ok, r.data.msg)
  r = await j('POST', '/api/backup/config', {}); ok('backup config', r.data.ok && r.data.backups.length >= 1, r.data.msg)
  r = await j('GET', '/api/backup/status'); ok('backup status', r.data.ok && r.data.projects[0].last && r.data.configBackups.length >= 1)
  r = await fetch(BASE + '/api/backup/download?file=config-smoke.tgz', { headers: { cookie } }); ok('backup download arquivo', r.status === 200 && r.headers.get('content-type') === 'application/gzip' && (await r.arrayBuffer()).byteLength > 20)
  r = await fetch(BASE + '/api/backup/download?file=../x.tgz', { headers: { cookie } }); ok('backup download nome invalido', r.status === 400)
  r = await j('GET', '/api/history?name=demo'); ok('history list', r.data.ok && r.data.sessions[0]?.title === 'Cria um README' && r.data.sessions[0].model === 'claude-opus-5', JSON.stringify(r.data).slice(0, 200))
  r = await j('GET', '/api/history/conversation?name=demo&id=abc123def456'); ok('history conversation', r.data.ok && r.data.conversation.items.length === 2)
  r = await j('GET', '/api/report'); ok('report custo por modelo', r.data.ok && r.data.usage.byModel['claude-opus-5'] && r.data.usage.total.cost > 0, JSON.stringify(r.data.usage.byModel))
  r = await j('GET', '/api/sessions'); ok('sessoes ativas lista a atual', r.data.ok && r.data.sessions.some((s) => s.current))
  // segunda sessao + revogar
  const r2 = await j('POST', '/api/login', { login: 'admin', password: 'test123' })
  const cookie2 = (r2.headers.get('set-cookie') || '').split(';')[0]
  r = await j('GET', '/api/sessions'); const other = r.data.sessions.find((s) => !s.current); ok('segunda sessao aparece', !!other)
  r = await j('POST', '/api/sessions/revoke', { id: other.id }); ok('revogar sessao', r.data.ok)
  r = await fetch(BASE + '/api/state', { headers: { cookie: cookie2 } }); ok('sessao revogada -> 401', r.status === 401)

  // 2FA
  r = await j('POST', '/api/totp/setup', {}); ok('totp setup', r.data.ok && /^otpauth:\/\/totp\//.test(r.data.otpauth) && r.data.secret.length >= 16)
  const secret = r.data.secret
  const codeNow = () => totp._code(secret)
  const wrong = () => { const g = codeNow(); return g === '000000' ? '000001' : '000000' }
  r = await j('POST', '/api/totp/enable', { code: wrong() }); ok('totp enable codigo errado', r.data.ok === false)
  const good = codeNow()
  r = await j('POST', '/api/totp/enable', { code: good }); ok('totp enable', r.data.ok, r.data.msg)
  r = await j('GET', '/api/login/info'); ok('login/info com 2FA', r.data.twofa === true)
  const saveCookie = cookie; cookie = ''
  r = await j('POST', '/api/login', { login: 'admin', password: 'test123' }); ok('login sem codigo -> need2fa', r.data.ok === false && r.data.need2fa === true)
  r = await j('POST', '/api/login', { login: 'admin', password: 'test123', code: good }); ok('login com codigo 2FA', r.data.ok === true, r.data.msg)
  r = await j('POST', '/api/login', { login: 'admin', password: 'test123', code: good }); ok('mesmo codigo de novo -> recusa (replay)', r.data.ok === false, r.data.msg)
  cookie = saveCookie
  r = await j('POST', '/api/totp/disable', { code: wrong() }); ok('totp disable codigo errado', r.data.ok === false)
  r = await j('POST', '/api/totp/disable', { code: codeNow() }); ok('totp disable', r.data.ok, r.data.msg)

  // static
  r = await fetch(BASE + '/'); ok('index', r.status === 200 && /text\/html/.test(r.headers.get('content-type')) && r.headers.get('cache-control') === 'no-store')
  ok('CSP presente', /default-src 'self'/.test(r.headers.get('content-security-policy') || ''))
  r = await fetch(BASE + '/terminal/demo'); ok('SPA fallback /terminal/demo', r.status === 200 && /<div id="root">/.test(await r.text()))
  r = await fetch(BASE + '/files/projects/demo'); ok('SPA fallback /files/...', r.status === 200)
  const assets = fs.existsSync(path.join(PANEL, 'dist', 'assets')) ? fs.readdirSync(path.join(PANEL, 'dist', 'assets')) : []
  const asset = assets.find((f) => f.startsWith('xterm-') && f.endsWith('.js'))
  if (asset) { r = await fetch(BASE + '/assets/' + asset); ok('asset imutavel', r.status === 200 && /immutable/.test(r.headers.get('cache-control'))) } else skip('asset imutavel (sem dist)')
  r = await fetch(BASE + '/manifest.webmanifest'); if (assets.length) ok('manifest PWA', r.status === 200); else skip('manifest (sem dist)')

  // SSE
  {
    const ac = new AbortController()
    const res = await fetch(BASE + '/api/events', { headers: { cookie }, signal: ac.signal })
    ok('SSE content-type', /text\/event-stream/.test(res.headers.get('content-type') || ''))
    const reader = res.body.getReader()
    let buf = ''
    const t0 = Date.now()
    while (Date.now() - t0 < 4000 && !/event: state/.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += Buffer.from(value).toString() }
    ok('SSE envia state', /event: state/.test(buf) && /"projects"/.test(buf))
    ok('SSE envia activity', /event: activity/.test(buf))
    ac.abort()
  }

  // websocket
  {
    const refused = (o) => o.code !== 1000 && !o.ctl.some((c) => c.type === 'ready') && (o.code === -1 || o.code === 1006 || o.code >= 4000)
    const noCookie = await wsOpen(`ws://127.0.0.1:${PORT}/ws/term?name=shell`, { origin: BASE })
    ok('ws sem cookie -> recusado', refused(noCookie), JSON.stringify({ code: noCookie.code, reason: noCookie.reason }))
    const badOrigin = await wsOpen(`ws://127.0.0.1:${PORT}/ws/term?name=shell`, { cookie, origin: 'http://evil.example' })
    ok('ws origem errada -> recusado', refused(badOrigin), JSON.stringify({ code: badOrigin.code, reason: badOrigin.reason }))
    if (HAS_TMUX) {
      // sessao real: espera "ready" + banner do session.sh falso, manda um echo e le a resposta
      const probe = await new Promise((resolve) => {
        const ws = new WSLib(`ws://127.0.0.1:${PORT}/ws/term?name=demo&cols=100&rows=30`, { headers: { cookie, origin: BASE } })
        let data = ''; const ctl = []
        ws.on('message', (m) => { const s = m.toString(); if (s.charCodeAt(0) === 1) ctl.push(JSON.parse(s.slice(1))); else data += s })
        ws.on('open', () => setTimeout(() => ws.send('echo PING-$((40+2))\r'), 800))
        ws.on('error', (e) => resolve({ err: e.message, data, ctl }))
        setTimeout(() => { ws.send('\x01' + JSON.stringify({ type: 'resize', cols: 90, rows: 25 })); ws.close(); }, 2500)
        ws.on('close', () => resolve({ data, ctl }))
      })
      ok('ws PTY real: ready', probe.ctl.some((c) => c.type === 'ready' && c.session === 'claude-demo'), JSON.stringify(probe.ctl))
      ok('ws PTY real: banner da sessao', /SMOKE-READY-demo/.test(probe.data), probe.data.slice(0, 200))
      ok('ws PTY real: comando ecoado', /PING-42/.test(probe.data), probe.data.slice(-300))
      const sess = spawnSync('tmux', ['has-session', '-t', '=claude-demo'], { env }); ok('sessao tmux continua viva apos fechar o ws', sess.status === 0)
      r = await j('GET', '/api/term/windows?name=demo'); ok('term windows', r.data.ok && r.data.windows.length >= 1, JSON.stringify(r.data))
      r = await j('POST', '/api/term/window', { name: 'demo', action: 'new' }); ok('term window new', r.data.ok, r.data.msg)
      r = await j('GET', '/api/term/windows?name=demo'); ok('term windows = 2', r.data.ok && r.data.windows.length === 2)
      r = await j('POST', '/api/term/window', { name: 'demo', action: 'kill', index: r.data.windows[1].index }); ok('term window kill', r.data.ok, r.data.msg)
      r = await j('GET', '/api/term/capture?name=demo'); ok('term capture', r.data.ok && /SMOKE-READY/.test(r.data.content))
      await new Promise((s) => setTimeout(s, 4500)) // watcher: 2 ticks quietos -> activity
      r = await j('GET', '/api/state'); ok('state: activity do watcher', ['idle', 'busy', 'prompt', 'off'].includes(r.data.projects[0].activity), JSON.stringify(r.data.projects[0]))
    } else {
      const o = await wsOpen(`ws://127.0.0.1:${PORT}/ws/term?name=demo&cols=100&rows=30`, { cookie, origin: BASE })
      ok('ws com cookie -> upgrade OK, fecha 4003/4004 (sem pty/tmux aqui)', o.code === 4003 || o.code === 4004, JSON.stringify({ code: o.code, reason: o.reason }))
      skip('ws PTY real (sem tmux nesta maquina)')
    }
  }

  // rate limit
  cookie = ''
  let last
  for (let i = 0; i < 9; i++) last = (await j('POST', '/api/login', { login: 'admin', password: 'x' })).data
  ok('rate-limit apos 8 falhas', /muitas tentativas/.test(last.msg), last.msg)

  // logout
  r = await j('POST', '/api/logout'); ok('logout limpa cookie', /Max-Age=0/.test(r.headers.get('set-cookie') || ''))
} catch (e) {
  console.log('  EXCEPTION', e); fails++
} finally {
  srv.kill()
  if (HAS_TMUX) spawnSync('tmux', ['kill-server'], { env })
  if (fails) console.log('\n--- server log ---\n' + logs.split('\n').slice(-20).join('\n'))
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* */ }
  console.log(`\n${passes} PASS, ${fails} FAIL${fails ? '' : ' — TUDO OK'}`)
  process.exit(fails ? 1 : 0)
}
