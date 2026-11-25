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
// claude-session.sh REAL (respeita enabled/autoStartClaude do panel.json) + supervisor FALSO
// (no lugar do claude-loop.sh: imprime um banner e vira um bash)
const DEVBOX = path.resolve(PANEL, '..')
const SESSION_SCRIPT = path.join(DEVBOX, 'claude-session.sh')
const FAKE_LOOP = path.join(ROOT, 'loop.sh')
fs.writeFileSync(FAKE_LOOP, '#!/usr/bin/env bash\necho SMOKE-READY-$2; exec bash --norc\n')
// `claude` FALSO: simula o 1o login (tema -> metodo -> link OAuth LONGO -> codigo -> sucesso)
const BIN = path.join(ROOT, 'bin')
fs.mkdirSync(BIN)
const LONG = 'x'.repeat(700) // link maior que a janela de 500 colunas: testa a juncao das linhas
fs.writeFileSync(path.join(BIN, 'claude'), `#!/usr/bin/env bash
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
echo "Choose the text style that looks best with your terminal"; read -r _
echo "Select login method:"; echo " ❯ 1. Claude account with subscription · Pro, Max"; read -r _
echo "Browser didn't open? Use the url below to sign in"
echo "https://claude.ai/oauth/authorize?code=true&client_id=abc&state=${LONG}"
printf "Paste code here if prompted > "; read -r code
if [ "$code" = "good-code" ]; then mkdir -p "$HOME/.claude"; echo '{"ok":1}' > "$HOME/.claude/.credentials.json"; echo "Login successful. Press Enter to continue"; read -r _; fi
`, { mode: 0o755 })
const BACKUP_SCRIPT = path.join(ROOT, 'backup.sh')
fs.writeFileSync(BACKUP_SCRIPT, '#!/usr/bin/env bash\nmkdir -p "$HOME/.claude/logs"; echo "[2026-01-01 00:00:00] ok    demo: snapshot enviado" | tee -a "$HOME/.claude/logs/backup.log"; if [ "$1" = "--config" ]; then mkdir -p "$HOME/.claude-backups"; tar czf "$HOME/.claude-backups/config-smoke.tgz" -C "$HOME" .claude; echo "[2026-01-01 00:00:00] ok    config: config-smoke.tgz"; fi\n')

