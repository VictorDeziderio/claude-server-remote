// Cliente da API do painel (mesmo origin, atras do gateway que ja autentica).
const toJson = (r) => r.json()

export const getState = () => fetch('/api/state', { cache: 'no-store' }).then(toJson)

const post = (path, body) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(toJson)

export const createProject = (name, autoStartClaude, autoRemote) =>
  post('/api/create', { name, autoStartClaude, autoRemote })
export const renameProject = (name, newName) => post('/api/rename', { name, newName })
export const setConfig = (name, key, value) => post('/api/config', { name, key, value })
export const restartProject = (name) => post('/api/restart', { name })
export const reconnectRemote = () => post('/api/remote', {})
