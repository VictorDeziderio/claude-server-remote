// Cliente da API do painel (mesmo origin). Auth por cookie de sessao (página de login).
const toJson = (r) => r.json()

// Retorna { __unauth: true } quando nao autenticado (a SPA mostra o login).
export const getState = () =>
  fetch('/api/state', { cache: 'no-store' }).then((r) => (r.status === 401 ? { __unauth: true } : r.json()))

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
export const restartProject = (name) => post('/api/restart', { name })
export const reconnectRemote = (name) => post('/api/remote', { name })