// no Windows, bash/tar do Git for Windows (p/ os scripts falsos de backup)
let PATH = BIN + path.delimiter + (process.env.PATH || '')
if (process.platform === 'win32') {
  for (const d of ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\bin']) if (fs.existsSync(d)) PATH = d + path.delimiter + PATH
}
const env = {
  ...process.env, PATH, HOME: ROOT, PANEL_PORT: String(PORT), PANEL_BIND: '127.0.0.1', PANEL_LOGIN: 'admin', PANEL_PASSWORD: 'test123',
  // teste roda em http puro em localhost: so o teste desliga o Secure do cookie (producao real,
  // atras do Traefik em https, nunca passa essa flag — ver server/auth.js)
  PANEL_TEST_INSECURE_COOKIE: '1',
  PROJECTS_DIR: path.join(ROOT, 'projects'), PANEL_CONFIG: path.join(ROOT, '.claude', 'panel.json'),
  SESSION_SCRIPT, BACKUP_SCRIPT, TMUX_TMPDIR: ROOT,
  DEVBOX_LIB: path.join(DEVBOX, 'devbox-lib.sh'), CLAUDE_LOOP: FAKE_LOOP,
}
// Run from inside tmux, the inherited $TMUX points at the REAL server and wins over TMUX_TMPDIR:
// the final `tmux kill-server` would kill every live session on the box. Isolate the socket.
delete env.TMUX
delete env.TMUX_PANE
// historico falso do Claude (usado pelo relatorio de custo e pela pagina Historico) — antes de
// subir o servidor, porque o relatorio cacheia a varredura (usage.js) por 60s e o teste nao
// espera esse tempo: a 1a chamada precisa achar o arquivo ja no lugar
const encDir = path.join(ROOT, '.claude', 'projects', path.join(ROOT, 'projects', 'demo').replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(encDir, { recursive: true })
fs.writeFileSync(path.join(encDir, 'abc123def456.jsonl'), [
  JSON.stringify({ timestamp: '2026-08-01T10:00:00Z', message: { role: 'user', content: 'Cria um README' } }),
  JSON.stringify({ timestamp: '2026-08-01T10:00:05Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Feito.' }], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 } } }),
].join('\n') + '\n')
// FAIL-CLOSED: o painel expoe um shell — nao pode subir sem senha nem com uma senha sabidamente
// publica. O default antigo que ja esteve versionado NAO fica no repo (o projeto e publico):
// o auth.js guarda so o sha256 dele, e aqui conferimos que esse hash continua na lista de bloqueio.
const LEAKED_DEFAULT_SHA256 = '98a2fc5119f2b61af6d90d9d7bb59813820e6cd43411eeb0a91484a769a0ccb9'
const bootWith = (pass) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: PANEL, env: { ...env, PANEL_PASSWORD: pass, PANEL_PORT: String(PORT + 1) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
  const t = setTimeout(() => { p.kill(); resolve({ code: 'still-running', out }) }, 2500)
  p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }) })
})
const failClosed = []
for (const [label, pass] of [['vazia', ''], ['changeme', 'changeme']]) {
  const b = await bootWith(pass)
  failClosed.push([`painel NAO sobe com senha ${label}`, b.code === 1 && !b.out.includes(pass || '\u0000'), JSON.stringify({ code: b.code, out: b.out.slice(-160) })])
}
{
  const authTxt = fs.readFileSync(path.join(PANEL, 'server', 'auth.js'), 'utf8')
  failClosed.push(['auth.js ainda bloqueia o default antigo (sha256)', authTxt.includes(LEAKED_DEFAULT_SHA256), 'KNOWN_PUBLIC'])
}
// o default nao pode voltar a ser versionado (Dockerfile / .env.example)
for (const f of ['Dockerfile', '.env.example']) {
  const txt = fs.readFileSync(path.join(DEVBOX, f), 'utf8')
  // nenhum PANEL_PASSWORD com valor (vazio ou ausente sao ok: o Dockerfile nao declara mais o ENV)
  failClosed.push([`${f} sem senha default`, !/^[ \t]*PANEL_PASSWORD=[ \t]*[^\s\\]/m.test(txt), f])
}
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
  for (const [name, cond, extra] of failClosed) ok(name, cond, extra)
  let r = await fetch(BASE + '/healthz'); ok('healthz', r.status === 200 && (await r.text()) === 'ok')
  r = await j('GET', '/api/login/info'); ok('login/info sem 2FA', r.data.ok && r.data.twofa === false)
  r = await j('GET', '/api/state'); ok('state sem auth -> 401', r.status === 401)
  r = await j('POST', '/api/login', { login: 'admin', password: 'errada' }); ok('login errado', r.data.ok === false)
  r = await j('POST', '/api/login', '{bad json'); ok('login corpo invalido -> 400', r.status === 400)
  // corpo acima do limite: readJson tem que resolver (nao travar a request pra sempre no req.destroy())
  {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 5000)
    try {
      const rr = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', ...H }, body: 'x'.repeat(1_200_000), signal: ac.signal })
      ok('corpo grande demais -> 400 (nao trava a conexao)', rr.status === 400)
    } catch (e) { ok('corpo grande demais -> 400 (nao trava a conexao)', false, e.message) }
    finally { clearTimeout(t) }
  }
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

  // sandbox x SYMLINK: link dentro de HOME apontando PARA FORA nao pode ler/gravar/apagar la fora
  {
    const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-outside-'))
    fs.writeFileSync(path.join(OUT, 'secret.txt'), 'SEGREDO')
    fs.symlinkSync(OUT, path.join(ROOT, 'escape'))                                  // pasta -> fora
    fs.symlinkSync(path.join(OUT, 'secret.txt'), path.join(ROOT, 'filelink.txt'))  // arquivo -> fora
    fs.symlinkSync(path.join(ROOT, 'projects'), path.join(ROOT, 'inlink'))         // pasta -> DENTRO
    const outside = () => fs.readdirSync(OUT).sort().join(',')
    const secret = () => fs.readFileSync(path.join(OUT, 'secret.txt'), 'utf8')
    const refused = (d) => d && d.ok === false && /symlink/i.test(d.msg || '')
    r = await j('GET', '/api/fs/list?path=escape'); ok('symlink p/ fora: list recusado', refused(r.data), JSON.stringify(r.data).slice(0, 160))
    r = await j('GET', '/api/fs/read?path=escape/secret.txt'); ok('symlink p/ fora: read recusado', refused(r.data), JSON.stringify(r.data).slice(0, 160))
    r = await j('GET', '/api/fs/read?path=filelink.txt'); ok('symlink de arquivo p/ fora: read recusado', refused(r.data), JSON.stringify(r.data).slice(0, 160))
    r = await j('GET', '/api/fs/stat?path=escape/secret.txt'); ok('symlink p/ fora: stat recusado', refused(r.data), JSON.stringify(r.data).slice(0, 160))
    r = await j('POST', '/api/fs/save', { path: 'escape/novo.txt', content: 'x' }); ok('symlink p/ fora: save (novo) recusado', refused(r.data) && outside() === 'secret.txt', JSON.stringify(r.data).slice(0, 160))
    r = await j('POST', '/api/fs/save', { path: 'filelink.txt', content: 'x' }); ok('symlink p/ fora: save (existente) recusado', refused(r.data) && secret() === 'SEGREDO', JSON.stringify(r.data).slice(0, 160))
    r = await j('POST', '/api/fs/create', { path: 'escape/pasta', kind: 'dir' }); ok('symlink p/ fora: create recusado', refused(r.data) && outside() === 'secret.txt', JSON.stringify(r.data).slice(0, 160))
    r = await j('POST', '/api/fs/delete', { path: 'escape/secret.txt' }); ok('symlink p/ fora: delete recusado', refused(r.data) && secret() === 'SEGREDO', JSON.stringify(r.data).slice(0, 160))
    r = await j('POST', '/api/fs/rename', { path: 'escape/secret.txt', newPath: 'projects/demo/roubado.txt' }); ok('symlink p/ fora: rename (origem) recusado', refused(r.data) && secret() === 'SEGREDO', JSON.stringify(r.data).slice(0, 160))
    fs.writeFileSync(path.join(ROOT, 'projects', 'demo', 'meu.txt'), 'meu')
    r = await j('POST', '/api/fs/rename', { path: 'projects/demo/meu.txt', newPath: 'escape/meu.txt' }); ok('symlink p/ fora: rename (destino) recusado', refused(r.data) && outside() === 'secret.txt', JSON.stringify(r.data).slice(0, 160))
    r = await fetch(BASE + '/api/fs/download?path=escape/secret.txt', { headers: { cookie } }); ok('symlink p/ fora: download recusado', r.status !== 200 && !(await r.text()).includes('SEGREDO'))
    r = await fetch(BASE + '/api/fs/upload?path=escape/up.bin', { method: 'POST', headers: { cookie, ...H, 'content-type': 'application/octet-stream' }, body: Buffer.from([1, 2]) }); ok('symlink p/ fora: upload recusado', refused(await r.json()) && outside() === 'secret.txt')
    r = await j('GET', '/api/fs/list?path='); const esc = r.data.entries && r.data.entries.find((e) => e.name === 'escape'); ok('list da raiz marca o link p/ fora sem expor o alvo', !!esc && esc.outside === true && !esc.size && !esc.mtime, JSON.stringify(esc))
    r = await j('GET', '/api/fs/read?path=inlink/demo/meu.txt'); ok('symlink p/ DENTRO da base: permitido', r.data.ok && r.data.content === 'meu', JSON.stringify(r.data).slice(0, 160))
    r = await j('POST', '/api/fs/delete', { path: 'escape' }); ok('apagar o PROPRIO link p/ fora: permitido, alvo intacto', r.data.ok && !fs.existsSync(path.join(ROOT, 'escape')) && secret() === 'SEGREDO', JSON.stringify(r.data).slice(0, 160))
    r = await j('GET', '/api/fs/list?path=../..'); ok('controle textual ../.. continua recusado', r.data.ok === false)

    // symlink QUEBRADO (alvo nao existe) p/ fora: realOf() tratava o link como "arquivo novo"
    // (ENOENT ao resolver) e deixava escrever ATRAVES dele — tem de recusar sem criar nada em OUT
    fs.symlinkSync(path.join(OUT, 'nao-existe-1.txt'), path.join(ROOT, 'dangling1.txt'))
    r = await j('POST', '/api/fs/save', { path: 'dangling1.txt', content: 'x' })
    ok('symlink quebrado p/ fora: save recusado', refused(r.data) && !fs.existsSync(path.join(OUT, 'nao-existe-1.txt')), JSON.stringify(r.data).slice(0, 160))
    fs.symlinkSync(path.join(OUT, 'nao-existe-2.txt'), path.join(ROOT, 'dangling2.txt'))
    r = await j('POST', '/api/fs/create', { path: 'dangling2.txt', kind: 'file' })
    ok('symlink quebrado p/ fora: create recusado', refused(r.data) && !fs.existsSync(path.join(OUT, 'nao-existe-2.txt')), JSON.stringify(r.data).slice(0, 160))
    fs.symlinkSync(path.join(OUT, 'nao-existe-3.txt'), path.join(ROOT, 'dangling3.txt'))
    r = await fetch(BASE + '/api/fs/upload?path=dangling3.txt', { method: 'POST', headers: { cookie, ...H, 'content-type': 'application/octet-stream' }, body: Buffer.from([9, 9]) })
    ok('symlink quebrado p/ fora: upload recusado', refused(await r.json()) && !fs.existsSync(path.join(OUT, 'nao-existe-3.txt')))

    fs.rmSync(OUT, { recursive: true, force: true })
  }

  // projetos / config
  r = await j('POST', '/api/config', { name: 'demo', key: 'autoStartClaude', value: false }); ok('config set', r.data.ok, r.data.msg)
  r = await j('POST', '/api/initline', { name: 'demo', text: 'oi\nmundo' }); ok('initline', r.data.ok)
  const cfgj = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'panel.json'), 'utf8')); ok('panel.json gravado', cfgj.projects.demo.autoStartClaude === false && cfgj.projects.demo.initLine === 'oi mundo')
  r = await j('POST', '/api/config', { name: 'x y', key: 'autoRemote', value: true }); ok('config nome invalido', r.data.ok === false)
  r = await j('POST', '/api/nada', {}); ok('rota POST desconhecida 404', r.status === 404)
  r = await j('POST', '/api/create', { name: 'demo' }, { headers: { origin: 'http://evil.example' } }); ok('POST origem errada -> 403', r.status === 403)
  r = await j('GET', '/api/term/status'); ok('term status', r.data.ok === true && typeof r.data.pty === 'boolean')
  r = await j('POST', '/api/config', { name: 'demo', key: 'autoStartClaude', value: true }); ok('config volta autoStartClaude', r.data.ok, r.data.msg)
  r = await j('POST', '/api/power', { name: 'nao-existe', on: false }); ok('power projeto inexistente', r.data.ok === false)

  // settings / logs / saude / backup / historico / sessoes
  r = await j('POST', '/api/settings/defaults', { autoRemote: false }); ok('settings defaults', r.data.ok && r.data.defaults.autoRemote === false)
  r = await j('POST', '/api/settings', { notifyDone: false }); ok('settings prefs', r.data.ok && r.data.settings.notifyDone === false)
  r = await j('GET', '/api/settings'); ok('settings get (env mascarado)', r.data.ok && r.data.env.find((e) => e.key === 'PANEL_PASSWORD').value !== 'test123' && r.data.defaults.autoRemote === false)
  r = await j('GET', '/api/logs'); ok('logs list', r.data.ok && r.data.logs.some((l) => l.key === 'audit'))
  r = await j('GET', '/api/logs/tail?file=audit&lines=50'); ok('audit log registrou acoes', r.data.ok && r.data.lines.some((l) => /"action":"config"/.test(l)) && r.data.lines.some((l) => /login\.ok/.test(l)), JSON.stringify(r.data).slice(0, 300))
  r = await j('GET', '/api/logs/tail?file=nada'); ok('log desconhecido', r.data.ok === false)
  r = await j('GET', '/api/health'); ok('health', r.data.ok && r.data.mem && Array.isArray(r.data.load) && r.data.claude, JSON.stringify(r.data).slice(0, 200))
  ok('health: cpu/top/history (sampler D)', typeof r.data.cpu?.pct === 'number' && Array.isArray(r.data.top) && Array.isArray(r.data.history), JSON.stringify({ cpu: r.data.cpu, topLen: r.data.top?.length, histLen: r.data.history?.length }))
  // contrato @panel-ui: ps da rss em KB, top[].rss tem de estar em BYTES (x1024) — pcpu continua numero
  ok('health: top[].rss em bytes (nao KB)', r.data.top.length === 0 || (typeof r.data.top[0].rss === 'number' && r.data.top[0].rss >= 1024 && typeof r.data.top[0].pcpu === 'number'), JSON.stringify(r.data.top[0]))
  r = await j('GET', '/api/usage'); ok('usage sob demanda (fora do buildState)', r.data.ok && 'total' in r.data.usage && 'today' in r.data.usage, JSON.stringify(r.data).slice(0, 200))
  r = await j('GET', '/api/state'); ok('state nao traz mais usage (tirado do tick de 2s)', !('usage' in r.data))
  r = await j('POST', '/api/backup/run', { name: 'demo' }); ok('backup run', r.data.ok, r.data.msg)
  r = await j('POST', '/api/backup/config', {}); ok('backup config', r.data.ok && r.data.backups.length >= 1, r.data.msg)
  r = await j('GET', '/api/backup/status'); ok('backup status', r.data.ok && r.data.projects[0].last && r.data.configBackups.length >= 1)
  r = await fetch(BASE + '/api/backup/download?file=config-smoke.tgz', { headers: { cookie } }); ok('backup download arquivo', r.status === 200 && r.headers.get('content-type') === 'application/gzip' && (await r.arrayBuffer()).byteLength > 20)
  r = await fetch(BASE + '/api/backup/download?file=../x.tgz', { headers: { cookie } }); ok('backup download nome invalido', r.status === 400)
  r = await j('GET', '/api/history?name=demo'); ok('history list', r.data.ok && r.data.sessions[0]?.title === 'Cria um README' && r.data.sessions[0].model === 'claude-opus-5', JSON.stringify(r.data).slice(0, 200))
  r = await j('GET', '/api/history/conversation?name=demo&id=abc123def456'); ok('history conversation', r.data.ok && r.data.conversation.items.length === 2)

  // A: modo de sessao (new/continue/pinned) — pinned exige um id que exista no historico
  r = await j('POST', '/api/session-mode', { name: 'demo', mode: 'pinned', id: 'nao-existe-123' })
  ok('session-mode pinned com id inexistente recusado', r.data.ok === false, JSON.stringify(r.data))
  r = await j('POST', '/api/session-mode', { name: 'demo', mode: 'pinned', id: 'abc123def456' })
  ok('session-mode pinned com id valido', r.data.ok === true, r.data.msg)
  const cfgPinned = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'panel.json'), 'utf8'))
  ok('panel.json: sessionMode/pinnedSession gravados', cfgPinned.projects.demo.sessionMode === 'pinned' && cfgPinned.projects.demo.pinnedSession === 'abc123def456', JSON.stringify(cfgPinned.projects.demo))
  r = await j('GET', '/api/state'); ok('state expoe sessionMode/pinnedSession', r.data.projects[0].sessionMode === 'pinned' && r.data.projects[0].pinnedSession === 'abc123def456', JSON.stringify(r.data.projects[0]).slice(0, 200))
  r = await j('POST', '/api/session-mode', { name: 'demo', mode: 'new' }); ok('session-mode volta pra new', r.data.ok === true)
  r = await j('POST', '/api/session-mode', { name: 'demo', mode: 'invalido' }); ok('session-mode invalido recusado', r.data.ok === false)

  // B: pausa manual — grava/remove o flag, estado reflete em paused
  const pausedFlagFile = path.join(ROOT, '.claude', 'run', 'claude-demo.paused')
  r = await j('POST', '/api/pause', { name: 'demo' }); ok('pause grava flag', r.data.ok, r.data.msg)
  ok('flag .paused existe com conteudo', fs.existsSync(pausedFlagFile) && fs.readFileSync(pausedFlagFile, 'utf8').trim().length > 0)
  r = await j('GET', '/api/state'); ok('state: paused=true', r.data.projects[0].paused === true)
  r = await j('POST', '/api/unpause', { name: 'demo' }); ok('unpause remove flag', r.data.ok && !fs.existsSync(pausedFlagFile), r.data.msg)
  r = await j('GET', '/api/state'); ok('state: paused=false', r.data.projects[0].paused === false)

  // C: alertas dos scripts (RUN_DIR/alerts.jsonl) -> GET /api/alerts (poll on-demand) -> clear
  fs.mkdirSync(path.join(ROOT, '.claude', 'run'), { recursive: true })
  fs.appendFileSync(path.join(ROOT, '.claude', 'run', 'alerts.jsonl'), JSON.stringify({ t: Date.now(), level: 'warn', kind: 'backup', project: 'demo', msg: 'backup atrasado' }) + '\n')
  r = await j('GET', '/api/alerts')
  ok('alerta anexado pelo script aparece em /api/alerts', r.data.ok && r.data.alerts.some((a) => a.kind === 'backup' && a.project === 'demo' && a.msg === 'backup atrasado'), JSON.stringify(r.data).slice(0, 300))
  ok('alerta: t em epoch ms', typeof r.data.alerts.find((a) => a.kind === 'backup')?.t === 'number' && r.data.alerts.find((a) => a.kind === 'backup').t > 1e12)
  r = await j('POST', '/api/alerts/clear', {}); ok('alerts/clear ok', r.data.ok)
  r = await j('GET', '/api/alerts'); ok('lista vazia apos clear', r.data.ok && r.data.alerts.length === 0)

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

      // Ctrl+A ("\x01") e TECLADO, nao frame de controle: vai pro inicio da linha no bash
      const ctrlA = await new Promise((resolve) => {
        const ws = new WSLib(`ws://127.0.0.1:${PORT}/ws/term?name=demo&cols=100&rows=30`, { headers: { cookie, origin: BASE } })
        let data = ''
        ws.on('message', (m) => { const s = m.toString(); if (s.charCodeAt(0) !== 1 || s.charCodeAt(1) !== 123) data += s })
        ws.on('open', () => setTimeout(() => { ws.send('echo Z'); ws.send('\x01'); ws.send('echo CTRLA-$((1+1)); '); ws.send('\r') }, 600))
        setTimeout(() => ws.close(), 2200)
        ws.on('close', () => resolve(data)); ws.on('error', () => resolve(data))
      })
      ok('ws: Ctrl+A chega ao terminal', /CTRLA-2/.test(ctrlA), ctrlA.slice(-300))

      // ciclo de vida: DESLIGAR persiste (boot/watchdog nao recriam), LIGAR volta
      const has = () => spawnSync('tmux', ['has-session', '-t', '=claude-demo'], { env }).status === 0
      const watchdog = () => spawnSync('bash', [SESSION_SCRIPT, '--all'], { env, stdio: 'ignore', timeout: 15000 })
      r = await j('POST', '/api/power', { name: 'demo', on: false }); ok('power off', r.data.ok && !has(), r.data.msg)
      ok('panel.json: enabled=false', JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'panel.json'), 'utf8')).projects.demo.enabled === false)
      watchdog(); ok('watchdog/boot NAO recria projeto desligado', !has())
      const offWs = await wsOpen(`ws://127.0.0.1:${PORT}/ws/term?name=demo`, { cookie, origin: BASE })
      ok('ws em projeto desligado -> 4006', offWs.code === 4006, JSON.stringify({ code: offWs.code, reason: offWs.reason }))
      ok('ws em projeto desligado nao recria a sessao', !has())
      await new Promise((s) => setTimeout(s, 2500)) // estado vem do watcher (tick de 2s)
      r = await j('GET', '/api/state'); ok('state: enabled=false', r.data.projects[0].enabled === false && r.data.projects[0].up === false)
      r = await j('POST', '/api/power', { name: 'demo', on: true }); ok('power on', r.data.ok && has(), r.data.msg)
      spawnSync('tmux', ['kill-session', '-t', '=claude-demo'], { env, stdio: 'ignore' }); watchdog(); ok('watchdog recria projeto ligado', has())
      r = await j('POST', '/api/config', { name: 'demo', key: 'autoStartClaude', value: false }); ok('Claude OFF aplica na hora', r.data.ok && has(), r.data.msg)
      await new Promise((s) => setTimeout(s, 600))
      r = await j('GET', '/api/term/capture?name=demo'); ok('Claude OFF: sessao so com shell', r.data.ok && /Claude DESLIGADO/.test(r.data.content) && !/SMOKE-READY/.test(r.data.content), r.data.content?.slice(0, 200))
      r = await j('POST', '/api/restart', { name: 'demo' }); ok('restart com Claude OFF', r.data.ok && /so shell/.test(r.data.msg), r.data.msg)

      // login guiado (com o `claude` falso): tema e metodo avancam sozinhos, link sai INTEIRO
      r = await j('GET', '/api/claude/login/status'); ok('login status idle', r.data.ok && r.data.phase === 'idle' && r.data.logged === false)
      r = await j('POST', '/api/claude/login/start', {}); ok('login start', r.data.ok && r.data.phase === 'starting', JSON.stringify(r.data))
      const waitPhase = async (want, ms) => { const t0 = Date.now(); let d; while (Date.now() - t0 < ms) { d = (await j('GET', '/api/claude/login/status')).data; if (want.includes(d.phase)) break; await new Promise((s) => setTimeout(s, 400)) } return d }
      let ls = await waitPhase(['url'], 40000) // folga p/ maquina carregada (CI/Docker)
      ok('login: avancou tema + "Claude account with subscription" ate o link', ls.phase === 'url', JSON.stringify({ phase: ls.phase, screen: ls.screen?.slice(-200) }))
      ok('login: link OAuth completo (nao cortado)', ls.url === `https://claude.ai/oauth/authorize?code=true&client_id=abc&state=${LONG}`, `len=${(ls.url || '').length}`)
      r = await j('POST', '/api/claude/login/code', { code: 'bad\u0007' }); ok('login: codigo com controle recusado', r.data.ok === false)
      r = await j('POST', '/api/claude/login/code', { code: 'good-code' }); ok('login: codigo enviado', r.data.ok, r.data.msg)
      ls = await waitPhase(['success', 'error'], 30000)
      ok('login: sucesso', ls.phase === 'success' && ls.logged === true, JSON.stringify({ phase: ls.phase, msg: ls.msg }))
      r = await j('POST', '/api/claude/login/cancel', {}); ok('login cancel', r.data.ok)
      const auditTxt = fs.readFileSync(path.join(ROOT, '.claude', 'logs', 'audit.log'), 'utf8')
      ok('audit nao grava o codigo de login', /login\.code/.test(auditTxt) && !/good-code/.test(auditTxt))
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
