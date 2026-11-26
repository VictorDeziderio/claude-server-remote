// Panel API client (same origin). Auth by session cookie (login page).
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

// Returns { __unauth: true } when not authenticated (the SPA shows the login).
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
export const fsViewUrl = (p) => '/api/fs/download?' + q({ path: p || '', inline: '1' })
export const fsUpload = (p, file, overwrite = false) =>
  fetch('/api/fs/upload?' + q({ path: p, overwrite: overwrite ? '1' : '0' }), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  }).then(handle)

// --- terminal: WebSocket real + REST de apoio ---
// a file dropped/pasted on the terminal -> {ok, path} (the server keeps it inside the project)
export const termUpload = (name, file) =>
  fetch('/api/term/upload?' + q({ name: name || 'shell', file: file.name || 'image.png' }), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  }).then(handle)
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
// Claude plan limits (5h/week) + API spend (server/limits.js)
export const limits = () => get('/api/limits')
export const limitsRefresh = () => post('/api/limits/refresh', {})

// --- alertas ---
export const alerts = () => get('/api/alerts')
export const alertsClear = () => post('/api/alerts/clear', {})

// --- Claude / panel account ---
export const claudeLogout = (id) => post('/api/claude/logout', id ? { id } : {})
export const claudeUpdate = () => post('/api/claude/update', {})
export const loginStart = (id) => post('/api/claude/login/start', id ? { id } : {})
export const loginStatus = () => get('/api/claude/login/status')
export const loginCode = (code) => post('/api/claude/login/code', { code })
export const loginKey = (key) => post('/api/claude/login/key', { key })
export const loginCancel = () => post('/api/claude/login/cancel', {})
// Claude accounts (server/accounts.js): chosen per project, switched by hand
export const accounts = () => get('/api/accounts')
export const accountCreate = (label) => post('/api/accounts/create', { label })
export const accountRename = (id, label) => post('/api/accounts/rename', { id, label })
export const accountRemove = (id) => post('/api/accounts/remove', { id })
export const accountLogout = (id) => post('/api/accounts/logout', { id })
export const accountToken = (id, token) => post('/api/accounts/token', { id, token })
export const setProjectAccount = (name, account) => post('/api/project/account', { name, account })
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
// import / restore (server/restore.js)
export const backupSources = () => get('/api/backup/sources')
export const restoreConfig = (source, file) => post('/api/backup/restore/config', { source, file })
export const restoreProject = (b) => post('/api/backup/restore/project', b)
export const importRemove = (file) => post('/api/backup/import/remove', { file })
// upload of a backup .tgz with progress (XHR: fetch has no upload progress) -> { promise, abort }
export function backupImport(file, onProgress) {
  const xhr = new XMLHttpRequest()
  const promise = new Promise((resolve) => {
    xhr.open('POST', '/api/backup/import?' + q({ name: file.name || '' }))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total) }
    xhr.onload = () => { let j = null; try { j = JSON.parse(xhr.responseText) } catch { /* not JSON */ } resolve(j || { ok: false, msg: `HTTP ${xhr.status}` }) }
    xhr.onerror = () => resolve({ ok: false, msg: 'network error' })
    xhr.onabort = () => resolve({ ok: false, msg: 'aborted' })
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}
export const settings = () => get('/api/settings')
export const setDefaults = (patch) => post('/api/settings/defaults', patch)
export const setSettings = (patch) => post('/api/settings', patch)
// disk use of a project + cleanup of old agent work copies (server/disk.js)
export const projectDisk = (name, fresh) => get('/api/disk?name=' + encodeURIComponent(name) + (fresh ? '&fresh=1' : ''))
export const cleanWorktrees = (name, worktrees) => post('/api/disk/clean', { name, worktrees })
// update the panel through DEPLOY_WEBHOOK_URL (server/update.js)
export const updateStatus = () => get('/api/update')
export const updateRequest = (mode) => post('/api/update', { mode })
// chat link keys of a project (server/chat.js); the plain key comes back only on create
export const chatKeys = (name) => get('/api/chat/keys?' + q({ name }))
export const chatKeyCreate = (name, label) => post('/api/chat/keys/create', { name, label })
export const chatKeyRevoke = (id) => post('/api/chat/keys/revoke', { id })
// remote hub people (server/hub.js)
export const hubPeople = () => get('/api/hub/people')
export const hubPersonCreate = (label) => post('/api/hub/people/create', { label })
export const hubPersonRevoke = (id) => post('/api/hub/people/revoke', { id })
