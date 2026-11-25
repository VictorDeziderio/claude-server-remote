/* Claude Remote — service worker.
 * Makes the panel installable (PWA) and receives Web Push (Notifications tab).
 * NO caching of API/terminal/SSE: everything goes straight to the network (the panel only
 * makes sense online). */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => { /* passthrough */ })

// only paths of this panel ("/x", never "//other.host" or "https://...")
const localPath = (u) => (typeof u === 'string' && /^\/(?!\/)/.test(u) ? u : '/dashboard')

// push from the server (panel/server/notify.js): { title, body, url, tag, event, project, t }
// Always shows a notification: Safari/Chrome revoke subscriptions that receive "silent" pushes.
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { body: e.data ? e.data.text() : '' } }
  const title = d.title || 'Claude Remote'
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: '/icon.svg',
    badge: '/icon-maskable.svg',
    timestamp: d.t || Date.now(),
    data: { url: localPath(d.url) },
  }))
})

// tap -> open the right page (project terminal, account...) in an open panel window, or a new one
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const path = localPath(e.notification.data && e.notification.data.url)
  const url = new URL(path, self.location.origin).href
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin)
    if (win) {
      // SPA navigation without a reload (main.jsx listens); navigate() as a fallback
      try { win.postMessage({ type: 'cr-navigate', url: path }) } catch { try { await win.navigate(url) } catch { /* */ } }
      try { await win.focus() } catch { /* */ }
      return
    }
    await self.clients.openWindow(url)
  })())
})

// the browser rotated the subscription: register the new one in place of the old (best effort;
// needs the panel session cookie, which same-origin fetches from the worker carry)
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const old = e.oldSubscription
    const opts = (old && old.options) || {}
    if (!opts.applicationServerKey) return
    const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: opts.applicationServerKey })
    await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ subscription: sub.toJSON(), name: 'Device (renewed)', replaces: old ? old.endpoint : '' }),
    })
  })().catch(() => {}))
})
