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

// Retorna { __unauth: true } quando nao autenticado (a SPA mostra o login).
export const getState = () => get('/api/state').catch((e) => { if (e.unauth) return { __unauth: true }; throw e })

export const login = (loginName, password) => post('/api/login', { login: loginName, password })
export const logout = () => post('/api/logout', {})

// --- projetos ---
export const createProject = (name, autoStartClaude, autoRemote) => post('/api/create', { name, autoStartClaude, autoRemote })
export const renameProject = (name, newName) => post('/api/rename', { name, newName })
export const deleteProject = (name) => post('/api/delete', { name })
export const setConfig = (name, key, value) => post('/api/config', { name, key, value })
export const setInitLine = (name, text) => post('/api/initline', { name, text })
export const restartProject = (name) => post('/api/restart', { name })
export const reconnectRemote = (name) => post('/api/remote', { name })

// --- arquivos (sandbox em /root) ---
const q = (obj) => new URLSearchParams(obj).toString()
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

// --- terminal: WebSocket real + REST de apoio (login do Claude) ---
export const termWsUrl = (name, cols, rows) => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/ws/term?` + q({ name: name || 'shell', cols, rows })
}
export const termCapture = (name) => get('/api/term/capture?' + q({ name: name || '' }))
export const termSend = (name, text, key) => post('/api/term/send', { name, text, key })
export const termExit = (name) => post('/api/term/exit', { name })

// --- relatorio por periodo ---
export const report = (from, to) => get('/api/report?' + q({ from: from || '', to: to || '' }))

// --- conta do Claude ---
export const claudeLogout = () => post('/api/claude/logout', {})
