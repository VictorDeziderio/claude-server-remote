/* Claude Remote — service worker of the project chat app (/remote/<project>?key=..., /c/<key>).
 * Registered by src/chat/push.js with scope /remote/ (or /c/). Receives the pushes of the chat
 * devices (server/notify.js: "Claude finished" / "Claude is asking" of one project) and opens the
 * chat when one is tapped. NO caching of pages or API: everything goes to the network.
 *
 * The page tells the worker its full link (with the key) for each project, kept in Cache Storage
 * of this device only: a tap opens THAT link, and a rotated subscription is registered again with it. */
const LINKS = 'cr-chat-links'
const linkReq = (project) => new Request('/__chat-link/' + encodeURIComponent(project))
const localPath = (u) => (typeof u === 'string' && /^\/(remote|c)\/(?!\/)/.test(u) ? u : '')

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => { /* passthrough */ })

self.addEventListener('message', (e) => {
  const d = e.data || {}
  if (d.type !== 'chat-link' || typeof d.project !== 'string' || !d.project || !localPath(d.url)) return
  e.waitUntil(caches.open(LINKS).then((c) => c.put(linkReq(d.project), new Response(d.url))).catch(() => {}))
})
async function linkOf(project) {
  try { const r = await (await caches.open(LINKS)).match(linkReq(project)); return r ? localPath(await r.text()) : '' } catch { return '' }
}

// push from the server: { title, body, url, tag, event, project, t }
// Always shows a notification: Safari/Chrome revoke subscriptions that receive "silent" pushes.
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(d.title || 'Claude', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: '/icon.svg',
    badge: '/icon-maskable.svg',
    timestamp: d.t || Date.now(),
    data: { url: localPath(d.url), project: typeof d.project === 'string' ? d.project : '' },
  }))
})

// tap -> the chat of that project: an open window of it, or its saved link in a new one
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const { url, project } = e.notification.data || {}
  e.waitUntil((async () => {
    const link = (project && await linkOf(project)) || url || '/remote/'
    const want = new URL(link, self.location.origin)
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find((c) => { const u = new URL(c.url); return u.origin === want.origin && u.pathname === want.pathname })
    if (win) { try { await win.focus() } catch { /* */ } return }
    await self.clients.openWindow(want.href)
  })())
})

// the browser rotated the subscription: register the new one with the key of a saved link
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const old = e.oldSubscription
    const opts = (old && old.options) || {}
    if (!opts.applicationServerKey) return
    const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: opts.applicationServerKey })
    const cache = await caches.open(LINKS)
    for (const req of await cache.keys()) {
      const u = new URL(localPath(await (await cache.match(req)).text()) || '/', self.location.origin)
      const key = u.searchParams.get('key') || (/^\/c\/([A-Za-z0-9_-]+)/.exec(u.pathname) || [])[1]
      if (!key) continue
      await fetch('/chat-api/push/subscribe', {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ subscription: sub.toJSON(), name: 'renewed' }),
      })
    }
  })().catch(() => {}))
})
