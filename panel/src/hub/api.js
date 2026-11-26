// Remote hub API client. The person's key lives in the page URL (/remote?key=<key>): iOS
// home-screen apps do not share cookies with Safari, so the saved link carries it. It is also
// remembered on this device, so /remote without ?key= (an old bookmark, a tap) still opens.
// Links of OTHER servers are read straight from those servers (their /hub-api and /chat-api allow
// any origin: Bearer keys only, never cookies).
const STORE = 'cr-hub-key'
const valid = (k) => /^[A-Za-z0-9_-]{20,128}$/.test(k || '')
function initialKey() {
  if (typeof location === 'undefined') return ''
  const k = new URLSearchParams(location.search).get('key') || ''
  if (valid(k)) { try { localStorage.setItem(STORE, k) } catch { /* storage off */ } return k }
  try { const s = localStorage.getItem(STORE) || ''; return valid(s) ? s : '' } catch { return '' }
}
const KEY = initialKey()
export const hubKey = () => KEY

export class ApiError extends Error {
  constructor(status, msg) { super(msg || `HTTP ${status}`); this.status = status }
}
// one call to a server: base '' = this server
export async function call(base, key, path, { body, headers, timeout = 12000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(base + path, {
      method: body ? 'POST' : 'GET', credentials: 'omit', signal: ctrl.signal, cache: 'no-store',
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    let j = null
    try { j = await r.json() } catch { /* not JSON */ }
    if (!r.ok || !j || j.ok === false) throw new ApiError(r.status, j?.msg)
    return j
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(0, e?.name === 'AbortError' ? 'timeout' : 'network')
  } finally { clearTimeout(timer) }
}
const me = (path, opts) => call('', KEY, path, opts)
export const api = {
  me: () => me('/hub-api/me'),
  projects: () => me('/hub-api/projects'),
  links: () => me('/hub-api/links'),
  addLink: (label, url) => me('/hub-api/links/add', { body: { label, url } }),
  editLink: (id, label) => me('/hub-api/links/edit', { body: { id, label } }),
  removeLink: (id) => me('/hub-api/links/remove', { body: { id } }),
  moveLink: (id, dir) => me('/hub-api/links/move', { body: { id, dir } }),
  accounts: () => me('/hub-api/accounts'),
  setAccount: (name, account) => me('/hub-api/project/account', { body: { name, account } }),
  usage: () => me('/hub-api/usage'),
  report: (from, to) => me(`/hub-api/report?from=${from}&to=${to}`),
  server: () => me('/hub-api/server'),
  refreshLimits: () => me('/hub-api/limits/refresh', { body: {} }),
}

// the chat link of a project of THIS server, opened with the person's key
export const chatHref = (project) => `/remote/${encodeURIComponent(project)}?key=${encodeURIComponent(KEY)}`

// what a saved link points to:
//  hub  -> { kind: 'hub', base, key }               (/remote?key=)
//  chat -> { kind: 'chat', base, key, project }     (/remote/<project>?key= or /c/<key>)
export function parseLink(url) {
  let u
  try { u = new URL(url) } catch { return null }
  const key = u.searchParams.get('key') || ''
  if (/^\/remote\/?$/.test(u.pathname) && valid(key)) return { kind: 'hub', base: u.origin, key }
  const r = /^\/remote\/([^/?#]+)\/?$/.exec(u.pathname)
  if (r && valid(key)) return { kind: 'chat', base: u.origin, key, project: decodeURIComponent(r[1]) }
  const c = /^\/c\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname)
  if (c) return { kind: 'chat', base: u.origin, key: c[1], project: '' }
  return null
}
// a link to this very server's hub with this very key adds nothing: it is "this server"
export const isSelf = (l) => !!l && l.kind === 'hub' && l.base === location.origin && l.key === KEY
export const remoteChatHref = (l, project) => `${l.base}/remote/${encodeURIComponent(project)}?key=${encodeURIComponent(l.key)}`
export const remoteProjects = (l) => call(l.base, l.key, '/hub-api/projects')
export const remoteChatState = (l) => call(l.base, l.key, '/chat-api/state', { headers: l.project ? { 'X-Chat-Project': l.project } : {} })
export const remoteChatMe = (l) => call(l.base, l.key, '/chat-api/me', { headers: l.project ? { 'X-Chat-Project': l.project } : {} })
