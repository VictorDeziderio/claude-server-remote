// Web Push / PWA helpers for the Notifications tab (API calls + browser feature detection).
const handle = async (r) => {
  let j = null
  try { j = await r.json() } catch { /* empty */ }
  if (!j) throw new Error(`HTTP ${r.status}`)
  return j
}
const get = (p) => fetch(p, { cache: 'no-store' }).then(handle)
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(handle)

export const pushInfo = () => get('/api/push/info')
export const pushSubscribe = (subscription, name) => post('/api/push/subscribe', { subscription, name })
export const pushUnsubscribe = (b) => post('/api/push/unsubscribe', b)
export const pushTest = (id) => post('/api/push/test', { id: id || '' })
export const pushPrefs = (patch) => post('/api/push/prefs', patch)

// ---------- environment ----------
const ua = () => (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '')
export const isIOS = () => /iPad|iPhone|iPod/.test(ua()) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export const isAndroid = () => /Android/i.test(ua())
export const isStandalone = () => {
  try { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true } catch { return false }
}
export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
export const permission = () => (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported')

export function deviceName() {
  const u = ua()
  const os = isIOS() ? (/iPad/.test(u) || navigator.maxTouchPoints > 1 && !/iPhone/.test(u) ? 'iPad' : 'iPhone')
    : isAndroid() ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'Device'
  const br = /Edg\//.test(u) ? 'Edge' : /Firefox\//.test(u) ? 'Firefox' : /SamsungBrowser/.test(u) ? 'Samsung Internet'
    : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'Browser'
  return `${os} · ${br}${isStandalone() ? ' (app)' : ''}`
}

// VAPID public key (base64url) -> Uint8Array for pushManager.subscribe
export function keyToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null
  let reg = await navigator.serviceWorker.getRegistration()
  if (!reg) { try { reg = await navigator.serviceWorker.register('/sw.js') } catch { return null } }
  // wait for an active worker (at most 10s)
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 10000))])
}
export async function currentSubscription() {
  try { const reg = await navigator.serviceWorker.getRegistration(); return reg ? await reg.pushManager.getSubscription() : null } catch { return null }
}

// asks permission (must run inside a tap), subscribes and registers this device on the server
export async function enableOnThisDevice(publicKey) {
  if (!pushSupported()) return { ok: false, msg: isIOS() && !isStandalone() ? 'On iPhone/iPad, open the panel from its Home Screen icon first (see the steps below).' : 'This browser does not support Web Push.' }
  const p = await Notification.requestPermission()
  if (p !== 'granted') return { ok: false, msg: p === 'denied' ? 'Notifications are blocked for this site — allow them in the browser/system settings.' : 'Permission was not granted.' }
  const reg = await registration()
  if (!reg) return { ok: false, msg: 'Service worker not available (the panel must be served over HTTPS).' }
  let sub = await reg.pushManager.getSubscription()
  const want = keyToBytes(publicKey)
  // subscribed with an older server key (state file recreated): start over
  if (sub && sub.options && sub.options.applicationServerKey) {
    const have = new Uint8Array(sub.options.applicationServerKey)
    if (have.length !== want.length || have.some((b, i) => b !== want[i])) { await sub.unsubscribe().catch(() => {}); sub = null }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want })
  return pushSubscribe(sub.toJSON(), deviceName())
}
export async function disableOnThisDevice() {
  const sub = await currentSubscription()
  if (!sub) return { ok: true, msg: 'this device was not subscribed' }
  const endpoint = sub.endpoint
  await sub.unsubscribe().catch(() => {})
  return pushUnsubscribe({ endpoint })
}

// ---------- global hooks (main.jsx) ----------
let installPrompt = null
const installListeners = new Set()
export const getInstallPrompt = () => installPrompt
export const onInstallPrompt = (cb) => { installListeners.add(cb); return () => installListeners.delete(cb) }
export async function promptInstall() {
  if (!installPrompt) return false
  installPrompt.prompt()
  const r = await installPrompt.userChoice.catch(() => null)
  installPrompt = null
  installListeners.forEach((cb) => cb(null))
  return !!(r && r.outcome === 'accepted')
}
export function initPwaHooks() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installPrompt = e
    installListeners.forEach((cb) => cb(e))
  })
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {}
      if (d.type !== 'cr-navigate' || typeof d.url !== 'string' || !/^\/(?!\/)/.test(d.url)) return
      window.history.pushState({}, '', d.url)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
  }
}
