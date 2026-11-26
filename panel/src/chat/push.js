// Push notifications of the chat app: its own service worker (/chat-sw.js, scope /remote/ or /c/),
// subscribed through /chat-api/push/* with the link key. The device then gets "Claude finished" /
// "Claude is asking" of THIS project, and a tap opens this chat.
//
// States: 'unsupported' (no Web Push here), 'install' (iPhone/iPad in Safari: Web Push only works
// in the app added to the Home Screen), 'denied' (blocked in the settings), 'off', 'on'.
// iOS asks for the permission only from a tap: enable() must be the first thing the tap handler
// awaits (Notification.requestPermission comes before any network call).
import { useCallback, useEffect, useState } from 'react'
import { deviceName, isIOS, isStandalone, keyToBytes, permission, pushSupported } from '../lib/push.js'
import { api, linkUrl } from './api.js'

export const SW_URL = '/chat-sw.js'
const scope = () => (typeof location !== 'undefined' && location.pathname.startsWith('/c/') ? '/c/' : '/remote/')

async function registration(create) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  let reg = null
  try { reg = await navigator.serviceWorker.getRegistration(location.pathname) } catch { /* */ }
  // the panel's own worker (scope "/") is not ours
  if (reg && !new URL(reg.scope).pathname.startsWith(scope())) reg = null
  if (!reg && create) { try { reg = await navigator.serviceWorker.register(SW_URL, { scope: scope() }) } catch { return null } }
  if (!reg) return null
  if (!reg.active) await new Promise((r) => { const w = reg.installing || reg.waiting; if (!w) return r(); w.addEventListener('statechange', () => { if (w.state === 'activated') r() }); setTimeout(r, 10000) })
  return reg
}
// tells the worker which link opens this chat (a notification tap), see public/chat-sw.js
export async function installWorker(project) {
  const reg = await registration(true)
  const url = linkUrl()
  if (reg && reg.active && url) reg.active.postMessage({ type: 'chat-link', project, url })
  return !!reg
}

export async function pushState() {
  if (isIOS() && !isStandalone()) return 'install'
  if (!pushSupported()) return 'unsupported'
  if (permission() === 'denied') return 'denied'
  if (permission() !== 'granted') return 'off'
  const reg = await registration(false)
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null
  if (!sub) return 'off'
  const r = await api.pushStatus(sub.endpoint).catch(() => null)
  return r && r.registered ? 'on' : 'off'
}

export async function enable(project) {
  if (!pushSupported()) return { ok: false, state: isIOS() && !isStandalone() ? 'install' : 'unsupported' }
  const p = await Notification.requestPermission()
  if (p !== 'granted') return { ok: false, state: p === 'denied' ? 'denied' : 'off' }
  const info = await api.pushInfo()
  if (!info.supported || !info.publicKey) return { ok: false, state: 'unsupported' }
  await installWorker(project)
  const reg = await registration(true)
  if (!reg) return { ok: false, state: 'unsupported' }
  const want = keyToBytes(info.publicKey)
  let sub = await reg.pushManager.getSubscription()
  // subscribed with an older server key (state file recreated): start over
  if (sub && sub.options && sub.options.applicationServerKey) {
    const have = new Uint8Array(sub.options.applicationServerKey)
    if (have.length !== want.length || have.some((b, i) => b !== want[i])) { await sub.unsubscribe().catch(() => {}); sub = null }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want })
  await api.pushSubscribe(sub.toJSON(), deviceName())
  return { ok: true, state: 'on' }
}

export async function disable() {
  const reg = await registration(false)
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {})
    await sub.unsubscribe().catch(() => {})
  }
  return { ok: true, state: 'off' }
}

// one shared state for the header bell and the info panel
export function usePush(project) {
  const [state, setState] = useState('checking')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(() => { pushState().then(setState).catch(() => setState('unsupported')) }, [])
  useEffect(() => { if (project) refresh() }, [project, refresh])
  const run = useCallback(async (fn) => {
    setBusy(true)
    try { const r = await fn(); setState(r.state); return r } catch { refresh(); return { ok: false } } finally { setBusy(false) }
  }, [refresh])
  return { state, busy, turnOn: () => run(() => enable(project)), turnOff: () => run(disable) }
}
