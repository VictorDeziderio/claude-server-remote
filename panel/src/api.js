// Cliente da API do painel (mesmo origin). Auth por cookie de sessao (página de login).
const toJson = (r) => r.json()

// Retorna { __unauth: true } quando nao autenticado (a SPA mostra o login).
export const getState = () =>
  fetch('/api/state', { cache: 'no-store' }).then((r) => (r.status === 401 ? { __unauth: true } : r.json()))

const get = (path) => fetch(path, { cache: 'no-store' }).then(toJson)
const post = (path, body) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(toJson)

export const login = (loginName, password) => post('/api/login', { login: loginName, password })
export const logout = () => post('/api/logout', {})

export const createProject = (name, autoStartClaude, autoRemote) =>
  post('/api/create', { name, autoStartClaude, autoRemote })
export const renameProject = (name, newName) => post('/api/rename', { name, newName })
export const setConfig = (name, key, value) => post('/api/config', { name, key, value })
export const setInitLine = (name, text) => post('/api/initline', { name, text })
export const restartProject = (name) => post('/api/restart', { name })
export const reconnectRemote = (name) => post('/api/remote', { name })

// --- file manager (sandbox em /root) ---
export const fsList = (p) => get('/api/fs/list?path=' + encodeURIComponent(p || ''))
export const fsRead = (p) => get('/api/fs/read?path=' + encodeURIComponent(p || ''))
export const fsSave = (p, content) => post('/api/fs/save', { path: p, content })
export const fsCreate = (p, kind) => post('/api/fs/create', { path: p, kind })
export const fsDelete = (p) => post('/api/fs/delete', { path: p })
export const fsRename = (p, newPath) => post('/api/fs/rename', { path: p, newPath })

// --- terminal (tmux capture/send) ---
export const termCapture = (name) => get('/api/term/capture?name=' + encodeURIComponent(name || ''))
export const termSend = (name, text, key) => post('/api/term/send', { name, text, key })
export const termExit = (name) => post('/api/term/exit', { name })

// --- relatório por período ---
export const report = (from, to) => get('/api/report?from=' + encodeURIComponent(from || '') + '&to=' + encodeURIComponent(to || ''))

// --- conta do Claude ---
export const claudeLogout = () => post('/api/claude/logout', {})
