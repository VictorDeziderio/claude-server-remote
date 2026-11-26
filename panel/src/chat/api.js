// Chat API client. The key lives in the page URL (/c/<key>): iOS home-screen apps do not share
// cookies with Safari, so the saved link carries it. Every call sends it as a Bearer token.
// No panel cookie is used here (credentials: 'omit').

// the link: /c/<key> or /remote/<project>?key=<key> -> { key, project, manifest }
export const linkOf = (pathname, search) => {
  const c = /^\/c\/([A-Za-z0-9_-]+)/.exec(pathname || '')
  if (c) return { key: c[1], project: '', manifest: `/c/${c[1]}/manifest.webmanifest` }
  const r = /^\/remote\/([^/?#]+)\/?$/.exec(pathname || '')
  const k = new URLSearchParams(search || '').get('key') || ''
  if (r && /^[A-Za-z0-9_-]+$/.test(k)) return { key: k, project: decodeURIComponent(r[1]), manifest: `/remote/${r[1]}/manifest.webmanifest?key=${k}` }
  return { key: '', project: '', manifest: '' }
}
export const keyFromPath = (pathname, search) => linkOf(pathname, search).key
const LINK = typeof location !== 'undefined' ? linkOf(location.pathname, location.search) : { key: '', project: '', manifest: '' }
const KEY = LINK.key
export const chatKey = () => KEY
// project named in a /remote/<project> link ('' for /c/<key>): it must be the key's project
export const linkProject = () => LINK.project
export const manifestHref = () => LINK.manifest
const auth = () => ({ Authorization: `Bearer ${KEY}` })

export class ApiError extends Error {
  constructor(status, msg) { super(msg || `HTTP ${status}`); this.status = status }
}

// a 401 anywhere means the key was revoked: the app shows its "link no longer valid" screen
export const UNAUTHORIZED = 'chat-unauthorized'
async function call(path, opts = {}) {
  const r = await fetch('/chat-api/' + path, {
    ...opts,
    credentials: 'omit',
    headers: { ...auth(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  })
  let j = null
  try { j = await r.json() } catch { /* not JSON */ }
  if (r.status === 401) { try { window.dispatchEvent(new Event(UNAUTHORIZED)) } catch { /* no DOM */ } }
  if (!r.ok || !j || j.ok === false) throw new ApiError(r.status, j?.msg || j?.error)
  return j
}
const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')

export const api = {
  me: () => call('me'),
  conversations: (before) => call('conversations?' + qs({ before, limit: 20 })),
  messages: (id, before) => call('messages?' + qs({ id, before, limit: 50 })),
  media: (id, tab, before) => call('media?' + qs({ id, tab, before, limit: 30 })),
  send: (id, text, attachments) => call('send', { method: 'POST', body: JSON.stringify({ id: id || null, text, attachments }) }),
  stop: (id) => call('stop', { method: 'POST', body: JSON.stringify({ id }) }),
}

// Upload one file as a raw body, with progress (fetch has no upload progress; XHR does).
// Returns { promise, abort }. promise resolves to the Att object.
export function upload(file, onProgress) {
  const xhr = new XMLHttpRequest()
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', '/chat-api/upload?' + qs({ name: file.name || 'file' }))
    xhr.setRequestHeader('Authorization', `Bearer ${KEY}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total) }
    xhr.onload = () => {
      let j = null
      try { j = JSON.parse(xhr.responseText) } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && j?.ok && j.att) resolve(j.att)
      else reject(new ApiError(xhr.status, j?.msg || j?.error))
    }
    xhr.onerror = () => reject(new ApiError(0, 'network'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted'))
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}

// <img>/<video> cannot send a header, so file URLs carry the key as ?key= (the server accepts it
// on /chat-api/file only, and supports Range requests for iOS video).
export const fileUrl = (path) => '/chat-api/file?' + qs({ path, key: KEY })

// Minimal SSE parser over fetch (EventSource cannot send an Authorization header).
// Calls onEvent(name, data) for each event; resolves when the stream ends.
export function parseSse(buffer, onEvent) {
  let idx
  while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
    const block = buffer.slice(0, idx)
    buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '')
    let name = 'message'
    const data = []
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const c = line.indexOf(':')
      const field = c < 0 ? line : line.slice(0, c)
      const val = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '')
      if (field === 'event') name = val
      else if (field === 'data') data.push(val)
    }
    if (!data.length) continue
    let parsed
    try { parsed = JSON.parse(data.join('\n')) } catch { parsed = { text: data.join('\n') } }
    onEvent(name, parsed)
  }
  return buffer
}

export function stream(id, onEvent) {
  const ctrl = new AbortController()
  const done = (async () => {
    const r = await fetch('/chat-api/stream?' + qs({ id }), { headers: { ...auth(), Accept: 'text/event-stream' }, credentials: 'omit', signal: ctrl.signal })
    if (!r.ok || !r.body) throw new ApiError(r.status)
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      buf = parseSse(buf + dec.decode(value, { stream: true }), onEvent)
    }
  })()
  return { done, close: () => ctrl.abort() }
}
