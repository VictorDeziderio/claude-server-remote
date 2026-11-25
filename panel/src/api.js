// Cliente da API do painel (mesmo origin). Auth por cookie de sessao (pagina de login).
class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status }
}
const handle = async (r) => {
  if (r.status === 401) { const e = new ApiError('nao autenticado', 401); e.unauth = true; throw e }
  let j = null
  try { j = await r.json() } catch { /* corpo vazio */ }
  if (!r.ok && !(j && typeof j.ok === 'boolean')) throw new ApiError((j && j.msg) || `HTTP ${r.status}`, r.status)
  return j
}
const get = (path) => fetch(path, { cache: 'no-store' }).then(handle)
const post = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(handle)
const q = (obj) => new URLSearchParams(obj).toString()

// Retorna { __unauth: true } quando nao autenticado (a SPA mostra o login).
export const getState = () => get('/api/state').catch((e) => { if (e.unauth) return { __unauth: true }; throw e })

export const loginInfo = () => get('/api/login/info')
export const login = (loginName, password, code) => post('/api/login', { login: loginName, password, code })
export const logout = () => post('/api/logout', {})
export const eventsUrl = () => '/api/events'

// --- projetos ---
export const createProject = (name, autoStartClaude, autoRemote) => post('/api/create', { name, autoStartClaude, autoRemote })
export const renameProject = (name, newName) => post('/api/rename', { name, newName })
export const deleteProject = (name) => post('/api/delete', { name })
export const setConfig = (name, key, value) => post('/api/config', { name, key, value })
export const setInitLine = (name, text) => post('/api/initline', { name, text })
export const restartProject = (name) => post('/api/restart', { name })
export const reconnectRemote = (name) => post('/api/remote', { name })
export const setPower = (name, on) => post('/api/power', { name, on })
export const setSessionMode = (name, mode, id) => post('/api/session-mode', { name, mode, id })
export const pauseProject = (name) => post('/api/pause', { name })
export const unpauseProject = (name) => post('/api/unpause', { name })

// --- arquivos (sandbox em /root) ---
export const fsStat = (p) => get('/api/fs/stat?' + q({ path: p || '' }))
export const fsList = (p) => get('/api/fs/list?' + q({ path: p || '' }))
export const fsRead = (p) => get('/api/fs/read?' + q({ path: p || '' }))
export const fsSave = (p, content) => post('/api/fs/save', { path: p, content })
export const fsCreate = (p, kind) => post('/api/fs/create', { path: p, kind })
export const fsDelete = (p) => post('/api/fs/delete', { path: p })
export const fsRename = (p, newPath) => post('/api/fs/rename', { path: p, newPath })
export const fsDownloadUrl = (p) => '/api/fs/download?' + q({ path: p || '' })
export const fsUpload = (p, file, overwrite = false) =>
  fetch('/api/fs/upload?' + q({ path: p, overwrite: overwrite ? '1' : '0' }), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  }).then(handle)

// --- terminal: WebSocket real + REST de apoio ---
export const termWsUrl = (name, cols, rows, detach) => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/ws/term?` + q({ name: name || 'shell', cols, rows, detach: detach ? '1' : '0' })
}
export const termCapture = (name, lines) => get('/api/term/capture?' + q(lines ? { name: name || '', lines } : { name: name || '' }))
export const termSend = (name, text, key) => post('/api/term/send', { name, text, key })
export const termExit = (name) => post('/api/term/exit', { name })
export const termWindows = (name) => get('/api/term/windows?' + q({ name: name || '' }))
export const termWindow = (name, action, index) => post('/api/term/window', { name, action, index })

// --- relatorio por periodo ---
export const report = (from, to) => get('/api/report?' + q({ from: from || '', to: to || '' }))
export const usage = () => get('/api/usage')
// limites do plano Claude (5h/semana) + gasto da API (server/limits.js)
export const limits = () => get('/api/limits')
export const limitsRefresh = () => post('/api/limits/refresh', {})

// --- alertas ---
export const alerts = () => get('/api/alerts')
export const alertsClear = () => post('/api/alerts/clear', {})

// --- conta do Claude / painel ---
export const claudeLogout = () => post('/api/claude/logout', {})
export const claudeUpdate = () => post('/api/claude/update', {})
export const loginStart = () => post('/api/claude/login/start', {})
export const loginStatus = () => get('/api/claude/login/status')
export const loginCode = (code) => post('/api/claude/login/code', { code })
export const loginKey = (key) => post('/api/claude/login/key', { key })
export const loginCancel = () => post('/api/claude/login/cancel', {})
export const sessions = () => get('/api/sessions')
export const revokeSession = (id) => post('/api/sessions/revoke', { id })
export const revokeOtherSessions = () => post('/api/sessions/revoke-others', {})
export const totpSetup = () => post('/api/totp/setup', {})
export const totpEnable = (code) => post('/api/totp/enable', { code })
export const totpDisable = (code) => post('/api/totp/disable', { code })

// --- historico de conversas ---
export const history = (name) => get('/api/history?' + q({ name }))
export const conversation = (name, id) => get('/api/history/conversation?' + q({ name, id }))
export const resumeConversation = (name, id) => post('/api/history/resume', { name, id })

// --- logs / saude / backup / settings ---
export const logs = () => get('/api/logs')
export const logTail = (file, lines) => get('/api/logs/tail?' + q({ file, lines: lines || 300 }))
export const health = () => get('/api/health')
export const backupStatus = () => get('/api/backup/status')
export const backupRun = (name) => post('/api/backup/run', { name: name || '' })
export const backupConfig = () => post('/api/backup/config', {})
export const backupDownloadUrl = (file, full) => '/api/backup/download?' + q({ file: file || '', full: full ? '1' : '0' })
export const settings = () => get('/api/settings')
export const setDefaults = (patch) => post('/api/settings/defaults', patch)
export const setSettings = (patch) => post('/api/settings', patch)
